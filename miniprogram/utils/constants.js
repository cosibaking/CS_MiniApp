// utils/constants.js — 前端通用常量（与云函数 common/lib/constants.js 保持对齐）
// 说明：文档中 admin-module 用 1001=登录失效 / 1003=无权限，user-module 用 1001=参数错误，
// 框架统一拆分为互不冲突的基础码段（详见 docs 各模块错误码段）：
const CODE = {
  OK: 0,            // 成功
  PARAM: 1001,      // 参数校验失败（msg 注明字段）
  UNAUTHORIZED: 1002, // 登录态失效或账号不可用
  BANNED: 1003,     // 账号已被封禁（user-module §5.2）
  FORBIDDEN: 1004,  // 无权限执行该操作（admin-module §5.18）
  INTERNAL: 1006,   // 服务器内部错误（用户侧提示「服务器开小差了」）
  SYSTEM: 1099,     // 系统异常兜底
  NOT_IMPL: 1999,   // 框架占位：接口未实现
};

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

// team 模块业务码（与 cloudfunctions/team/actions/shared.js BIZ 保持对齐）
const TEAM_BIZ = {
  CAPTAIN_ONLY: 40302,
  TEAM_NOT_FOUND: 40401,
  RECORD_NOT_FOUND: 40402,
  ALREADY_IN_TEAM: 40901,
  NAME_TAKEN: 40902,
  TEAM_FULL: 40903,
  DUP_PENDING: 40904,
  TEAM_STATE: 40905,
  RECORD_HANDLED: 40907,
  TARGET_IN_TEAM: 40908,
  CAPTAIN_PROTECTED: 40910,
  QUOTA_SHORT: 40909,         // 活动名额不足（§5.19，activity 模块回传映射）
};

// admin 模块业务码（与 cloudfunctions/admin/actions/shared.js ADMIN_BIZ 对齐）
const ADMIN_BIZ = {
  DUP_ROLE: 5001,             // 角色标识/名称已存在
  UNREGISTERED_PERM: 5002,    // 未登记的权限点
  ROLE_NOT_FOUND: 5003,       // 角色不存在
  PRESET_PROTECTED: 5004,     // 预置角色不允许删除 / * 不可移除
  ROLE_IN_USE: 5005,          // 角色仍有用户引用
  LAST_ADMIN: 5006,           // 最后管理员保护
  OPTIMISTIC_LOCK: 5007,      // 乐观锁冲突（配置已被他人修改）
  SELF_OPERATION: 5008,       // 不能对本人操作
  BIZ_TYPE_UNREGISTERED: 5009,// 导入业务类型未注册
  FILE_OVER_LIMIT: 5010,      // 文件超限（>2MB / >500 行）
  FILE_INVALID: 5011,         // 文件不合法（非 xlsx / 表头不符）
  IMPORT_NOT_FOUND: 5012,     // 导入记录不存在
  EXPORT_TOO_LARGE: 5013,     // 日志导出范围过大（> 1 万行）
  EXPORT_FAILED: 5014,        // 导出文件生成失败
  NOT_FOUND: 5016,            // 资源不存在
};

// 预置角色名映射（database/seed.json §6.1；自定义角色显示 role_key 原样）
const ROLE_NAMES = {
  guest: '游客',
  member: '会员',
  captain: '战队队长',
  staff: '工作人员',
  admin: '管理员',
};

module.exports = { CODE, TEAM_BIZ, ADMIN_BIZ, ROLE_NAMES, levelOf, RANKS, rankOf };
