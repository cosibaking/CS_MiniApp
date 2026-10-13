// demo/cloud/emulator.js — 云函数模拟器核心
// 职责：
//   1. 函数注册表：承载原始 cloudfunctions/*/index.js 的 exports.main
//   2. AsyncLocalStorage 注入 per-request OPENID（getWXContext 数据源）
//   3. 调用串行化（与内存库事务/共享状态互斥）
//   4. 云支付模拟（unifiedOrder/queryOrder/refund/closeOrder + 确认支付回调闭环）
//   5. 虚拟文件存储（cloud://demo/<id>，供 uploadFile/临时链接/下载）
'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { createDb, genId } = require('./db');

const als = new AsyncLocalStorage();
const functions = new Map(); // name → exports.main
const payState = new Map(); // outTradeNo → 'NOTPAY'|'SUCCESS'|'CLOSED'|'REFUND'
const files = new Map(); // id → { cloudPath, content: Buffer, mime }

let dbCtx = null;
let demoActors = [];

// 调用串行化：内存库 + 事务快照假设单飞行调用，全部入队逐个执行
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

// ---------- 初始化与数据 ----------

function init({ persistFile, actors }) {
  dbCtx = createDb({ persistFile });
  demoActors = actors || [];
  return dbCtx;
}

function getDbCtx() {
  if (!dbCtx) throw new Error('emulator 未初始化');
  return dbCtx;
}

function register(name, main) {
  functions.set(name, main);
}

function hasFunction(name) {
  return functions.has(name);
}

function currentOpenid() {
  const s = als.getStore();
  return s ? s.openid : null;
}

function replaceAll(collections) {
  getDbCtx().store.restore(collections || {});
  getDbCtx().save();
}

function exportAll() {
  return getDbCtx().store.toJSON();
}

function flushSave() {
  getDbCtx().save();
}

// ---------- 调用 ----------

// 嵌套深度：>0 表示当前已在一个云函数执行栈内（云函数间 cloud.callFunction 互调）。
// 外层已通过队列串行化，嵌套调用直接同步执行，否则会排队等待外层完成 → 死锁。
let depth = 0;

async function invoke(name, data, opts = {}) {
  if (!functions.has(name)) {
    const e = new Error('cloud.callFunction:fail 云函数未注册: ' + name);
    e.errMsg = e.message;
    throw e;
  }
  const main = functions.get(name);
  const openid = opts.openid !== undefined ? opts.openid : currentOpenid();
  if (depth > 0) {
    // 嵌套调用：openid 继承父级上下文（与真实 TCB 一致），不经过队列
    depth += 1;
    try {
      const result = await als.run({ openid }, () => main(data || {}));
      return { result };
    } finally {
      depth -= 1;
    }
  }
  const result = await enqueue(() => {
    depth += 1;
    return als.run({ openid }, () => main(data || {})).finally(() => {
      depth -= 1;
    });
  });
  return { result };
}

// 定时任务触发：event 形如 { Type: 'Timer', TriggerName }
function runCron(name, triggerName) {
  return invoke(name, { Type: 'Timer', TriggerName: triggerName });
}

// ---------- 支付模拟 ----------

function makePaymentPackage(outTradeNo) {
  return {
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: genId().slice(0, 16),
    package: 'prepay_id=demo_' + outTradeNo,
    signType: 'RSA',
    paySign: 'demo-sign-' + genId().slice(0, 12),
  };
}

const pay = {
  // 真实返回 res.payment（order/actions/shared.js:189-197 取 res.payment）
  async unifiedOrder(params) {
    payState.set(params.outTradeNo, 'NOTPAY');
    return { payment: makePaymentPackage(params.outTradeNo) };
  },
  async queryOrder(params) {
    const st = payState.get(params.outTradeNo) || 'NOTPAY';
    const tradeState = st === 'SUCCESS' ? 'SUCCESS' : st === 'CLOSED' ? 'CLOSED' : st === 'REFUND' ? 'REFUND' : 'NOTPAY';
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState };
  },
  // 退款模拟：立即成功（order/actions/shared.js:225-235 校验 returnCode/resultCode 后取 refundId）
  async refund(params) {
    payState.set(params.outTradeNo, 'REFUND');
    return {
      returnCode: 'SUCCESS',
      resultCode: 'SUCCESS',
      refundId: 'DEMO_RF_' + genId().slice(0, 12).toUpperCase(),
    };
  },
  async closeOrder(params) {
    payState.set(params.outTradeNo, 'CLOSED');
    return { returnCode: 'SUCCESS', resultCode: 'SUCCESS' };
  },
};

// 模拟「用户在收银台点击支付」：以微信回调事件形态调 order 云函数（order/index.js
// 对无 action 且带 outTradeNo/returnCode 的事件自动分流到支付回调 action）。
// totalFee 必须等于订单 pay_amount（pay.js:83 金额校验），从库中读取真实订单。
async function confirmPayment(outTradeNo) {
  const { db } = getDbCtx();
  const res = await db.collection('order').where({ order_no: outTradeNo }).limit(1).get();
  const order = res.data && res.data[0];
  if (!order) return { ok: false, msg: '订单不存在: ' + outTradeNo };
  payState.set(outTradeNo, 'SUCCESS');

  let openid = null;
  try {
    const u = await db.collection('user').doc(order.user_id).get();
    openid = (u.data && u.data.openid) || null;
  } catch (e) { /* 用户缺失时置 null */ }

  const cb = {
    returnCode: 'SUCCESS',
    resultCode: 'SUCCESS',
    outTradeNo,
    totalFee: order.pay_amount,
    transactionId: 'DEMO_TXN_' + genId().slice(0, 12).toUpperCase(),
    openid,
  };
  const r = await invoke('order', cb);
  return { ok: true, callback: r.result };
}

// ---------- 虚拟��件存储 ----------

function filesPut(cloudPath, contentBuf, mime, fixedId) {
  const id = fixedId || 'f' + genId();
  files.set(id, {
    cloudPath: cloudPath || id,
    content: Buffer.isBuffer(contentBuf) ? contentBuf : Buffer.from(contentBuf || ''),
    mime: mime || 'application/octet-stream',
  });
  return 'cloud://demo/' + id;
}

function parseFileId(fileID) {
  return String(fileID || '').replace(/^cloud:\/\/demo\//, '');
}

function filesGet(id) {
  return files.get(parseFileId(id)) || null;
}

function filesDelete(fileID) {
  return files.delete(parseFileId(fileID));
}

// ---------- 演示身份 ----------

function listActors() {
  return demoActors.map((a) => ({
    openid: a.openid,
    nickname: a.nickname,
    phone: a.phone,
    role: a.role,
    desc: a.desc || '',
  }));
}

function findActor(openid) {
  return demoActors.find((a) => a.openid === openid) || null;
}

function getActorPhone(openid) {
  const a = findActor(openid);
  return a ? a.phone : '';
}

module.exports = {
  init, register, hasFunction, invoke, runCron, currentOpenid,
  getDbCtx, replaceAll, exportAll, flushSave,
  pay, confirmPayment,
  filesPut, filesGet, filesDelete, parseFileId,
  listActors, findActor, getActorPhone,
};
