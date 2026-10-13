// actions/role.js — 角色 CRUD（admin-module §5.1-§5.5）
// wrapAdminAction：role_manage 权限 + 审计日志（role.create/update/delete；list/detail 读操作不写日志）
// 保护规则：预置角色不可改删（5004）、有用户引用不可删（5005）、乐观锁 updated_at（5007）
// _id = role_key（与 seed.json 预置角色一致，role_id 即 role_key）
const common = require('@club/admin-common');
const S = require('./shared');
const { wrapAdminAction, CODE, BizError, assertString, invalidateRoleCache } = common;
const { ADMIN_BIZ, ROLE_KEY_RE, pick, hasAnyPermission, validatePermissionList } = S;

// ---------- §5.1 role/create ----------
async function roleCreate(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'role_key', 'name', 'permissions', 'description');

  assertString(p.role_key, 'role_key', { max: 31 });
  if (!ROLE_KEY_RE.test(p.role_key)) {
    throw new BizError(CODE.PARAM, '参数错误：role_key 需匹配 ^[a-z][a-z0-9_]{1,30}$');
  }
  assertString(p.name, 'name', { min: 1, max: 20 });
  if (p.description !== undefined && p.description !== null) {
    assertString(p.description, 'description', { max: 100 });
  }
  const permissions = validatePermissionList(p.permissions);

  // 唯一性：role_key / name（5001）
  const dupKey = await db.collection('role_permission').where({ role_key: p.role_key }).count();
  if (dupKey.total > 0) {
    throw new BizError(ADMIN_BIZ.DUP_ROLE, `角色标识已存在：${p.role_key}`);
  }
  const dupName = await db.collection('role_permission').where({ name: p.name }).count();
  if (dupName.total > 0) {
    throw new BizError(ADMIN_BIZ.DUP_ROLE, `角色名称已存在：${p.name}`);
  }

  const now = Date.now();
  const role = {
    role_key: p.role_key,
    name: p.name,
    permissions,
    description: p.description || '',
    is_preset: false,
    user_count: 0,
    created_at: now,
    updated_at: now,
  };
  await db.collection('role_permission').add({ data: { _id: p.role_key, ...role } });

  // 日志快照（wrap detail 读取）
  event._logAfter = { role_key: role.role_key, name: role.name, permissions: role.permissions, description: role.description };
  return { role_id: role.role_key };
}

// ---------- §5.2 role/update（乐观锁 R16） ----------
async function roleUpdate(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'role_key', 'name', 'permissions', 'description', 'base_updated_at');
  const _ = db.command;

  assertString(p.role_key, 'role_key', { max: 31 });
  if (typeof p.base_updated_at !== 'number') {
    throw new BizError(CODE.PARAM, '参数错误：base_updated_at 需为毫秒时间戳');
  }
  const hasUpdate = p.name !== undefined || p.permissions !== undefined || p.description !== undefined;
  if (!hasUpdate) {
    throw new BizError(CODE.PARAM, '参数错误：至少提交一项变更（name/permissions/description）');
  }

  const roleRes = await db.collection('role_permission').where({ role_key: p.role_key }).limit(1).get();
  const role = roleRes.data[0];
  if (!role) throw new BizError(ADMIN_BIZ.ROLE_NOT_FOUND, `角色不存在：${p.role_key}`);

  // 预置保护：admin 的 * 不可移除（5004）；role_key 本身不可改（入参即查询键，天然不可改）
  let permissions = role.permissions || [];
  if (p.permissions !== undefined) {
    permissions = validatePermissionList(p.permissions);
    if (role.role_key === 'admin' && !permissions.includes('*')) {
      throw new BizError(ADMIN_BIZ.PRESET_PROTECTED, '预置 admin 角色的 * 通配权限不可移除');
    }
  }
  let name = role.name;
  if (p.name !== undefined) {
    assertString(p.name, 'name', { min: 1, max: 20 });
    name = p.name;
    const dupName = await db.collection('role_permission')
      .where({ name, role_key: _.neq(p.role_key) }).count();
    if (dupName.total > 0) throw new BizError(ADMIN_BIZ.DUP_ROLE, `角色名称已存在：${p.name}`);
  }
  let description = p.description !== undefined && p.description !== null
    ? (assertString(p.description, 'description', { max: 100 }), p.description)
    : (p.description === null ? '' : role.description || '');

  // 乐观锁：updated_at == base_updated_at 才生效（5007）
  const now = Date.now();
  const upd = await db.collection('role_permission')
    .where({ role_key: p.role_key, updated_at: p.base_updated_at })
    .update({ data: { name, permissions, description, updated_at: now } });
  if (!upd.stats || upd.stats.updated === 0) {
    throw new BizError(ADMIN_BIZ.OPTIMISTIC_LOCK, '配置已被他人修改，请刷新重试');
  }
  invalidateRoleCache(); // 权限即时生效（E2）

  event._logBefore = { name: role.name, permissions: role.permissions || [] };
  event._logAfter = { name, permissions };
  return { role_key: p.role_key, updated_at: now };
}

// ---------- §5.3 role/delete（引用检查 R6） ----------
async function roleDelete(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'role_key');
  assertString(p.role_key, 'role_key', { max: 31 });

  const roleRes = await db.collection('role_permission').where({ role_key: p.role_key }).limit(1).get();
  const role = roleRes.data[0];
  if (!role) throw new BizError(ADMIN_BIZ.ROLE_NOT_FOUND, `角色不存在：${p.role_key}`);
  if (role.is_preset) throw new BizError(ADMIN_BIZ.PRESET_PROTECTED, '预置角色不允许删除');

  const used = await db.collection('user').where({ role: p.role_key }).count();
  if (used.total > 0) {
    throw new BizError(ADMIN_BIZ.ROLE_IN_USE, `该角色仍有 ${used.total} 名用户使用，请先迁移`);
  }

  await db.collection('role_permission').doc(role._id).remove();
  invalidateRoleCache();

  event._logBefore = {
    role_key: role.role_key, name: role.name,
    permissions: role.permissions || [], description: role.description || '',
  };
  return null;
}

// ---------- §5.4 role/list（role_manage 或 user_role_assign 任一，读不写日志） ----------
async function roleList(event, auth) {
  const { db } = common.getContext();
  if (!hasAnyPermission(auth, 'role_manage', 'user_role_assign')) {
    throw new BizError(CODE.FORBIDDEN, '无权限执行该操作');
  }
  const res = await db.collection('role_permission')
    .orderBy('is_preset', 'desc')     // 预置优先
    .orderBy('updated_at', 'desc')
    .limit(100)
    .get();

  // user_count 聚合（user.role 分组计数）
  const $ = db.command.aggregate;
  const agg = await db.collection('user').aggregate()
    .group({ _id: '$role', count: $.sum(1) })
    .end();
  const countMap = {};
  (agg.list || []).forEach((x) => {
    if (x._id) countMap[x._id] = x.count;
  });

  return {
    list: res.data.map((r) => ({
      role_key: r.role_key,
      name: r.name,
      permissions: r.permissions || [],
      is_preset: !!r.is_preset,
      description: r.description || '',
      user_count: r.user_count != null ? r.user_count : (countMap[r.role_key] || 0),
      updated_at: r.updated_at || 0,
    })),
  };
}

// ---------- §5.5 role/detail（权限点展开，读不写日志） ----------
async function roleDetail(event, auth) {
  const { db } = common.getContext();
  const p = pick(event, 'role_key');
  assertString(p.role_key, 'role_key', { max: 31 });

  const roleRes = await db.collection('role_permission').where({ role_key: p.role_key }).limit(1).get();
  const role = roleRes.data[0];
  if (!role) throw new BizError(ADMIN_BIZ.ROLE_NOT_FOUND, `角色不存在：${p.role_key}`);

  // 权限点展开：优先 permission_point 集合口径的常量表（§5.6 说明，出参结构一致）
  const permMap = new Map(
    common.PERMISSIONS.map((x) => [x.key, { key: x.key, name: x.name, module_group: x.module_group }])
  );
  const used = await db.collection('user').where({ role: p.role_key }).count();

  return {
    role_key: role.role_key,
    name: role.name,
    permissions: role.permissions || [],
    permission_details: (role.permissions || []).map((k) => permMap.get(k) || { key: k, name: k, module_group: 'admin' }),
    is_preset: !!role.is_preset,
    description: role.description || '',
    user_count: role.user_count != null ? role.user_count : (used.total || 0),
    updated_at: role.updated_at || 0,
    created_at: role.created_at || 0,
  };
}

module.exports = {
  // §5.1 role/create — 创建角色（5001 重名/5002 未登记权限点）→ 日志 role.create
  'role/create': wrapAdminAction('role.create', roleCreate, {
    permission: 'role_manage', module: 'admin', targetType: 'role',
    targetId: (event, result) => (result && result.role_key) || null,
    detail: (event) => ({ after: event._logAfter || null }),
  }),
  // §5.2 role/update — 更新角色（乐观锁 5007）→ 日志 role.update（before/after 权限数组）
  'role/update': wrapAdminAction('role.update', roleUpdate, {
    permission: 'role_manage', module: 'admin', targetType: 'role',
    targetId: (event) => (event.payload || {}).role_key,
    detail: (event) => {
      const b = event._logBefore || {};
      const a = event._logAfter || {};
      return {
        before: b.permissions || null,
        after: a.permissions || null,
        name_change: b.name !== a.name ? `${b.name || '-'} → ${a.name || '-'}` : null,
      };
    },
  }),
  // §5.3 role/delete — 删除角色（5004 预置/5005 引用）→ 日志 role.delete（before 角色定义）
  'role/delete': wrapAdminAction('role.delete', roleDelete, {
    permission: 'role_manage', module: 'admin', targetType: 'role',
    targetId: (event) => (event.payload || {}).role_key,
    detail: (event) => ({ before: event._logBefore || null }),
  }),
  // §5.4 role/list — 角色列表（读操作不写日志 R9；权限为任一：role_manage/user_role_assign）
  'role/list': wrapAdminAction('role.list', roleList, {
    permission: null, module: 'admin', targetType: 'role', log: false,
  }),
  // §5.5 role/detail — 角色详情（读操作不写日志 R9）
  'role/detail': wrapAdminAction('role.detail', roleDetail, {
    permission: 'role_manage', module: 'admin', targetType: 'role',
    targetId: (event) => (event.payload || {}).role_key, log: false,
  }),
};
