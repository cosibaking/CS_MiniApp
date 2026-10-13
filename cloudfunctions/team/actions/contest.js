// actions/contest.js — 战队排名与活动报名（team-module §5.17-§5.19）
const common = require('@club/admin-common');
const { CODE, ok, fail } = common;
const S = require('./shared');

const MIN_RANK_GAMES = 5; // R7 榜单最低场次门槛（§5.17 第 2 步，参数化建议值）

// activity 模块业务码（activity-module §5.0；teamSignup 回传映射用）：
// 3006 在 teamSignup 内唯一表示「名额不足」→ 40909；3009 重复报名 → 40904
const ACT_BIZ = { CONCURRENCY: 3006, DUPLICATE: 3009 };
// activity 报名进行中状态（activity-module §3.3-6 口径，本地副本）
const ENROLLMENT_ACTIVE_STATUSES = ['pending', 'enrolled', 'waitlist', 'checked_in', 'completed'];

// §5.17 ranking — 战队排行榜（登录会员；R7：胜率降序 → 场次降序 → 建队时间升序）
// 俱乐部规模量级：team_stats 门槛过滤后内存排序，再分页返回（§6.3 组合索引 win_rate+total_games）。
async function ranking(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'page', 'page_size');
  const { page, pageSize } = S.normalizePagination(p);
  const _ = db.command;

  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  // 门槛过滤（total_games ≥ 5，§5.17 第 2 步）
  const statsRes = await db.collection('team_stats')
    .where({ total_games: _.gte(MIN_RANK_GAMES) })
    .limit(1000)
    .get();
  const stats = (statsRes.data || []).filter((t) => t.team_id);

  // 联查 team：仅收录在职战队（解散出榜，§5.20⑥/R7）；分块查询（_.in 每批 ≤100）
  const teamMap = new Map();
  const ids = stats.map((t) => t.team_id);
  for (let i = 0; i < ids.length; i += 100) {
    const res = await db.collection('team')
      .where({ _id: _.in(ids.slice(i, i + 100)), status: 'normal' })
      .field({ name: true, logo: true, member_count: true, created_at: true })
      .get();
    for (const t of res.data || []) teamMap.set(t._id, t);
  }

  const rows = stats
    .filter((t) => teamMap.has(t.team_id))
    .map((t) => {
      const team = teamMap.get(t.team_id);
      return {
        team_id: t.team_id,
        name: team.name || t.team_name || '',
        logo: team.logo || '',
        win_rate: t.win_rate || 0,
        total_games: t.total_games || 0,
        wins: t.wins || 0,
        member_count: team.member_count || 0,
        created_at: team.created_at || 0,
      };
    })
    .sort((a, b) => (b.win_rate - a.win_rate)
      || (b.total_games - a.total_games)
      || (a.created_at - b.created_at));

  // my_rank：操作人所在战队在全量榜单中的名次（未上榜/未入队返回 null，§5.17 第 4 步）
  const myRank = user.active_team_id
    ? (rows.findIndex((r) => r.team_id === user.active_team_id) + 1 || null)
    : null;

  // 分页返回（内存分页）
  const total = rows.length;
  const list = rows
    .slice((page - 1) * pageSize, page * pageSize)
    .map((r, i) => ({
      rank: (page - 1) * pageSize + i + 1,
      team_id: r.team_id,
      name: r.name,
      logo: r.logo,
      win_rate: r.win_rate,
      total_games: r.total_games,
      wins: r.wins,
      member_count: r.member_count,
    }));

  return ok({ total, my_rank: myRank, page, page_size: pageSize, list });
}

// ---------- §5.18/§5.19 共用助手 ----------

// 队长校验（§5.18/§5.19 前置）：登录 + 在职战队（normal）+ 队长本人。
// 返回 { user, team } / { err }。
async function requireCaptain(cloud, db) {
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return { err: fail(CODE.UNAUTHORIZED, '请先登录') };
  if (!user.active_team_id) return { err: fail(S.BIZ.CAPTAIN_ONLY, '仅本队队长可操作') };
  const team = await S.getTeamById(db, user.active_team_id);
  if (!team || team.status !== 'normal') return { err: fail(S.BIZ.CAPTAIN_ONLY, '仅本队队长可操作') };
  if (team.captain_user_id !== user._id) return { err: fail(S.BIZ.CAPTAIN_ONLY, '仅本队队长可操作') };
  return { user, team };
}

// 批量免责协议校验（activity-module §3.3-4 口径：类型匹配 adult/minor + 最新 published 版本）。
// agreement 按 type 各取最新一条 published；waiver_record 按 user 取最新签署。
// 返回 Map<user_id, valid>。
async function getWaiverValidMap(db, users) {
  const _ = db.command;
  const out = new Map();
  if (!users.length) return out;

  const activeMap = new Map(); // agreement_type → 最新 published 协议
  const agrRes = await db.collection('agreement')
    .where({ agreement_type: _.in(['adult', 'minor']), status: 'published' })
    .orderBy('published_at', 'desc').limit(10).get();
  for (const a of agrRes.data || []) {
    if (!activeMap.has(a.agreement_type)) activeMap.set(a.agreement_type, a);
  }

  const signedMap = new Map(); // user_id → 最新签署记录
  const ids = users.map((u) => u._id);
  const recRes = await db.collection('waiver_record')
    .where({ user_id: _.in(ids) })
    .orderBy('signed_at', 'desc').limit(1000).get();
  for (const r of recRes.data || []) {
    if (!signedMap.has(r.user_id)) signedMap.set(r.user_id, r);
  }

  for (const u of users) {
    const requiredType = u.is_minor ? 'minor' : 'adult';
    const active = activeMap.get(requiredType);
    const signed = signedMap.get(u._id);
    out.set(u._id, !!(active && signed
      && signed.agreement_type === requiredType
      && signed.agreement_version === active.version));
  }
  return out;
}

// 已报名该活动的成员集合（§5.18 block_reason 判定 / §5.19 重复预检共用；单查询）
async function findEnrolledUserIds(db, activityId, userIds) {
  const _ = db.command;
  if (!userIds.length) return new Set();
  const res = await db.collection('activity_enrollment')
    .where({
      activity_id: activityId,
      user_id: _.in(userIds),
      status: _.in(ENROLLMENT_ACTIVE_STATUSES),
    })
    .field({ user_id: true })
    .get();
  return new Set((res.data || []).map((r) => r.user_id));
}

// 本队在职成员记录（created_at 升序 = 入队顺序；上限 MEMBER_LIMIT）
async function listActiveMembers(db, teamId) {
  const res = await db.collection('team_member')
    .where({ team_id: teamId, status: 'active' })
    .orderBy('created_at', 'asc')
    .limit(S.MEMBER_LIMIT)
    .get();
  return res.data || [];
}

// §5.18 enrollable-members — 可报名成员列表（队长）
// 逐成员标记 enrollable / block_reason（已报名该活动 → 未签免责协议 → 未绑定手机号）；
// 已报名仅标记不算错误（列表可见，提交时由 activity 侧兜底 40904）。
async function enrollableMembers(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'activity_id');
  if (!p.activity_id || typeof p.activity_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：activity_id');
  }

  const cap = await requireCaptain(cloud, db);
  if (cap.err) return cap.err;
  const { team } = cap;

  const activity = await S.getDoc(db, 'activity', p.activity_id);
  if (!activity || activity.status !== 'published') {
    return fail(CODE.PARAM, '活动不存在或未开放报名');
  }

  // 在职成员 + 用户文档 + 已报名集合 + 协议状态（各一次批量查询）
  const records = await listActiveMembers(db, team._id);
  const userIds = records.map((r) => r.user_id);
  const userMap = await S.fetchUserMap(db, userIds);
  const enrolledSet = await findEnrolledUserIds(
    db, activity._id, userIds.filter((id) => userMap.has(id))
  );
  const waiverMap = await getWaiverValidMap(db, [...userMap.values()]);

  const list = records.map((r) => {
    const u = userMap.get(r.user_id);
    let enrollable = !!u;
    let blockReason = null;
    if (!u) {
      enrollable = false;
      blockReason = '用户不存在或已注销';
    } else if (enrolledSet.has(r.user_id)) {
      enrollable = false;
      blockReason = '已报名该活动';
    } else if (!waiverMap.get(r.user_id)) {
      enrollable = false;
      blockReason = '未签免责协议';
    } else if (!u.phone) {
      enrollable = false;
      blockReason = '未绑定手机号';
    }
    return {
      user_id: r.user_id,
      nickname: (u && u.nickname) || r.nickname || '',
      avatar: (u && u.avatar) || r.avatar || '',
      role: r.role || 'member',
      enrollable,
      block_reason: blockReason,
    };
  });

  return ok({ activity_left_quota: activity.remain_num || 0, list });
}

// §5.19 enroll-submit — 以战队名义提交活动报名（队长；批量订单支付人=队长）
// 预检（在职/重复/协议/手机号/名额）通过后调 activity 内部 teamSignup
// （S1 批量扣名额 + 事务直建 N 条报名与 1 张批量订单，activity-module §3.4/§4.5）。
// 回传码映射：3006 名额不足 → 40909；3009 重复 → 40904；null（互调失败）→ 50001；其余透传。
async function enrollSubmit(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'activity_id', 'member_user_ids');
  if (!p.activity_id || typeof p.activity_id !== 'string') {
    return fail(CODE.PARAM, '参数错误：activity_id');
  }
  const memberIds = [...new Set((Array.isArray(p.member_user_ids) ? p.member_user_ids : []).filter(
    (id) => id && typeof id === 'string'
  ))];
  if (!memberIds.length) return fail(CODE.PARAM, '参数错误：member_user_ids');

  const cap = await requireCaptain(cloud, db);
  if (cap.err) return cap.err;
  const { user, team } = cap;

  // 活动预检（§5.19：状态/截止；剩余名额须 ≥ 报名人数）
  const activity = await S.getDoc(db, 'activity', p.activity_id);
  if (!activity || activity.type === 'custom' || activity.status !== 'published'
    || (activity.signup_deadline || 0) <= Date.now()) {
    return fail(CODE.PARAM, '活动不在报名中');
  }
  if ((activity.remain_num || 0) < memberIds.length) {
    return fail(S.BIZ.QUOTA_SHORT, '活动名额不足');
  }

  // ① 全员须为本队在职成员（40402）
  const records = await listActiveMembers(db, team._id);
  const memberSet = new Set(records.map((r) => r.user_id));
  if (!memberIds.every((id) => memberSet.has(id))) {
    return fail(S.BIZ.RECORD_NOT_FOUND, '存在非本队在职成员');
  }

  // ② 重复报名预检（40904，点名提示）
  const userMap = await S.fetchUserMap(db, memberIds);
  const enrolledSet = await findEnrolledUserIds(db, activity._id, memberIds);
  if (enrolledSet.size) {
    const names = memberIds
      .filter((id) => enrolledSet.has(id))
      .map((id) => { const u = userMap.get(id); return (u && u.nickname) || '成员'; })
      .slice(0, 5);
    return fail(S.BIZ.DUP_PENDING, `以下成员已报名该活动：${names.join('、')}`);
  }

  // ③ 协议/手机号兜底（§5.18 列表已标注，提交时强校验；文档 40001 → CODE.PARAM）
  const waiverMap = await getWaiverValidMap(db, [...userMap.values()]);
  for (const id of memberIds) {
    const u = userMap.get(id);
    if (!u) return fail(CODE.PARAM, '部分成员不存在或已注销');
    if (!waiverMap.get(id)) {
      return fail(CODE.PARAM, `成员「${u.nickname || '未知'}」未签署免责协议`);
    }
    if (!u.phone) {
      return fail(CODE.PARAM, `成员「${u.nickname || '未知'}」未绑定手机号`);
    }
  }

  // ④ activity 内部批量报名（名额事务 + 批量订单直建；支付人=队长）
  const r = await S.callActivityInternal(cloud, 'teamSignup', {
    activity_id: activity._id,
    team_id: team._id,
    payer_user_id: user._id,
    user_ids: memberIds,
  });
  if (!r.ok) {
    if (r.code === ACT_BIZ.CONCURRENCY) return fail(S.BIZ.QUOTA_SHORT, r.msg || '活动名额不足');
    if (r.code === ACT_BIZ.DUPLICATE) return fail(S.BIZ.DUP_PENDING, r.msg || '部分成员已报名该活动');
    if (r.code === null || r.code === undefined) return fail(CODE.INTERNAL, r.msg || '报名失败，请稍后重试');
    return fail(r.code, r.msg || '报名失败，请稍后重试');
  }

  const d = r.data || {};
  return ok({
    order_no: d.order_no || null,
    enrollment_ids: d.enrollment_ids || [],
    expire_at: d.expire_at || null,
  });
}

module.exports = {
  // §5.17 ranking — 战队排行榜（登录会员）
  ranking,
  // §5.18 enrollable-members — 可报名成员列表（队长）
  'enrollable-members': enrollableMembers,
  // §5.19 enroll-submit — 以战队名义提交活动报名（队长）
  'enroll-submit': enrollSubmit,
};
