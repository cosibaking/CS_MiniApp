// actions/perm.js — 权限点查询（admin-module §5.6-§5.7）
const common = require('@club/admin-common');
const { ok, checkPermission, PERMISSIONS, wrapAdminAction } = common;

// §5.6 permission/list — 权限点总表（role_manage，读操作不写日志 R9）
// 优先读 permission_point 集合（种子与常量一致）；集合不可用时退化为公共层常量表，出参结构不变
async function permissionListImpl(event, auth) {
  const { db } = common.getContext();
  let points = [];
  try {
    const res = await db.collection('permission_point').orderBy('key', 'asc').limit(100).get();
    points = res.data || [];
  } catch (e) {
    console.warn('[permission/list] permission_point 集合不可用，退化为常量表', e);
  }
  if (!points.length) {
    points = PERMISSIONS.map((x) => ({ ...x, description: x.name, status: 'enabled' }));
  }

  const GROUP_ORDER = ['activity', 'team', 'user', 'order', 'admin'];
  const groups = [];
  const groupMap = new Map();
  points.forEach((p) => {
    const g = p.module_group || 'admin';
    if (!groupMap.has(g)) {
      groupMap.set(g, []);
      groups.push(g);
    }
    groupMap.get(g).push({
      key: p.key,
      name: p.name,
      description: p.description || p.name,
      status: p.status || 'enabled',
    });
  });
  groups.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  return { groups: groups.map((g) => ({ module_group: g, points: groupMap.get(g) })) };
}

// §5.7 permission/my — 当前用户权限点（真实最小实现）
// 供前端管理端菜单可见性使用（双层防线的前端层；云函数侧仍硬校验）
async function permissionMy() {
  const { cloud } = common.getContext();
  const { OPENID } = cloud.getWXContext();
  try {
    const auth = await checkPermission(OPENID, null);
    return ok({
      permissions: auth.permissions,
      operator: auth.operator,
    });
  } catch (e) {
    // 登录态失效：返回空权限（前端按普通会员处理，不弹错误）
    return ok({ permissions: [], operator: null });
  }
}

module.exports = {
  'permission/list': wrapAdminAction('permission.list', permissionListImpl, {
    permission: 'role_manage', module: 'admin', targetType: 'role', log: false,
  }),
  'permission/my': permissionMy,
};
