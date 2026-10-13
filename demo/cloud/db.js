// demo/cloud/db.js — 内存数据库引擎（模拟 wx-server-sdk database API 子集）
// 覆盖本项目云函数实际用到的全部能力：
//   collection().where().orderBy().limit().skip().field().get()/count()/update()/remove()
//   doc(id).get()/update()/remove()/set()、add({data})（单条/数组批量）、createCollection、
//   command 操作符：in/nin/gt/gte/lt/lte/neq/eq/inc/and/or（含链式 .and()/.or()）、
//   db.RegExp({regexp, options})、db.startTransaction()（全量快照 + 串行化）
// 时间口径与线上一致：全部毫秒时间戳，不涉及 serverDate。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- 基础工具 ----------

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => looseEqual(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && looseEqual(a[k], b[k]));
}

// ---------- Command 操作符 ----------

class Command {
  constructor(op, operand) {
    this.__cmd = op;
    this.operand = operand;
  }
  and(other) {
    return new Command('and', [this, asCondition(other)]);
  }
  or(other) {
    return new Command('or', [this, asCondition(other)]);
  }
}

function asCondition(x) {
  return x instanceof Command ? x : new Command('eq', x);
}

function makeCommandFactory() {
  const f = (v) => new Command('eq', v);
  f.eq = (v) => new Command('eq', v);
  f.neq = (v) => new Command('neq', v);
  f.gt = (v) => new Command('gt', v);
  f.gte = (v) => new Command('gte', v);
  f.lt = (v) => new Command('lt', v);
  f.lte = (v) => new Command('lte', v);
  f.in = (arr) => new Command('in', arr);
  f.nin = (arr) => new Command('nin', arr);
  f.inc = (n) => new Command('inc', n);
  f.and = (...ops) => new Command('and', (ops.length === 1 && Array.isArray(ops[0]) ? ops[0] : ops).map(asCondition));
  f.or = (...ops) => new Command('or', (ops.length === 1 && Array.isArray(ops[0]) ? ops[0] : ops).map(asCondition));
  return f;
}

class DbRegExp {
  constructor({ regexp, options }) {
    this.__regexp = String(regexp);
    this.__options = options || '';
  }
  test(v) {
    try {
      return new RegExp(this.__regexp, this.__options).test(String(v));
    } catch (e) {
      return false;
    }
  }
}

function isCommand(x) {
  return x instanceof Command;
}

// 数值/字符串比较，类型不兼容返回 null（不匹配）
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}

function evalCondition(fieldValue, cond) {
  switch (cond.__cmd) {
    case 'eq': return looseEqual(fieldValue, cond.operand);
    case 'neq': return !looseEqual(fieldValue, cond.operand); // 字段缺失（undefined）也视为匹配
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const c = cmp(fieldValue, cond.operand);
      if (c === null) return false;
      if (cond.__cmd === 'gt') return c > 0;
      if (cond.__cmd === 'gte') return c >= 0;
      if (cond.__cmd === 'lt') return c < 0;
      return c <= 0;
    }
    case 'in': return Array.isArray(cond.operand) && cond.operand.some((v) => looseEqual(fieldValue, v));
    case 'nin': return !Array.isArray(cond.operand) || !cond.operand.some((v) => looseEqual(fieldValue, v));
    case 'and': return cond.operand.every((c) => evalCondition(fieldValue, c));
    case 'or': return cond.operand.some((c) => evalCondition(fieldValue, c));
    default: return false;
  }
}

function matchField(fieldValue, cond) {
  if (isCommand(cond)) return evalCondition(fieldValue, cond);
  if (cond instanceof DbRegExp) return fieldValue !== undefined && fieldValue !== null && cond.test(fieldValue);
  if (cond === null) return fieldValue === null || fieldValue === undefined;
  // Mongo 数组语义：字段为数组且条件非数组时，任一元素等于条件即匹配
  if (Array.isArray(fieldValue) && !Array.isArray(cond) && !isCommand(cond)) {
    return fieldValue.some((v) => looseEqual(v, cond));
  }
  return looseEqual(fieldValue, cond);
}

// 顶层 where 匹配：普通对象逐键 AND；_.or([...]) / _.and([...]) 按对象级组合
function matchDoc(doc, query) {
  if (isCommand(query)) {
    if (query.__cmd === 'or') return query.operand.some((sub) => matchDoc(doc, sub));
    if (query.__cmd === 'and') return query.operand.every((sub) => matchDoc(doc, sub));
    throw new Error('where 不支持对象级操作符 ' + query.__cmd);
  }
  if (!query || typeof query !== 'object') return true;
  return Object.keys(query).every((key) => matchField(getPath(doc, key), query[key]));
}

// ---------- 更新表达式 ----------

function applyUpdate(doc, data) {
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (isCommand(val) && val.__cmd === 'inc') {
      const cur = getPath(doc, key);
      const num = (typeof cur === 'number' && Number.isFinite(cur)) ? cur : 0;
      setPath(doc, key, num + val.operand);
    } else if (isCommand(val) && val.__cmd === 'eq') {
      setPath(doc, key, deepClone(val.operand));
    } else if (isCommand(val)) {
      throw new Error('update 不支持操作符 ' + val.__cmd);
    } else {
      setPath(doc, key, deepClone(val));
    }
  }
}

// ---------- 投影（field）----------

function projectDoc(doc, fieldSpec) {
  const keys = Object.keys(fieldSpec);
  if (!keys.length) return deepClone(doc);
  const includeMode = !!fieldSpec[keys[0]];
  if (includeMode) {
    const out = {};
    if (fieldSpec._id) out._id = doc._id;
    for (const k of keys) {
      if (k === '_id' || !fieldSpec[k]) continue;
      const v = getPath(doc, k);
      if (v !== undefined) setPath(out, k, deepClone(v));
    }
    return out;
  }
  const out = deepClone(doc);
  for (const k of keys) {
    if (fieldSpec[k]) continue;
    unsetPath(out, k);
  }
  return out;
}

// ---------- 排序 ----------

function sortDocs(docs, orders) {
  if (!orders.length) return docs;
  return docs.slice().sort((a, b) => {
    for (const { field, order } of orders) {
      const va = getPath(a, field);
      const vb = getPath(b, field);
      const ua = va === undefined || va === null;
      const ub = vb === undefined || vb === null;
      if (ua && ub) continue;
      if (ua) return order === 'asc' ? -1 : 1; // 缺失值排最后（asc 语义近似）
      if (ub) return order === 'asc' ? 1 : -1;
      const c = cmp(va, vb);
      if (c === null || c === 0) continue;
      return order === 'asc' ? c : -c;
    }
    return 0;
  });
}

// ---------- 存储 ----------

class Store {
  constructor() {
    this.cols = new Map(); // name → Map(id → doc)
    this.onChange = null; // 变更通知（由 createDb 挂接防抖落盘）
  }
  _touch() {
    if (this.onChange) this.onChange();
  }
  col(name) {
    let c = this.cols.get(name);
    if (!c) {
      c = new Map();
      this.cols.set(name, c);
    }
    return c;
  }
  has(name) {
    return this.cols.has(name);
  }
  snapshot() {
    const out = {};
    for (const [name, col] of this.cols) {
      out[name] = [];
      for (const doc of col.values()) out[name].push(deepClone(doc));
    }
    return out;
  }
  restore(snap) {
    this.cols = new Map();
    for (const name of Object.keys(snap)) {
      const col = new Map();
      for (const doc of snap[name]) col.set(doc._id, doc);
      this.cols.set(name, col);
    }
    this._touch();
  }
  toJSON() {
    return this.snapshot();
  }
  loadJSON(json) {
    this.restore(json || {});
  }
}

// ---------- 事务（全量快照 + 全局串行化） ----------

class Mutex {
  constructor() {
    this._busy = false;
    this._queue = [];
  }
  acquire() {
    return new Promise((resolve) => {
      const tryStart = () => {
        if (this._busy) return; // 已被占用，留在队列等待 release 唤醒
        this._busy = true;
        // 立即获锁：把自己移出队列，防止之后 release 时被 shift 重复触发
        const i = this._queue.indexOf(tryStart);
        if (i >= 0) this._queue.splice(i, 1);
        resolve();
      };
      this._queue.push(tryStart);
      tryStart();
    });
  }
  release() {
    this._busy = false;
    const next = this._queue.shift();
    if (next) next();
  }
}

class Transaction {
  constructor(store, mutex) {
    this._store = store;
    this._mutex = mutex;
    this._granted = mutex.acquire().then(() => {
      this._snapshot = store.snapshot();
    });
    this._done = false;
  }
  async _ready() {
    await this._granted;
  }
  _assertOpen() {
    if (this._done) throw new Error('transaction 已提交/回滚，不能再操作');
  }
  collection(name) {
    const self = this;
    return {
      doc: (id) => ({
        get: async () => {
          await self._ready();
          self._assertOpen();
          const doc = self._store.col(name).get(id);
          if (!doc) {
            const e = new Error('document.get:fail document not exists');
            e.errMsg = e.message;
            throw e;
          }
          return { data: deepClone(doc) };
        },
        update: async ({ data }) => {
          await self._ready();
          self._assertOpen();
          const doc = self._store.col(name).get(id);
          if (!doc) return { stats: { updated: 0 } };
          applyUpdate(doc, data);
          self._store._touch();
          return { stats: { updated: 1 } };
        },
        set: async ({ data }) => {
          await self._ready();
          self._assertOpen();
          const next = deepClone(data);
          next._id = id;
          self._store.col(name).set(id, next);
          self._store._touch();
          return { stats: { updated: 1 } };
        },
        remove: async () => {
          await self._ready();
          self._assertOpen();
          const removed = self._store.col(name).delete(id) ? 1 : 0;
          if (removed) self._store._touch();
          return { stats: { removed } };
        },
      }),
      add: async ({ data }) => {
        await self._ready();
        self._assertOpen();
        const next = deepClone(data);
        const id = next._id || genId();
        next._id = id;
        self._store.col(name).set(id, next);
        self._store._touch();
        return { _id: id };
      },
    };
  }
  async commit() {
    await this._ready();
    this._assertOpen();
    this._done = true;
    this._mutex.release();
  }
  async rollback() {
    await this._ready();
    if (this._done) return;
    this._done = true;
    this._store.restore(this._snapshot);
    this._mutex.release();
  }
}

// ---------- 查询链 ----------

const DEFAULT_LIMIT = 1000;

class Query {
  constructor(store, name) {
    this._store = store;
    this._name = name;
    this._wheres = [];
    this._orders = [];
    this._limit = DEFAULT_LIMIT;
    this._skip = 0;
    this._field = null;
  }
  where(q) {
    this._wheres.push(q);
    return this;
  }
  orderBy(field, order) {
    this._orders.push({ field, order: order === 'desc' ? 'desc' : 'asc' });
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  skip(n) {
    this._skip = n;
    return this;
  }
  field(spec) {
    this._field = spec;
    return this;
  }
  _matched() {
    const col = this._store.col(this._name);
    const out = [];
    for (const doc of col.values()) {
      if (this._wheres.every((q) => matchDoc(doc, q))) out.push(doc);
    }
    return sortDocs(out, this._orders);
  }
  async get() {
    const matched = this._matched();
    const page = matched.slice(this._skip, this._skip + this._limit);
    const data = page.map((d) => {
      const doc = this._field ? projectDoc(d, this._field) : deepClone(d);
      if (doc._id === undefined) doc._id = d._id;
      return doc;
    });
    return { data, errMsg: 'collection.get:ok' };
  }
  async count() {
    return { total: this._matched().length, errMsg: 'collection.count:ok' };
  }
  async update({ data }) {
    let updated = 0;
    for (const doc of this._matched()) {
      applyUpdate(doc, data);
      updated++;
    }
    if (updated) this._store._touch();
    return { stats: { updated } };
  }
  async remove() {
    const col = this._store.col(this._name);
    let removed = 0;
    for (const doc of this._matched()) {
      col.delete(doc._id);
      removed++;
    }
    if (removed) this._store._touch();
    return { stats: { removed } };
  }
}

class DocRef {
  constructor(store, name, id) {
    this._store = store;
    this._name = name;
    this._id = id;
  }
  async get() {
    const doc = this._store.col(this._name).get(this._id);
    if (!doc) {
      const e = new Error('document.get:fail document not exists');
      e.errMsg = e.message;
      throw e;
    }
    return { data: deepClone(doc) };
  }
  async update({ data }) {
    const doc = this._store.col(this._name).get(this._id);
    if (!doc) return { stats: { updated: 0 } };
    applyUpdate(doc, data);
    this._store._touch();
    return { stats: { updated: 1 } };
  }
  async set({ data }) {
    const next = deepClone(data);
    next._id = this._id;
    this._store.col(this._name).set(this._id, next);
    this._store._touch();
    return { stats: { updated: 1 } };
  }
  async remove() {
    const removed = this._store.col(this._name).delete(this._id) ? 1 : 0;
    if (removed) this._store._touch();
    return { stats: { removed } };
  }
}

class Collection {
  constructor(store, name) {
    this._store = store;
    this._name = name;
  }
  doc(id) {
    return new DocRef(this._store, this._name, id);
  }
  where(q) {
    return new Query(this._store, this._name).where(q);
  }
  orderBy(field, order) {
    return new Query(this._store, this._name).orderBy(field, order);
  }
  limit(n) {
    return new Query(this._store, this._name).limit(n);
  }
  skip(n) {
    return new Query(this._store, this._name).skip(n);
  }
  field(spec) {
    return new Query(this._store, this._name).field(spec);
  }
  async add({ data }) {
    const col = this._store.col(this._name);
    if (Array.isArray(data)) {
      const ids = [];
      for (const item of data) {
        const next = deepClone(item);
        const id = next._id || genId();
        next._id = id;
        col.set(id, next);
        ids.push(id);
      }
      this._store._touch();
      return { ids, errMsg: 'collection.add:ok' };
    }
    const next = deepClone(data);
    const id = next._id || genId();
    next._id = id;
    col.set(id, next);
    this._store._touch();
    return { _id: id, errMsg: 'collection.add:ok' };
  }
  async count() {
    return new Query(this._store, this._name).count();
  }
  async get() {
    return new Query(this._store, this._name).get();
  }
  async update({ data }) {
    return new Query(this._store, this._name).update({ data });
  }
  async remove() {
    return new Query(this._store, this._name).remove();
  }
}

class Database {
  constructor(store) {
    this._store = store;
    this.command = makeCommandFactory();
    this._ = this.command; // 常见别名
  }
  RegExp(opts) {
    return new DbRegExp(opts);
  }
  collection(name) {
    return new Collection(this._store, name);
  }
  createCollection(name) {
    if (this._store.cols.has(name)) {
      const e = new Error('collection already exists: ' + name);
      e.errMsg = e.message;
      throw e;
    }
    this._store.col(name);
    return { errMsg: 'collection.create:ok' };
  }
  startTransaction() {
    return new Transaction(this._store, this._mutex);
  }
}

// ---------- 对外入口 ----------

function createDb({ persistFile } = {}) {
  const store = new Store();
  const mutex = new Mutex();
  const database = new Database(store);
  database._mutex = mutex;

  // 持久化：业务数据是纯 JSON（时间戳为数字、无 Date/RegExp 存储），直接整库落盘
  let saveTimer = null;
  function save() {
    if (!persistFile) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(persistFile), { recursive: true });
        fs.writeFileSync(persistFile, JSON.stringify(store.toJSON(), null, 1));
      } catch (e) {
        console.error('[demo-db] 持久化失败', e);
      }
    }, 150);
  }
  store.onChange = save; // 任何云函数写入后自动防抖落盘

  function load() {
    if (!persistFile || !fs.existsSync(persistFile)) return false;
    try {
      store.loadJSON(JSON.parse(fs.readFileSync(persistFile, 'utf8')));
      return true;
    } catch (e) {
      console.error('[demo-db] 读取持久化文件失败，使用空库', e);
      return false;
    }
  }

  return { store, db: database, save, load };
}

module.exports = { createDb, genId, deepClone };
