// actions/view.js — 会员端只读接口（activity-module §5.1/§5.3/§5.4/§5.5）
// 本文件为普通 handler：业务错误一律直接 return fail(...)（activity/index.js 路由层 catch 不识别 BizError）
const common = require('@club/admin-common');
const { ok, fail, CODE, rankOf, RANKS } = common;
const S = require('./shared');
const { BIZ } = S;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePaging(p) {
  const page = Math.max(1, parseInt(p.page, 10) || 1);
  const pageSize = Math.min(S.PAGE_SIZE_MAX, Math.max(1, parseInt(p.page_size, 10) || 10));
  return { page, pageSize };
}

// 活动列表（§5.1.1）：仅可见状态，精简字段，start_time 升序
async function list(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const { page, pageSize } = parsePaging(p);
  const _ = db.command;

  const where = { status: _.in(S.VISIBLE_STATUSES) };
  if (p.type) {
    if (!S.ACTIVITY_TYPES.includes(p.type)) return fail(CODE.PARAM, '参数错误：type 取值不合法');
    where.type = p.type;
  }
  if (p.status) {
    if (!S.VISIBLE_STATUSES.includes(p.status)) return fail(CODE.PARAM, '参数错误：status 取值不合法');
    where.status = p.status; // 单一状态精筛（默认混合可见状态）
  }
  if (p.keyword) {
    if (typeof p.keyword !== 'string' || !p.keyword.trim() || p.keyword.length > 30) {
      return fail(CODE.PARAM, '参数错误：keyword');
    }
    where.title = db.RegExp({ regexp: escapeRegExp(p.keyword.trim()), options: 'i' });
  }

  const total = (await db.collection('activity').where(where).count()).total || 0;
  const res = await db.collection('activity').where(where)
    .orderBy('start_time', p.order === 'start_time_desc' ? 'desc' : 'asc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .field({
      title: true, type: true, cover: true,
      start_time: true, end_time: true, signup_deadline: true,
      price: true, max_num: true, remain_num: true, status: true,
    })
    .get();
  return ok({ total, page, page_size: pageSize, list: res.data });
}

// 活动详情（§5.1.2）：全量字段 + 本人报名态（含候补位次）+ finished 汇总
async function detail(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  if (!p.activity_id || typeof p.activity_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  const _ = db.command;

  const data = { activity };

  // my_enrollment：仅登录态（未登录 null）
  const user = await S.getCurrentUser(cloud, db);
  if (user) {
    const res = await db.collection('activity_enrollment')
      .where({ activity_id: activity._id, user_id: user._id, status: _.in(S.ENROLLMENT_ACTIVE_STATUSES) })
      .orderBy('created_at', 'desc').limit(1).get();
    const mine = res.data[0] || null;
    data.my_enrollment = mine ? {
      enrollment_id: mine._id,
      status: mine.status,
      pay_type: mine.pay_type,
      order_id: mine.order_id || null,
      expire_at: mine.expire_at || null,
      position: await S.getWaitlistPosition(db, activity._id, mine),
    } : null;
  } else {
    data.my_enrollment = null;
  }

  // finished 汇总（评价摘要 / 相册数；战绩 Top10 属 M2）
  if (activity.status === 'finished') {
    const revRes = await db.collection('activity_review')
      .where({ activity_id: activity._id, status: 'published' }).limit(500).get();
    const stars = revRes.data.map((r) => r.stars || 0).filter((s) => s > 0);
    data.review_summary = stars.length
      ? {
        avg_stars: Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10,
        count: stars.length,
      }
      : { avg_stars: null, count: 0 };
    data.album_count = (await db.collection('activity_album').where({ activity_id: activity._id }).count()).total || 0;
    // 单场战绩榜（§5.1.2 ③）：kills 前十 + 荣誉名单（从各记录 honors 聚合；报名上限内 ≤500，limit 1000 兜底）
    const stRes = await db.collection('activity_stats')
      .where({ activity_id: activity._id })
      .orderBy('kills', 'desc').limit(1000).get();
    const stats = stRes.data;
    const honors = { mvp: [], svp: [], best_heal: [], best_supply: [], best_capture: [] };
    for (const s of stats) {
      for (const h of s.honors || []) {
        if (honors[h] !== undefined && s.nickname) honors[h].push(s.nickname);
      }
    }
    data.stats_summary = {
      total: stats.length,
      top10: stats.slice(0, 10).map((s) => ({
        user_id: s.user_id,
        nickname: s.nickname || '',
        kills: s.kills || 0,
        deaths: s.deaths || 0,
        is_win: s.is_win === true,
        honors: s.honors || [],
      })),
      honors,
    };
  }

  return ok(data);
}

// 我的报名（§5.1.7）：user_id 过滤，created_at 倒序，候补位次实时计算
async function myEnrollments(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  const { page, pageSize } = parsePaging(p);
  const _ = db.command;

  const where = { user_id: user._id };
  const ALL = ['pending', 'enrolled', 'waitlist', 'checked_in', 'completed', 'cancelled'];
  if (p.status) {
    const arr = Array.isArray(p.status) ? p.status : [p.status];
    for (const s of arr) {
      if (!ALL.includes(s)) return fail(CODE.PARAM, '参数错误：status 取值不合法');
    }
    where.status = _.in(arr);
  }

  const total = (await db.collection('activity_enrollment').where(where).count()).total || 0;
  const res = await db.collection('activity_enrollment').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .get();

  // 附 order_no（待支付项「去支付」跳收银台用，payment-module §2 页面2：cashier 按 order_no 拉起）
  const orderIds = res.data.map((e) => e.order_id).filter(Boolean);
  const orderNoMap = {};
  if (orderIds.length) {
    const ordRes = await db.collection('order').where({ _id: _.in(orderIds) })
      .field({ order_no: true }).limit(orderIds.length).get();
    for (const o of ordRes.data) orderNoMap[o._id] = o.order_no || null;
  }

  const list = [];
  for (const e of res.data) {
    list.push({
      _id: e._id,
      activity_id: e.activity_id,
      activity_title: e.activity_title || '',
      activity_cover: e.activity_cover || '',
      activity_start_time: e.activity_start_time || null,
      status: e.status,
      pay_type: e.pay_type,
      price_snapshot: e.price_snapshot || null,
      order_id: e.order_id || null,
      order_no: e.order_id ? orderNoMap[e.order_id] || null : null,
      expire_at: e.expire_at || null,
      checkin_time: e.checkin_time || null,
      cancel_type: e.cancel_type || null,
      created_at: e.created_at,
      waitlist_position: e.status === 'waitlist' ? await S.getWaitlistPosition(db, e.activity_id, e) : null,
    });
  }
  return ok({ total, page, page_size: pageSize, list });
}

// 我的战绩汇总（§5.1.8，§3.9.5 聚合口径）：全量聚合本人 activity_stats；军衔块读 user 冗余字段（R15，不实时聚合）
async function myStats() {
  const { cloud, db } = common.getContext();
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  // 单场一条记录（upsert 键 activity_id+user_id，§6.3），limit 1000 覆盖常规体量
  const res = await db.collection('activity_stats')
    .where({ user_id: user._id }).limit(1000).get();

  let totalMatches = 0;
  let wins = 0;
  let kills = 0, deaths = 0, heals = 0, supplies = 0, captures = 0;
  const honorCounts = { mvp: 0, svp: 0, best_heal: 0, best_supply: 0, best_capture: 0 };
  for (const s of res.data) {
    totalMatches += 1;
    if (s.is_win === true) wins += 1;
    kills += s.kills || 0;
    deaths += s.deaths || 0;
    heals += s.heals || 0;
    supplies += s.supplies || 0;
    captures += s.captures || 0;
    for (const h of s.honors || []) {
      if (honorCounts[h] !== undefined) honorCounts[h] += 1;
    }
  }

  // 胜率=胜场/总场次，百分比保留 1 位；无记录置 null（与 detail avg_stars 同口径）
  const winRate = totalMatches ? Math.round((wins / totalMatches) * 1000) / 10 : null;
  // K/D 保留 2 位；阵亡为 0 时取击杀数（§3.9.5 建议）
  const kd = deaths > 0 ? Math.round((kills / deaths) * 100) / 100 : kills;

  // 军衔块：读 user 冗余字段（R15 口径），rankOf 换算 + 下一档双门槛（少将封顶无下一档 → null）
  const totalKills = user.total_kills || 0;
  const totalWins = user.total_wins || 0;
  const current = rankOf(totalKills, totalWins);
  const idx = RANKS.findIndex((r) => r.key === current.key);
  const next = idx >= 0 && idx < RANKS.length - 1 ? RANKS[idx + 1] : null;

  return ok({
    total_matches: totalMatches,
    wins,
    losses: totalMatches - wins,
    win_rate: winRate,
    total_kills: kills,
    total_deaths: deaths,
    kd,
    total_heals: heals,
    total_supplies: supplies,
    total_captures: captures,
    honor_counts: honorCounts,
    rank: {
      key: current.key,
      name: current.name,
      total_kills: totalKills,
      total_wins: totalWins,
      next_thresholds: next ? { total_kills: next.kills, total_wins: next.wins } : null,
    },
  });
}

// 活动相册浏览（§5.1.9）：登录可见，status=normal（archived 已隐藏），created_at 倒序分页
// 附加 image_total/video_total：管理端相册管理页容量进度需分类型计数（对会员端无害的冗余字段）
async function albumList(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  if (!p.activity_id || typeof p.activity_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：activity_id');
  }
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) return fail(BIZ.NOT_FOUND, '活动不存在');
  const { page, pageSize } = parsePaging(p);

  const baseWhere = { activity_id: p.activity_id, status: 'normal' };
  const total = (await db.collection('activity_album').where(baseWhere).count()).total || 0;
  const imageTotal = (await db.collection('activity_album')
    .where({ activity_id: p.activity_id, status: 'normal', media_type: 'image' }).count()).total || 0;
  const res = await db.collection('activity_album').where(baseWhere)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .field({ file_id: true, media_type: true, size: true, created_at: true })
    .get();
  return ok({
    activity_title: activity.title, // 冗余快照直读活动（相册页头部，§6.5）
    activity_cover: activity.cover || '',
    total,
    page,
    page_size: pageSize,
    image_total: imageTotal,
    video_total: total - imageTotal,
    list: res.data,
  });
}

module.exports = { list, detail, myEnrollments, myStats, albumList };
