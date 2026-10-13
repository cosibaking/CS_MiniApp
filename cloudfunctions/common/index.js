// index.js — @club/admin-common 入口
// 使用方式：各云函数 index.js 中
//   const cloud = require('wx-server-sdk');
//   const common = require('@club/admin-common');
//   cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
//   common.setup({ cloud, db: cloud.database() });
const state = require('./state');

// 依赖注入：注入当前云函数的 cloud / db 实例
function setup({ cloud, db }) {
  state.cloud = cloud;
  state.db = db;
}

// 运行期获取注入的 cloud / db（action 处理器内部使用）
function getContext() {
  return { cloud: state.cloud, db: state.db };
}

const response = require('./lib/response');
const constants = require('./lib/constants');

module.exports = {
  setup,
  getContext,
  state,

  // 统一返回与业务错误
  ok: response.ok,
  fail: response.fail,
  BizError: response.BizError,
  withTimeout: response.withTimeout,

  // 参数校验
  assertParam: require('./lib/validate').assertParam,
  assertEnum: require('./lib/validate').assertEnum,
  assertPositiveInt: require('./lib/validate').assertPositiveInt,
  assertString: require('./lib/validate').assertString,

  // 权限校验（admin-module §5.19）
  checkPermission: require('./lib/permission').checkPermission,
  invalidateRoleCache: require('./lib/permission').invalidateRoleCache,

  // 审计与脱敏（admin-module §6.2）
  writeOperationLog: require('./lib/audit').writeOperationLog,
  sanitizeDetail: require('./lib/sanitize').sanitizeDetail,
  maskPhone: require('./lib/sanitize').maskPhone,

  // 敏感字段加解密（架构 §8.1：phone / guardian_phone AES）
  encryptField: require('./lib/crypto').encryptField,
  decryptField: require('./lib/crypto').decryptField,
  hashField: require('./lib/crypto').hashField,

  // 管理端 action 包装器（admin-module §5.18）
  wrapAdminAction: require('./lib/wrap').wrapAdminAction,

  // Excel 导入注册（admin-module §5.20）
  registerImporter: require('./lib/importer').registerImporter,
  getImporter: require('./lib/importer').getImporter,
  listImporters: require('./lib/importer').listImporters,

  // 骨架占位
  stub: require('./lib/stub').stub,

  // 常量与换算
  CODE: constants.CODE,
  PERMISSIONS: constants.PERMISSIONS,
  PRESET_ROLES: constants.PRESET_ROLES,
  LOG_MODULES: constants.LOG_MODULES,
  RANKS: constants.RANKS,
  levelOf: constants.levelOf,
  rankOf: constants.rankOf,
};
