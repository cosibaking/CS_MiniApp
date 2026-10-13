// actions/admin.js — 用户模块管理端接口（user-module §5.20-§5.24）
// 全部走 wrapAdminAction：权限硬校验 + 审计日志（admin-module §5.18；查询类 R9 不埋点）
// 动态埋点约定：handler 把变更前后快照挂到 event._logBefore / event._logAfter，
//   业务明细挂 event._logDetail，由各 action 的 detail 函数合并读取（wrap.js）
const common = require('@club/admin-common');
const {
  wrapAdminAction, BizError, CODE,
  assertParam, assertEnum, assertPositiveInt, assertString,
  decryptField, hashField, levelOf, RANKS,
} = common;

// 模块业务错误码（user-module §5.26）
const BIZ = {
  NOT_FOUND: 1005,           // 目标资源不存在（用户/会员卡）
  CARD_STATE: 2007,          // 会员卡状态不支持该调整
  ROLE_NOT_FOUND: 2009,      // 目标角色不存在
  OPERATION_FORBIDDEN: 2010, // 不允许的操作对象（本人/最后一名管理员）
};

const PHONE_RE = /^1\d{10}$/;
const DAY_MS = 86400000;

// ---------- 公共辅助 ----------

function payloadOf(event) {
  return (event && event.payload) || {};
}

// detail 埋点：_logDetail（业务明细）+ _logBefore/_logAfter（变更前后快照，§5.22/§5.24）
function detailFromEvent(event) {
  return Object.assign({}, event._logDetail || {}, {
    before: event._logBefore || null,
    after: event._logAfter || null,
  });
}

// 正则转义（昵称模糊搜索，防注入特殊字符）
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 用户读取（§5.21/§5.22/§5.23：不存在 → 1005）
async function getUserById(db, userId) {
  const res = await db.collection('user').where({ _id: userId }).limit(1).get();
  const user = res.data && res.data[0];
  if (!user) throw new BizError(BIZ.NOT_FOUND, '用户不存在');
  return user;
}

// 会员卡读取（§5.24：卡不存在 → 1005）
async function getCardById(db, cardId) {
  const res = await db.collection('member_card').where({ _id: cardId }).limit(1).get();
  const card = res.data && res.data[0];
  if (!card) throw new BizError(BIZ.NOT_FOUND, '会员卡不存在');
  return card;
}

// 防呆：不允许操作本人（§5.19；auth.operator.id 即当前操作者 user._id）
function assertNotSelf(auth, userId) {
  if (auth.operator && auth.operator.id === userId) {
    throw new BizError(BIZ.OPERATION_FORBIDDEN, '不允许对本人执行该操作');
  }
}

// 最后一名 admin 保护（§5.22：防止无人可管理）
async function countAdmins(db) {
  const res = await db.collection('user').where({ role: 'admin' }).count();
  return (res && res.total) || 0;
}

// R7 有效期：base + N 个自然月，取到期日 23:59:59.999（东八区），大月/小月/2 月末钳制
function expireAfterMonths(baseTs, months) {
  const UTC8 = 8 * 3600 * 1000;
  const d = new Date(baseTs + UTC8);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + months;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInMonth);
  return Date.UTC(y, m, day, 23, 59, 59, 999) - UTC8;
}

// 调整前后快照（§5.24：before/after 记 remain_times/expire_at/status）
function cardSnapshot(card) {
  if (!card) return null;
  return {
    card_type: card.card_type || null,
    remain_times: card.remain_times == null ? null : card.remain_times,
    expire_at: card.expire_at == null ? null : card.expire_at,
    status: card.status || null,
  };
}

// ---------- §5.20 adminList — 用户列表（user_manage） ----------

// 入参：{ keyword?, role?, status?, is_minor?, page?, page_size? }
// keyword：完整手机号（phone_hash 等值，§8.1）/ 昵称正则模糊（转义）；
// user_id 精确查询为「建议，可调」项，此处不实现（编号非连续，分页场景收益低）。
// 管理端持 user_manage，出参返回完整手机号（解密失败降级 null）。
async function adminListHandler(event) {
  const { db } = common.getContext();
  const p = payloadOf(event);

  const page = Number.isInteger(p.page) && p.page > 0 ? p.page : 1;
  const rawSize = Number.isInteger(p.page_size) && p.page_size > 0 ? p.page_size : 20;
  const pageSize = Math.min(rawSize, 50); // page_size 上限 50（§5.20）
  const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : '';

  const where = {};
  if (p.role) {
    assertString(p.role, 'role', { min: 1, max: 50 });
    where.role = p.role;
  }
  if (p.status) {
    assertEnum(p.status, ['normal', 'banned'], 'status');
    where.status = p.status;
  }
  if (p.is_minor === true || p.is_minor === false) {
    where.is_minor = p.is_minor;
  }
  if (keyword) {
    if (PHONE_RE.test(keyword)) {
      where.phone_hash = hashField(keyword); // 加密字段走哈希等值查询（架构 §8.1）
    } else {
      where.nickname = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
    }
  }

  const [cnt, res] = await Promise.all([
    db.collection('user').where(where).count(),
    db.collection('user').where(where)
      .orderBy('created_at', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  const list = (res.data || []).map((u) => ({
    user_id: u._id,
    nickname: u.nickname || '',
    avatar: u.avatar || '',
    phone: u.phone ? decryptField(u.phone) : null,
    phone_owner: u.phone_owner || 'self',
    is_minor: !!u.is_minor,
    role: u.role || 'member',
    status: u.status || 'normal',
    total_games: u.total_games || 0, // 等级由前端按 R14 表换算展示（不落库）
    created_at: u.created_at || null,
  }));
  return { total: (cnt && cnt.total) || 0, list, page, page_size: pageSize };
}

// ---------- §5.21 adminDetail — 用户详情（user_manage） ----------

// 入参：{ user_id }；出参：profile（含 level 实时换算 R14）+ cards + waivers
// 操作轨迹不在此返回，统一走 admin 模块 operation_log 查询（§5.21 模块边界）
async function adminDetailHandler(event) {
  const { db } = common.getContext();
  const userId = payloadOf(event).user_id;
  assertParam(typeof userId === 'string' && userId, 'user_id');

  const user = await getUserById(db, userId);

  const [cardRes, waiverRes] = await Promise.all([
    db.collection('member_card').where({ user_id: userId }).limit(50).get(),
    db.collection('waiver_record').where({ user_id: userId })
      .orderBy('signed_at', 'desc').limit(20).get(),
  ]);

  // 卡列表：active 优先，同状态按 expire_at 升序（与 R9 选卡口径一致）
  const cards = (cardRes.data || []).slice().sort((a, b) => {
    const activeDiff = (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1);
    if (activeDiff !== 0) return activeDiff;
    return (a.expire_at || 0) - (b.expire_at || 0);
  }).map((c) => ({
    card_id: c._id,
    card_name: c.card_name || '',
    card_type: c.card_type,
    remain_times: c.card_type === 'count' ? c.remain_times || 0 : null,
    total_times: c.card_type === 'count' ? c.total_times || 0 : null,
    used_times: c.card_type === 'count' ? c.used_times || 0 : null,
    expire_at: c.expire_at || null,
    status: c.status,
    source: c.source || 'purchase',
    remark: c.remark || null,
    activated_at: c.activated_at || null,
    created_at: c.created_at || null,
  }));

  const waivers = (waiverRes.data || []).map((w) => ({
    agreement_version: w.agreement_version || null,
    agreement_type: w.agreement_type || null,
    signed_at: w.signed_at || null,
  }));

  // level 按 R14 由 total_games 实时换算（不落库）；rank 读冗余字段（R15）
  const lv = levelOf(user.total_games);
  const rank = RANKS.find((r) => r.key === (user.rank || 'recruit')) || RANKS[0];

  return {
    profile: {
      user_id: user._id,
      nickname: user.nickname || '',
      avatar: user.avatar || '',
      phone: user.phone ? decryptField(user.phone) : null, // 完整手机号（user_manage）
      phone_owner: user.phone_owner || 'self',
      is_minor: !!user.is_minor,
      gender: user.gender === undefined ? 0 : user.gender,
      birthday: user.birthday || null,
      role: user.role || 'member',
      status: user.status || 'normal',
      total_games: user.total_games || 0,
      level: `LV${lv.level}`,
      level_name: lv.name,
      total_kills: user.total_kills || 0,
      total_wins: user.total_wins || 0,
      rank: rank.key,
      rank_name: rank.name,
      created_at: user.created_at || null,
      phone_bound_at: user.phone_bound_at || null,
      last_login_at: user.last_login_at || null,
    },
    cards,
    waivers,
  };
}

// ---------- §5.22 adminUpdateRole — 角色变更（user_role_assign） ----------

// 入参：{ user_id, role, remark? }；保护：本人（2010）/ 最后一名 admin（2010）
// 日志 detail={ user_id, before, after, remark }（§5.22）
async function adminUpdateRoleHandler(event, auth) {
  const { db } = common.getContext();
  const p = payloadOf(event);
  const userId = p.user_id;
  const role = p.role;
  const remark = typeof p.remark === 'string' ? p.remark.trim() : '';

  assertParam(typeof userId === 'string' && userId, 'user_id');
  assertString(role, 'role', { min: 1, max: 50 });
  if (remark) assertString(remark, 'remark', { max: 200 });

  const user = await getUserById(db, userId);
  assertNotSelf(auth, userId);

  // role 必须为 role_permission 已存在的 role_key（2009）
  const roleRes = await db.collection('role_permission').where({ role_key: role }).limit(1).get();
  if (!(roleRes.data && roleRes.data.length)) {
    throw new BizError(BIZ.ROLE_NOT_FOUND, '目标角色不存在');
  }

  // 最后一名 admin 保护（2010）
  if (user.role === 'admin' && role !== 'admin') {
    const admins = await countAdmins(db);
    if (admins <= 1) throw new BizError(BIZ.OPERATION_FORBIDDEN, '不允许改掉最后一名管理员');
  }

  await db.collection('user').doc(userId).update({
    data: { role, updated_at: Date.now() },
  });

  event._logBefore = user.role || null;
  event._logAfter = role;
  event._logDetail = { user_id: userId, remark: remark || null };
  return { user_id: userId, role };
}

// ---------- §5.23 adminSetStatus — 封禁/解封（user_ban） ----------

// 入参：{ user_id, status: 'normal'|'banned', reason? }；封禁必填 reason（1-200 字）
// 保护：不允许封禁本人（2010）；封禁后该用户所有请求 1003（§5.23）
async function adminSetStatusHandler(event, auth) {
  const { db } = common.getContext();
  const p = payloadOf(event);
  const userId = p.user_id;
  const status = p.status;
  const reason = typeof p.reason === 'string' ? p.reason.trim() : '';

  assertParam(typeof userId === 'string' && userId, 'user_id');
  assertEnum(status, ['normal', 'banned'], 'status');
  if (status === 'banned') assertString(reason, 'reason', { min: 1, max: 200 });

  const user = await getUserById(db, userId);
  assertNotSelf(auth, userId);

  await db.collection('user').doc(userId).update({
    data: { status, updated_at: Date.now() },
  });

  event._logBefore = user.status || null;
  event._logAfter = status;
  event._logDetail = { user_id: userId, reason: reason || null };
  return { user_id: userId, status };
}

// ---------- §5.24 adminAdjustCard — 人工调卡（user_card_adjust） ----------

// 入参按 adjust_type 分支：
//   grant：{ user_id, card_name, card_type, times?(count), valid_months?(count,默认12),
//            period_months?(period), expire_at?(覆盖,须晚于当前), remark }
//   add_times：{ card_id, times, remark }
//   extend：{ card_id, days, remark }
//   void：{ card_id, reason }（留痕即 reason）
// R13：人工调整绕过支付链路，所有分支必须留痕（日志 + remark/reason）
async function adminAdjustCardHandler(event) {
  const p = payloadOf(event);
  const adjustType = p.adjust_type;
  assertEnum(adjustType, ['grant', 'add_times', 'extend', 'void'], 'adjust_type');

  if (adjustType === 'void') {
    const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
    assertString(reason, 'reason', { min: 1, max: 200 });
    return voidCardAdmin(event, p, reason);
  }

  // 其余分支：remark 必填（R13 必须留痕）
  const remark = typeof p.remark === 'string' ? p.remark.trim() : '';
  assertString(remark, 'remark', { min: 1, max: 200 });

  if (adjustType === 'grant') return grantCard(event, p, remark);
  if (adjustType === 'add_times') return addCardTimes(event, p, remark);
  return extendCard(event, p, remark);
}

// 人工开卡：口径同 activateCard §5.15（source='admin'、order_id=null、price=null，R13 ①）
async function grantCard(event, p, remark) {
  const { db } = common.getContext();
  const userId = p.user_id;
  const cardType = p.card_type;
  const cardName = typeof p.card_name === 'string' ? p.card_name.trim() : '';

  assertParam(typeof userId === 'string' && userId, 'user_id');
  assertString(cardName, 'card_name', { min: 1, max: 50 });
  assertEnum(cardType, ['count', 'period'], 'card_type');
  await getUserById(db, userId); // 1005

  const now = Date.now();
  let expireAt;
  if (p.expire_at != null) {
    // R13 ①/③：可覆盖 expire_at，但须为晚于当前时间的毫秒时间戳
    if (!Number.isInteger(p.expire_at) || p.expire_at <= now) {
      throw new BizError(CODE.PARAM, '参数错误：expire_at 需为晚于当前时间的毫秒时间戳');
    }
    expireAt = p.expire_at;
  } else if (cardType === 'count') {
    const validMonths = p.valid_months == null ? 12 : p.valid_months; // 次卡默认 12 个月（R7）
    assertPositiveInt(validMonths, 'valid_months');
    expireAt = expireAfterMonths(now, validMonths);
  } else {
    assertPositiveInt(p.period_months, 'period_months');
    expireAt = expireAfterMonths(now, p.period_months);
  }

  const card = {
    user_id: userId,
    card_type: cardType,
    card_name: cardName,
    expire_at: expireAt,
    status: 'active',
    source: 'admin',
    order_id: null,
    price: null,
    remark,
    activated_at: now,
    created_at: now,
  };
  if (cardType === 'count') {
    assertPositiveInt(p.times, 'times');
    card.remain_times = p.times;
    card.total_times = p.times;
    card.used_times = 0;
  }

  const addRes = await db.collection('member_card').add({ data: card });
  event._logBefore = null;
  event._logAfter = cardSnapshot(card);
  event._logDetail = { adjust_type: 'grant', user_id: userId, card_id: addRes._id, remark };
  return { card_id: addRes._id };
}

// 增次：count + active（§5.24）；remain_times + times 不设上限（R13 ②）
async function addCardTimes(event, p, remark) {
  const { db } = common.getContext();
  const cardId = p.card_id;
  assertParam(typeof cardId === 'string' && cardId, 'card_id');
  assertPositiveInt(p.times, 'times');

  const card = await getCardById(db, cardId); // 1005
  if (card.card_type !== 'count') {
    throw new BizError(CODE.PARAM, '期限卡不适用增减次操作'); // R13 ⑥ → 1001
  }
  if (card.status !== 'active') {
    throw new BizError(BIZ.CARD_STATE, '会员卡状态不支持该调整'); // 2007
  }

  const _ = db.command;
  const upd = await db.collection('member_card')
    .where({ _id: cardId, card_type: 'count', status: 'active' }) // 条件更新防并发状态变更
    .update({
      data: {
        remain_times: _.inc(p.times),
        total_times: _.inc(p.times),
      },
    });
  if (!upd.stats || upd.stats.updated !== 1) {
    throw new BizError(BIZ.CARD_STATE, '会员卡状态不支持该调整');
  }

  const after = await getCardById(db, cardId);
  event._logBefore = cardSnapshot(card);
  event._logAfter = cardSnapshot(after);
  event._logDetail = { adjust_type: 'add_times', user_id: card.user_id, card_id: cardId, times: p.times, remark };
  return { card_id: cardId };
}

// 延期：expire_at + days*86400000（自然日）；expired 卡续期即复活（R13 ⑤，§5.24）
async function extendCard(event, p, remark) {
  const { db } = common.getContext();
  const cardId = p.card_id;
  assertParam(typeof cardId === 'string' && cardId, 'card_id');
  assertPositiveInt(p.days, 'days');

  const card = await getCardById(db, cardId); // 1005
  if (card.status === 'voided') {
    throw new BizError(BIZ.CARD_STATE, '已作废的卡不支持延期'); // 2007
  }

  const now = Date.now();
  const newExpire = (card.expire_at || now) + p.days * DAY_MS;
  if (newExpire <= now) {
    // R13 ③：改有效期不得早于当前时间（提前作废请用 void）
    throw new BizError(CODE.PARAM, '参数错误：延期后的有效期不得早于当前时间');
  }

  const data = { expire_at: newExpire };
  if (card.status === 'expired') data.status = 'active'; // 续期即复活
  await db.collection('member_card').doc(cardId).update({ data });

  const after = await getCardById(db, cardId);
  event._logBefore = cardSnapshot(card);
  event._logAfter = cardSnapshot(after);
  event._logDetail = { adjust_type: 'extend', user_id: card.user_id, card_id: cardId, days: p.days, remark };
  return { card_id: cardId };
}

// 作废：口径同 user/voidCard §5.18——① 幂等（已 voided 直接成功）② remark 追加 reason
// ③ 已 expired 的卡不作废（状态不再变更，此处给 2007 明确反馈）
async function voidCardAdmin(event, p, reason) {
  const { db } = common.getContext();
  const cardId = p.card_id;
  assertParam(typeof cardId === 'string' && cardId, 'card_id');

  const card = await getCardById(db, cardId); // 1005
  if (card.status === 'voided') {
    event._logSkipIdempotent = true; // 幂等返回：不重复埋点（wrap.js skipLog 设计约定）
    return { card_id: cardId, status: 'voided' };
  }
  if (card.status === 'expired') {
    throw new BizError(BIZ.CARD_STATE, '已过期的卡不再作废（状态无需变更）'); // 2007
  }

  const remark = card.remark ? `${card.remark}；${reason}` : reason;
  const upd = await db.collection('member_card')
    .where({ _id: cardId, status: 'active' }) // 条件更新：active → voided
    .update({ data: { status: 'voided', remark } });
  if (!upd.stats || upd.stats.updated !== 1) {
    throw new BizError(BIZ.CARD_STATE, '会员卡状态不支持该调整'); // 并发状态变更
  }

  event._logBefore = cardSnapshot(card);
  event._logAfter = cardSnapshot(Object.assign({}, card, { status: 'voided', remark }));
  event._logDetail = { adjust_type: 'void', user_id: card.user_id, card_id: cardId, remark: reason };
  return { card_id: cardId, status: 'voided' };
}

module.exports = {
  // §5.20 用户列表（user_manage）→ 只读不埋点（admin-module R9）
  adminList: wrapAdminAction('user.list', adminListHandler, {
    permission: 'user_manage', module: 'user', targetType: 'user', log: false,
  }),
  // §5.21 用户详情（user_manage）→ 只读不埋点（admin-module R9）
  adminDetail: wrapAdminAction('user.detail', adminDetailHandler, {
    permission: 'user_manage', module: 'user', targetType: 'user', log: false,
    targetId: (event) => payloadOf(event).user_id,
  }),
  // §5.22 角色变更（user_role_assign）→ 日志 user.role
  adminUpdateRole: wrapAdminAction('user.role', adminUpdateRoleHandler, {
    permission: 'user_role_assign', module: 'user', targetType: 'user',
    targetId: (event) => payloadOf(event).user_id,
    detail: detailFromEvent,
  }),
  // §5.23 封禁/解封（user_ban）→ 日志按目标状态区分 user.ban / user.unban
  adminSetStatus: (event, context) => {
    const action = payloadOf(event).status === 'banned' ? 'user.ban' : 'user.unban';
    return wrapAdminAction(action, adminSetStatusHandler, {
      permission: 'user_ban', module: 'user', targetType: 'user',
      targetId: (event2) => payloadOf(event2).user_id,
      detail: detailFromEvent,
    })(event, context);
  },
  // §5.24 人工调卡（user_card_adjust）→ 日志 card.adjust；幂等作废不重复埋点
  adminAdjustCard: wrapAdminAction('card.adjust', adminAdjustCardHandler, {
    permission: 'user_card_adjust', module: 'user', targetType: 'user',
    targetId: (event) => payloadOf(event).user_id,
    detail: detailFromEvent,
    skipLog: (event) => !!event._logSkipIdempotent,
  }),
};
