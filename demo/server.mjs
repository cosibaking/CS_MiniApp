// demo/server.mjs — 本地演示服务（零依赖，Node >= 16）
// 职责：
//   1. 启动前注入云函数所需环境变量（internal_token / SUB_MCH_ID / CHECKIN_TOKEN_SECRET / PHONE_AES_KEY）
//   2. require 钩子：wx-server-sdk → demo 桩；@club/admin-common → 共享库源码
//      （钩子先于 node_modules 解析，确保绝不加载真实 SDK）
//   3. 加载 6 个云函数原始源码并注册进模拟器（零改动）
//   4. 数据库：优先加载 demo/.data/db.json 持久化，否则灌入 seed 种子数据
//   5. HTTP：
//      - 静态托管：/（运行时壳）、/runtime/*、/mp/*（miniprogram 原文件）
//      - API：/api/cloud（callFunction）、/api/upload、/api/file/:id
//      - 演示控制：/api/demo/actors | state | switch | confirm-pay | cron | reset
//
// 启动：node demo/server.mjs   （环境变量 DEMO_PORT 可改端口，默认 8787）

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const MP_DIR = path.join(ROOT, 'miniprogram');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const PERSIST_FILE = path.join(__dirname, '.data', 'db.json');
const PORT = Number(process.env.DEMO_PORT || 8787);

// ---------- 1. 环境变量（必须在加载云函数与 seed 之前） ----------

process.env.internal_token = 'demo-internal-token';
process.env.SUB_MCH_ID = '1900000100demo';
process.env.CHECKIN_TOKEN_SECRET = 'demo-checkin-secret';
process.env.PHONE_AES_KEY = 'demo-phone-aes-key';

// ---------- 2. 模拟器 + 种子数据 ----------

const emulator = require('./cloud/emulator.js');
const { buildSeed } = await import('./seed.mjs');
let seed = buildSeed();

const dbCtx = emulator.init({ persistFile: PERSIST_FILE, actors: seed.actors });

// 演示文件素材：固定 id，每次启动重注册（覆盖旧内容）
for (const f of seed.files) {
  emulator.filesPut(f.cloudPath, Buffer.from(f.content, 'base64'), f.mime, f.id);
}

// 数据库：优先读持久化（保留上次演示产生的数据），失败/缺失则灌入种子
if (!dbCtx.load()) {
  dbCtx.store.restore(seed.collections);
  dbCtx.save();
  console.log('[demo] 已灌入种子演示数据');
} else {
  console.log('[demo] 已加载持久化数据（如需重置请点击工具条「重置数据」或删除 demo/.data）');
}

// ---------- 3. require 钩子 ----------

const Module = require('node:module');
const origResolveFilename = Module._resolveFilename;
const WX_STUB_PATH = require.resolve('./cloud/wx-server-sdk.js');
const COMMON_ENTRY = path.join(ROOT, 'cloudfunctions', 'common', 'index.js');

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return WX_STUB_PATH;
  if (request === '@club/admin-common') return COMMON_ENTRY;
  return origResolveFilename.call(this, request, parent, isMain, options);
};

// ---------- 4. 加载云函数原始源码 ----------

// 已知源码瑕疵补丁（不改原文件）：order/actions/refund.js:324 module.exports 中
// 裸引用 wrapAdminAction（未从 common 解构，真实环境同样会加载失败）。
// 通过全局变量兜底，使其解析到共享库的同一实现。
const commonEntry = require(COMMON_ENTRY);
globalThis.wrapAdminAction = commonEntry.wrapAdminAction;

const FUNCTION_NAMES = ['activity', 'admin', 'db-init', 'order', 'team', 'user'];
const registeredNames = [];
for (const name of FUNCTION_NAMES) {
  const mod = require(path.join(ROOT, 'cloudfunctions', name, 'index.js'));
  if (mod && typeof mod.main === 'function') {
    emulator.register(name, mod.main);
    registeredNames.push(name);
    console.log('[demo] 已注册云函数:', name);
  } else {
    console.warn('[demo] 跳过（无 exports.main）:', name);
  }
}

// ---------- 5. HTTP 服务 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wxml': 'text/plain; charset=utf-8',
  '.wxss': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, filePath) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

// 静态文件：base 之内、防穿越
function serveStatic(res, baseDir, relPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch (e) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const full = path.normalize(path.join(baseDir, decoded));
  const rel = path.relative(baseDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  sendFile(res, full);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error('JSON 解析失败');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    // ----- 页面与静态资源 -----
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return sendFile(res, path.join(RUNTIME_DIR, 'index.html'));
    }
    if (req.method === 'GET' && pathname.startsWith('/runtime/')) {
      return serveStatic(res, RUNTIME_DIR, pathname.slice('/runtime/'.length));
    }
    if (req.method === 'GET' && pathname.startsWith('/mp/')) {
      return serveStatic(res, MP_DIR, pathname.slice('/mp/'.length));
    }

    // ----- 虚拟文件存储 -----
    if (req.method === 'GET' && pathname.startsWith('/api/file/')) {
      const id = decodeURIComponent(pathname.slice('/api/file/'.length));
      const f = emulator.filesGet(id);
      if (!f) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': f.mime || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(f.content);
      return;
    }

    // ----- 云函数调用 -----
    if (req.method === 'POST' && pathname === '/api/cloud') {
      const { name, data } = await readJsonBody(req);
      const openid = req.headers['x-demo-openid'] || null;
      if (!name) return sendJson(res, { ok: false, errMsg: '缺少云函数名' });
      try {
        const { result } = await emulator.invoke(name, data, { openid });
        return sendJson(res, { ok: true, result });
      } catch (e) {
        return sendJson(res, { ok: false, errMsg: e.message || String(e) });
      }
    }

    // ----- 文件上传（wx.cloud.uploadFile 的落地端点�� -----
    if (req.method === 'POST' && pathname === '/api/upload') {
      const { cloudPath, contentBase64, mime } = await readJsonBody(req);
      if (!cloudPath || typeof contentBase64 !== 'string') {
        return sendJson(res, { ok: false, errMsg: '参数缺失' });
      }
      const fileID = emulator.filesPut(cloudPath, Buffer.from(contentBase64, 'base64'), mime || 'application/octet-stream');
      return sendJson(res, { ok: true, fileID });
    }

    // ----- 演示控制 -----
    if (req.method === 'GET' && pathname === '/api/demo/actors') {
      return sendJson(res, { ok: true, actors: emulator.listActors() });
    }
    if (req.method === 'GET' && pathname === '/api/demo/state') {
      const store = emulator.getDbCtx().store;
      const collections = {};
      for (const [name, col] of store.cols.entries()) collections[name] = col.size;
      return sendJson(res, { ok: true, functions: registeredNames, collections, actors: emulator.listActors() });
    }
    if (req.method === 'POST' && pathname === '/api/demo/switch') {
      const { openid } = await readJsonBody(req);
      const actor = emulator.findActor(openid);
      if (!actor) return sendJson(res, { ok: false, errMsg: '未知演示身份' });
      return sendJson(res, { ok: true, actor });
    }
    if (req.method === 'POST' && pathname === '/api/demo/confirm-pay') {
      const { outTradeNo } = await readJsonBody(req);
      if (!outTradeNo) return sendJson(res, { ok: false, errMsg: '缺少 outTradeNo' });
      const r = await emulator.confirmPayment(outTradeNo);
      return sendJson(res, { ok: !!r.ok, ...r });
    }
    if (req.method === 'POST' && pathname === '/api/demo/cron') {
      const { name, trigger } = await readJsonBody(req);
      if (!emulator.hasFunction(name)) return sendJson(res, { ok: false, errMsg: '云函数未注册: ' + name });
      const { result } = await emulator.runCron(name, trigger || '');
      return sendJson(res, { ok: true, result });
    }
    if (req.method === 'POST' && pathname === '/api/demo/reset') {
      seed = buildSeed(); // 重新构造，使活动/订单时间相对当前时刻
      for (const f of seed.files) {
        emulator.filesPut(f.cloudPath, Buffer.from(f.content, 'base64'), f.mime, f.id);
      }
      dbCtx.store.restore(seed.collections);
      dbCtx.save();
      return sendJson(res, { ok: true, msg: '已重置为种子数据' });
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    console.error('[demo] 请求处理异常', pathname, e);
    try {
      sendJson(res, { ok: false, errMsg: e.message || '服务器内部错误' }, 500);
    } catch (_) { /* headers 已发送 */ }
  }
});

process.on('uncaughtException', (e) => console.error('[demo] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[demo] unhandledRejection', e));

server.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('  真人CS俱乐部 · 本地演示已启动');
  console.log(`  浏览器打开: http://localhost:${PORT}`);
  console.log('==========================================');
  console.log('');
});
