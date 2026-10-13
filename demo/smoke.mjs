// 演示冒烟脚本：验证本地模拟器核心链路（node demo/smoke.mjs，需服务已启动）
'use strict';
import fs from 'node:fs';

const B = 'http://localhost:8787';
const DB_FILE = new URL('./.data/db.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const call = (name, data, openid) =>
  fetch(B + '/api/cloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(openid ? { 'x-demo-openid': openid } : {}) },
    body: JSON.stringify({ name, data }),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS', name, detail ? '· ' + detail : ''); }
  else { fail++; console.log('  FAIL', name, detail ? '· ' + detail : ''); }
};

console.log('== 冒烟开始 ==');

// 1) 重置演示数据
const r0 = await fetch(B + '/api/demo/reset', { method: 'POST' }).then((r) => r.json());
ok('reset', r0.ok !== false);
await sleep(400); // 等待防抖落盘

// 2) 读取全新订单号
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const order = db.order.find((x) => x._id === 'ord_vip_a1');
ok('seed 订单待支付', order.status === 'pending', order.order_no);

// 3) 身份：VIP 用户登录
const r3 = await call('user', { action: 'login', code: 'demo-code-vip' }, 'demo-vip');
ok('login(vip)', r3.result && r3.result.code === 0, r3.result?.data?.userInfo?.nickname);

// 4) 活动列表
const r4 = await call('activity', { action: 'list' }, 'demo-vip');
ok('activity/list', r4.result?.code === 0 && r4.result.data.list.length === 3, r4.result?.data?.list.length + ' 项');

// 5) 管理员权限（admin 身份）
const r5 = await call('admin', { action: 'permission/my' }, 'demo-admin');
ok('admin 权限', JSON.stringify(r5.result?.data?.permissions) === '["*"]');

// 6) 普通用户无权限
const r6 = await call('admin', { action: 'permission/my' }, 'demo-new');
ok('普通用户无权限', (r6.result?.data?.permissions || []).length === 0);

// 7) 模拟支付回调（核心链路：订单事务 + 嵌套报名联动）
const t0 = Date.now();
let r7 = null, err7 = null;
try {
  r7 = await fetch(B + '/api/demo/confirm-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outTradeNo: order.order_no }),
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json());
} catch (e) { err7 = e; }
ok('confirm-pay', !err7 && r7?.ok === true && r7?.callback?.errcode === 0,
  err7 ? err7.message : Date.now() - t0 + 'ms');

// 8) 落盘校验：订单/报名/活动人数/支付流水
await sleep(400);
const db2 = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const o2 = db2.order.find((x) => x._id === 'ord_vip_a1');
const enr = db2.activity_enrollment.find((x) => x._id === 'enr_vip_a1');
const act = db2.activity.find((x) => x._id === 'act_1');
ok('订单已支付', o2.status === 'paid', 'paid_at=' + !!o2.paid_at);
ok('报名生效', enr.status === 'enrolled');
ok('活动人数+1', act.signup_count === 2, 'signup_count=' + act.signup_count);
ok('支付流水+1', db2.payment.length === 6, 'payment=' + db2.payment.length);

// 9) 重复回调幂等
const r9 = await fetch(B + '/api/demo/confirm-pay', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ outTradeNo: order.order_no }),
  signal: AbortSignal.timeout(10000),
}).then((r) => r.json());
ok('重复回调幂等', r9?.ok === true && r9?.callback?.errcode === 0, JSON.stringify(r9?.callback).slice(0, 60));

console.log(`== 冒烟结束：${pass} 通过 / ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
