// actions/shared.js — activity 模块共享助手（activity-module §3/§5/§6）
// 供 view / signup / manage / notify / cron 复用：业务错误码、计价、订单号、
// 名额释放（§3.5）、候补递补（§3.6）、时间冲突（§8.3）、订阅消息。
//
// 错误码口径：基础码用 CODE.*（common/constants.js 为数值权威）；activity 业务码 3xxx 本地定义（§5.0）。
// 文档 §5.0 的 1004(资源不存在)/1005(数据状态冲突) 与基础码段易混，改占用空闲 3xxx 段（3002/3003）。
// 满员转候补（文档 3001）按 §5.0 约定 code=0，以 data.result='waitlist' 区分，不作为错误码。
const { CODE, levelOf, rankOf } = require('@club/admin-common');
const crypto = require('crypto');

// ---------- 常量 ----------

const LOCK_MINUTES = 15;                          // 支付锁时长（§3.5）
const LOCK_MS = LOCK_MINUTES * 60 * 1000;
const WAITLIST_SCAN_LIMIT = 50;                   // 递补单轮扫描上限（§3.6 防长事务）
const PAGE_SIZE_MAX = 50;                         // 列表分页上限（§5.1.1）

const ACTIVITY_TYPES = ['novice', 'regular', 'theme', 'league', 'custom'];          // §3.1
const ACTIVITY_STATUSES = ['draft', 'published', 'signup_closed', 'ongoing', 'finished', 'cancelled']; // §3.11
const VISIBLE_STATUSES = ['published', 'signup_closed', 'ongoing', 'finished'];     // 会员端可见（§5.1.1）
const ENROLLMENT_ACTIVE_STATUSES = ['pending', 'enrolled', 'waitlist', 'checked_in', 'completed'];     // 重复报名判定（§3.3-6）
const ENROLLMENT_NOT_FINISHED = ['pending', 'enrolled', 'waitlist', 'checked_in'];  // 冗余同步范围（§6.6）

// activity 业务错误码（§5.0 的 3xxx 段）
const BIZ = {
  NOT_FOUND: 3002,          // 资源不存在（文档 1004 与 CODE.FORBIDDEN 冲突 → 空闲段）
  STATE_CONFLICT: 3003,     // 数据状态冲突（文档 1005 同上）
  NOT_SIGNUP: 3004,         // 活动不在报名中
  NOT_ALLOWED: 3005,        // 报名已截止/活动状态不允许
  CONCURRENCY: 3006,        // 报名人数较多，请稍后重试（事务冲突，可重试）
  DUPLICATE: 3009,          // 已报名该活动，请勿重复报名
  WAIVER_REQUIRED: 3010,    // 请先签署免责协议（data.need_action='sign_waiver'）
  PHONE_REQUIRED: 3011,     // 请先绑定手机号（data.need_action='bind_phone'）
  TIMES_CARD_INVALID: 3012, // 次卡不可用（无效/过期/次数不足）
  PERIOD_CARD_INVALID: 3013,// 期限卡不可用
  TOKEN_INVALID: 3021,      // 签到二维码已过期，请重扫（§5.0）
  NOT_ENROLLED: 3022,       // 未找到有效报名记录，无法签到（§5.0）
  NOT_PARTICIPATED: 3031,   // 仅已参加者可评价（§5.0）
  ALREADY_REVIEWED: 3032,   // 您已评价过该活动（§5.0）
};

// ---------- 通用读取 ----------

// openid → user 文档（未注册/未登录返回 null）
async function getCurrentUser(cloud, db) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
}

// 单文档读取（doc 不存在时 SDK 抛错 → 返回 null）
async function getDoc(db, coll, id) {
  if (!id) return null;
  try {
    const res = await db.collection(coll).doc(id).get();
    return (res && res.data) || null;
  } catch (e) {
    return null;
  }
}

function getActivityById(db, id) {
  return getDoc(db, 'activity', id);
}

function getEnrollmentById(db, id) {
  return getDoc(db, 'activity_enrollment', id);
}

// 批量取用户（enrollList 联表用），返回 Map<user_id, user>
async function fetchUserMap(db, userIds) {
  const _ = db.command;
  const ids = [...new Set((userIds || []).filter(Boolean))].slice(0, 100);
  if (!ids.length) return new Map();
  const res = await db.collection('user').where({ _id: _.in(ids) }).limit(100).get();
  return new Map(res.data.map((u) => [u._id, u]));
}

// 候补位次（§3.6）：该活动 enqueue_at 早于本人的候补记录数 + 1（同毫秒近似）
async function getWaitlistPosition(db, activityId, enrollment) {
  if (!enrollment || enrollment.status !== 'waitlist' || !enrollment.enqueue_at) return null;
  const _ = db.command;
  const res = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, status: 'waitlist', enqueue_at: _.lt(enrollment.enqueue_at) })
    .count();
  return (res.total || 0) + 1;
}

// ---------- 报名校验链（§3.3）----------

// 协议有效性：与 user/login 的 waiver_signed 口径一致（profile.js computeWaiverStatus 的精简版）
// 有效 = 本人最近签署记录的类型 === 所需类型（is_minor ? 'minor' : 'adult'）且版本 === 该类型当前生效版本
async function getWaiverState(db, user) {
  const requiredType = user.is_minor ? 'minor' : 'adult';
  const activeRes = await db.collection('agreement')
    .where({ agreement_type: requiredType, status: 'published' })
    .orderBy('published_at', 'desc').limit(1).get();
  const active = activeRes.data[0] || null;
  const signedRes = await db.collection('waiver_record')
    .where({ user_id: user._id })
    .orderBy('signed_at', 'desc').limit(1).get();
  const signed = signedRes.data[0] || null;
  const valid = !!(active && signed
    && signed.agreement_type === requiredType
    && signed.agreement_version === active.version);
  return { valid, requiredType, activeVersion: active ? active.version : null };
}

// 是否已存在有效报名（重复报名判定，可排除自身记录，候补递补时复用）
async function hasActiveEnrollment(db, activityId, userId, excludeId) {
  const _ = db.command;
  const res = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, user_id: userId, status: _.in(ENROLLMENT_ACTIVE_STATUSES) })
    .limit(5).get();
  const hit = res.data.find((e) => e._id !== excludeId);
  return hit || null;
}

// 卡资格（M1 决议：次卡/期限卡仅限 regular；期限卡 theme 折扣率未定义，M2 再扩展）
// 返回 { ok:true, card } 或 { ok:false, code:BIZ.* }
async function checkCardEligibility(db, activity, user, payType) {
  if (payType === 'wxpay' || payType === 'free') return { ok: true, card: null };
  const bizCode = payType === 'times_card' ? BIZ.TIMES_CARD_INVALID : BIZ.PERIOD_CARD_INVALID;
  if (activity.type !== 'regular') return { ok: false, code: bizCode };
  const cardType = payType === 'times_card' ? 'count' : 'period';
  const now = Date.now();
  const res = await db.collection('member_card')
    .where({ user_id: user._id, card_type: cardType, status: 'active' })
    .limit(50).get();
  const valid = res.data
    .filter((c) => (c.expire_at || 0) > now)
    .filter((c) => (cardType === 'count' ? (c.remain_times || 0) > 0 : true));
  valid.sort((a, b) => (a.expire_at || 0) - (b.expire_at || 0)); // 先到期先用
  if (!valid.length) return { ok: false, code: bizCode };
  return { ok: true, card: valid[0] };
}

// 时间冲突强校验（§8.3）：与本人其他 pending/enrolled 报名的时间段是否重叠
// 返回冲突活动或 null。报名时仅提示不强拦（§3.3-8），候补递补时强校验（§3.6）。
async function findTimeConflict(db, userId, activity, excludeEnrollmentId) {
  const _ = db.command;
  const res = await db.collection('activity_enrollment')
    .where({ user_id: userId, status: _.in(['pending', 'enrolled']) })
    .limit(100).get();
  const others = res.data.filter((e) => e._id !== excludeEnrollmentId && e.activity_id !== activity._id);
  if (!others.length) return null;
  const actIds = [...new Set(others.map((e) => e.activity_id))];
  const actRes = await db.collection('activity').where({ _id: _.in(actIds) }).limit(100).get();
  const conflict = actRes.data.find((a) => a.start_time < activity.end_time && a.end_time > activity.start_time);
  return conflict || null;
}

// ---------- 计价（§3.2）----------

// 等级折后价（整数分，四舍五入）；0 元活动直接返回 0
function calcPrice(activity, user) {
  const base = Math.max(0, Math.round(activity.price || 0));
  if (base <= 0) return 0;
  const pct = levelOf(user.total_games).discount_percent;
  if (!pct) return base;
  return Math.round((base * pct) / 100);
}

// 报名计价结果：amount=应付分；payType=如实记录（0 元 wxpay → 'free'）；needOrder=是否建待支付订单
function resolvePay(activity, user, payType) {
  const amount = payType === 'wxpay' ? calcPrice(activity, user) : 0;
  const effective = amount <= 0 && payType === 'wxpay' ? 'free' : payType;
  return { amount, payType: effective, needOrder: amount > 0 };
}

// ---------- 单号与文档构造（payment-module §6.1/§6.4）----------

const INSTANCE_ID = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); // 4 位实例标识（进程内固定）

function padNum(n, len) {
  return String(n).padStart(len, '0');
}

// 订单号：'CS' + yyMMddHHmmss(12) + 实例(4) + 随机(6) = 24 位（微信 outTradeNo ≤32）
function genOrderNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 东八区（与 profile.js calcAge 同法）
  const ts = String(d.getUTCFullYear()).slice(2)
    + padNum(d.getUTCMonth() + 1, 2) + padNum(d.getUTCDate(), 2)
    + padNum(d.getUTCHours(), 2) + padNum(d.getUTCMinutes(), 2) + padNum(d.getUTCSeconds(), 2);
  return `CS${ts}${INSTANCE_ID}${padNum(Math.floor(Math.random() * 1000000), 6)}`;
}

// 报名记录文档（§6.2）：冗余字段在报名/递补时快照（§6.6）
function buildEnrollmentDoc({ activity, user, status, payType, priceSnapshot, orderId, expireAt, enqueueAt, teamId }) {
  const now = Date.now();
  return {
    activity_id: activity._id,
    user_id: user._id,
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    activity_title: activity.title,
    activity_cover: activity.cover || '',
    activity_start_time: activity.start_time,
    team_id: teamId || null,             // 战队报名（§5.19）传本队 ID；个人报名恒 null
    status,
    pay_type: payType,
    order_id: orderId || null,
    price_snapshot: priceSnapshot,
    expire_at: expireAt || null,
    enqueue_at: enqueueAt || null,
    checkin_time: null,
    checkin_by: null,
    checkin_request: null,
    cancel_type: null,
    created_at: now,
    updated_at: now,
  };
}

// 待支付订单文档（payment-module §6.1）
// biz_type 口径：activity-module §3.4 为 'activity_enroll'（本模块权威）；
// payment-module §6.1 枚举写作 'activity_signup'，冲突时以 activity-module 为准（order 模块 M2 落地时对齐）。
function buildOrderDoc({ orderNo, user, enrollmentId, activity, amount, expireAt, teamId, items }) {
  const now = Date.now();
  return {
    order_no: orderNo,
    user_id: user._id,
    nickname: user.nickname || '',
    biz_type: 'activity_enroll',
    biz_id: enrollmentId,                // §3.4：指向报名记录（payment §6.1 写活动 ID，以 activity-module 为准）
    team_id: teamId || null,             // 战队批量单（§5.19）传本队 ID；个人/会员卡单恒 null
    items: items && items.length ? items : [{
      user_id: user._id,
      nickname: user.nickname || '',
      enrollment_id: enrollmentId,
      unit_price: amount,
      refund_status: 'none',
    }],
    snapshot: {
      title: activity.title,
      type: activity.type,
      cover: activity.cover || '',
      start_time: activity.start_time,
      venue: activity.venue,
      unit_price: activity.price,
    },
    amount,
    pay_amount: amount,
    pay_type: 'wxpay',
    status: 'pending',
    expire_at: expireAt,
    paid_at: null,
    closed_at: null,
    closed_reason: null,
    refunded_total: 0,
    created_at: now,
    updated_at: now,
  };
}

// ---------- 名额释放（§3.5/§5.3.2）----------

// 释放报名名额：事务内 置 cancelled + remain_num 回补（可选）+ 待支付订单关单（可选）。
// sourceStatus 必须与当前状态一致才执行（幂等 + 并发安全，事务内先读后写）。
// 返回 { released:true } 成功；{ released:false, retryable:false } 状态已变（幂等跳过）；
// { released:false, retryable:true } 事务冲突（调用方按 3006 返回或记日志重试）。
async function releaseEnrollment(db, enrollment, opts = {}) {
  const {
    cancelType,               // pay_timeout / user_cancel / refund / activity_cancel / not_reached_min
    sourceStatus,             // 释放前状态：pending / enrolled
    incRemain = true,         // club_cancel 联动不回补名额（§5.3.2 ②，remain_num 冻结清零）
    closeOrder = false,       // 是否同事务关闭待支付订单
    orderReason = 'timeout',  // order.closed_reason：timeout / user_cancel / admin_close
  } = opts;
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('activity_enrollment').doc(enrollment._id).get();
    const doc = cur && cur.data;
    if (!doc || doc.status !== sourceStatus) {
      await transaction.rollback();
      return { released: false, retryable: false };
    }
    await transaction.collection('activity_enrollment').doc(enrollment._id).update({
      data: { status: 'cancelled', cancel_type: cancelType, updated_at: now },
    });
    if (incRemain) {
      const actCur = await transaction.collection('activity').doc(enrollment.activity_id).get();
      const actDoc = actCur && actCur.data;
      if (actDoc) {
        // 事务内先读后写（快照隔离），避免依赖事务对更新符的支持差异
        await transaction.collection('activity').doc(enrollment.activity_id).update({
          data: { remain_num: (actDoc.remain_num || 0) + 1, updated_at: now },
        });
      }
    }
    if (closeOrder && enrollment.order_id) {
      const orderCur = await transaction.collection('order').doc(enrollment.order_id).get();
      const order = orderCur && orderCur.data;
      if (order && order.status === 'pending') {
        await transaction.collection('order').doc(enrollment.order_id).update({
          data: { status: 'closed', closed_at: now, closed_reason: orderReason, updated_at: now },
        });
      }
    }
    await transaction.commit();
    return { released: true };
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[release] 事务失败', enrollment._id, cancelType, e);
    return { released: false, retryable: true };
  }
}

// ---------- 候补递补（§3.6）----------

// 候补校验未通过 → 置 cancelled(waitlist_conflict) 并回退 waitlist_count，继续下一位（§3.6 ③）
async function markWaitlistConflict(db, activityId, candidate, reason) {
  try {
    await db.collection('activity_enrollment').doc(candidate._id).update({
      data: { status: 'cancelled', cancel_type: 'waitlist_conflict', updated_at: Date.now() },
    });
    await db.collection('activity').where({ _id: activityId }).update({
      data: { waitlist_count: db.command.inc(-1), updated_at: Date.now() },
    });
    console.info(`[waitlist] 递补校验未通过跳过：${candidate._id}（${reason}）`);
  } catch (e) {
    console.warn('[waitlist] 冲突标记失败（不阻断）', candidate._id, e);
  }
}

// 递补事务：waitlist → pending/enrolled + 订单（递补时重算价格，§3.6）
// 事务内复检 status==='waitlist'（防并发重复递补）；失败返回 null，由调用方回补名额。
async function confirmPromotion(db, activity, user, candidate) {
  const now = Date.now();
  const { amount, payType, needOrder } = resolvePay(activity, user, candidate.pay_type === 'free' ? 'free' : candidate.pay_type);
  const expireAt = now + LOCK_MS;
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('activity_enrollment').doc(candidate._id).get();
    const doc = cur && cur.data;
    if (!doc || doc.status !== 'waitlist') {
      await transaction.rollback();
      return null;
    }
    let orderId = null;
    if (needOrder) {
      const addRes = await transaction.collection('order').add({
        data: buildOrderDoc({ orderNo: genOrderNo(), user, enrollmentId: candidate._id, activity, amount, expireAt }),
      });
      orderId = (addRes && addRes._id) || null;
    }
    const status = needOrder ? 'pending' : 'enrolled'; // 0 元/卡类直接 enrolled（§3.4）
    await transaction.collection('activity_enrollment').doc(candidate._id).update({
      data: Object.assign(
        { status, expire_at: needOrder ? expireAt : null, updated_at: now },
        orderId ? { order_id: orderId } : {}
      ),
    });
    await transaction.commit();
    return {
      enrollmentId: candidate._id,
      userId: user._id,
      status,
      payType,
      amount,
      orderId,
      expireAt: needOrder ? expireAt : null,
    };
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略 */ }
    console.error('[promote] 递补事务失败', candidate._id, e);
    return null;
  }
}

// 单个候补候选人的递补执行（§3.6 ①-⑦，自动递补与运营指定递补共用）：
// 返回 { promoted } 成功；{ skipped: reason } 校验未通过（内部已置 cancelled 冲突标记）；
// null = 名额已被抢占（条件扣减未命中）或事务失败（名额已回补，调用方终止或换人）。
async function promoteCandidate(cloud, db, activity, candidate) {
  const _ = db.command;
  const now = Date.now();
  const activityId = activity._id;
  // ① 用户状态
  const user = await getDoc(db, 'user', candidate.user_id);
  if (!user || user.status !== 'normal') {
    await markWaitlistConflict(db, activityId, candidate, '用户状态异常');
    return { skipped: '用户状态异常' };
  }
  // ② 无重复报名（排除本人候补记录）
  const dup = await hasActiveEnrollment(db, activityId, user._id, candidate._id);
  if (dup) {
    await markWaitlistConflict(db, activityId, candidate, '已有有效报名');
    return { skipped: '已有有效报名' };
  }
  // ③ 时间冲突强校验（§8.3，递补侧必须强拦）
  const conflict = await findTimeConflict(db, user._id, activity, candidate._id);
  if (conflict) {
    await markWaitlistConflict(db, activityId, candidate, `与「${conflict.title}」时间冲突`);
    return { skipped: '时间冲突' };
  }
  // ④ 卡资格复检（递补时点卡可能已失效）
  const cardCheck = await checkCardEligibility(db, activity, user, candidate.pay_type);
  if (!cardCheck.ok) {
    await markWaitlistConflict(db, activityId, candidate, '支付资格失效');
    return { skipped: '支付资格失效' };
  }
  // ⑤ db 级条件扣减名额（防超卖核心：where + update 原子自提交）
  const upd = await db.collection('activity').where({
    _id: activityId, status: 'published', remain_num: _.gt(0),
  }).update({ data: { remain_num: _.inc(-1), updated_at: now } });
  if (!upd.stats || upd.stats.updated !== 1) return null; // 已满：本轮终止
  // ⑥ 事务确认递补（失败 → 回补名额）
  const promoted = await confirmPromotion(db, activity, user, candidate);
  if (!promoted) {
    await db.collection('activity').where({ _id: activityId })
      .update({ data: { remain_num: _.inc(1) } });
    return null;
  }
  // ⑦ 计数与通知（事务外）：waitlist_count-1；直接成团者 signup_count+1（§6.1 口径：只增不减）
  const counterUpdate = { waitlist_count: _.inc(-1), updated_at: now };
  if (promoted.status === 'enrolled') counterUpdate.signup_count = _.inc(1);
  await db.collection('activity').where({ _id: activityId }).update({ data: counterUpdate });
  sendSubscribeMsg(cloud, user.openid, 'WAITLIST_PROMOTED', {
    thing1: { value: String(activity.title || '').slice(0, 20) },
    time2: { value: formatDateTime(promoted.expireAt || activity.start_time) },
  }, `pages/activity/detail?id=${activityId}`);
  return { promoted };
}

// 候补递补（单轮最多 1 个有效名额，§3.6 ②）：
// 队首校验（用户正常/无重复/时间冲突强校验/卡资格复检）→ db 级条件扣减名额 → 事务确认。
// 返回递补结果或 null（无可递补/名额未空出/截止后不递补）。
async function promoteWaitlist(cloud, db, activityId) {
  const activity = await getActivityById(db, activityId);
  if (!activity || activity.status !== 'published' || (activity.signup_deadline || 0) <= Date.now()) {
    return null; // 截止后不递补（§3.6 ⑦）
  }
  const candRes = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, status: 'waitlist' })
    .orderBy('enqueue_at', 'asc').limit(WAITLIST_SCAN_LIMIT).get();
  const candidates = candRes.data.slice().sort((a, b) =>
    ((a.enqueue_at || 0) - (b.enqueue_at || 0)) || (a._id < b._id ? -1 : 1)); // 同毫秒按 _id 稳定排序
  for (const candidate of candidates) {
    const res = await promoteCandidate(cloud, db, activity, candidate);
    if (res && res.promoted) return res.promoted;
    if (res === null) return null; // 名额已满/事务失败：本轮终止
  }
  return null;
}

// ---------- 取消联动（§3.8，manage/cancel 与成团校验共用）----------

const CANCEL_TARGET_STATUSES = ['pending', 'enrolled', 'waitlist', 'checked_in'];

// 取消活动全量联动（§3.8）：事务置 cancelled（remain_num/waitlist_count 冻结清零）→
// 快照分批拉全量 → 逐条条件更新 + 关单/退款联动 → 全员订阅消息。
// 人工取消（cancelType=activity_cancel）与成团校验自动取消（not_reached_min）共用。
// 返回 { cancelled, refund_created, refund_failed, notified }；
// 或 { conflict: true, retryable } —— 状态复检失败（retryable=false，幂等跳过）/
// 事务异常（retryable=true，调用方决定报错形态：manage 抛 BizError，cron 记日志下轮重试）。
async function runCancelFlow(cloud, db, activity, reason, opts = {}) {
  const { cancelType = 'activity_cancel' } = opts;
  const _ = db.command;

  // ① 事务：置 cancelled，remain_num / waitlist_count 冻结清零
  const transaction = await db.startTransaction();
  try {
    const actCur = await transaction.collection('activity').doc(activity._id).get();
    const a = actCur && actCur.data;
    if (!a || (a.status !== 'published' && a.status !== 'signup_closed')) {
      await transaction.rollback();
      return { conflict: true, retryable: false };
    }
    await transaction.collection('activity').doc(activity._id).update({
      data: {
        status: 'cancelled',
        cancel_reason: reason,
        remain_num: 0,
        waitlist_count: 0,
        updated_at: Date.now(),
      },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[cancelFlow] 取消事务失败', activity._id, e);
    return { conflict: true, retryable: true };
  }

  // ② 快照拉全量待处理报名（分批 100，处理过程中状态漂移由条件更新兜底）
  const snapshot = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const res = await db.collection('activity_enrollment')
      .where({ activity_id: activity._id, status: _.in(CANCEL_TARGET_STATUSES) })
      .skip(skip).limit(100).get();
    snapshot.push(...res.data);
    if (res.data.length < 100) break;
  }

  // ③ 逐条联动（§3.8：单条失败不阻断，仅记数转人工；§8.4 已签到异常同样退款）
  let cancelledCount = 0;
  let refundCreated = 0;
  let refundFailed = 0;
  const toNotify = [];
  for (const enr of snapshot) {
    try {
      const upd = await db.collection('activity_enrollment')
        .where({ _id: enr._id, status: enr.status })
        .update({ data: { status: 'cancelled', cancel_type: cancelType, updated_at: Date.now() } });
      if (!upd.stats || upd.stats.updated !== 1) continue; // 已被他方处理
      cancelledCount += 1;
      toNotify.push(enr);

      if (enr.status === 'pending' && enr.order_id) {
        // 待支付：直接关单（未支付不退款）
        await db.collection('order')
          .where({ _id: enr.order_id, status: 'pending' })
          .update({ data: { status: 'closed', closed_reason: 'admin_close', updated_at: Date.now() } });
      } else if ((enr.status === 'enrolled' || enr.status === 'checked_in') && enr.pay_type === 'wxpay') {
        // 已支付（含已签到异常）：全额退款 club_cancel（订单缺失/失败 → 人工复核）
        const order = await getDoc(db, 'order', enr.order_id);
        if (order && order.order_no) {
          const refund = await callOrderInternal(cloud, 'refundApply', {
            order_no: order.order_no,
            reason: '活动取消：' + reason,
            refund_type: 'club_cancel',
          });
          if (refund.ok) refundCreated += 1;
          else refundFailed += 1;
        } else {
          refundFailed += 1;
        }
      }
      // 卡/免费/候补：仅置 cancelled，无退款联动
    } catch (e) {
      console.error(`[cancelFlow] 报名 ${enr._id} 处理失败（不阻断）：`, e);
      if (enr.pay_type === 'wxpay' && (enr.status === 'enrolled' || enr.status === 'checked_in')) {
        refundFailed += 1;
      }
    }
  }

  // ④ 全员订阅消息通知（含退款说明，fire-and-forget，§7.5）
  const userMap = await fetchUserMap(db, toNotify.map((e) => e.user_id));
  toNotify.forEach((enr) => {
    const u = userMap.get(enr.user_id);
    if (u && u.openid) {
      sendSubscribeMsg(cloud, u.openid, 'ACTIVITY_CANCELLED', {
        thing1: { value: String(activity.title).slice(0, 20) },
        thing2: { value: String(reason).slice(0, 20) },
      }, 'pages/activity/list/list');
    }
  });

  return {
    cancelled: cancelledCount,
    refund_created: refundCreated,
    refund_failed: refundFailed,
    notified: toNotify.length,
  };
}

// ---------- 订阅消息与工具 ----------

// 东八区时间格式化：yyyy-MM-dd HH:mm
function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 订阅消息发送（fire-and-forget，§3.6：资格不以通知送达为前提）
// 模板 ID 走环境变量 SUB_TMPL_<KEY>，未配置静默跳过；失败仅记日志。
function sendSubscribeMsg(cloud, openid, templateKey, fields, page) {
  setImmediate(async () => {
    try {
      const templateId = process.env[`SUB_TMPL_${templateKey}`];
      if (!templateId || !openid) return;
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: page || 'pages/activity/list/list',
        data: fields || {},
        miniprogramState: 'formal',
      });
    } catch (e) {
      console.info(`[subscribe] ${templateKey} 发送失败（不阻断）：`, (e && e.errMsg) || e);
    }
  });
}

// 云函数间调用 order 模块内部接口（带 internal_token；order 为 stub 时返回 NOT_IMPL，调用方降级处理）
async function callOrderInternal(cloud, action, payload) {
  const token = process.env.internal_token || '';
  if (!token) return { ok: false, code: null, msg: 'internal_token 未配置' };
  try {
    const res = await cloud.callFunction({
      name: 'order',
      data: Object.assign({ action, source: 'internal', internal_token: token }, payload),
    });
    const body = res && res.result;
    if (body && body.code === 0) return { ok: true, data: body.data };
    return { ok: false, code: body && body.code, msg: (body && body.msg) || 'order 模块返回失败' };
  } catch (e) {
    return { ok: false, code: null, msg: (e && e.errMsg) || String(e) };
  }
}

// ---------- 签到动态 token（§3.7/§5.2.7）----------
// token = '<时间窗口>.<HMAC-SHA256 前 32 位 hex>'，窗口 60 秒一换（window = floor(now/60000)）。
// 密钥取环境变量 CHECKIN_TOKEN_SECRET（部署时配置；未配置签发侧抛错，校验侧一律不通过）。
// 校验容忍上一窗口：覆盖 60s 轮换边界（实际有效期 60~120 秒，member 验签侧同口径）。

function checkinHmac(secret, window, activityId) {
  return crypto.createHmac('sha256', secret)
    .update(`${window}:${activityId}`).digest('hex').slice(0, 32);
}

function signCheckinToken(activityId) {
  const secret = process.env.CHECKIN_TOKEN_SECRET;
  if (!secret) throw new Error('环境变量 CHECKIN_TOKEN_SECRET 未配置，无法签发签到 token');
  const window = Math.floor(Date.now() / 60000);
  return `${window}.${checkinHmac(secret, window, activityId)}`;
}

function verifyCheckinToken(activityId, token) {
  const secret = process.env.CHECKIN_TOKEN_SECRET;
  if (!secret) return false;
  const str = String(token || '');
  const dot = str.indexOf('.');
  if (dot <= 0) return false;
  const window = Number(str.slice(0, dot));
  if (!Number.isInteger(window)) return false;
  const nowWin = Math.floor(Date.now() / 60000);
  if (window !== nowWin && window !== nowWin - 1) return false; // 仅当前/上一窗口有效
  return checkinHmac(secret, window, activityId) === str.slice(dot + 1);
}

// ---------- 战绩荣誉重评定与军衔重算（§3.9.4/§3.9.6）----------
// 与 admin/importers/stats.js 同算法（云函数独立进程不共享内存模块，D9 双落位）。

const HONOR_RULES = [ // [分组, 字段, 荣誉]
  ['win', 'kills', 'mvp'],        // MVP：胜方组击杀最高
  ['lose', 'kills', 'svp'],       // SVP：负方组击杀最高
  ['all', 'heals', 'best_heal'],
  ['all', 'supplies', 'best_supply'],
  ['all', 'captures', 'best_capture'],
];

// 荣誉重评定（幂等）：清空该活动 honors → 全量重评写回。
// 返回 { touched: [user_id...], honored: [{ user_id, nickname, honors }] }（供军衔重算与录入响应）。
async function reevaluateHonors(db, activityId) {
  // ① 清空（一次 where 批量 update）
  await db.collection('activity_stats')
    .where({ activity_id: activityId })
    .update({ data: { honors: [], updated_at: Date.now() } });
  // ② 重拉全量战绩（报名上限内 ≤ 500，limit 1000 兜底）
  const res = await db.collection('activity_stats')
    .where({ activity_id: activityId }).limit(1000).get();
  const stats = res.data;
  if (!stats.length) return { touched: [], honored: [] };

  // ③ 评定：并列均得；max ≤ 0 视为无实际成绩不产生；并列 > 5 提示复核（仍发放）
  const honorMap = new Map(); // user_id -> honors[]
  const add = (uid, h) => {
    const arr = honorMap.get(uid) || [];
    if (!arr.includes(h)) arr.push(h);
    honorMap.set(uid, arr);
  };
  const winStats = stats.filter((s) => s.is_win === true);
  const loseStats = stats.filter((s) => s.is_win === false);
  if (!winStats.length) console.warn('[honors] 全场无人 is_win=true，MVP 不产生');
  const pools = { win: winStats, lose: loseStats, all: stats };
  for (const [poolKey, field, honor] of HONOR_RULES) {
    const pool = pools[poolKey];
    if (!pool.length) continue;
    const maxV = Math.max(...pool.map((s) => s[field] || 0));
    if (maxV <= 0) continue;
    const top = pool.filter((s) => (s[field] || 0) === maxV);
    if (top.length > 5) {
      console.warn(`[honors] ${honor} 并列 ${top.length} 人（>5），建议运营复核（仍照常发放）`);
    }
    top.forEach((s) => add(s.user_id, honor));
  }

  // ④ 写回各记录 honors
  for (const [userId, honors] of Array.from(honorMap)) {
    await db.collection('activity_stats')
      .where({ activity_id: activityId, user_id: userId })
      .update({ data: { honors, updated_at: Date.now() } });
  }
  const touched = stats.map((s) => s.user_id).filter(Boolean);
  const honored = stats
    .filter((s) => (honorMap.get(s.user_id) || []).length)
    .map((s) => ({
      user_id: s.user_id,
      nickname: s.nickname || '',
      honors: honorMap.get(s.user_id),
    }));
  return { touched, honored };
}

// 军衔冗余重算（R15 如实升降）：对 userIds 逐个全量聚合 → rankOf → 写 user（单用户失败不阻断）
async function recomputeRanks(db, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  for (const uid of ids) {
    try {
      const res = await db.collection('activity_stats').where({ user_id: uid }).limit(1000).get();
      const stats = res.data;
      const totalKills = stats.reduce((sum, s) => sum + (s.kills || 0), 0);
      const totalWins = stats.filter((s) => s.is_win === true).length;
      const rank = rankOf(totalKills, totalWins); // 与门：kills 与 wins 双门槛最高档
      await db.collection('user').doc(uid).update({
        data: { total_kills: totalKills, total_wins: totalWins, rank: rank.key, rank_updated_at: Date.now() },
      });
    } catch (e) {
      console.warn(`[rank] 军衔重算失败 uid=${uid}（不阻断，下次写入全量聚合自愈）`, e);
    }
  }
}

module.exports = {
  // 常量与错误码
  BIZ, CODE, LOCK_MINUTES, LOCK_MS, WAITLIST_SCAN_LIMIT, PAGE_SIZE_MAX,
  ACTIVITY_TYPES, ACTIVITY_STATUSES, VISIBLE_STATUSES,
  ENROLLMENT_ACTIVE_STATUSES, ENROLLMENT_NOT_FINISHED, CANCEL_TARGET_STATUSES,
  // 读取
  getCurrentUser, getDoc, getActivityById, getEnrollmentById, fetchUserMap, getWaitlistPosition,
  // 校验
  getWaiverState, hasActiveEnrollment, checkCardEligibility, findTimeConflict,
  // 计价
  calcPrice, resolvePay,
  // 构造
  genOrderNo, buildEnrollmentDoc, buildOrderDoc,
  // 名额与候补
  releaseEnrollment, promoteWaitlist, promoteCandidate, runCancelFlow,
  // 签到动态 token（§3.7）
  signCheckinToken, verifyCheckinToken,
  // 战绩荣誉/军衔（§3.9）
  reevaluateHonors, recomputeRanks,
  // 工具
  sendSubscribeMsg, formatDateTime, callOrderInternal,
};
