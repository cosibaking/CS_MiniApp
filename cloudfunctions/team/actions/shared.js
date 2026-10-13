// actions/shared.js — team 模块共享助手（team-module §3/§5/§6/§7）
// 供 basic / member / admin / contest 复用：业务错误码、取参兼容、身份与队长校验、
// 战队/成员查询助手、R9 队名软唯一、R2/R3 入队与离队事务（CP-6）、订阅消息。
//
// 错误码口径：基础码用 CODE.*（common/constants.js 为数值权威）；team 业务码
// 40xxx 本地定义（team-module §5.0，文档基础码 40001/40101/40301/50001 与框架
// CODE 段冲突时以框架为准，仅占用文档独有号位）。
const common = require('@club/admin-common');
const { CODE } = common;

// ---------- 常量 ----------

const PAGE_SIZE_MAX = 50;                        // 分页上限（§5.0）
const MEMBER_LIMIT = 100;                        // R2 战队人数上限
const REAPPLY_COOLDOWN = 7 * 24 * 3600 * 1000;   // R10 被拒/被移除 7 天冷却

const TEAM_STATUSES = ['pending', 'normal', 'rejected', 'dissolved'];
const MEMBER_STATUSES = [
  'applying', 'invited', 'active', 'quit', 'removed', 'rejected', 'invite_rejected',
];
const OPEN_MEMBER_STATUSES = ['applying', 'invited'];   // 未处理记录（R10）
const NAME_TAKEN_STATUSES = ['pending', 'normal'];     // R9 队名占用状态

// team 业务错误码（§5.0 的 40xxx 独有号位）
const BIZ = {
  CAPTAIN_ONLY: 40302,      // 非本队队长
  TEAM_NOT_FOUND: 40401,    // 战队不存在/不可见
  RECORD_NOT_FOUND: 40402,  // 申请/邀请/成员记录不存在
  ALREADY_IN_TEAM: 40901,   // 已属于战队（一人一队冲突，R3）
  NAME_TAKEN: 40902,        // 队名已存在（R9）
  TEAM_FULL: 40903,         // 战队已满员（R2）
  DUP_PENDING: 40904,       // 存在未处理申请/邀请或冷却期内（R10）
  TEAM_STATE: 40905,        // 战队状态不允许该操作
  ENROLL_BLOCKED: 40906,    // 存在进行中的报名（R6 解散前置）
  RECORD_HANDLED: 40907,    // 记录已被处理
  TARGET_IN_TEAM: 40908,    // 目标已属于其他战队（CP-3）
  QUOTA_SHORT: 40909,       // 活动名额不足（§5.19，activity 模块回传映射）
  CAPTAIN_PROTECTED: 40910, // 队长不可执行此操作（R5）
};

// ---------- 取参与身份 ----------

// 双取参兼容：前端 callCloud 走 event.payload 嵌套。先 payload 再顶层（与 order 一致）。
function pick(event, ...keys) {
  const payload = (event && event.payload) || {};
  const top = event || {};
  const out = {};
  for (const k of keys) {
    if (payload[k] !== undefined) out[k] = payload[k];
    else if (top[k] !== undefined) out[k] = top[k];
  }
  return out;
}

// openid → user 文档（未注册/未登录返回 null）
async function getCurrentUser(cloud, db) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  return (res.data && res.data[0]) || null;
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

// user_id 批量 → Map（≤100；军衔读时联查、通知取 openid，与 activity 同法）
async function fetchUserMap(db, userIds) {
  const _ = db.command;
  const ids = [...new Set((userIds || []).filter(Boolean))].slice(0, 100);
  if (!ids.length) return new Map();
  const res = await db.collection('user').where({ _id: _.in(ids) }).limit(100).get();
  return new Map((res.data || []).map((u) => [u._id, u]));
}

// 分页参数归一（§5.0：page 从 1 起，page_size 默认 10 上限 50）
function normalizePagination(p) {
  const page = Number.isInteger(p.page) && p.page > 0 ? p.page : 1;
  const rawSize = Number.isInteger(p.page_size) && p.page_size > 0 ? p.page_size : 10;
  return { page, pageSize: Math.min(rawSize, PAGE_SIZE_MAX) };
}

// ---------- 战队/成员查询 ----------

async function getTeamById(db, teamId) {
  if (!teamId || typeof teamId !== 'string') return null;
  return getDoc(db, 'team', teamId);
}

// 在职成员记录（一人一队：同一 user 至多一条 active）
async function getActiveMembership(db, userId) {
  if (!userId) return null;
  const res = await db.collection('team_member')
    .where({ user_id: userId, status: 'active' }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

// 本队未处理记录（R10：applying/invited 不可重复提交）
async function getOpenRecord(db, teamId, userId) {
  const _ = db.command;
  const res = await db.collection('team_member')
    .where({ team_id: teamId, user_id: userId, status: _.in(OPEN_MEMBER_STATUSES) })
    .orderBy('created_at', 'desc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

// R9 队名软唯一：pending/normal 状态占用同名（不建唯一索引，excludeId 供 update 排除自身）
async function isNameTaken(db, name, excludeId) {
  const _ = db.command;
  const where = { name, status: _.in(NAME_TAKEN_STATUSES) };
  if (excludeId) where._id = _.neq(excludeId);
  const res = await db.collection('team').where(where).limit(1).get();
  return !!((res.data || []).length);
}

// ---------- 校验 ----------

// 战队资料校验（create/update 共用，§5.1/§5.5）：
// name 2~20 字符必填、logo fileID 必填、slogan ≤30 字、intro ≤200 字。
// 返回错误文案或 null；name/logo 仅在传入时校验（update 支持部分更新）。
function validateTeamProfile({ name, logo, slogan, intro }) {
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return '队名不能为空';
    const len = name.trim().length;
    if (len < 2 || len > 20) return '队名需 2~20 个字符';
  }
  if (logo !== undefined) {
    if (typeof logo !== 'string' || !logo.startsWith('cloud://')) return '队徽格式不正确';
  }
  if (slogan !== undefined && slogan !== null && String(slogan).length > 30) {
    return '口号不能超过 30 字';
  }
  if (intro !== undefined && intro !== null && String(intro).length > 200) {
    return '简介不能超过 200 字';
  }
  return null;
}

// ---------- 事务（R2/R3/CP-6） ----------

// 入队事务（apply-handle/invite-handle 接受共用，§5.8/§5.10 第 3 步）：
// ① 条件 team（status=normal 且 member_count<100 → +1）；
// ② 条件 user（active_team_id==null → set team_id，CP-4/CP-5 硬校验）；
// ③ 记录 status=active、role=member、joined_at=now；
// 任一步失败整体回滚。事务内读快照校验（与 order markPaid 同法），
// commit 冲突（并发入队）→ 50001 可重试口径。
// 返回 { ok, member_count } / { ok:false, code, msg }。
async function joinTeamTx(db, { teamId, user, recordId }) {
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    const teamRes = await transaction.collection('team').doc(teamId).get();
    const team = teamRes && teamRes.data;
    if (!team) {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_NOT_FOUND, msg: '战队不存在' };
    }
    if (team.status !== 'normal') {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_STATE, msg: '战队状态不允许该操作' };
    }
    if ((team.member_count || 0) >= MEMBER_LIMIT) {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_FULL, msg: `战队已满员（${MEMBER_LIMIT}/${MEMBER_LIMIT}）` };
    }

    const userRes = await transaction.collection('user').doc(user._id).get();
    const targetUser = userRes && userRes.data;
    if (!targetUser) {
      await transaction.rollback();
      return { ok: false, code: CODE.UNAUTHORIZED, msg: '用户不存在' };
    }
    if (targetUser.active_team_id) {
      await transaction.rollback();
      return { ok: false, code: BIZ.ALREADY_IN_TEAM, msg: '该用户已属于战队' };
    }

    if (recordId) {
      const recRes = await transaction.collection('team_member').doc(recordId).get();
      const record = recRes && recRes.data;
      if (!record || record.user_id !== user._id) {
        await transaction.rollback();
        return { ok: false, code: BIZ.RECORD_NOT_FOUND, msg: '记录不存在' };
      }
      if (!OPEN_MEMBER_STATUSES.includes(record.status)) {
        await transaction.rollback();
        return { ok: false, code: BIZ.RECORD_HANDLED, msg: '记录已被处理' };
      }
      await transaction.collection('team_member').doc(recordId).update({
        data: { status: 'active', role: 'member', joined_at: now, updated_at: now },
      });
    }

    await transaction.collection('team').doc(teamId).update({
      data: { member_count: (team.member_count || 0) + 1, updated_at: now },
    });
    await transaction.collection('user').doc(user._id).update({
      data: { active_team_id: teamId, updated_at: now },
    });
    await transaction.commit();
    return { ok: true, member_count: (team.member_count || 0) + 1 };
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[joinTeamTx] 事务失败', teamId, user && user._id, e);
    return { ok: false, code: CODE.INTERNAL, msg: '操作冲突，请稍后重试' };
  }
}

// 离队事务（remove-member/quit 共用，§5.12/§5.13，R5）：
// 记录 status→quit|removed、note 留痕、user.active_team_id 置空（仅当指向本队，
// 容忍冗余漂移不清他队）、team.member_count-1（下限 0 兜底）。
// 返回 { ok, member_count } / { ok:false, code, msg }。
async function leaveTeamTx(db, { teamId, recordId, userId, newStatus, note }) {
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    const teamRes = await transaction.collection('team').doc(teamId).get();
    const team = teamRes && teamRes.data;
    if (!team) {
      await transaction.rollback();
      return { ok: false, code: BIZ.TEAM_NOT_FOUND, msg: '战队不存在' };
    }

    const recRes = await transaction.collection('team_member').doc(recordId).get();
    const record = recRes && recRes.data;
    if (!record || record.team_id !== teamId || record.user_id !== userId || record.status !== 'active') {
      await transaction.rollback();
      return { ok: false, code: BIZ.RECORD_NOT_FOUND, msg: '非本队在职成员' };
    }

    const userRes = await transaction.collection('user').doc(userId).get();
    const targetUser = userRes && userRes.data;

    const data = { status: newStatus, updated_at: now };
    if (note !== undefined && note !== null) data.note = String(note).slice(0, 100);
    await transaction.collection('team_member').doc(recordId).update({ data });

    if (targetUser && targetUser.active_team_id === teamId) {
      await transaction.collection('user').doc(userId).update({
        data: { active_team_id: null, updated_at: now },
      });
    }

    const newCount = Math.max((team.member_count || 0) - 1, 0);
    await transaction.collection('team').doc(teamId).update({
      data: { member_count: newCount, updated_at: now },
    });
    await transaction.commit();
    return { ok: true, member_count: newCount };
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[leaveTeamTx] 事务失败', teamId, userId, e);
    return { ok: false, code: CODE.INTERNAL, msg: '操作冲突，请稍后重试' };
  }
}

// ---------- 订阅消息（§7.2，fire-and-forget） ----------

// 模板 ID 走环境变量 SUB_TMPL_<KEY>，未配置静默跳过；失败仅记日志（activity 同法）。
// KEY 约定：TEAM_AUDIT_RESULT / NEW_APPLY / APPLY_RESULT / NEW_INVITE /
// INVITE_RESULT / NEW_CAPTAIN / MEMBER_REMOVED（dissolve M3）
function sendSubscribeMsg(cloud, openid, templateKey, fields, page) {
  setImmediate(async () => {
    try {
      const templateId = process.env[`SUB_TMPL_${templateKey}`];
      if (!templateId || !openid) return;
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: page || 'pages/team/list',
        data: fields || {},
        miniprogramState: 'formal',
      });
    } catch (e) {
      console.info(`[subscribe] ${templateKey} 发送失败（不阻断）：`, (e && e.errMsg) || e);
    }
  });
}

// 通知单个用户（user_id → 查 user 取 openid 再发）；fire-and-forget，不抛错。
async function notifyUser(db, cloud, userId, templateKey, fields, page) {
  if (!userId) return;
  try {
    const user = await getDoc(db, 'user', userId);
    if (user && user.openid) {
      sendSubscribeMsg(cloud, user.openid, templateKey, fields, page);
    }
  } catch (e) {
    console.warn(`[notify] ${templateKey} 取用户失败（不阻断）：`, e);
  }
}

// ---------- 云函数互调（activity 模块） ----------

// 调 activity 内部接口（teamSignup 等，wrapInternal 校验 internal_token；§5.19）
async function callActivityInternal(cloud, action, payload) {
  const token = process.env.internal_token || '';
  if (!token) return { ok: false, code: null, msg: 'internal_token 未配置' };
  try {
    const res = await cloud.callFunction({
      name: 'activity',
      data: Object.assign({ action, source: 'internal', internal_token: token }, payload),
    });
    const body = res && res.result;
    if (body && body.code === 0) return { ok: true, data: body.data };
    return { ok: false, code: body && body.code, msg: (body && body.msg) || 'activity 模块返回失败' };
  } catch (e) {
    return { ok: false, code: null, msg: (e && e.errMsg) || String(e) };
  }
}

module.exports = {
  // 常量与错误码
  BIZ, CODE,
  PAGE_SIZE_MAX, MEMBER_LIMIT, REAPPLY_COOLDOWN,
  TEAM_STATUSES, MEMBER_STATUSES, OPEN_MEMBER_STATUSES, NAME_TAKEN_STATUSES,
  // 取参与身份
  pick, getCurrentUser, getDoc, fetchUserMap, normalizePagination,
  // 战队/成员查询
  getTeamById, getActiveMembership, getOpenRecord, isNameTaken,
  // 校验
  validateTeamProfile,
  // 事务
  joinTeamTx, leaveTeamTx,
  // 订阅消息
  sendSubscribeMsg, notifyUser,
  // 云函数互调（§5.19）
  callActivityInternal,
};
