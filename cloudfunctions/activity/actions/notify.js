// actions/notify.js — 支付/退款/关单内部回调 + 战队批量报名
// （activity-module §5.30-§5.31 / §5.3.1-§5.3.2 / §4.5 战队报名下游）
// 仅限 order / team 云函数调用：internal_token 环境变量比对（user-module §5.0 ③）。
// 普通 handler：业务错误一律 return fail(...)（activity/index.js 路由层不识别 BizError）。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;
const S = require('./shared');
const { BIZ } = S;

function wrapInternal(handler) {
  return async (event, context) => {
    const token = process.env.internal_token || '';
    if (!token || event.internal_token !== token) {
      return fail(CODE.FORBIDDEN, '拒绝访问：内部接口');
    }
    return handler(event, context);
  };
}

// §5.3.1 notifyPaid — 支付成功回调（order 模块调用）
// 入参（event 顶层）：{ order_id, enrollment_id, paid_at }
// ① 幂等：已 enrolled 直接成功；② 订单已 closed（超时释放后回调）→ refund_needed 由 order 自动退款；
// ③ 事务 pending→enrolled + signup_count+1；④ 事务外发「报名成功」订阅消息。
async function notifyPaid(event) {
  const { cloud, db } = common.getContext();
  const p = event || {};

  if (!p.enrollment_id || typeof p.enrollment_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：enrollment_id');
  }
  const enr = await S.getEnrollmentById(db, p.enrollment_id);
  if (!enr) return fail(BIZ.NOT_FOUND, '报名记录不存在');

  // ① 幂等：已报名直接成功
  if (enr.status === 'enrolled') {
    return ok({ status: 'enrolled' });
  }

  // ② 订单已超时关闭（或报名已被取消/候补等其他状态）→ 款项需退回，由 order 侧自动退款
  const order = enr.order_id ? await S.getDoc(db, 'order', enr.order_id) : null;
  const orderClosed = !order || order.status === 'closed';
  if (orderClosed || enr.status !== 'pending') {
    return ok({ status: enr.status, refund_needed: true });
  }

  // ③ 事务：pending → enrolled + signup_count+1（先读后写，防并发重复推进）
  const now = Date.now();
  let promotedToEnrolled = false;
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('activity_enrollment').doc(enr._id).get();
    const doc = cur && cur.data;
    if (!doc) {
      await transaction.rollback();
      return fail(BIZ.NOT_FOUND, '报名记录不存在');
    }
    if (doc.status === 'enrolled') {
      await transaction.rollback();
      return ok({ status: 'enrolled' }); // 并发幂等
    }
    if (doc.status !== 'pending') {
      await transaction.rollback();
      return ok({ status: doc.status, refund_needed: true });
    }
    await transaction.collection('activity_enrollment').doc(enr._id).update({
      data: { status: 'enrolled', updated_at: now },
    });
    const actCur = await transaction.collection('activity').doc(doc.activity_id).get();
    const actDoc = actCur && actCur.data;
    if (actDoc) {
      await transaction.collection('activity').doc(doc.activity_id).update({
        data: { signup_count: (actDoc.signup_count || 0) + 1, updated_at: now },
      });
    }
    await transaction.commit();
    promotedToEnrolled = true;
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[notifyPaid] 事务失败', enr._id, e);
    return fail(BIZ.CONCURRENCY, '操作繁忙，请稍后重试');
  }

  // ④ 事务外发「报名成功」订阅消息（fire-and-forget）
  if (promotedToEnrolled) {
    const userMap = await S.fetchUserMap(db, [enr.user_id]);
    const u = userMap.get(enr.user_id);
    if (u && u.openid) {
      S.sendSubscribeMsg(cloud, u.openid, 'SIGNUP_SUCCESS', {
        thing1: { value: String(enr.activity_title || '').slice(0, 20) },
        time2: { value: S.formatDateTime(enr.activity_start_time) },
      }, 'pages/activity/detail?id=' + enr.activity_id);
    }
  }
  return ok({ status: 'enrolled' });
}

// §5.3.2 notifyRefund — 退款成功回调（order 模块调用）
// 入参（event 顶层）：{ order_id, enrollment_id, refund_id, refund_type }
// ① 幂等（已 cancelled 直接成功）；② 释放报名（cancel_type=refund）+ 回补名额；
// ③ 候补自动递补（§3.6.3 含冲突跳过）；④ 递补订阅消息（promoteWaitlist 内部发送）；
// ⑤ refund_type=club_cancel（活动取消批量退款）不递补（活动已取消）。
async function notifyRefund(event) {
  const { cloud, db } = common.getContext();
  const p = event || {};

  if (!p.enrollment_id || typeof p.enrollment_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：enrollment_id');
  }
  const enr = await S.getEnrollmentById(db, p.enrollment_id);
  if (!enr) return fail(BIZ.NOT_FOUND, '报名记录不存在');

  // ① 幂等：已取消直接成功
  if (enr.status === 'cancelled') {
    return ok({ released: true, promoted: null });
  }
  if (enr.status !== 'enrolled') {
    return fail(BIZ.STATE_CONFLICT, '当前报名状态不可退款释放');
  }

  // ② 事务释放（cancel_type=refund，回补名额；订单已退款，无需关单）
  const rel = await S.releaseEnrollment(db, enr, {
    cancelType: 'refund',
    sourceStatus: 'enrolled',
    incRemain: true,
  });
  if (!rel.released) {
    if (rel.retryable) {
      return fail(BIZ.CONCURRENCY, '操作繁忙，请稍后重试');
    }
    // 状态已变化（被他方并发取消）→ 幂等视为已释放
    return ok({ released: true, promoted: null });
  }

  // ③/④ 候补自动递补（club_cancel 不递补；promoteWaitlist 内部校验发布态/截止并发通知）
  let promoted = null;
  if (p.refund_type !== 'club_cancel') {
    const res = await S.promoteWaitlist(cloud, db, enr.activity_id);
    if (res) {
      promoted = { user_id: res.userId, notified: true };
    }
  }
  return ok({ released: true, promoted });
}

// notifyClose — 订单关闭回调（order 模块调用，payment-module §5.7 ④/§5.2 过期关单联动）
// 入参（event 顶层）：{ order_id, enrollment_id, reason }（reason: user_cancel / timeout）
// 订单方已先行关单（pending → closed）；此处释放 pending 报名 + 回补名额 + 候补递补。
// ① 幂等：已 cancelled 直接成功；② 非 pending（enrolled 为晚付链路、由退款联动释放；
// waitlist 无订单不达）→ 幂等跳过；③ 事务释放（cancel_type 按来源，不关单——订单已由
// 调用方关闭）；④ 候补递补（名额释放即递补，与 notifyRefund 同策略）。
async function notifyClose(event) {
  const { cloud, db } = common.getContext();
  const p = event || {};

  if (!p.enrollment_id || typeof p.enrollment_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：enrollment_id');
  }
  const enr = await S.getEnrollmentById(db, p.enrollment_id);
  if (!enr) return fail(BIZ.NOT_FOUND, '报名记录不存在');

  // ① 幂等：已取消直接成功
  if (enr.status === 'cancelled') {
    return ok({ released: true, promoted: null });
  }
  // ② 非 pending：并发状态已变（晚付 enrolled / 其他）→ 幂等跳过，由对应链路处理
  if (enr.status !== 'pending') {
    return ok({ released: false, status: enr.status });
  }

  // ③ 事务释放 pending 报名（回补名额；订单已由 order 侧关闭，不再关单）
  const cancelType = p.reason === 'user_cancel' ? 'user_cancel' : 'pay_timeout';
  const rel = await S.releaseEnrollment(db, enr, {
    cancelType, sourceStatus: 'pending', incRemain: true, closeOrder: false,
  });
  if (!rel.released) {
    if (rel.retryable) {
      return fail(BIZ.CONCURRENCY, '操作繁忙，请稍后重试');
    }
    return ok({ released: false, status: enr.status }); // 并发状态已变，幂等跳过
  }

  // ④ 候补自动递补（活动已取消/已截止时内部直接返回 null）
  const res = await S.promoteWaitlist(cloud, db, enr.activity_id);
  return ok({ released: true, promoted: res ? { user_id: res.userId } : null });
}

// teamSignup — 战队批量报名内部接口（team 模块队长 enroll-submit 调用，team-module §5.19）
// 分工（activity-module §4.5）：队内选人/在职/协议/手机号校验属战队模块；本接口负责
// 活动状态校验、重复报名兜底、S1 条件批量扣减名额 + S2-S4 事务建 N 条报名（team_id 落档）
// 与 1 张批量订单（支付人=队长，items[] 逐成员，activity-module §3.4 报名与订单同事务直建）。
// 名额不足整体失败（不支持批量候补 §4.5）；全额 0 元免单直接 enrolled（无订单）。
// 回传码契约：BIZ.CONCURRENCY(3006) 唯一表示「名额不足」（事务冲突改用 CODE.INTERNAL 区分），
// team 侧映射 40909；BIZ.DUPLICATE(3009) → team 侧 40904。
// 付费路径不在此统一下单：前端凭 order_no 调 order/getPayParams（§5.2）拉起支付。
async function teamSignup(event) {
  const { cloud, db } = common.getContext();
  const p = event || {};
  const _ = db.command;

  if (!p.activity_id || typeof p.activity_id !== 'string') return fail(CODE.PARAM, '参数错误：activity_id');
  if (!p.team_id || typeof p.team_id !== 'string') return fail(CODE.PARAM, '参数错误：team_id');
  if (!p.payer_user_id || typeof p.payer_user_id !== 'string') return fail(CODE.PARAM, '参数错误：payer_user_id');
  const userIds = [...new Set((Array.isArray(p.user_ids) ? p.user_ids : []).filter(
    (id) => id && typeof id === 'string'
  ))];
  if (!userIds.length) return fail(CODE.PARAM, '参数错误：user_ids');
  if (userIds.length > 100) return fail(CODE.PARAM, '单次最多为 100 名成员报名');

  // ① 活动校验（§3.3-2/3/4/5；战队批量报名仅支持微信支付统一收款）
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  if (activity.type === 'custom') return fail(BIZ.NOT_SIGNUP, '该活动类型暂未开放报名');
  if (activity.status !== 'published') return fail(BIZ.NOT_SIGNUP, '活动不在报名中');
  const now = Date.now();
  if ((activity.signup_deadline || 0) <= now) return fail(BIZ.NOT_ALLOWED, '报名已截止');
  const payTypes = Array.isArray(activity.pay_types) && activity.pay_types.length
    ? activity.pay_types : ['wxpay', 'times_card', 'period_card'];
  if (!payTypes.includes('wxpay')) return fail(BIZ.NOT_ALLOWED, '该活动不支持微信支付');

  // ② 成员与支付人文档（计价/快照以本模块读取为准，不信任跨模块冗余副本）
  const userMap = await S.fetchUserMap(db, [...userIds, p.payer_user_id]);
  const members = userIds.map((id) => userMap.get(id)).filter(Boolean);
  if (members.length !== userIds.length) return fail(CODE.PARAM, '部分成员不存在或已注销');
  const payer = userMap.get(p.payer_user_id);
  if (!payer) return fail(CODE.PARAM, '支付人不存在或已注销');

  // ③ 重复报名兜底（§3.3-6 口径；战队模块已预检，此处防并发窗口）
  const dupRes = await db.collection('activity_enrollment')
    .where({
      activity_id: activity._id,
      user_id: _.in(userIds),
      status: _.in(S.ENROLLMENT_ACTIVE_STATUSES),
    })
    .limit(1).get();
  if ((dupRes.data || []).length) return fail(BIZ.DUPLICATE, '部分成员已报名该活动');

  // 计价：逐成员等级折后价（§3.2），合计为订单金额；全额 0 元免单
  const prices = members.map((m) => S.calcPrice(activity, m));
  const total = prices.reduce((sum, v) => sum + v, 0);
  const needOrder = total > 0;
  const expireAt = now + S.LOCK_MS;

  // S1：db 级条件批量扣减名额（防超卖核心，§3.4/§4.5）
  const upd = await db.collection('activity').where({
    _id: activity._id, status: 'published', remain_num: _.gte(userIds.length),
  }).update({ data: { remain_num: _.inc(-userIds.length), updated_at: now } });
  if (!upd.stats || upd.stats.updated !== 1) {
    return fail(BIZ.CONCURRENCY, '活动名额不足');
  }

  // S2-S4：事务建 N 条报名 + 1 张批量订单 + 回写 order_id（任一步失败整体回滚）
  const orderNo = needOrder ? S.genOrderNo() : null;
  const transaction = await db.startTransaction();
  const enrollmentIds = [];
  let orderId = null;
  try {
    for (let i = 0; i < members.length; i++) {
      const enrAdd = await transaction.collection('activity_enrollment').add({
        data: S.buildEnrollmentDoc({
          activity, user: members[i],
          status: needOrder ? 'pending' : 'enrolled',
          payType: needOrder ? 'wxpay' : 'free',
          priceSnapshot: prices[i],
          expireAt: needOrder ? expireAt : null,
          teamId: p.team_id,
        }),
      });
      enrollmentIds.push(enrAdd._id);
    }
    if (needOrder) {
      const ordAdd = await transaction.collection('order').add({
        data: S.buildOrderDoc({
          orderNo, user: payer, enrollmentId: enrollmentIds[0], activity,
          amount: total, expireAt, teamId: p.team_id,
          items: members.map((m, i) => ({
            user_id: m._id,
            nickname: m.nickname || '',
            enrollment_id: enrollmentIds[i],
            unit_price: prices[i],
            refund_status: 'none',
          })),
        }),
      });
      orderId = ordAdd._id;
      for (const eid of enrollmentIds) {
        await transaction.collection('activity_enrollment').doc(eid).update({
          data: { order_id: orderId, updated_at: now },
        });
      }
    }
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略 */ }
    // 反补偿：回补名额（§3.4 边界；CODE.INTERNAL 与「名额不足」3006 区分，team 侧分别映射）
    await db.collection('activity').where({ _id: activity._id })
      .update({ data: { remain_num: _.inc(userIds.length) } });
    console.error('[teamSignup] 事务失败', activity._id, p.team_id, e);
    return fail(CODE.INTERNAL, '报名人数较多，请稍后重试');
  }

  // 免单路径：全额 0 元 → 无订单，直接 enrolled，signup_count += N，逐成员发订阅消息
  if (!needOrder) {
    await db.collection('activity').where({ _id: activity._id })
      .update({ data: { signup_count: _.inc(members.length) } });
    for (const m of members) {
      if (m.openid) {
        S.sendSubscribeMsg(cloud, m.openid, 'SIGNUP_SUCCESS', {
          thing1: { value: String(activity.title || '俱乐部活动').slice(0, 20) },
          time2: { value: S.formatDateTime(activity.start_time) },
        }, 'pages/activity/detail?id=' + activity._id);
      }
    }
    return ok({
      order_no: null, order_id: null, enrollment_ids: enrollmentIds,
      amount: 0, expire_at: null,
    });
  }

  // 付费路径：批量订单待支付；markPaid 已按 items[] 逐成员推进（payment-module 批量口径）
  return ok({
    order_no: orderNo, order_id: orderId, enrollment_ids: enrollmentIds,
    amount: total, expire_at: expireAt,
  });
}

module.exports = {
  notifyPaid: wrapInternal(notifyPaid),
  notifyRefund: wrapInternal(notifyRefund),
  notifyClose: wrapInternal(notifyClose),
  teamSignup: wrapInternal(teamSignup),
};
