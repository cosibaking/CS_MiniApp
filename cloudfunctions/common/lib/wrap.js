// lib/wrap.js — 管理端 action 包装器（admin-module §5.18 wrapAdminAction）
// 职责：鉴权（checkPermission 硬校验）→ 业务（handler）→ 审计日志（非阻断，800ms 限时）→ 统一返回
const state = require('../state');
const { checkPermission } = require('./permission');
const { writeOperationLog } = require('./audit');
const { sanitizeDetail } = require('./sanitize');
const { withTimeout, fail, ok } = require('./response');
const { CODE } = require('./constants');

const LOG_WRITE_TIMEOUT = 800; // 日志写入限时（ms），超时放弃并告警，不阻断业务

// wrapAdminAction(action, handler, options)
// options: { permission, module, targetType, targetId?(event, result), detail?(event, result), log?: false, skipLog?(event, result) }
// log: false —— 查询类操作不写审计日志（admin-module R9），或 handler 自写业务日志（如 import/submit）避免重复埋点
// skipLog —— 返回 true 时跳过本次日志（如 grant 同值幂等返回，设计约定不埋点）
// detail 动态 before/after 约定：handler 可把业务前快照挂到 event._logBefore / event._logAfter，
//   detail 函数从 event 读取（event 为请求级对象，并发请求互不串扰）
function wrapAdminAction(action, handler, options = {}) {
  return async (event, context) => {
    const { cloud } = state;
    const { OPENID } = cloud.getWXContext();

    // 1. 登录态校验
    let auth;
    try {
      auth = await checkPermission(OPENID, options.permission);
    } catch (err) {
      return fail(CODE.UNAUTHORIZED, '登录态失效或账号不可用');
    }

    // 2. 权限点硬校验（越权不写日志，仅告警）
    if (options.permission && !auth.hasPermission) {
      console.warn(
        `[authz-deny] openid=${OPENID} permission=${options.permission} action=${action}`
      );
      return fail(CODE.FORBIDDEN, '无权限执行该操作');
    }

    // 3. 业务执行
    let result = null;
    let bizError = null;
    try {
      result = await handler(event, auth, context);
    } catch (err) {
      bizError =
        err && err.code && err.msg
          ? err
          : { code: CODE.INTERNAL, msg: '服务器开小差了' };
      console.error(`[biz-error] action=${action}`, err);
    }

    // 4. 审计日志（非阻断；log:false 的读操作或 handler 自写场景跳过；skipLog 幂等返回跳过）
    if (options.log !== false) {
      let skipped = false;
      try {
        skipped = options.skipLog ? await options.skipLog(event, result) : false;
      } catch (skipErr) {
        skipped = false;
      }
      if (!skipped) {
        try {
          await withTimeout(
            writeOperationLog({
              operator: auth.operator,
              module: options.module,
              action,
              targetType: options.targetType,
              targetId: options.targetId ? options.targetId(event, result) : null,
              detail: sanitizeDetail(
                options.detail ? await options.detail(event, result) : null
              ),
              result: bizError ? 'fail' : 'success',
              errorMsg: bizError ? bizError.msg : null,
            }),
            LOG_WRITE_TIMEOUT
          );
        } catch (logErr) {
          console.warn('[op-log] write failed (非阻断):', logErr);
        }
      }
    }

    // 5. 统一返回
    if (bizError) return fail(bizError.code, bizError.msg, bizError.data);
    return ok(result === undefined || result === null ? null : result);
  };
}

module.exports = { wrapAdminAction };
