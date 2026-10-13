// demo/cloud/wx-server-sdk.js — wx-server-sdk 模拟桩（CJS）
// server.mjs 通过 Module._resolveFilename 钩子把所有 require('wx-server-sdk')
// 重定向到本文件，原始云函数代码零改动直接在本地运行。
'use strict';

const emulator = require('./emulator');

const DYNAMIC_CURRENT_ENV = Symbol.for('wx-server-sdk.DYNAMIC_CURRENT_ENV');

// cloud.init({ env }) —— 本地单一环境，记录参数即可
function init() { /* no-op */ }

// cloud.database() —— 返回共享内存库 API（各云函数模块加载时各取一次，底层同一 Store）
function database() {
  return emulator.getDbCtx().db;
}

// cloud.getWXContext() —— OPENID 来自 AsyncLocalStorage（HTTP 头/内部调用链继承）
function getWXContext() {
  return {
    OPENID: emulator.currentOpenid(),
    APPID: 'wx-demo-appid',
    UNIONID: '',
    CLIENTIP: '127.0.0.1',
  };
}

// cloud.callFunction —— 进程内直调；嵌套调用自动继承当前 OPENID（内部互调
// 依靠 event.source/internal_token 鉴权，与 OPENID 无关；manage.js:988 无 token
// 调 admin 时则依赖继承的操作者 OPENID 走权限校验，语义与线上一致）
async function callFunction({ name, data }) {
  return emulator.invoke(name, data);
}

// ---------- 云支付模拟 ----------

const cloudPay = {
  unifiedOrder: (params) => emulator.pay.unifiedOrder(params),
  queryOrder: (params) => emulator.pay.queryOrder(params),
  refund: (params) => emulator.pay.refund(params),
  closeOrder: (params) => emulator.pay.closeOrder(params),
};

// ---------- 开放接口模拟 ----------

const openapi = {
  subscribeMessage: {
    // 订阅消息：fire-and-forget，仅记日志
    send: async (p) => {
      console.info('[demo] 订阅消息(模拟):', (p && p.touser) || '', (p && p.templateId) || '');
      return { errCode: 0, errMsg: 'openapi.subscribeMessage.send:ok' };
    },
  },
  phonenumber: {
    // 手机号快速验证：按演示身份返回预置手机号
    getPhoneNumber: async () => {
      const openid = emulator.currentOpenid();
      const phone = emulator.getActorPhone(openid) || '13800000000';
      return {
        errCode: 0,
        phoneInfo: {
          phoneNumber: phone,
          purePhoneNumber: phone,
          countryCode: '86',
          watermark: { timestamp: Date.now() },
        },
      };
    },
  },
};

// ---------- 云存储模拟 ----------

async function uploadFile({ cloudPath, fileContent }) {
  const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent || '');
  const fileID = emulator.filesPut(cloudPath, buf);
  return { fileID, statusCode: 200 };
}

async function getTempFileURL({ fileList }) {
  const list = (fileList || []).map((it) => {
    const fid = typeof it === 'string' ? it : it && it.fileID;
    const f = emulator.filesGet(fid);
    return {
      fileID: fid,
      tempFileURL: f ? '/api/file/' + emulator.parseFileId(fid) : '',
      status: f ? 0 : -1,
      errMsg: f ? 'ok' : 'file not found',
    };
  });
  return { fileList: list };
}

async function downloadFile({ fileID }) {
  const f = emulator.filesGet(fileID);
  if (!f) {
    const e = new Error('downloadFile:fail file not found');
    e.errMsg = e.message;
    throw e;
  }
  return { fileContent: f.content, statusCode: 200 };
}

async function deleteFile({ fileList }) {
  for (const fid of fileList || []) emulator.filesDelete(fid);
  return { fileList: (fileList || []).map((fid) => ({ fileID: fid, status: 0 })) };
}

module.exports = {
  DYNAMIC_CURRENT_ENV,
  init,
  database,
  getWXContext,
  callFunction,
  cloudPay,
  openapi,
  uploadFile,
  getTempFileURL,
  downloadFile,
  deleteFile,
};
