// lib/permission.js — 权限校验（admin-module §5.19 checkPermission）
// 流程：openid → user（不存在/封禁 → 登录态失效）→ role → role_permission → permissions
// 缓存：角色权限 60s TTL 实例级内存缓存（角色配置更新后最多 60s 生效）
const state = require('../state');
const { BizError } = require('./response');
const { CODE } = require('./constants');

const CACHE_TTL = 60 * 1000;
const cache = new Map(); // role_key → { permissions, cachedAt }

async function getRolePermissions(roleKey) {
  const hit = cache.get(roleKey);
  const now = Date.now();
  if (hit && now - hit.cachedAt < CACHE_TTL) return hit.permissions;

  const res = await state.db.collection('role_permission').where({ role_key: roleKey }).limit(1).get();
  const permissions = (res.data && res.data[0] && res.data[0].permissions) || [];
  cache.set(roleKey, { permissions, cachedAt: now });
  return permissions;
}

// 角色配置变更后调用，立即失效缓存
function invalidateRoleCache() {
  cache.clear();
}

// 返回 { hasPermission, permissions, operator: { id, name, role } }
async function checkPermission(openid, permissionKey) {
  const userRes = await state.db.collection('user').where({ openid }).limit(1).get();
  const user = userRes.data && userRes.data[0];
  if (!user) throw new BizError(CODE.UNAUTHORIZED, '登录态失效或账号不可用');
  if (user.status === 'banned') throw new BizError(CODE.UNAUTHORIZED, '登录态失效或账号不可用');

  const roleKey = user.role || 'member';
  let permissions = [];
  try {
    permissions = await getRolePermissions(roleKey); // 角色记录缺失按空权限兜底
  } catch (e) {
    console.warn('[permission] 角色权限查询失败，按空权限兜底', e);
  }

  const hasPermission =
    permissionKey === undefined || permissionKey === null ||
    permissions.includes('*') ||
    permissions.includes(permissionKey);

  return {
    hasPermission,
    permissions,
    operator: { id: user._id, name: user.nickname || '未命名', role: roleKey },
  };
}

module.exports = { checkPermission, invalidateRoleCache };
