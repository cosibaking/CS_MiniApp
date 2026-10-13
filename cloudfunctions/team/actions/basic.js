// actions/basic.js — 战队基础接口（team-module §5.1-§5.5）
// create / list / detail / my / update；事务与公共助手见 ./shared。
const common = require('@club/admin-common');
const S = require('./shared');
const { CODE, ok, fail } = common;

// 关键词转义（与 activity view/manage 的 db.RegExp 包含匹配同法）
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// §5.1 create — 创建战队（进入 pending 待审核）
async function create(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'name', 'logo', 'slogan', 'intro');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.name || !p.logo) return fail(CODE.PARAM, '队名与队徽不能为空');

  const err = S.validateTeamProfile(p);
  if (err) return fail(CODE.PARAM, err);
  const name = String(p.name).trim();

  // CP-1：无在职战队（user 冗余 + team_member 双保险）
  if (user.active_team_id || (await S.getActiveMembership(db, user._id))) {
    return fail(S.BIZ.ALREADY_IN_TEAM, '须先退出当前战队后才能创建新战队');
  }
  // 无审核中的创建申请
  const pendingRes = await db.collection('team')
    .where({ captain_user_id: user._id, status: 'pending' })
    .orderBy('created_at', 'desc').limit(1).get();
  if ((pendingRes.data || []).length) {
    return fail(S.BIZ.DUP_PENDING, '已有战队在审核中，请耐心等待');
  }

  // R1 被拒重提：本人最新 rejected 战队走原记录重新提交（清空审核痕迹置回 pending）
  const rejectedRes = await db.collection('team')
    .where({ captain_user_id: user._id, status: 'rejected' })
    .orderBy('updated_at', 'desc').limit(1).get();
  const rejectedTeam = (rejectedRes.data || [])[0] || null;

  // R9 队名软唯一（重提时排除自身记录）
  if (await S.isNameTaken(db, name, rejectedTeam ? rejectedTeam._id : undefined)) {
    return fail(S.BIZ.NAME_TAKEN, '队名已被使用，请换一个');
  }

  const now = Date.now();
  const fields = {
    name,
    logo: p.logo,
    slogan: p.slogan !== undefined && p.slogan !== null ? String(p.slogan) : null,
    intro: p.intro !== undefined && p.intro !== null ? String(p.intro) : null,
  };

  if (rejectedTeam) {
    await db.collection('team').doc(rejectedTeam._id).update({
      data: {
        ...fields,
        status: 'pending',
        reject_reason: null,
        auditor_id: null,
        auditor_name: null,
        audit_at: null,
        updated_at: now,
      },
    });
    return ok({ team_id: rejectedTeam._id, status: 'pending', resubmitted: true });
  }

  // 新建（此时不写 team_member，审核通过才生效，§5.1 第 4 步）
  const addRes = await db.collection('team').add({
    data: {
      ...fields,
      captain_user_id: user._id,
      captain_name: user.nickname || '',
      member_count: 0,
      status: 'pending',
      reject_reason: null,
      auditor_id: null,
      auditor_name: null,
      audit_at: null,
      created_at: now,
      updated_at: now,
    },
  });
  return ok({ team_id: addRes._id, status: 'pending' });
}

// §5.2 list — 战队列表 / 搜索（仅 normal；member_count 降序 + created_at 升序）
async function list(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'keyword', 'page', 'page_size');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  const { page, pageSize } = S.normalizePagination(p);
  const where = { status: 'normal' };
  const kw = p.keyword !== undefined && p.keyword !== null ? String(p.keyword).trim() : '';
  if (kw) where.name = db.RegExp({ regexp: escapeRegExp(kw), options: 'i' });

  const [countRes, listRes] = await Promise.all([
    db.collection('team').where(where).count(),
    db.collection('team').where(where)
      .orderBy('member_count', 'desc')
      .orderBy('created_at', 'asc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  const teams = listRes.data || [];
  const _ = db.command;
  const statsMap = new Map();
  if (teams.length) {
    const statsRes = await db.collection('team_stats')
      .where({ _id: _.in(teams.map((t) => t._id)) }).get();
    for (const st of (statsRes.data || [])) statsMap.set(st._id, st);
  }

  return ok({
    total: countRes.total,
    page,
    page_size: pageSize,
    list: teams.map((t) => {
      const st = statsMap.get(t._id);
      return {
        team_id: t._id,
        name: t.name,
        logo: t.logo,
        slogan: t.slogan,
        member_count: t.member_count || 0,
        win_rate: st && st.win_rate !== undefined && st.win_rate !== null ? st.win_rate : null,
        captain_name: t.captain_name,
      };
    }),
  });
}

// §5.3 detail — 战队详情（pending/rejected/dissolved 仅创建者可见，否则按 40401 处理）
async function detail(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  const isCreator = team.captain_user_id === user._id;
  if (team.status !== 'normal' && !isCreator) {
    return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  }

  // 战绩（P0 常态无记录 → null，前端显示「暂无战绩」）
  const stats = await S.getDoc(db, 'team_stats', team._id);

  // members_preview：队长置顶 + 其余按 joined_at（共 ≤10，§5.3 第 4 步）
  const [captainRes, membersRes] = await Promise.all([
    db.collection('team_member')
      .where({ team_id: team._id, user_id: team.captain_user_id, status: 'active' })
      .limit(1)
      .get(),
    db.collection('team_member')
      .where({ team_id: team._id, status: 'active', role: 'member' })
      .orderBy('joined_at', 'asc')
      .limit(9)
      .get(),
  ]);
  const previewRecords = [
    ...(captainRes.data || []).map((r) => ({ ...r, role: 'captain' })),
    ...(membersRes.data || []),
  ];

  // rank 军衔读时批量联查 user（R15 口径，不落 team_member 冗余）
  const userMap = await S.fetchUserMap(db, previewRecords.map((r) => r.user_id));
  const members_preview = previewRecords.map((r) => {
    const u = userMap.get(r.user_id);
    return {
      user_id: r.user_id,
      nickname: (u && u.nickname) || r.nickname || '',
      avatar: (u && u.avatar) || r.avatar || '',
      role: r.role,
      rank: (u && u.rank) || 'recruit',
      joined_at: r.joined_at || null,
    };
  });

  const captainUser = userMap.get(team.captain_user_id);
  const captainRecord = (captainRes.data || [])[0];
  const captainAvatar = (captainUser && captainUser.avatar)
    || (captainRecord && captainRecord.avatar) || '';

  // my_relation：user.active_team_id + 本队最新 team_member 记录（§5.3 第 5 步）
  const activeRecord = await S.getActiveMembership(db, user._id);
  const inTeam = !!(activeRecord && activeRecord.team_id === team._id)
    || user.active_team_id === team._id;
  let memberStatus = null;
  if (inTeam) {
    memberStatus = 'active';
  } else {
    const latestRes = await db.collection('team_member')
      .where({ team_id: team._id, user_id: user._id })
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    const latest = (latestRes.data || [])[0];
    if (latest) memberStatus = latest.status;
  }

  const teamOut = {
    team_id: team._id,
    name: team.name,
    logo: team.logo,
    slogan: team.slogan,
    intro: team.intro,
    captain_user_id: team.captain_user_id,
    captain_name: team.captain_name,
    captain_avatar: captainAvatar,
    member_count: team.member_count || 0,
    status: team.status,
    created_at: team.created_at || null,
  };
  if (isCreator) teamOut.reject_reason = team.reject_reason || null;

  return ok({
    team: teamOut,
    stats: stats ? {
      total_games: stats.total_games || 0,
      wins: stats.wins || 0,
      win_rate: stats.win_rate !== undefined && stats.win_rate !== null ? stats.win_rate : null,
      participated_members: stats.participated_members || 0,
    } : null,
    members_preview,
    my_relation: {
      in_team: inTeam,
      role: activeRecord && activeRecord.team_id === team._id ? activeRecord.role : null,
      member_status: memberStatus,
    },
    recent_activities: [],   // P1 起由活动模块透传聚合
  });
}

// §5.4 my — 我的战队关系聚合（四块均可 null/空数组）
async function my(event) {
  const { cloud, db } = common.getContext();
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  const _ = db.command;

  // active_team：user.active_team_id 直查 + team_member 双保险（§6.4）
  const activeRecord = await S.getActiveMembership(db, user._id);
  const teamId = user.active_team_id || (activeRecord && activeRecord.team_id) || null;
  let active_team = null;
  if (teamId) {
    const team = await S.getTeamById(db, teamId);
    if (team && team.status === 'normal') {
      const stats = await S.getDoc(db, 'team_stats', team._id);
      active_team = {
        team_id: team._id,
        name: team.name,
        logo: team.logo,
        role: (activeRecord && activeRecord.team_id === team._id && activeRecord.role) || 'member',
        member_count: team.member_count || 0,
        win_rate: stats && stats.win_rate !== undefined && stats.win_rate !== null ? stats.win_rate : null,
      };
    }
  }

  // creating：审核中/被拒（含 reject_reason，供创建页「重新提交」引导）
  const creatingRes = await db.collection('team')
    .where({ captain_user_id: user._id, status: _.in(['pending', 'rejected']) })
    .orderBy('updated_at', 'desc')
    .limit(1)
    .get();
  const creatingTeam = (creatingRes.data || [])[0] || null;

  // applying / invited：未处理记录（冗余 team_name 直接展示）
  const [applyingRes, invitedRes] = await Promise.all([
    db.collection('team_member')
      .where({ user_id: user._id, status: 'applying' })
      .orderBy('created_at', 'desc')
      .limit(10)
      .get(),
    db.collection('team_member')
      .where({ user_id: user._id, status: 'invited' })
      .orderBy('created_at', 'desc')
      .limit(10)
      .get(),
  ]);

  return ok({
    active_team,
    creating: creatingTeam ? {
      team_id: creatingTeam._id,
      name: creatingTeam.name,
      status: creatingTeam.status,
      reject_reason: creatingTeam.status === 'rejected' ? (creatingTeam.reject_reason || null) : null,
    } : null,
    applying: (applyingRes.data || []).map((r) => ({
      record_id: r._id,
      team_id: r.team_id,
      team_name: r.team_name,
      applied_at: r.created_at || null,
    })),
    invited: (invitedRes.data || []).map((r) => ({
      record_id: r._id,
      team_id: r.team_id,
      team_name: r.team_name,
      invited_at: r.created_at || null,
    })),
  });
}

// §5.5 update — 队长更新战队资料（不改变状态与人数；旧队徽不删除）
async function update(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'name', 'logo', 'slogan', 'intro');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');

  const data = {};
  for (const k of ['name', 'logo', 'slogan', 'intro']) {
    if (p[k] !== undefined) data[k] = p[k];
  }
  if (!Object.keys(data).length) return fail(CODE.PARAM, '无可更新字段');

  const err = S.validateTeamProfile(data);
  if (err) return fail(CODE.PARAM, err);
  if (data.name !== undefined) data.name = String(data.name).trim();
  if (data.slogan !== undefined && data.slogan !== null) data.slogan = String(data.slogan);
  if (data.intro !== undefined && data.intro !== null) data.intro = String(data.intro);

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (team.captain_user_id !== user._id) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可修改战队资料');
  if (team.status !== 'normal') return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');

  // R9 队名唯一（仅变更时校验，排除自身）
  const nameChanged = data.name !== undefined && data.name !== team.name;
  if (nameChanged && (await S.isNameTaken(db, data.name, team._id))) {
    return fail(S.BIZ.NAME_TAKEN, '队名已被使用，请换一个');
  }

  // 事务复核队长 + normal 后更新
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    const fresh = (await transaction.collection('team').doc(team._id).get()).data;
    if (!fresh || fresh.captain_user_id !== user._id) {
      await transaction.rollback();
      return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可修改战队资料');
    }
    if (fresh.status !== 'normal') {
      await transaction.rollback();
      return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');
    }
    await transaction.collection('team').doc(team._id).update({
      data: { ...data, updated_at: now },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[team/update] 事务失败', team._id, e);
    return fail(CODE.INTERNAL, '操作冲突，请稍后重试');
  }

  // 冗余同步（§6.5）：队名变更 → team_member.team_name 同步（单队 ≤100 条量小）；
  // team_stats.team_name fire-and-forget（P0 无 stats 记录，容忍失败）；
  // activity_enrollment 回刷待 P1 活动报名落地后接入。
  if (nameChanged) {
    try {
      await db.collection('team_member').where({ team_id: team._id })
        .update({ data: { team_name: data.name } });
    } catch (e) {
      console.warn('[team/update] team_member 冗余同步失败（不阻断）', e);
    }
    setImmediate(async () => {
      try {
        await db.collection('team_stats').doc(team._id)
          .update({ data: { team_name: data.name } });
      } catch (e) { /* 无 stats 记录时忽略 */ }
    });
  }

  return ok({ updated_fields: Object.keys(data) });
}

module.exports = { create, list, detail, my, update };
