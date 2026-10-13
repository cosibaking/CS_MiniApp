// lib/response.js — 统一返回结构与业务错误
// 约定：云函数统一返回 { code, msg, data }，code=0 成功，msg 为可直接展示的简体中文。
const { CODE } = require('./constants');

// 业务错误：throw 后由 wrapAdminAction / index 路由层转为 fail 返回
class BizError extends Error {
  constructor(code, msg, data) {
    super(msg || '业务错误');
    this.code = code;
    this.msg = this.message;
    this.data = data || null;
  }
}

function ok(data, msg) {
  return { code: CODE.OK, msg: msg || 'ok', data: data === undefined ? null : data };
}

function fail(code, msg, data) {
  return {
    code: code === undefined || code === null ? CODE.INTERNAL : code,
    msg: msg || '请求失败',
    data: data === undefined ? null : data,
  };
}

// 限时执行：超时 reject（用于操作日志写入 800ms 上限，admin-module §5.18）
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { BizError, ok, fail, withTimeout };
