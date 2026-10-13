// lib/audit.js — 操作审计日志写入（admin-module §6.2）
// 定时任务写入时 operator 固定为 "system"。fire-and-forget 由调用方（wrapAdminAction）控制超时。
const state = require('../state');

async function writeOperationLog(log) {
  const operator = log.operator || { id: 'system', name: 'system', role: 'system' };
  await state.db.collection('operation_log').add({
    data: {
      operator_id: operator.id,
      operator_name: operator.name,
      operator_role: operator.role,
      module: log.module,                 // activity/team/user/stats/album/order/admin
      action: log.action,                 // 点分式，如 activity.publish
      target_type: log.targetType || null,
      target_id: log.targetId || null,
      detail: log.detail || null,         // 已由 sanitizeDetail 处理，≤4KB
      result: log.result || 'success',    // success / fail
      error_msg: log.errorMsg || null,
      created_at: Date.now(),
    },
  });
}

module.exports = { writeOperationLog };
