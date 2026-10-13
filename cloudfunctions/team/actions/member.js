// actions/member.js — 战队成员管理（team-module §5.6-§5.14）
// 申请/邀请双路径、成员列表、移除/退出、转让队长；入队离队事务见 ./shared。
const common = require('@club/admin-common');
const S = require('./shared');
const { CODE, ok, fail, hashField, maskPhone, decryptField } = common;

// 队长校验（40302）：返回 team 或 null（战队不存在时已先行返回 40401）
function assertCaptain(team, user) {
  if (team.captain_user_id !== user._id) return false;
  return true;
}

// §5.6 join-apply — 提交入队申请（申请路径）
async function joinApply(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'apply_note');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');
  if (p.apply_note !== undefined && p.apply_note !== null && String(p.apply_note).length > 100) {
    return fail(CODE.PARAM, '申请留言不能超过 100 字');
  }

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (team.status !== 'normal') return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');
  if ((team.member_count || 0) >= S.MEMBER_LIMIT) {
    return fail(S.BIZ.TEAM_FULL, `战队已满员（${S.MEMBER_LIMIT}/${S.MEMBER_LIMIT}）`);
  }

  // CP-2：操作人无在职战队（user 冗余 + team_member 双保险）
  if (user.active_team_id || (await S.getActiveMembership(db, user._id))) {
    return fail(S.BIZ.ALREADY_IN_TEAM, '已有在职战队，须先退出后才能申请');
  }

  // R10：无本队未处理记录
  const openRecord = await S.getOpenRecord(db, team._id, user._id);
  if (openRecord) {
    return fail(S.BIZ.DUP_PENDING, openRecord.status === 'applying'
      ? '已有未处理的入队申请' : '已有未处理的邀请，请先处理');
  }
  // R10 冷却：本队被拒/被移除后 7 天内不可重复申请
  const _ = db.command;
  const closedRes = await db.collection('team_member')
    .where({ team_id: team._id, user_id: user._id, status: _.in(['rejected', 'removed']) })
    .orderBy('updated_at', 'desc').limit(1).get();
  const closed = (closedRes.data || [])[0];
  if (closed && Date.now() - (closed.updated_at || 0) < S.REAPPLY_COOLDOWN) {
    return fail(S.BIZ.DUP_PENDING, '被拒绝或移除后 7 天内不可重新申请');
  }

  const now = Date.now();
  const addRes = await db.collection('team_member').add({
    data: {
      team_id: team._id,
      team_name: team.name,
      user_id: user._id,
      nickname: user.nickname || '',
      avatar: user.avatar || null,
      role: 'member',          // 待生效
      status: 'applying',
      note: p.apply_note !== undefined && p.apply_note !== null ? String(p.apply_note) : null,
      joined_at: null,
      created_at: now,
      updated_at: now,
    },
  });

  // 通知队长「新入队申请」
  S.notifyUser(db, cloud, team.captain_user_id, 'NEW_APPLY', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: String(user.nickname || '新会员').slice(0, 20) },
  }, `pages/team/manage?team_id=${team._id}`);

  return ok({ record_id: addRes._id });
}

// §5.7 apply-list — 入队申请列表（队长）
async function applyList(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'status', 'page', 'page_size');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可查看申请列表');

  // status 过滤：applying（默认）/ rejected（近 30 天已处理，前端切换查看）
  const status = p.status === 'rejected' ? 'rejected' : 'applying';
  const { page, pageSize } = S.normalizePagination(p);
  const where = { team_id: team._id, status };
  const [countRes, listRes] = await Promise.all([
    db.collection('team_member').where(where).count(),
    db.collection('team_member').where(where)
      .orderBy('created_at', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  return ok({
    total: countRes.total,
    page,
    page_size: pageSize,
    list: (listRes.data || []).map((r) => ({
      record_id: r._id,
      user_id: r.user_id,
      nickname: r.nickname,
      avatar: r.avatar,
      apply_note: r.note || null,
      status: r.status,
      applied_at: r.created_at || null,
    })),
  });
}

// §5.8 apply-handle — 队长处理入队申请（通过即入队事务）
async function applyHandle(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'record_id', 'operate');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id || !p.record_id) return fail(CODE.PARAM, '缺少 team_id 或 record_id');
  if (!['accept', 'reject'].includes(p.operate)) return fail(CODE.PARAM, 'operate 须为 accept 或 reject');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可处理申请');

  const record = await S.getDoc(db, 'team_member', p.record_id);
  if (!record || record.team_id !== team._id) {
    return fail(S.BIZ.RECORD_NOT_FOUND, '申请记录不存在或不属于本队');
  }
  if (record.status !== 'applying') {
    return fail(S.BIZ.RECORD_HANDLED, '该申请已被处理');
  }

  // 拒绝：置 rejected + 通知申请人
  if (p.operate === 'reject') {
    await db.collection('team_member').doc(record._id).update({
      data: { status: 'rejected', updated_at: Date.now() },
    });
    S.notifyUser(db, cloud, record.user_id, 'APPLY_RESULT', {
      thing1: { value: String(team.name || '').slice(0, 20) },
      thing2: { value: '申请未通过' },
    }, `pages/team/detail?team_id=${team._id}`);
    return ok({ user_id: record.user_id, result: 'rejected' });
  }

  // 通过：入队事务（条件 team/user + 记录生效，任一步失败整体回滚）
  const applicant = await S.getDoc(db, 'user', record.user_id);
  if (!applicant) return fail(S.BIZ.RECORD_NOT_FOUND, '申请人不存在');
  const r = await S.joinTeamTx(db, { teamId: team._id, user: applicant, recordId: record._id });
  if (!r.ok) return fail(r.code, r.msg);

  // 通知申请人（队长本人为操作人，前端已知结果）
  S.notifyUser(db, cloud, record.user_id, 'APPLY_RESULT', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: '申请已通过' },
  }, `pages/team/detail?team_id=${team._id}`);
  // team_stats 联动重算（R8）P1 接入

  return ok({ member_count: r.member_count, user_id: record.user_id, result: 'active' });
}

// §5.9 invite — 队长发出邀请（邀请路径）
async function invite(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'target_user_id', 'invite_note');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id || !p.target_user_id) return fail(CODE.PARAM, '缺少 team_id 或 target_user_id');
  if (p.invite_note !== undefined && p.invite_note !== null && String(p.invite_note).length > 100) {
    return fail(CODE.PARAM, '邀请留言不能超过 100 字');
  }
  if (p.target_user_id === user._id) return fail(CODE.PARAM, '不能邀请自己');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可发出邀请');
  if (team.status !== 'normal') return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');
  if ((team.member_count || 0) >= S.MEMBER_LIMIT) {
    return fail(S.BIZ.TEAM_FULL, `战队已满员（${S.MEMBER_LIMIT}/${S.MEMBER_LIMIT}）`);
  }

  const target = await S.getDoc(db, 'user', p.target_user_id);
  if (!target) return fail(S.BIZ.RECORD_NOT_FOUND, '目标会员不存在');

  // CP-3：目标无在职战队
  if (target.active_team_id || (await S.getActiveMembership(db, target._id))) {
    return fail(S.BIZ.TARGET_IN_TEAM, '对方已属于战队，无法邀请');
  }

  // R10：目标与本队无未处理记录（含目标已提交申请的情况）
  const openRecord = await S.getOpenRecord(db, team._id, target._id);
  if (openRecord) {
    return fail(S.BIZ.DUP_PENDING, openRecord.status === 'applying'
      ? '对方已提交入队申请，请到申请列表处理'
      : '已有未处理的邀请');
  }

  const now = Date.now();
  const addRes = await db.collection('team_member').add({
    data: {
      team_id: team._id,
      team_name: team.name,
      user_id: target._id,
      nickname: target.nickname || '',
      avatar: target.avatar || null,
      role: 'member',          // 待生效
      status: 'invited',
      note: p.invite_note !== undefined && p.invite_note !== null ? String(p.invite_note) : null,
      joined_at: null,
      created_at: now,
      updated_at: now,
    },
  });

  // 通知被邀请人
  S.notifyUser(db, cloud, target._id, 'NEW_INVITE', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: String(user.nickname || '队长').slice(0, 20) },
  }, `pages/team/detail?team_id=${team._id}`);

  return ok({ record_id: addRes._id });
}

// §5.10 invite-handle — 被邀请人接受/拒绝（接受即入队事务）
async function inviteHandle(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'record_id', 'operate');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.record_id) return fail(CODE.PARAM, '缺少 record_id');
  if (!['accept', 'reject'].includes(p.operate)) return fail(CODE.PARAM, 'operate 须为 accept 或 reject');

  const record = await S.getDoc(db, 'team_member', p.record_id);
  if (!record || record.user_id !== user._id) {
    return fail(S.BIZ.RECORD_NOT_FOUND, '邀请记录不存在或非本人');
  }
  if (record.status !== 'invited') {
    return fail(S.BIZ.RECORD_HANDLED, '该邀请已被处理');
  }

  // 拒绝：置 invite_rejected + 通知队长
  if (p.operate === 'reject') {
    await db.collection('team_member').doc(record._id).update({
      data: { status: 'invite_rejected', updated_at: Date.now() },
    });
    const team = await S.getTeamById(db, record.team_id);
    if (team) {
      S.notifyUser(db, cloud, team.captain_user_id, 'INVITE_RESULT', {
        thing1: { value: String(team.name || '').slice(0, 20) },
        thing2: { value: '对方已拒绝邀请' },
      }, `pages/team/manage?team_id=${team._id}`);
    }
    return ok({ team_id: record.team_id, team_name: record.team_name, result: 'invite_rejected' });
  }

  // 接受：入队事务（CP-5 硬校验；战队非正常/满员时邀请失效）
  const r = await S.joinTeamTx(db, { teamId: record.team_id, user, recordId: record._id });
  if (!r.ok) return fail(r.code, r.msg);

  // 通知队长
  const teamAfter = await S.getTeamById(db, record.team_id);
  S.notifyUser(db, cloud, teamAfter ? teamAfter.captain_user_id : null, 'INVITE_RESULT', {
    thing1: { value: String(record.team_name || '').slice(0, 20) },
    thing2: { value: '对方已接受邀请' },
  }, `pages/team/manage?team_id=${record.team_id}`);
  // team_stats 联动重算（R8）P1 接入

  return ok({ team_id: record.team_id, team_name: record.team_name, result: 'active' });
}

// §5.11 member-list — 成员列表（正常战队对外可见）
async function memberList(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'status', 'page', 'page_size');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');

  const status = p.status !== undefined && p.status !== null ? String(p.status) : 'active';
  if (!S.MEMBER_STATUSES.includes(status)) return fail(CODE.PARAM, 'status 取值不合法');

  const { page, pageSize } = S.normalizePagination(p);
  const where = { team_id: team._id, status };
  // 队长置顶（'captain' 字典序 < 'member'）+ joined_at 升序
  const [countRes, listRes] = await Promise.all([
    db.collection('team_member').where(where).count(),
    db.collection('team_member').where(where)
      .orderBy('role', 'asc')
      .orderBy('joined_at', 'asc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  // rank 军衔读时联查 user（R15 口径）
  const userMap = await S.fetchUserMap(db, (listRes.data || []).map((r) => r.user_id));

  return ok({
    total: countRes.total,
    member_count: team.member_count || 0,
    page,
    page_size: pageSize,
    list: (listRes.data || []).map((r) => {
      const u = userMap.get(r.user_id);
      return {
        user_id: r.user_id,
        nickname: r.nickname,
        avatar: r.avatar,
        role: r.role,
        rank: (u && u.rank) || 'recruit',
        joined_at: r.joined_at || null,
      };
    }),
  });
}

// §5.12 remove-member — 队长移除在职队员（R5）
async function removeMember(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'target_user_id', 'reason');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id || !p.target_user_id) return fail(CODE.PARAM, '缺少 team_id 或 target_user_id');
  if (p.reason !== undefined && p.reason !== null && String(p.reason).length > 100) {
    return fail(CODE.PARAM, '移除原因不能超过 100 字');
  }

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可移除成员');
  if (p.target_user_id === team.captain_user_id) {
    return fail(S.BIZ.CAPTAIN_PROTECTED, '队长不可被移除');
  }

  // 目标须为本队 active 队员
  const targetRes = await db.collection('team_member')
    .where({ team_id: team._id, user_id: p.target_user_id, status: 'active' })
    .limit(1).get();
  const targetRecord = (targetRes.data || [])[0];
  if (!targetRecord || targetRecord.role !== 'member') {
    return fail(S.BIZ.RECORD_NOT_FOUND, '目标不是本队在职队员');
  }

  // 离队事务：removed + 留痕 + active_team_id 置空 + member_count-1
  const reason = p.reason !== undefined && p.reason !== null ? String(p.reason) : null;
  const r = await S.leaveTeamTx(db, {
    teamId: team._id, recordId: targetRecord._id,
    userId: p.target_user_id, newStatus: 'removed', note: reason,
  });
  if (!r.ok) return fail(r.code, r.msg);

  // 通知被移除人（含战队名）
  S.notifyUser(db, cloud, p.target_user_id, 'MEMBER_REMOVED', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: String(reason || '已被移出战队').slice(0, 20) },
  }, 'pages/team/list');
  // team_stats 联动重算（R8）P1 接入

  return ok({ member_count: r.member_count });
}

// §5.13 quit — 队员自助退出（R5：队长不可直接退出）
async function quit(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');

  // 本人须为本队 active 成员
  const myRes = await db.collection('team_member')
    .where({ team_id: team._id, user_id: user._id, status: 'active' })
    .limit(1).get();
  const myRecord = (myRes.data || [])[0];
  if (!myRecord) return fail(S.BIZ.RECORD_NOT_FOUND, '非本队在职成员');
  if (myRecord.role === 'captain') {
    return fail(S.BIZ.CAPTAIN_PROTECTED, '队长请先转让队长或解散战队后再退出');
  }

  // 离队事务：quit + active_team_id 置空 + member_count-1
  const r = await S.leaveTeamTx(db, {
    teamId: team._id, recordId: myRecord._id,
    userId: user._id, newStatus: 'quit', note: null,
  });
  if (!r.ok) return fail(r.code, r.msg);
  // team_stats 联动重算（R8）P1 接入

  return ok({ member_count: r.member_count });
}

// §5.14 transfer-captain — 转让队长（R4，CP-7 事务内复核）
async function transferCaptain(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'target_user_id');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id || !p.target_user_id) return fail(CODE.PARAM, '缺少 team_id 或 target_user_id');
  if (p.target_user_id === user._id) return fail(CODE.PARAM, '不能转让给自己');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可转让队长');
  if (team.status !== 'normal') return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');

  // 预查双方记录（事务内按 doc 复核，CP-7）
  const [targetRes, myRes] = await Promise.all([
    db.collection('team_member')
      .where({ team_id: team._id, user_id: p.target_user_id, status: 'active' })
      .limit(1).get(),
    db.collection('team_member')
      .where({ team_id: team._id, user_id: user._id, status: 'active', role: 'captain' })
      .limit(1).get(),
  ]);
  const targetRecord = (targetRes.data || [])[0];
  const myRecord = (myRes.data || [])[0];
  if (!targetRecord || targetRecord.role !== 'member') {
    return fail(S.BIZ.RECORD_NOT_FOUND, '目标不是本队在职队员');
  }
  if (!myRecord) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可转让队长');

  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    // 事务复核：队长 + normal；目标 active 队员；本人队长记录仍在职
    const freshTeam = (await transaction.collection('team').doc(team._id).get()).data;
    if (!freshTeam || freshTeam.captain_user_id !== user._id) {
      await transaction.rollback();
      return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可转让队长');
    }
    if (freshTeam.status !== 'normal') {
      await transaction.rollback();
      return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');
    }
    const freshTarget = (await transaction.collection('team_member').doc(targetRecord._id).get()).data;
    if (!freshTarget || freshTarget.team_id !== team._id
      || freshTarget.user_id !== p.target_user_id
      || freshTarget.status !== 'active' || freshTarget.role !== 'member') {
      await transaction.rollback();
      return fail(S.BIZ.RECORD_NOT_FOUND, '目标不是本队在职队员');
    }
    const freshMine = (await transaction.collection('team_member').doc(myRecord._id).get()).data;
    if (!freshMine || freshMine.status !== 'active' || freshMine.role !== 'captain') {
      await transaction.rollback();
      return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可转让队长');
    }

    await transaction.collection('team_member').doc(targetRecord._id).update({
      data: { role: 'captain', updated_at: now },
    });
    await transaction.collection('team_member').doc(myRecord._id).update({
      data: { role: 'member', updated_at: now },
    });
    // captain_name 冗余同步（§6.5：转让事务同步）
    await transaction.collection('team').doc(team._id).update({
      data: {
        captain_user_id: p.target_user_id,
        captain_name: freshTarget.nickname || '',
        updated_at: now,
      },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[team/transfer-captain] 事务失败', team._id, p.target_user_id, e);
    return fail(CODE.INTERNAL, '操作冲突，请稍后重试');
  }

  // 通知新队长（操作人前端已知结果）
  S.notifyUser(db, cloud, p.target_user_id, 'NEW_CAPTAIN', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: '你已成为新队长' },
  }, `pages/team/detail?team_id=${team._id}`);

  return ok({ captain_user_id: p.target_user_id });
}

// §2.1-5 search-users — 邀请队员搜索（按昵称/手机号，服务 invite 页）
// 设计缺口补齐：user 模块无 P0 普通用户搜索接口（user-module §5.18 adminList 为 P1 管理端），
// 依 user-module §7.2 跨模块直读 user 集合口径落在 team 模块；出参手机号一律脱敏（R3）。
async function searchUsers(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'keyword', 'page', 'page_size');
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '缺少 team_id');
  const keyword = String(p.keyword || '').trim();
  if (!keyword || keyword.length > 50) return fail(CODE.PARAM, '关键词为 1-50 个字符');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(S.BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (!assertCaptain(team, user)) return fail(S.BIZ.CAPTAIN_ONLY, '仅队长可搜索会员');
  if (team.status !== 'normal') return fail(S.BIZ.TEAM_STATE, '战队状态不允许该操作');

  const { page, pageSize } = S.normalizePagination(p);
  const _ = db.command;

  // 关键词分派：完整 11 位手机号 → phone_hash 等值（AES 密文不可模糊匹配）；否则昵称正则模糊（转义）
  let where;
  if (/^1\d{10}$/.test(keyword)) {
    where = { phone_hash: hashField(keyword) };
  } else {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    where = { nickname: db.RegExp({ regexp: safe, options: 'i' }) };
  }
  where.status = 'normal';
  where._id = _.neq(user._id);

  const [countRes, listRes] = await Promise.all([
    db.collection('user').where(where).count(),
    db.collection('user').where(where)
      .orderBy('created_at', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  // §2.2 禁选标注：在职战队（CP-3 软校验口径）+ 本队未处理记录（R10）
  const users = listRes.data || [];
  const userIds = users.map((u) => u._id);
  const activeMap = {};
  const pendingMap = {};
  if (userIds.length) {
    const [activeRes, openRes] = await Promise.all([
      db.collection('team_member').where({ user_id: _.in(userIds), status: 'active' }).get(),
      db.collection('team_member')
        .where({ team_id: team._id, user_id: _.in(userIds), status: _.in(['applying', 'invited']) })
        .get(),
    ]);
    (activeRes.data || []).forEach((r) => { activeMap[r.user_id] = r.team_id; });
    (openRes.data || []).forEach((r) => { pendingMap[r.user_id] = r.status; });
  }

  return ok({
    total: countRes.total,
    page,
    page_size: pageSize,
    list: users.map((u) => {
      const plainPhone = decryptField(u.phone);
      const activeTeamId = activeMap[u._id] || u.active_team_id || null;
      return {
        user_id: u._id,
        nickname: u.nickname || '会员',
        avatar: u.avatar || null,
        phone_masked: plainPhone ? maskPhone(plainPhone) : null,
        in_team: !!activeTeamId,
        in_my_team: activeTeamId === team._id,
        pending: pendingMap[u._id] || null,   // 'applying' | 'invited' | null
      };
    }),
  });
}

module.exports = {
  'join-apply': joinApply,
  'apply-list': applyList,
  'apply-handle': applyHandle,
  invite,
  'invite-handle': inviteHandle,
  'member-list': memberList,
  'remove-member': removeMember,
  quit,
  'transfer-captain': transferCaptain,
  'search-users': searchUsers,
};
