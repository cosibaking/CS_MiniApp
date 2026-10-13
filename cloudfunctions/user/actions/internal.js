// actions/internal.js — 内部接口（user-module §5.14-§5.18）+ 定时任务（§5.22）
// 仅限云函数间调用（order/activity 等），防前端直调：internal_token 环境变量比对（§5.0 ③）。
// internal_token 请在云开发控制台为各云函数配置相同的环境变量。
// 通用约定（§5.14）：全部幂等；能并入调用方事务的操作（如签到核销）由调用方
// 在自身事务内直接更新 member_card，deductTimes 仅用于无法并入同一事务的场景。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;

// user 模块业务码（user-module §5.15-§5.18）
const BIZ = {
  CARD_NOT_FOUND: 1005, // 卡不存在或不属于该用户 / 用户不存在
  TIMES_INSUFFICIENT: 2005, // 剩余次数不足
  CARD_EXPIRED: 2006, // 会员卡已过期
  CARD_VOIDED: 2007, // 会员卡状态不可用（已作废）/ 订单已绑定其他卡
};

function assertInternal(event) {
  const token = process.env.internal_token || '';
  if (!token || event.internal_token !== token) {
    return fail(CODE.FORBIDDEN, '拒绝访问：内部接口');
  }
  return null;
}

function wrapInternal(handler, action, docRef) {
  return async (event, context) => {
    const denied = assertInternal(event);
    if (denied) return denied;
    return handler(event, context);
  };
}

// ---------- 内部工具 ----------

// R7：now + months 个自然月，取到期日 23:59:59.999（东八区口径，月末截断：1/31 + 1月 → 2/28）
function monthExpire(now, months) {
  const t = new Date(now + 8 * 3600 * 1000);
  const y = t.getUTCFullYear();
  const tm = t.getUTCMonth() + months; // Date.UTC 自动进位跨年
  const daysIn = new Date(Date.UTC(y, tm + 1, 0)).getUTCDate();
  const day = Math.min(t.getUTCDate(), daysIn);
  return Date.UTC(y, tm, day + 1) - 8 * 3600 * 1000 - 1;
}

// ---------- 内部 Actions ----------

// §5.15 activateCard — 支付成功后写入并激活会员卡（幂等：member_card.order_id）
// 卡种参数取调用方传入的下单快照，不实时读 card_product（§5.15 ②）。
async function activateCard(event) {
  const { db } = common.getContext();
  const p = (event && event.payload) || {};
  const {
    order_id: orderId,
    order_no: orderNo,
    user_id: userId,
    card_name: cardName,
    card_type: cardType,
    times,
    valid_months: validMonths,
    period_months: periodMonths,
    price,
  } = p;

  if (!orderId || !orderNo || !userId || !cardName || !cardType) {
    return fail(CODE.PARAM, '参数错误：order_id/order_no/user_id/card_name/card_type 必填');
  }
  if (cardType !== 'count' && cardType !== 'period') {
    return fail(CODE.PARAM, '参数错误：card_type 非法');
  }
  if (cardType === 'count' && (!times || times <= 0 || !validMonths || validMonths <= 0)) {
    return fail(CODE.PARAM, '参数错误：次卡需 times/valid_months');
  }
  if (cardType === 'period' && (!periodMonths || periodMonths <= 0)) {
    return fail(CODE.PARAM, '参数错误：期限卡需 period_months');
  }

  // 幂等：同订单已发卡直接返回该 card_id（§5.15 ①）
  const dup = await db.collection('member_card').where({ order_id: orderId }).limit(1).get();
  if (dup.data && dup.data[0]) {
    return ok({ card_id: dup.data[0]._id });
  }
  // 同单号已绑定其他卡：数据异常（§5.15 2007）
  const byNo = await db.collection('member_card').where({ order_no: orderNo }).limit(1).get();
  if (byNo.data && byNo.data[0]) {
    return fail(BIZ.CARD_VOIDED, '该订单已绑定其他卡（数据异常，需人工介入）');
  }

  // 用户存在性校验（§5.15 1005）
  const userFound = await db.collection('user').doc(userId).get().catch(() => null);
  if (!userFound || !userFound.data) {
    return fail(BIZ.CARD_NOT_FOUND, 'user_id 对应用户不存在');
  }

  const now = Date.now();
  const data = {
    user_id: userId,
    card_type: cardType,
    card_name: cardName,
    status: 'active',
    source: 'purchase',
    order_id: orderId,
    order_no: orderNo, // 实现级冗余：供 getCardDetail 出参 order_no（§5.10 示例）
    price: price || 0,
    remark: '',
    activated_at: now,
    created_at: now,
  };
  if (cardType === 'count') {
    data.remain_times = times;
    data.total_times = times;
    data.used_times = 0;
    data.expire_at = monthExpire(now, validMonths);
  } else {
    // 期限卡不设 remain_times（§5.15 ④）
    data.expire_at = monthExpire(now, periodMonths);
  }

  const added = await db.collection('member_card').add({ data });
  return ok({ card_id: added._id });
}

// §5.16 deductTimes — 跨云函数原子扣次（R10 条件更新），0 行回读区分原因
async function deductTimes(event) {
  const { db } = common.getContext();
  const _ = db.command;
  const p = (event && event.payload) || {};
  const { card_id: cardId, user_id: userId, times } = p;
  if (!cardId || !userId || !times || times <= 0) {
    return fail(CODE.PARAM, '参数错误：card_id/user_id/times 必填');
  }

  const now = Date.now();
  const res = await db
    .collection('member_card')
    .where({
      _id: cardId,
      user_id: userId,
      card_type: 'count',
      status: 'active',
      expire_at: _.gt(now),
      remain_times: _.gte(times),
    })
    .update({ data: { remain_times: _.inc(-times), used_times: _.inc(times) } });

  if (res.stats && res.stats.updated > 0) {
    const fresh = await db.collection('member_card').doc(cardId).get();
    return ok({ card_id: cardId, remain_times: fresh.data.remain_times });
  }

  // 更新 0 行：回读区分失败原因（§5.16 ② + 错误表 2007）
  const found = await db.collection('member_card').doc(cardId).get().catch(() => null);
  const card = found && found.data;
  if (!card || card.user_id !== userId) {
    return fail(BIZ.CARD_NOT_FOUND, '会员卡不存在或不属于该用户');
  }
  if (card.status === 'voided') {
    return fail(BIZ.CARD_VOIDED, '会员卡已作废，无法扣次');
  }
  if ((card.expire_at || 0) <= now) {
    return fail(BIZ.CARD_EXPIRED, '会员卡已过期');
  }
  return fail(BIZ.TIMES_INSUFFICIENT, '剩余次数不足');
}

// §5.17 restoreTimes — 活动取消/退款退次（过期卡仍退；voided 拒绝）
async function restoreTimes(event) {
  const { db } = common.getContext();
  const _ = db.command;
  const p = (event && event.payload) || {};
  const { card_id: cardId, user_id: userId, times } = p;
  if (!cardId || !userId || !times || times <= 0) {
    return fail(CODE.PARAM, '参数错误：card_id/user_id/times 必填');
  }

  const found = await db.collection('member_card').doc(cardId).get().catch(() => null);
  const card = found && found.data;
  if (!card || card.user_id !== userId) {
    return fail(BIZ.CARD_NOT_FOUND, '会员卡不存在或不属于该用户');
  }
  // 已 voided 不再恢复：整卡退款已作废，卡上数据冻结作为退款依据（§5.17 ③）
  if (card.status === 'voided') {
    return fail(BIZ.CARD_VOIDED, '会员卡已作废，不允许恢复');
  }

  // 条件更新（§5.17 ①）：无 status/expire_at 过滤 → 过期卡仍退
  const res = await db
    .collection('member_card')
    .where({ _id: cardId, user_id: userId, card_type: 'count', used_times: _.gte(times) })
    .update({ data: { remain_times: _.inc(times), used_times: _.inc(-times) } });

  if (res.stats && res.stats.updated > 0) {
    const fresh = await db.collection('member_card').doc(cardId).get();
    return ok({ card_id: cardId, remain_times: fresh.data.remain_times });
  }
  // 通过前置校验但条件更新 0 行：used_times < times，数据异常
  return fail(
    BIZ.TIMES_INSUFFICIENT,
    `已核销次数不足（used_times=${card.used_times || 0}），无法退还 ${times} 次`
  );
}

// §5.18 voidCard — 整卡作废（幂等；expired 不作废，返回实际状态）
async function voidCard(event) {
  const { db } = common.getContext();
  const p = (event && event.payload) || {};
  const { card_id: cardId, reason } = p;
  if (!cardId) {
    return fail(CODE.PARAM, '参数错误：card_id 必填');
  }

  const found = await db.collection('member_card').doc(cardId).get().catch(() => null);
  const card = found && found.data;
  if (!card) {
    return fail(BIZ.CARD_NOT_FOUND, '会员卡不存在');
  }

  // 幂等：已 voided 直接成功（§5.18 ①）
  if (card.status === 'voided') {
    return ok({ card_id: cardId, status: 'voided' });
  }
  // 已 expired 不作废：状态不再变更，退款金额由 order 按退款规则计算（§5.18 ③）
  if (card.status !== 'active') {
    return ok({ card_id: cardId, status: card.status });
  }

  const remark = reason
    ? `${card.remark || ''}${card.remark ? '；' : ''}${String(reason).slice(0, 200)}`
    : card.remark || '';
  await db
    .collection('member_card')
    .where({ _id: cardId, status: 'active' })
    .update({ data: { status: 'voided', remark } });

  return ok({ card_id: cardId, status: 'voided' });
}

// ---------- 定时任务 ----------

// §5.22 expireCards — 每日 00:05 定时任务：active 且 expire_at < now → expired
async function expireCards() {
  const { db } = common.getContext();
  const _ = db.command;
  const now = Date.now();
  let total = 0;
  // 循环批量直至清零（上限防意外大集合阻塞定时器）
  for (let i = 0; i < 20; i++) {
    const res = await db
      .collection('member_card')
      .where({ status: 'active', expire_at: _.lt(now) })
      .update({ data: { status: 'expired' } });
    const updated = (res.stats && res.stats.updated) || 0;
    total += updated;
    if (updated === 0) break;
  }
  console.log('[user] expireCards 完成：本轮置过期', total, '张');
  return ok({ expired: total });
}

module.exports = {
  activateCard: wrapInternal(activateCard, 'activateCard', 'user-module §5.15'),
  deductTimes: wrapInternal(deductTimes, 'deductTimes', 'user-module §5.16'),
  restoreTimes: wrapInternal(restoreTimes, 'restoreTimes', 'user-module §5.17'),
  voidCard: wrapInternal(voidCard, 'voidCard', 'user-module §5.18'),
  expireCards,
};
