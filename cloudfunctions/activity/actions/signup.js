// actions/signup.js — 报名/取消报名/扫码签到/活动评价（activity-module §5.1.3-§5.1.6，§3.3-§3.7、§3.10）
// 本文件为普通 handler：业务错误一律直接 return fail(...)（activity/index.js 路由层 catch 不识别 BizError）。
// 支付链路（§3.4）：S1 db 级条件扣减名额（防超卖）→ S2-S4 事务建报名+订单 → S5 统一下单（事务外），
// S5 失败走反补偿；支付回调由 order 模块接收后回调本模块 notifyPaid 置 enrolled。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;
const S = require('./shared');
const { BIZ } = S;

const PAY_TYPES = ['wxpay', 'times_card', 'period_card']; // 客户端可选（free 由 0 元派生）

// 报名（§5.1.3）
async function signup(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const _ = db.command;

  // 参数
  if (!p.activity_id || typeof p.activity_id !== 'string') return fail(CODE.PARAM, '参数错误：activity_id');
  if (!PAY_TYPES.includes(p.pay_type)) return fail(CODE.PARAM, '参数错误：pay_type 取值不合法');
  // team_id M1 恒空（战队模块 M2），入参忽略

  // ① 登录态（§3.3 校验链固定顺序）
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status !== 'normal') return fail(CODE.BANNED, '账号已被封禁', { banned: true });

  // ② 活动状态：published 且未截止
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  if (activity.type === 'custom') return fail(BIZ.NOT_SIGNUP, '该活动类型暂未开放报名');
  if (activity.status !== 'published') return fail(BIZ.NOT_SIGNUP, '活动不在报名中');
  const now = Date.now();
  if ((activity.signup_deadline || 0) <= now) return fail(BIZ.NOT_ALLOWED, '报名已截止');
  const payTypes = Array.isArray(activity.pay_types) && activity.pay_types.length
    ? activity.pay_types : ['wxpay', 'times_card', 'period_card'];
  if (!payTypes.includes(p.pay_type)) return fail(BIZ.NOT_ALLOWED, '该活动不支持此支付方式');

  // ③ 协议（先协议后手机号，§3.3-4/5）
  const waiver = await S.getWaiverState(db, user);
  if (!waiver.valid) {
    return fail(BIZ.WAIVER_REQUIRED, '请先签署免责协议', {
      need_action: 'sign_waiver', agreement_type: waiver.requiredType,
    });
  }
  if (!user.phone) {
    return fail(BIZ.PHONE_REQUIRED, '请先绑定手机号', { need_action: 'bind_phone' });
  }
  // ④ 重复报名（§3.3-6）
  const dup = await S.hasActiveEnrollment(db, activity._id, user._id);
  if (dup) return fail(BIZ.DUPLICATE, '您已报名该活动，请勿重复报名');
  // ⑤ 卡资格（§3.3-7，M1 仅 regular）
  const cardCheck = await S.checkCardEligibility(db, activity, user, p.pay_type);
  if (!cardCheck.ok) {
    return fail(cardCheck.code, cardCheck.code === BIZ.TIMES_CARD_INVALID
      ? '次卡不可用（无效/过期/次数不足）' : '期限卡不可用（无效或已过期）');
  }
  // ⑥ 时间冲突（§3.3-8）：报名侧默认不拦（仅提示），候补递补侧强校验（shared.findTimeConflict）

  // 计价（§3.2）：0 元/卡类直接 enrolled；wxpay 建待支付订单
  const { amount, payType, needOrder } = S.resolvePay(activity, user, p.pay_type);
  const expireAt = now + S.LOCK_MS;

  // S1：db 级条件扣减名额（防超卖核心，§3.4）
  const upd = await db.collection('activity').where({
    _id: activity._id, status: 'published', remain_num: _.gt(0),
  }).update({ data: { remain_num: _.inc(-1), updated_at: now } });

  if (!upd.stats || upd.stats.updated !== 1) {
    // 满员/状态并发变化 → 候补分支（§3.6 ①）
    return enqueueWaitlist(db, activity, user, p.pay_type, amount);
  }

  // S2-S4：事务建报名 + 订单 + 回写 order_id
  const orderNo = S.genOrderNo();
  const transaction = await db.startTransaction();
  let enrollmentId = null;
  let orderId = null;
  try {
    const enrAdd = await transaction.collection('activity_enrollment').add({
      data: S.buildEnrollmentDoc({
        activity, user,
        status: needOrder ? 'pending' : 'enrolled',
        payType, priceSnapshot: amount,
        expireAt: needOrder ? expireAt : null,
      }),
    });
    enrollmentId = enrAdd._id;
    if (needOrder) {
      const ordAdd = await transaction.collection('order').add({
        data: S.buildOrderDoc({ orderNo, user, enrollmentId, activity, amount, expireAt }),
      });
      orderId = ordAdd._id;
      await transaction.collection('activity_enrollment').doc(enrollmentId).update({
        data: { order_id: orderId, updated_at: now },
      });
    }
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略 */ }
    // 反补偿：回补名额（§3.4 边界）
    await db.collection('activity').where({ _id: activity._id })
      .update({ data: { remain_num: _.inc(1) } });
    console.error('[signup] 事务失败', activity._id, user._id, e);
    return fail(BIZ.CONCURRENCY, '报名人数较多，请稍后重试');
  }

  // 事务成功后的收尾：0 元/卡类 → 直接成团；wxpay → S5 统一下单
  if (!needOrder) {
    // 直接成团（§3.4：free/卡类应付 0，无订单，立即 enrolled）
    await db.collection('activity').where({ _id: activity._id })
      .update({ data: { signup_count: _.inc(1) } });
    S.sendSubscribeMsg(cloud, user.openid, 'SIGNUP_SUCCESS', {
      thing1: { value: String(activity.title || '俱乐部活动').slice(0, 20) },
      time2: { value: S.formatDateTime(activity.start_time) },
    }, 'pages/activity/detail?id=' + activity._id);
    return ok({
      result: 'enrolled', enrollment_id: enrollmentId,
      order_id: null, order_no: null, amount: 0,
      expire_at: null, pay_params: null,
    });
  }

  // S5：统一下单（事务外，§3.4）。商户号未配置/下单失败 → 反补偿：释放名额 + 关单。
  let payParams = null;
  try {
    const subMchId = process.env.SUB_MCH_ID;
    if (!subMchId) throw new Error('SUB_MCH_ID 未配置');
    const payRes = await cloud.cloudPay.unifiedOrder({
      body: '活动报名-' + String(activity.title || '').slice(0, 120),
      outTradeNo: orderNo,
      subMchId,
      totalFee: amount,
      spbillCreateIp: '127.0.0.1',
      envId: process.env.PAY_CALLBACK_ENV || process.env.TCB_ENV || '',
      functionName: 'order', // 支付回调经 order 模块 → 回调本模块 notifyPaid 置 enrolled
    });
    payParams = payRes && payRes.payment;
    if (!payParams) throw new Error('unifiedOrder 未返回 payment 参数');
  } catch (e) {
    console.error('[signup] S5 下单失败', orderNo, e);
    await S.releaseEnrollment(db, {
      _id: enrollmentId, activity_id: activity._id, order_id: orderId,
    }, {
      // pay_fail：扩展 §6.2 cancel_type 枚举（S5 下单失败补偿专用）
      cancelType: 'pay_fail', sourceStatus: 'pending',
      incRemain: true, closeOrder: true, orderReason: 'admin_close',
    });
    return fail(BIZ.CONCURRENCY, '支付下单失败，请稍后重试');
  }

  return ok({
    result: 'pay', enrollment_id: enrollmentId,
    order_id: orderId, order_no: orderNo, amount,
    expire_at: expireAt, pay_params: payParams,
  });
}

// 满员 → 加入候补队列（§3.6 ①）
async function enqueueWaitlist(db, activity, user, payType, snapshot) {
  const _ = db.command;
  const now = Date.now();
  // 重取活动复检（防止满员判定后活动被下架/截止的并发窗口）
  const fresh = await S.getActivityById(db, activity._id);
  if (!fresh || fresh.status !== 'published' || (fresh.signup_deadline || 0) <= now) {
    return fail(BIZ.NOT_ALLOWED, '当前不可加入候补');
  }
  const enrAdd = await db.collection('activity_enrollment').add({
    data: S.buildEnrollmentDoc({
      activity: fresh, user, status: 'waitlist',
      payType, priceSnapshot: snapshot, enqueueAt: now,
    }),
  });
  await db.collection('activity').where({ _id: fresh._id })
    .update({ data: { waitlist_count: _.inc(1), updated_at: now } });
  return ok({
    result: 'waitlist', enrollment_id: enrAdd._id,
    order_id: null, order_no: null, amount: null,
    expire_at: null, pay_params: null,
  });
}

// 取消报名（§5.1.4）：pending → 释放名额；enrolled+wxpay → 退款申请；
// enrolled+卡/免费 → 直接释放；waitlist → 退出队列。
async function cancelSignup(event) {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const p = event.payload || {};

  if (!p.enrollment_id || typeof p.enrollment_id !== 'string') return fail(CODE.PARAM, '参数错误：enrollment_id');
  if (p.reason != null && (typeof p.reason !== 'string' || p.reason.length > 200)) {
    return fail(CODE.PARAM, '参数错误：reason 最长 200 字');
  }

  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  const enr = await S.getEnrollmentById(db, p.enrollment_id);
  if (!enr) return fail(BIZ.NOT_FOUND, '报名记录不存在');
  if (enr.user_id !== user._id) return fail(CODE.FORBIDDEN, '无权操作该报名记录');

  // 分支一：待支付 → 释放名额（同事务关单）+ 候补递补
  if (enr.status === 'pending') {
    const rel = await S.releaseEnrollment(db, enr, {
      cancelType: 'user_cancel', sourceStatus: 'pending',
      incRemain: true, closeOrder: true, orderReason: 'user_cancel',
    });
    if (!rel.released) {
      return rel.retryable
        ? fail(BIZ.CONCURRENCY, '操作繁忙，请稍后重试')
        : fail(BIZ.STATE_CONFLICT, '报名状态已变化，请刷新后重试');
    }
    const promoted = await S.promoteWaitlist(cloud, db, enr.activity_id);
    return ok({
      result: 'released',
      notice: '名额已释放，候补已自动递补',
      promoted: promoted ? { user_id: promoted.userId } : null,
    });
  }

  // 分支二：已支付（微信）→ 走退款流程，enrollment 保持 enrolled 等 notifyRefund 回调
  if (enr.status === 'enrolled' && enr.pay_type === 'wxpay') {
    const activity = await S.getActivityById(db, enr.activity_id);
    if (activity && Date.now() >= (activity.start_time || 0)) {
      return fail(BIZ.NOT_ALLOWED, '活动已开始，无法取消报名');
    }
    const order = enr.order_id ? await S.getDoc(db, 'order', enr.order_id) : null;
    if (!order || !order.order_no) return fail(BIZ.STATE_CONFLICT, '订单信息缺失，请联系管理员');
    const refund = await S.callOrderInternal(cloud, 'refundApply', {
      order_no: order.order_no, reason: p.reason || '用户取消报名',
    });
    if (!refund.ok) {
      // 透传 order 侧真实错误（42001 状态不可退 / 42002 已开始已签到 / 42004 重复申请
      // / 50001 微信侧失败等），由前端按码提示；callOrderInternal 异常时 code 缺省
      return fail(refund.code || CODE.INTERNAL, refund.msg || '退款发起失败，请联系俱乐部管理员处理');
    }
    const hoursLeft = activity
      ? Math.floor((activity.start_time - Date.now()) / 3600000) : 0;
    return ok({
      result: 'refund_applied',
      refund_id: (refund.data && (refund.data.refund_no || refund.data.refund_id)) || null,
      notice: hoursLeft >= 24
        ? '已申请退款，预计 1-3 个工作日到账'
        : '已申请退款（开赛前 24 小时内取消将收取 50% 费用）',
    });
  }

  // 分支三：已支付（卡类/免费）→ 直接释放名额 + 候补递补
  if (enr.status === 'enrolled') {
    const rel = await S.releaseEnrollment(db, enr, {
      cancelType: 'user_cancel', sourceStatus: 'enrolled', incRemain: true,
    });
    if (!rel.released) {
      return rel.retryable
        ? fail(BIZ.CONCURRENCY, '操作繁忙，请稍后重试')
        : fail(BIZ.STATE_CONFLICT, '报名状态已变化，请刷新后重试');
    }
    const promoted = await S.promoteWaitlist(cloud, db, enr.activity_id);
    return ok({
      result: 'released',
      notice: '名额已释放，候补已自动递补',
      promoted: promoted ? { user_id: promoted.userId } : null,
    });
  }

  // 分支四：候补中 → 退出队列（名额未占用，无需释放/递补）
  if (enr.status === 'waitlist') {
    const upd = await db.collection('activity_enrollment').where({
      _id: enr._id, status: 'waitlist',
    }).update({
      data: { status: 'cancelled', cancel_type: 'user_cancel', updated_at: Date.now() },
    });
    if (!upd.stats || upd.stats.updated !== 1) {
      return fail(BIZ.STATE_CONFLICT, '报名状态已变化，请刷新后重试');
    }
    await db.collection('activity').where({ _id: enr.activity_id })
      .update({ data: { waitlist_count: _.inc(-1) } });
    return ok({ result: 'waitlist_quited', notice: '已退出候补队列' });
  }

  return fail(BIZ.STATE_CONFLICT, '当前报名状态不可取消');
}

// selfCheckin：会员自主扫码签到提交（§5.1.5，§3.7）。
// 校验链按文档顺序：token 验签（3021）→ 活动签到窗口（3005）→ 本人报名（3022）→ 置待核验 → 返回凭证。
// 幂等：已 checked_in 直接返回 checked_in；待核验状态重复扫码仅刷新 requested_at（§3.7 边界2）。
// 次卡核销不在本接口——由工作人员 confirmCheckin 同事务核销（§3.7-3）。
async function selfCheckin(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const _ = db.command;
  if (!p.activity_id || typeof p.activity_id !== 'string') return fail(CODE.PARAM, '参数错误：activity_id');
  if (!p.token || typeof p.token !== 'string') return fail(CODE.PARAM, '参数错误：token');

  // ① 登录态
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status !== 'normal') return fail(CODE.BANNED, '账号已被封禁', { banned: true });

  // ② token 验签（60s 窗口 + 上一窗口容忍；伪造/过期一律 3021，不区分暴露）
  if (!S.verifyCheckinToken(p.activity_id, p.token)) {
    return fail(BIZ.TOKEN_INVALID, '签到二维码已过期，请重扫');
  }

  // ③ 活动状态 + 签到窗口（与 confirmCheckin 同口径：signup_closed/ongoing，[start-30min, end]）
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  const now = Date.now();
  const statusOk = activity.status === 'signup_closed' || activity.status === 'ongoing';
  const timeOk = now >= (activity.start_time || 0) - 30 * 60 * 1000
    && now <= (activity.end_time || 0);
  if (!statusOk || !timeOk) return fail(BIZ.NOT_ALLOWED, '当前不在签到时间窗口内');

  // ④ 本人有效报名（先查 enrolled/checked_in，规避取消后重报的多记录干扰）
  const activeRes = await db.collection('activity_enrollment').where({
    activity_id: p.activity_id, user_id: user._id,
    status: _.in(['enrolled', 'checked_in']),
  }).limit(1).get();
  const enr = activeRes.data[0];
  const credential = {
    nickname: '', avatar: '', pay_type: '', card_remain_times: null, status: '',
  };

  // 已签到 → 幂等返回（§3.7 边界2）
  if (enr && enr.status === 'checked_in') {
    credential.nickname = enr.nickname || user.nickname || '未设置昵称';
    credential.avatar = enr.avatar || user.avatar || '';
    credential.pay_type = enr.pay_type;
    credential.status = 'checked_in';
    return ok({
      checkin_status: 'checked_in',
      enrollment: credential,
      checkin_time: enr.checkin_time || null,
      tip: '您已完成签到，可直接入场',
    });
  }
  if (enr && enr.status === 'enrolled') {
    credential.nickname = enr.nickname || user.nickname || '未设置昵称';
    credential.avatar = enr.avatar || user.avatar || '';
    credential.pay_type = enr.pay_type;
    credential.status = 'enrolled';
  } else {
    // 无有效报名 → 按最近一条记录给出区分文案（§3.7-2：待支付/候补等对应提示）
    const latestRes = await db.collection('activity_enrollment').where({
      activity_id: p.activity_id, user_id: user._id,
    }).orderBy('created_at', 'desc').limit(1).get();
    const latest = latestRes.data[0];
    const reason = {
      pending: '报名尚未完成支付，无法签到',
      waitlist: '您仍在候补中，尚未获得名额，无法签到',
      completed: '该活动签到已结束（记录已完成）',
    };
    return fail(BIZ.NOT_ENROLLED, (latest && reason[latest.status]) || '未找到有效报名记录，无法签到');
  }

  // ⑤ 置待核验标记（重复扫码仅刷新 requested_at，工作台按此排序）
  await db.collection('activity_enrollment').doc(enr._id).update({
    data: { checkin_request: { requested_at: now, status: 'waiting' }, updated_at: now },
  });

  // ⑥ 凭证补次卡余次（现场比对用；先到期先用，与 manage.pickTimesCard 同口径）
  if (enr.pay_type === 'times_card') {
    const cardRes = await db.collection('member_card')
      .where({ user_id: user._id, card_type: 'count', status: 'active' }).limit(50).get();
    const card = cardRes.data
      .filter((c) => (c.expire_at || 0) > now && (c.remain_times || 0) > 0)
      .sort((a, b) => (a.expire_at || 0) - (b.expire_at || 0))[0];
    credential.card_remain_times = card ? card.remain_times : 0;
  }

  return ok({
    checkin_status: 'waiting',
    enrollment: credential,
    checkin_time: null,
    tip: '请向工作人员出示此凭证完成核验',
  });
}

// submitReview：活动评价提交（§5.1.6，§3.10）。
// 资格：活动 status=finished 且本人有效报名 status ∈ {checked_in, completed}（3031）；
// 唯一：activity_id+user_id 每场一条（3032）；内容：stars 1~5 整数必填、content ≤200 字。
// 冗余昵称头像（§6.4）；提交后会员端不可修改/删除。msgSecCheck 内容安全检测为文档建议项，暂未接入。
async function submitReview(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const _ = db.command;

  // ① 参数：stars 整数 1~5；content 可空但 ≤200 字
  if (!p.activity_id || typeof p.activity_id !== 'string') return fail(CODE.PARAM, '参数错误：activity_id');
  if (!Number.isInteger(p.stars) || p.stars < 1 || p.stars > 5) return fail(CODE.PARAM, '参数错误：stars 需为 1~5 的整数');
  const content = typeof p.content === 'string' ? p.content.trim() : '';
  if (content.length > 200) return fail(CODE.PARAM, '评价内容不能超过 200 字');

  // ② 登录态
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status !== 'normal') return fail(CODE.BANNED, '账号已被封禁', { banned: true });

  // ③ 活动 status=finished（未结束/已取消不可评价，§3.10 边界）
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'finished') return fail(BIZ.NOT_PARTICIPATED, '活动结束后才能评价');

  // ④ 资格：本人有效报名 ∈ {checked_in, completed}（未签到的 enrolled 不算已参加）
  const enrRes = await db.collection('activity_enrollment').where({
    activity_id: p.activity_id,
    user_id: user._id,
    status: _.in(['checked_in', 'completed']),
  }).limit(1).get();
  if (!enrRes.data.length) return fail(BIZ.NOT_PARTICIPATED, '仅已参加者可评价');

  // ⑤ 唯一性：activity_id+user_id 每场一条（§6.5 复合唯一索引兜底并发重复）
  const dupRes = await db.collection('activity_review').where({
    activity_id: p.activity_id,
    user_id: user._id,
  }).count();
  if (dupRes.total > 0) return fail(BIZ.ALREADY_REVIEWED, '您已评价过该活动');

  // ⑥ 写入（冗余昵称头像，§6.4）
  const addRes = await db.collection('activity_review').add({
    data: {
      activity_id: p.activity_id,
      user_id: user._id,
      nickname: user.nickname || '未设置昵称',
      avatar: user.avatar || '',
      stars: p.stars,
      content,
      created_at: Date.now(),
    },
  });
  return ok({ review_id: addRes._id });
}

module.exports = {
  signup, cancelSignup, selfCheckin, submitReview,
};
