// lib/constants.js — 云函数侧通用常量与换算
// 说明：文档中 admin-module 用 1001=登录失效 / 1003=无权限，user-module 用 1001=参数错误，
// 框架统一拆分为互不冲突的基础码段，模块业务错误码使用各自的号段（2xxx/3xxx/40xxx/4xxxx/5xxx）。
const CODE = {
  OK: 0,              // 成功
  PARAM: 1001,        // 参数校验失败（msg 注明字段，user-module §5.0）
  UNAUTHORIZED: 1002, // 登录态失效或账号不可用（admin-module §5.18 wrapAdminAction）
  BANNED: 1003,       // 账号已被封禁（user-module §5.2 login）
  FORBIDDEN: 1004,    // 无权限执行该操作（admin-module §5.18 authz-deny）
  INTERNAL: 1006,     // 服务器内部错误（用户侧提示「服务器开小差了」）
  SYSTEM: 1099,       // 系统异常兜底
  NOT_IMPL: 1999,     // 框架占位：接口未实现
};

// 权限点总表（admin-module §1.4，权威口径，13 项）
const PERMISSIONS = [
  { key: 'publish_activity', name: '发布活动', module_group: 'activity' },
  { key: 'cancel_activity', name: '取消活动', module_group: 'activity' },
  { key: 'audit_team', name: '战队审核', module_group: 'team' },
  { key: 'record_stats', name: '战绩录入', module_group: 'activity' },
  { key: 'upload_album', name: '相册上传', module_group: 'activity' },
  { key: 'checkin_activity', name: '现场签到核验', module_group: 'activity' },
  { key: 'audit_refund', name: '退款审核', module_group: 'order' },
  { key: 'view_operation_log', name: '操作日志查询', module_group: 'admin' },
  { key: 'role_manage', name: '角色与权限配置', module_group: 'admin' },
  { key: 'user_role_assign', name: '用户角色分配', module_group: 'admin' },
  { key: 'user_manage', name: '用户管理', module_group: 'user' },
  { key: 'user_ban', name: '封禁/解封', module_group: 'user' },
  { key: 'user_card_adjust', name: '会员卡人工调整', module_group: 'user' },
];

// 预置角色（admin-module §6.1 种子数据，幂等 upsert 以 role_key 为准）
const PRESET_ROLES = [
  { role_key: 'guest', permissions: [], is_preset: true, description: '游客（未登录/默认）' },
  { role_key: 'member', permissions: [], is_preset: true, description: '普通会员' },
  { role_key: 'captain', permissions: [], is_preset: true, description: '战队队长' },
  { role_key: 'staff', permissions: ['checkin_activity', 'record_stats', 'upload_album'], is_preset: true, description: '现场工作人员' },
  { role_key: 'admin', permissions: ['*'], is_preset: true, description: '超级管理员' },
];

// operation_log 模块枚举（admin-module §6.2）
const LOG_MODULES = ['activity', 'team', 'user', 'stats', 'album', 'order', 'admin'];

// 会员等级换算（user-module R14）：按累计场次实时换算，不落库
function levelOf(totalGames) {
  const n = totalGames || 0;
  if (n <= 0) return { level: 0, name: '未定级', discount_percent: null };
  if (n < 10) return { level: 1, name: '新兵', discount_percent: null };
  if (n < 30) return { level: 2, name: '老兵', discount_percent: null };
  if (n < 60) return { level: 3, name: '精英', discount_percent: 95 };
  return { level: 4, name: '王牌', discount_percent: 90 };
}

// 军衔表（user-module R15）：击杀门槛/胜场门槛，双门槛与门短板决定
const RANKS = [
  { key: 'recruit', name: '新兵', kills: 0, wins: 0 },
  { key: 'pfc', name: '一等兵', kills: 15, wins: 1 },
  { key: 'corporal', name: '下士', kills: 50, wins: 4 },
  { key: 'sergeant', name: '中士', kills: 100, wins: 8 },
  { key: 'staff_sergeant', name: '上士', kills: 180, wins: 14 },
  { key: 'master_sergeant', name: '军士长', kills: 300, wins: 21 },
  { key: 'second_lieutenant', name: '少尉', kills: 450, wins: 30 },
  { key: 'first_lieutenant', name: '中尉', kills: 650, wins: 40 },
  { key: 'captain', name: '上尉', kills: 900, wins: 52 },
  { key: 'major', name: '少校', kills: 1200, wins: 66 },
  { key: 'lieutenant_colonel', name: '中校', kills: 1600, wins: 88 },
  { key: 'colonel', name: '上校', kills: 2100, wins: 112 },
  { key: 'senior_colonel', name: '大校', kills: 2800, wins: 140 },
  { key: 'major_general', name: '少将', kills: 3600, wins: 180 },
];

// 军衔计算：从低到高取最后一个双门槛均达标的档位
function rankOf(totalKills, totalWins) {
  let current = RANKS[0];
  for (const r of RANKS) {
    if ((totalKills || 0) >= r.kills && (totalWins || 0) >= r.wins) current = r;
  }
  return current;
}

module.exports = { CODE, PERMISSIONS, PRESET_ROLES, LOG_MODULES, RANKS, levelOf, rankOf };
