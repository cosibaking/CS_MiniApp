// actions/admin.js — 战队审核与解散（team-module §5.15-§5.16、§5.20）
// wrapAdminAction：audit_team 权限硬校验 + 审计日志（module=team，fire-and-forget 非阻断）。
// handler 业务错误一律 throw new BizError(code, msg)（wrap 捕获后转 fail）。
const common = require('@club/admin-common');
const { wrapAdminAction, BizError, CODE, ok, fail, maskPhone, decryptField } = common;
const S = require('./shared');
const { BIZ } = S;

const P = (event) => (event.payload || {}).team_id;

// 审核结果通知创建人（拒绝附理由，§5.15 第 5 步 / §7.2 TEAM_AUDIT_RESULT）
function notifyAuditResult(cloud, db, team, approved, reason) {
  S.notifyUser(db, cloud, team.captain_user_id, 'TEAM_AUDIT_RESULT', {
    thing1: { value: String(team.name || '').slice(0, 20) },
    thing2: { value: approved ? '审核通过' : `审核未通过：${reason || ''}`.slice(0, 20) },
  }, `pages/team/detail?team_id=${team._id}`);
}

// 审核生效事务（CP-6，§5.15 第 4 步 / E7）：
// 创建人 user 条件更新（active_team_id==null → set）→ 创建队长 team_member（captain/active）→
// team.status=normal、member_count=1 + 审核人冗余；失败整体回滚。
// 返回 { ok } / { ok:false, code, msg }。
async function approveTeamTx(db, team, operator) {
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    // 事务内复核 team 仍为 pending（并发审核互斥）
    const teamRes = await transaction.collection('team').doc(team._id).get();
    const freshTeam = teamRes && teamRes.data;
    if (!freshTeam) {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_NOT_FOUND, msg: '战队不存在' };
    }
    if (freshTeam.status !== 'pending') {
      await transaction.rollback();
      return { ok: false, code: BIZ.RECORD_HANDLED, msg: '该战队已被处理，请刷新' };
    }

    // 条件更新创建人：已在其他战队 → 40901 整体回滚（E7）
    const userRes = await transaction.collection('user').doc(team.captain_user_id).get();
    const creator = userRes && userRes.data;
    if (!creator) {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_NOT_FOUND, msg: '战队创建人账号不存在' };
    }
    if (creator.active_team_id) {
      await transaction.rollback();
      return {
        ok: false, code: BIZ.ALREADY_IN_TEAM,
        msg: '创建人已加入其他战队，可与其确认后改为拒绝',
      };
    }

    // 创建人生成队长成员记录（§6.2：创建时不写 team_member，审核通过才生效）
    await transaction.collection('team_member').add({
      data: {
        team_id: team._id,
        team_name: freshTeam.name,
        user_id: team.captain_user_id,
        nickname: creator.nickname || '',
        avatar: creator.avatar || null,
        role: 'captain',
        status: 'active',
        note: null,
        joined_at: now,
        created_at: now,
        updated_at: now,
      },
    });
    // team 生效（normal、member_count=1）+ 审核人冗余（§6.1）
    await transaction.collection('team').doc(team._id).update({
      data: {
        status: 'normal',
        member_count: 1,
        auditor_id: operator.id,
        auditor_name: operator.name,
        audit_at: now,
        updated_at: now,
      },
    });
    await transaction.collection('user').doc(team.captain_user_id).update({
      data: { active_team_id: team._id, updated_at: now },
    });
    await transaction.commit();
    return { ok: true };
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[team.audit] 审核生效事务失败', team._id, e);
    return { ok: false, code: CODE.INTERNAL, msg: '操作冲突，请稍后重试' };
  }
}

// §5.15 audit — 管理员审核战队创建（通过/拒绝，R1）
async function audit(event, auth) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id', 'operate', 'reject_reason');

  if (!p.team_id || typeof p.team_id !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：team_id');
  }
  if (p.operate !== 'approve' && p.operate !== 'reject') {
    throw new BizError(CODE.PARAM, '参数错误：operate 需为 approve/reject');
  }

  const team = await S.getTeamById(db, p.team_id);
  if (!team) throw new BizError(BIZ.TEAM_NOT_FOUND, '战队不存在');
  if (team.status !== 'pending') {
    throw new BizError(BIZ.RECORD_HANDLED, '该战队已审核');
  }

  const now = Date.now();

  // 拒绝：条件更新原子防并发（reject_reason 必填 2~100 字）
  if (p.operate === 'reject') {
    const reason = typeof p.reject_reason === 'string' ? p.reject_reason.trim() : '';
    if (reason.length < 2 || reason.length > 100) {
      throw new BizError(CODE.PARAM, '参数错误：reject_reason 需为 2~100 字');
    }
    const upd = await db.collection('team')
      .where({ _id: team._id, status: 'pending' })
      .update({
        data: {
          status: 'rejected',
          reject_reason: reason,
          auditor_id: auth.operator.id,
          auditor_name: auth.operator.name,
          audit_at: now,
          updated_at: now,
        },
      });
    if (!upd.stats || upd.stats.updated !== 1) {
      throw new BizError(BIZ.RECORD_HANDLED, '该战队已被处理，请刷新');
    }
    notifyAuditResult(cloud, db, team, false, reason);
    return { team_id: team._id, status: 'rejected' };
  }

  // 通过：审核生效事务（CP-6）
  const r = await approveTeamTx(db, team, auth.operator);
  if (!r.ok) throw new BizError(r.code, r.msg);

  notifyAuditResult(cloud, db, team, true, null);
  return { team_id: team._id, status: 'normal' };
}

// §5.16 audit-list — 管理端待审核列表（pending 优先，creator 联查脱敏）
async function auditList(event, auth) {
  const { db } = common.getContext();
  const p = S.pick(event, 'status', 'page', 'page_size');
  const { page, pageSize } = S.normalizePagination(p);

  const where = {};
  if (p.status) {
    if (p.status !== 'pending' && p.status !== 'rejected') {
      throw new BizError(CODE.PARAM, '参数错误：status 取值不合法');
    }
    where.status = p.status;
  } else {
    where.status = db.command.in(['pending', 'rejected']);
  }

  const cnt = await db.collection('team').where(where).count();
  let query = db.collection('team').where(where);
  if (!p.status) query = query.orderBy('status', 'asc'); // 'pending' < 'rejected'：待审核优先
  const res = await query.orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .get();

  // creator 联查（pending/rejected 阶段创建人=队长；手机号 AES 解密后脱敏）
  const userMap = await S.fetchUserMap(db, res.data.map((t) => t.captain_user_id));
  const list = res.data.map((t) => {
    const u = userMap.get(t.captain_user_id) || null;
    const plainPhone = u && u.phone ? decryptField(u.phone) : null;
    return {
      team_id: t._id,
      name: t.name,
      logo: t.logo || '',
      slogan: t.slogan || null,
      intro: t.intro || null,
      status: t.status,
      creator: {
        user_id: t.captain_user_id,
        nickname: (u && u.nickname) || t.captain_name || '',
        phone: plainPhone ? maskPhone(plainPhone) : '',
      },
      created_at: t.created_at,
      reject_reason: t.status === 'rejected' ? (t.reject_reason || '') : null,
      audit_at: t.audit_at || null,
    };
  });
  return { total: cnt.total || 0, page, page_size: pageSize, list };
}

// ---------- §5.20 dissolve — 解散战队（R6，P2） ----------

const DISSOLVE_OPEN_ENROLL = ['pending', 'enrolled', 'waitlist'];         // R6：待支付/已报名/候补
const DISSOLVE_OPEN_ACTIVITY = ['published', 'signup_closed', 'ongoing']; // R6：活动未结束

// 发起人：本队队长（team-module §5.20），或具 audit_team 权限的俱乐部侧强制解散（admin-module §1.4）。
// CP-9 释放采用「先释放后锚定」幂等序列：成员 ≤100 时批量 where().update() 不可入事务
// 且总写数可能超事务上限，以末步 team 条件更新（status=normal → dissolved）为原子锚点；
// 中途失败重试可补齐（各释放步骤天然幂等）。
async function dissolve(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'team_id');
  const _ = db.command;

  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (!p.team_id) return fail(CODE.PARAM, '参数错误：team_id');

  const team = await S.getTeamById(db, p.team_id);
  if (!team) return fail(BIZ.TEAM_NOT_FOUND, '战队不存在或已解散');

  // 身份：队长本人；非队长须持 audit_team 权限（俱乐部侧强制解散）
  const isCaptain = team.captain_user_id === user._id;
  if (!isCaptain) {
    let allowed = false;
    try {
      const { OPENID } = cloud.getWXContext();
      const auth = await common.checkPermission(OPENID, 'audit_team');
      allowed = !!auth.hasPermission;
    } catch (e) { /* 取登录态/权限失败按无权限处理 */ }
    if (!allowed) return fail(BIZ.CAPTAIN_ONLY, '仅队长可解散战队');
  }
  if (team.status !== 'normal') return fail(BIZ.TEAM_STATE, '战队状态不允许解散');

  // R6 前置：全员无进行中的报名（按状态粗查报名 → 联查活动精确过滤未结束者）
  const enrRes = await db.collection('activity_enrollment')
    .where({ team_id: team._id, status: _.in(DISSOLVE_OPEN_ENROLL) })
    .field({ user_id: true, activity_id: true, activity_title: true, status: true })
    .limit(1000)
    .get();
  const candidates = enrRes.data || [];
  let blocked = [];
  if (candidates.length) {
    const actRes = await db.collection('activity')
      .where({
        _id: _.in([...new Set(candidates.map((e) => e.activity_id))]),
        status: _.in(DISSOLVE_OPEN_ACTIVITY),
      })
      .field({ _id: true })
      .get();
    const openActs = new Set((actRes.data || []).map((a) => a._id));
    blocked = candidates.filter((e) => openActs.has(e.activity_id));
  }
  if (blocked.length) {
    // 40906 附受阻明细（成员昵称/活动标题/状态，§5.20 第 2 步；明细截断防 data 过大）
    const userMap = await S.fetchUserMap(db, blocked.map((b) => b.user_id));
    return fail(BIZ.ENROLL_BLOCKED, '存在进行中的报名，请先处理后再解散战队', {
      total: blocked.length,
      blocked: blocked.slice(0, 20).map((b) => ({
        user_id: b.user_id,
        nickname: (userMap.get(b.user_id) || {}).nickname || '',
        activity_title: b.activity_title || '',
        status: b.status,
      })),
    });
  }

  // 解散前快照：在职成员（通知全员 + released_members 口径）
  const memRes = await db.collection('team_member')
    .where({ team_id: team._id, status: 'active' })
    .field({ user_id: true })
    .limit(S.MEMBER_LIMIT)
    .get();
  const memberIds = (memRes.data || []).map((m) => m.user_id);
  const now = Date.now();

  // CP-9 释放序列（幂等）：① 在职成员 active→quit ② 未处理申请/邀请统一关闭（E6）
  // ③ 清空指向本队的 active_team_id ④ 末步条件更新锚定（并发解散互斥）
  await db.collection('team_member')
    .where({ team_id: team._id, status: 'active' })
    .update({ data: { status: 'quit', note: '战队解散', updated_at: now } });
  await db.collection('team_member')
    .where({ team_id: team._id, status: 'applying' })
    .update({ data: { status: 'rejected', note: '战队解散', updated_at: now } });
  await db.collection('team_member')
    .where({ team_id: team._id, status: 'invited' })
    .update({ data: { status: 'invite_rejected', note: '战队解散', updated_at: now } });
  await db.collection('user')
    .where({ active_team_id: team._id })
    .update({ data: { active_team_id: null, updated_at: now } });

  const anchor = await db.collection('team')
    .where({ _id: team._id, status: 'normal' })
    .update({
      data: { status: 'dissolved', dissolved_at: now, member_count: 0, updated_at: now },
    });
  if (!anchor.stats || anchor.stats.updated !== 1) {
    return fail(BIZ.TEAM_STATE, '战队状态已变化，请刷新后重试');
  }

  // 通知队长 + 全体在职成员（§7.2 战队解散通知；订阅一次性授权限制下未触达容忍）
  const notifyIds = [...new Set([team.captain_user_id, ...memberIds].filter(Boolean))].slice(0, 100);
  if (notifyIds.length) {
    const notifyMap = await S.fetchUserMap(db, notifyIds);
    for (const uid of notifyIds) {
      const u = notifyMap.get(uid);
      if (u && u.openid) {
        S.sendSubscribeMsg(cloud, u.openid, 'TEAM_DISSOLVED', {
          thing1: { value: String(team.name || '').slice(0, 20) },
          thing2: { value: '战队已解散' },
        }, 'pages/team/list');
      }
    }
  }

  // 操作日志（架构 §1.5 战队行含解散；队长发起不走 wrapAdminAction，故自写）
  common.writeOperationLog({
    operator: { id: user._id, name: user.nickname || '', role: user.role || 'member' },
    module: 'team',
    action: 'team.dissolve',
    targetType: 'team',
    targetId: team._id,
    detail: common.sanitizeDetail({
      member_count: memberIds.length,
      captain_user_id: team.captain_user_id,
      by_admin: !isCaptain,
    }),
    result: 'success',
  }).catch((e) => console.warn('[team.dissolve] 写操作日志失败（不阻断）：', e));

  return ok({ status: 'dissolved', released_members: memberIds.length });
}

module.exports = {
  // §5.15 audit — 战队审核（audit_team）→ 日志 team.audit
  audit: wrapAdminAction('team.audit', audit, {
    permission: 'audit_team', module: 'team', targetType: 'team',
    targetId: P,
    detail: (event, result) => ({
      operate: (event.payload || {}).operate || null,
      before: 'pending',
      after: (result && result.status) || null,
      reject_reason: (event.payload || {}).reject_reason || null,
    }),
  }),
  // §5.16 audit-list — 待审核列表 → 日志 team.audit.list
  'audit-list': wrapAdminAction('team.audit.list', auditList, {
    permission: 'audit_team', module: 'team', targetType: 'team',
    detail: (event) => ({ status: (event.payload || {}).status || null }),
  }),
  // §5.20 dissolve — 解散战队（队长本人，或 audit_team 强制解散）→ 日志 team.dissolve
  dissolve,
};
