// lib/importer.js — Excel 导入注册框架（admin-module §5.20 registerImporter）
// 各模块以 def 注册导入能力，admin 云函数 runImport 统一调度（M2 实现）。
// def 结构：{
//   bizType,        // 业务类型（唯一键，如 activity_stats）
//   permission,     // 权限点（如 record_stats）
//   module,         // 日志 module（activity/user/...）
//   logAction,      // 日志 action（如 stats.import）
//   requireBizId,   // 是否必填业务 ID（如 activity_id）
//   templateFileId, // 模板文件 cloudID
//   version,        // 模板版本号
//   columns: [{ col, title, required, example, desc }],
//   validateRow(row, ctx) → null | 错误信息,
//   writeRow(row, ctx),
// }

const importers = new Map(); // bizType → def

function registerImporter(def) {
  if (!def || !def.bizType) throw new Error('registerImporter: bizType 必填');
  importers.set(def.bizType, def);
  return def;
}

function getImporter(bizType) {
  return importers.get(bizType) || null;
}

function listImporters() {
  return Array.from(importers.values());
}

module.exports = { registerImporter, getImporter, listImporters };
