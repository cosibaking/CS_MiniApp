// actions/shared.js — admin 模块共享辅助（admin-module §5.0 业务错误码 5xxx + 取参/权限辅助）
// 说明：文档 1004（资源不存在）在本框架基础码段已被 FORBIDDEN 占用，admin 内统一改用 5016。
// 日志 before/after 约定：handler 把业务前快照挂 event._logBefore / event._logAfter，
//   wrapAdminAction 的 detail 函数从 event 读取（请求级对象，并发互不串扰）。
const common = require('@club/admin-common');
const { CODE, PERMISSIONS, BizError } = common;

const ADMIN_BIZ = {
  DUP_ROLE: 5001,              // 角色标识或名称已存在
  UNREGISTERED_PERM: 5002,     // 存在未登记的权限点
  ROLE_NOT_FOUND: 5003,        // 角色不存在
  PRESET_PROTECTED: 5004,      // 预置角色不允许该操作
  ROLE_IN_USE: 5005,           // 该角色仍有用户使用
  LAST_ADMIN: 5006,            // 系统需保留至少一名管理员
  OPTIMISTIC_LOCK: 5007,       // 配置已被他人修改，请刷新重试
  SELF_OPERATION: 5008,        // 不能对本人执行该操作
  BIZ_TYPE_UNREGISTERED: 5009, // 不支持的导入类型
  FILE_OVER_LIMIT: 5010,       // 文件超出导入限制（>2MB 或 >500 行）
  FILE_INVALID: 5011,          // 文件格式错误（非 xlsx / 表头不匹配 / 解析失败）
  IMPORT_NOT_FOUND: 5012,      // 导入任务不存在
  EXPORT_TOO_LARGE: 5013,      // 日志导出范围过大（>10000 行，E9）
  EXPORT_FAILED: 5014,         // 导出文件生成失败（E9）
  NOT_FOUND: 5016,             // 资源不存在（用户/日志，替代文档 1004 口径）
};

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;

// 从 event.payload 取指定字段（缺省 undefined）
function pick(event, ...keys) {
  const p = (event && event.payload) || {};
  const out = {};
  keys.forEach((k) => {
    out[k] = p[k];
  });
  return out;
}

// 分页参数归一：默认 1/20，上限 100
function normalizePagination(p) {
  let page = Number(p.page);
  let pageSize = Number(p.page_size);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 20;
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize };
}

// 持有任一权限点（含 * 通配）——供 role/list「role_manage 或 user_role_assign」类场景
function hasAnyPermission(auth, ...keys) {
  const perms = (auth && auth.permissions) || [];
  if (perms.includes('*')) return true;
  return keys.some((k) => perms.includes(k));
}

// 校验权限点数组：逐项登记 → 去重；不可为 ["*"]（* 仅预置 admin 固有）
function validatePermissionList(permissions) {
  if (!Array.isArray(permissions)) {
    throw new BizError(CODE.PARAM, '参数错误：permissions 需为数组');
  }
  const registry = new Set(PERMISSIONS.map((x) => x.key));
  const seen = new Set();
  const out = [];
  permissions.forEach((key) => {
    if (typeof key !== 'string' || !registry.has(key)) {
      throw new BizError(ADMIN_BIZ.UNREGISTERED_PERM, `存在未登记的权限点：${key}`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  });
  if (out.includes('*')) {
    throw new BizError(ADMIN_BIZ.PRESET_PROTECTED, '通配权限 * 仅预置 admin 角色固有，不可配置');
  }
  return out;
}

module.exports = { ADMIN_BIZ, ROLE_KEY_RE, pick, normalizePagination, hasAnyPermission, validatePermissionList };
