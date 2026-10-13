// actions/grant.js — 用户角色授权（admin-module §5.7-§5.9）
// wrapAdminAction：user_role_assign 权限 + 审计日志（role.grant/role.revoke，before/after 角色快照）
// 保护规则：不能操作本人（5008）、角色不存在（5003）、最后管理员（5006）、用户不存在（5016）
// 同值幂等：grant 目标角色与现值相同 → 返回成功但不写日志（设计约定）；revoke 目标本就是 member 同理
const common = require('@club/admin-common');
const S = require('./shared');
const { wrapAdminAction, CODE, BizError, assertString, hashField, decryptField, maskPhone } = common;
const { ADMIN_BIZ, pick, normalizePagination } = S;

// 冗余刷新：role_permission.user_count（fire-and-forget，失败仅告警，§6.6）
function refreshUserCount(db, roleKey) {
  return db.collection('user').where({ role: roleKey }).count()
    .then((cnt) => db.collection('role_permission')
      .where({ role_key: roleKey })
      .update({ data: { user_count: cnt.total || 0 } }))
    .catch((e) => console.warn(`[user_count] 刷新失败 role=${roleKey}`, e));
}

// 加载目标用户（5016 不存在；封禁按登录态口径拒绝）
async function loadTargetUser(db, userId) {
  const res = await db.collection('user').where({ _id: userId }).limit(1).get();
  const user = res.data[0];
  if (!user) throw new BizError(ADMIN_BIZ.NOT_FOUND, '用户不存在');
  if (user.status === 'banned') throw new BizError(CODE.UNAUTHORIZED, '目标账号已被封禁');
  return user;
}

// ---------- §5.7 user/grant-role ----------
async function grantRole(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'user_id', 'role_key', 'remark');
  assertString(p.user_id, 'user_id');
  assertString(p.role_key, 'role_key', { max: 31 });
  if (p.remark !== undefined && p.remark !== null) {
    assertString(p.remark, 'remark', { max: 200 });
  }

  if (p.user_id === auth.operator.id) {
    throw new BizError(ADMIN_BIZ.SELF_OPERATION, '不能对本人执行该操作');
  }
  const user = await loadTargetUser(db, p.user_id);

  const roleRes = await db.collection('role_permission').where({ role_key: p.role_key }).limit(1).get();
  const role = roleRes.data[0];
  if (!role) throw new BizError(ADMIN_BIZ.ROLE_NOT_FOUND, `角色不存在：${p.role_key}`);

  const oldRole = user.role || 'member';
  const now = Date.now();
  event._logBefore = { role: oldRole };
  event._logAfter = { role: role.role_key };
  event._remark = p.remark || null;
  event._noopGrant = oldRole === role.role_key; // 同值幂等：成功返回但不写日志

  if (!event._noopGrant) {
    await db.collection('user').doc(user._id).update({
      data: { role: role.role_key, role_updated_at: now },
    });
    // 冗余异步刷新（新旧角色 user_count）
    refreshUserCount(db, oldRole);
    refreshUserCount(db, role.role_key);
  }
  return { user_id: user._id, role: role.role_key, role_name: role.name };
}

// ---------- §5.8 user/revoke-role（回退 member） ----------
async function revokeRole(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'user_id', 'remark');
  assertString(p.user_id, 'user_id');
  if (p.remark !== undefined && p.remark !== null) {
    assertString(p.remark, 'remark', { max: 200 });
  }

  if (p.user_id === auth.operator.id) {
    throw new BizError(ADMIN_BIZ.SELF_OPERATION, '不能对本人执行该操作');
  }
  const user = await loadTargetUser(db, p.user_id);

  const oldRole = user.role || 'member';
  const now = Date.now();
  event._logBefore = { role: oldRole };
  event._logAfter = { role: 'member' };
  event._remark = p.remark || null;
  event._noopGrant = oldRole === 'member'; // 本就是会员：幂等返回不写日志

  if (!event._noopGrant) {
    // 最后管理员保护（R8/E10）：现角色持有 * 且仅剩这一名用户 → 5006
    const roleRes = await db.collection('role_permission').where({ role_key: oldRole }).limit(1).get();
    const role = roleRes.data[0];
    if (role && (role.permissions || []).includes('*')) {
      const holders = await db.collection('user').where({ role: oldRole }).count();
      if (holders.total <= 1) {
        throw new BizError(ADMIN_BIZ.LAST_ADMIN, '系统需保留至少一名管理员');
      }
    }
    await db.collection('user').doc(user._id).update({
      data: { role: 'member', role_updated_at: now },
    });
    refreshUserCount(db, oldRole);
  }
  return { user_id: user._id, role: 'member' };
}

// ---------- §5.9 user/role-list（授权页目标用户搜索，读不写日志） ----------
async function userRoleList(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'role_key', 'keyword', 'page', 'page_size');
  if (p.keyword !== undefined && p.keyword !== null) {
    assertString(p.keyword, 'keyword', { max: 32 });
  }
  const { page, pageSize } = normalizePagination(p);

  const where = {};
  if (p.role_key) where.role = p.role_key;
  const keyword = String(p.keyword || '').trim();
  if (keyword) {
    // 与 team search-users 同口径：完整 11 位手机号 → phone_hash 等值；否则昵称模糊（转义）
    if (/^1\d{10}$/.test(keyword)) {
      where.phone_hash = hashField(keyword);
    } else {
      const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      where.nickname = db.RegExp({ regexp: safe, options: 'i' });
    }
  }

  const cnt = await db.collection('user').where(where).count();
  const res = await db.collection('user').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .get();

  // 角色名映射（角色量级 < 50，一次拉全量）
  const roleRes = await db.collection('role_permission').limit(100).get();
  const roleNameMap = new Map(roleRes.data.map((r) => [r.role_key, r.name]));

  return {
    total: cnt.total || 0,
    page,
    page_size: pageSize,
    list: res.data.map((u) => {
      const plainPhone = u.phone ? decryptField(u.phone) : null;
      const role = u.role || 'member';
      return {
        user_id: u._id,
        nickname: u.nickname || '会员',
        avatar: u.avatar || null,
        phone: plainPhone ? maskPhone(plainPhone) : null,
        role,
        role_name: roleNameMap.get(role) || role,
        status: u.status || 'normal',
        created_at: u.created_at || 0,
        role_updated_at: u.role_updated_at || null,
      };
    }),
  };
}

module.exports = {
  // §5.7 user/grant-role — 授予角色 → 日志 role.grant（同值幂等返回不写日志）
  'user/grant-role': wrapAdminAction('role.grant', grantRole, {
    permission: 'user_role_assign', module: 'admin', targetType: 'user',
    targetId: (event) => (event.payload || {}).user_id,
    skipLog: (event) => !!event._noopGrant,
    detail: (event) => ({
      before: (event._logBefore && event._logBefore.role) || null,
      after: (event._logAfter && event._logAfter.role) || null,
      remark: event._remark || null,
    }),
  }),
  // §5.8 user/revoke-role — 撤销角色（回落 member，5006 最后管理员）→ 日志 role.revoke
  'user/revoke-role': wrapAdminAction('role.revoke', revokeRole, {
    permission: 'user_role_assign', module: 'admin', targetType: 'user',
    targetId: (event) => (event.payload || {}).user_id,
    skipLog: (event) => !!event._noopGrant,
    detail: (event) => ({
      before: (event._logBefore && event._logBefore.role) || null,
      after: (event._logAfter && event._logAfter.role) || null,
      remark: event._remark || null,
    }),
  }),
  // §5.9 user/role-list — 按角色/关键词查询用户（读操作不写日志 R9）
  'user/role-list': wrapAdminAction('role.user.list', userRoleList, {
    permission: 'user_role_assign', module: 'admin', targetType: 'user',
    targetId: (event) => (event.payload || {}).user_id || null, log: false,
  }),
};
