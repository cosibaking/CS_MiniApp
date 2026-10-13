// utils/cloud.js — 统一云函数调用封装
// 约定：wx.cloud.callFunction({ name, data: { action, payload } })，
// 云函数统一返回 { code, msg, data }，code=0 成功（architecture.md §6）。
const { CODE } = require('./constants');

function callRaw(name, action, payload) {
  return wx.cloud
    .callFunction({ name, data: { action, payload: payload || {} } })
    .then((res) => {
      const body = res.result || {};
      if (body.code === CODE.OK) return body;
      const err = new Error(body.msg || '请求失败');
      err.code = body.code;
      err.data = body.data;
      err.msg = err.message; // showError 读取 e.msg，统一暴露后端文案
      throw err;
    });
}

// 统一入口：
// - 1002(UNAUTHORIZED)：自动静默重登并重试一次
// - 1003(BANNED)：透传，由调用方展示封禁提示
// - 1004(FORBIDDEN)：透传，调用方 toast「无权限」
async function callCloud(name, action, payload) {
  try {
    return await callRaw(name, action, payload);
  } catch (e) {
    if (e.code === CODE.UNAUTHORIZED) {
      const app = getApp();
      if (app && app.silentLogin) await app.silentLogin();
      return callRaw(name, action, payload); // 重试一次
    }
    throw e;
  }
}

module.exports = { callCloud };
