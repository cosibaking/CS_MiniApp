// actions/card.js — 会员卡会员端接口（user-module §5.8-§5.10）
// 业务错误一律直接 return fail(...)（user/index.js 路由层 catch 不识别 BizError）。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;

// user 模块业务码（user-module §5.10）
const BIZ = {
  CARD_NOT_FOUND: 1005, // 卡不存在或不属于当前用户
};

const BANNED_MSG = '账号已被封禁，如有疑问请联系俱乐部工作人员';

// ---------- 内部工具 ----------

// 由 openid 解析当前用户（profile.js 同款内联实现，user 模块无 shared.js）
async function getCurrentUser(db, cloud) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  return (found.data && found.data[0]) || null;
}

// 会员卡出参裁剪（§5.9 示例口径：期限卡不带次数字段）
function cardBrief(card, { withUsed = false } = {}) {
  const out = {
    card_id: card._id,
    card_type: card.card_type,
    card_name: card.card_name,
    expire_at: card.expire_at,
    status: card.status,
  };
  if (card.card_type === 'count') {
    out.remain_times = card.remain_times;
    out.total_times = card.total_times;
    if (withUsed) out.used_times = card.used_times || 0;
  }
  return out;
}

// ---------- Actions ----------

// §5.8 getCardShop — 购卡页在售卡种（游客亦可查看；封禁账号 1003）
async function getCardShop() {
  const { cloud, db } = common.getContext();

  try {
    const user = await getCurrentUser(db, cloud);
    if (user && user.status === 'banned') {
      return fail(CODE.BANNED, BANNED_MSG, { banned: true });
    }
  } catch (e) {
    console.warn('[getCardShop] 登录态解析失败（按游客继续）', e);
  }

  const res = await db
    .collection('card_product')
    .where({ status: 'on' })
    .orderBy('sort', 'asc')
    .limit(50)
    .get();

  const list = (res.data || []).map((p) => {
    // 种子/运营配置字段为 discount_percent，出参契约名 theme_discount_percent（§5.8 示例）
    const themeDiscount = p.card_type === 'period' ? p.discount_percent || null : null;
    const benefit =
      p.card_type === 'count'
        ? `常规对抗赛${p.times}场，购买后${p.valid_months}个月内有效`
        : `期限内常规对抗赛免费${themeDiscount ? `，主题赛事${themeDiscount / 10}折` : ''}`;
    return {
      product_id: p._id,
      card_type: p.card_type,
      name: p.name,
      times: p.card_type === 'count' ? p.times : null,
      valid_months: p.card_type === 'count' ? p.valid_months : null,
      period_months: p.card_type === 'period' ? p.period_months : null,
      price: p.price,
      theme_discount_percent: themeDiscount,
      benefit_desc: benefit,
    };
  });

  return ok({ list });
}

// §5.9 getMyCards — 我的会员卡：有效卡 / 历史卡分组
async function getMyCards() {
  const { cloud, db } = common.getContext();
  const user = await getCurrentUser(db, cloud);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, BANNED_MSG, { banned: true });
  }

  const now = Date.now();
  const res = await db.collection('member_card').where({ user_id: user._id }).limit(100).get();

  const activeCards = [];
  const historyCards = [];
  (res.data || []).forEach((c) => {
    // R12：实时校验（定时器可能滞后）；count 卡用完即入历史
    const isActive =
      c.status === 'active' &&
      (c.expire_at || 0) > now &&
      !(c.card_type === 'count' && (c.remain_times || 0) <= 0);
    if (isActive) activeCards.push(cardBrief(c));
    else historyCards.push(cardBrief(c, { withUsed: true }));
  });

  // R9：先到期先用 → expire_at 升序；同到期时间次卡余次少在前
  activeCards.sort((a, b) => {
    if (a.expire_at !== b.expire_at) return a.expire_at - b.expire_at;
    const ra = a.card_type === 'count' ? a.remain_times : Infinity;
    const rb = b.card_type === 'count' ? b.remain_times : Infinity;
    return ra - rb;
  });
  historyCards.sort((a, b) => b.expire_at - a.expire_at);

  return ok({ active_cards: activeCards, history_cards: historyCards });
}

// §5.10 getCardDetail — 卡详情 + 核销流水（order 集合 0 元核销单）
async function getCardDetail(event) {
  const { cloud, db } = common.getContext();
  const payload = (event && event.payload) || {};
  const cardId = payload.card_id;
  if (!cardId || typeof cardId !== 'string') {
    return fail(CODE.PARAM, '参数错误：card_id 缺失');
  }

  const user = await getCurrentUser(db, cloud);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, BANNED_MSG, { banned: true });
  }

  const found = await db.collection('member_card').doc(cardId).get().catch(() => null);
  const card = found && found.data;
  if (!card || card.user_id !== user._id) {
    return fail(BIZ.CARD_NOT_FOUND, '会员卡不存在或不属于当前用户');
  }

  // 核销流水：pay_type='card_deduct' 的 0 元核销单（verifyCard 写入，倒序分页）
  let usageRecords = [];
  if (card.card_type === 'count') {
    const orders = await db
      .collection('order')
      .where({
        card_id: cardId,
        user_id: user._id,
        biz_type: 'activity_signup',
        pay_type: 'card_deduct',
      })
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();
    usageRecords = (orders.data || []).map((o) => ({
      activity_id: o.biz_id,
      activity_title: (o.snapshot && o.snapshot.title) || '活动核销',
      used_at: o.paid_at || o.created_at,
    }));
  }
  // 期限卡 usage_records 返回空数组（期限内免费无扣次流水，§5.10 ③）

  const cardOut = cardBrief(card, { withUsed: true });
  cardOut.source = card.source || null;
  cardOut.order_no = card.order_no || null;
  cardOut.activated_at = card.activated_at || null;

  return ok({ card: cardOut, usage_records: usageRecords });
}

module.exports = {
  getCardShop,
  getMyCards,
  getCardDetail,
};
