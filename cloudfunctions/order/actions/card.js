// actions/card.js — 次卡核销（payment-module §5.13）
// 权限：内部调用（activity 签到流程经 callOrderInternal，带 internal_token）
// 或持现场核验权限（checkin_activity）的工作人员直接调用。
// 职责边界：本接口只做扣次 + 0 元核销单落库；报名/签到生效（⑤）由调用方完成。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;
const S = require('./shared');
const { BIZ } = S;

// §5.13 verifyCard — 次卡扣次核销（0 元单 pay_type=card_deduct；43001/43002/43003）
async function verifyCard(event) {
  // ① 来源校验：内部调用 或 持现场核验权限的工作人员（BizError 需自行捕获，路由层不识别）
  if (!S.isInternal(event)) {
    const { OPENID } = common.getContext().cloud.getWXContext();
    let hasPermission = false;
    try {
      const auth = await common.checkPermission(OPENID, 'checkin_activity');
      hasPermission = !!auth.hasPermission;
    } catch (e) {
      hasPermission = false; // 用户不存在/被封禁时 checkPermission 抛 BizError
    }
    if (!hasPermission) return fail(CODE.FORBIDDEN, '无核验权限');
  }

  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'user_id', 'activity_id');
  if (!p.user_id || typeof p.user_id !== 'string') return fail(CODE.PARAM, '参数错误：user_id');
  if (!p.activity_id || typeof p.activity_id !== 'string') return fail(CODE.PARAM, '参数错误：activity_id');

  const now = Date.now();
  const _ = db.command;

  // ② 防重：该活动该用户已有核销流水 → 43003（0 元单 biz_type=activity_signup/pay_type=card_deduct）
  const dup = await db.collection('order').where({
    biz_type: 'activity_signup',
    pay_type: 'card_deduct',
    biz_id: p.activity_id,
    user_id: p.user_id,
  }).limit(1).get();
  if (dup.data && dup.data[0]) {
    return fail(BIZ.CARD_DUP, '该活动该用户已有核销记录');
  }

  // ③ 选卡：有效次卡（active/未过期/有余次），先扣临期（expire_at 升序取第一张，
  // 与 activity/signup 凭证补次同口径）
  const cards = await db.collection('member_card').where({
    user_id: p.user_id,
    card_type: 'count',
    status: 'active',
    expire_at: _.gt(now),
    remain_times: _.gt(0),
  }).orderBy('expire_at', 'asc').limit(1).get();
  const card = cards.data && cards.data[0];
  if (!card) return fail(BIZ.CARD_NONE, '无可用次卡');

  // 快照信息（0 元单固化；owner/活动缺失时兜底，不阻断核销）
  const [owner, activity] = await Promise.all([
    S.getDoc(db, 'user', p.user_id),
    S.getDoc(db, 'activity', p.activity_id),
  ]);
  const nickname = (owner && owner.nickname) || '会员';
  const title = (activity && activity.title) || '活动核销';

  // ④ 事务（仅 doc 操作）：member_card 复读校验 → 扣次 → 写 0 元核销订单
  //（并发扣减由事务快照冲突 commit 抛错承载，与 markPaid 同模式）
  const transaction = await db.startTransaction();
  let orderNo = null;
  try {
    const cur = await transaction.collection('member_card').doc(card._id).get();
    const curCard = cur && cur.data;
    if (!curCard || curCard.status !== 'active' || (curCard.expire_at || 0) <= now) {
      await transaction.rollback();
      return fail(BIZ.CARD_NONE, '无可用次卡');
    }
    if ((curCard.remain_times || 0) <= 0) {
      await transaction.rollback();
      return fail(BIZ.CARD_INSUFFICIENT, '次卡次数不足');
    }
    await transaction.collection('member_card').doc(card._id).update({
      data: { remain_times: _.inc(-1), used_times: _.inc(1), updated_at: now },
    });
    orderNo = S.genOrderNo();
    await transaction.collection('order').add({
      data: {
        order_no: orderNo,
        user_id: p.user_id,
        nickname,
        biz_type: 'activity_signup',
        biz_id: p.activity_id,
        team_id: null,
        items: [{
          user_id: p.user_id,
          nickname,
          enrollment_id: null,
          unit_price: 0,
          refund_status: 'none',
        }],
        snapshot: { title, card_id: card._id, unit_price: 0 },
        card_id: card._id, // 实现级冗余：user.getCardDetail usage_records 按 card_id 查询
        amount: 0,
        pay_amount: 0,
        pay_type: 'card_deduct',
        status: 'paid',
        expire_at: null,
        paid_at: now,
        closed_at: null,
        closed_reason: null,
        refunded_total: 0,
        created_at: now,
        updated_at: now,
      },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[verifyCard] 事务失败', card._id, e);
    return fail(BIZ.TX, '核销事务失败，请重试');
  }

  // ⑤ 联动报名/签到生效：由调用方完成（内部调用方拿到成功返回后继续签到流程）。
  // ⑥ 返回剩余次数（扣减后）
  return ok({
    order_no: orderNo,
    pay_type: 'card_deduct',
    card_id: card._id,
    remain_times: (card.remain_times || 1) - 1,
    status: 'paid',
  });
}

module.exports = {
  verifyCard,
};
