// actions/log.js — 操作日志查询/详情/导出（admin-module §5.10-§5.12）
// log/list、log/detail 为读操作，不写审计日志（R9，wrap options log:false）。
// log/export 导出动作本身留痕（R9：wrap 默认 log:true，detail 记筛选条件与导出行数）。
const ExcelJS = require('exceljs');
const common = require('@club/admin-common');
const {
  wrapAdminAction, getContext,
  assertParam, assertString, assertEnum,
  BizError, LOG_MODULES,
} = common;
const { ADMIN_BIZ, pick, normalizePagination } = require('./shared');

const MAX_RANGE = 92 * 24 * 60 * 60 * 1000;         // 筛选时间跨度上限（E9 防全表扫描）
const MAIN_TABLE_WINDOW = 365 * 24 * 60 * 60 * 1000; // R12：主表仅保留近 1 年
const EXPORT_MAX_ROWS = 10000;                       // E9：导出行数上限，超出返回 5013
const URL_MAX_AGE = 2 * 60 * 60;                     // E14：临时链接默认 2 小时（秒）
const EXPORT_BATCH = 1000;                           // 导出逐批拉取，避免一次性全量

// 正则元字符转义（keyword 模糊搜索用，与 team search-users 同口径）
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 毫秒时间戳 → YYYY-MM-DD HH:mm:ss（云函数运行时为 UTC，统一按东八区展示）
function fmtTime(ms) {
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// 毫秒时间戳 → yyyyMMddHHmmss（导出文件名用）
function fmtStamp(ms) {
  return fmtTime(ms).replace(/[-: ]/g, '');
}

// 日志查询字段投影（不含 detail 大字段）
const LOG_FIELDS = {
  operator_id: true, operator_name: true, operator_role: true,
  module: true, action: true, target_type: true, target_id: true,
  result: true, error_msg: true, created_at: true,
};

// §5.10/§5.12 共用：筛选参数校验 + 组合查询条件
// requireTime=true 时 start_time/end_time 必填（§5.12 导出场景）
function buildLogFilter(event, requireTime) {
  const p = pick(event, 'operator_id', 'module', 'action', 'result',
    'keyword', 'start_time', 'end_time');

  // 1. 校验筛选参数
  if (p.operator_id != null) assertString(p.operator_id, 'operator_id', { min: 1, max: 64 });
  if (p.module != null) assertEnum(p.module, LOG_MODULES, 'module');
  if (p.action != null) assertString(p.action, 'action', { min: 1, max: 64 });
  if (p.result != null) assertEnum(p.result, ['success', 'fail'], 'result');
  if (p.keyword != null) assertString(p.keyword, 'keyword', { min: 1, max: 32 });
  if (requireTime) {
    assertParam(Number.isFinite(p.start_time), 'start_time 必填且需为毫秒时间戳');
    assertParam(Number.isFinite(p.end_time), 'end_time 必填且需为毫秒时间戳');
  } else {
    if (p.start_time != null) assertParam(Number.isFinite(p.start_time), 'start_time 需为毫秒时间戳');
    if (p.end_time != null) assertParam(Number.isFinite(p.end_time), 'end_time 需为毫秒时间戳');
  }
  if (p.start_time != null && p.end_time != null) {
    assertParam(p.end_time > p.start_time, 'end_time 需大于 start_time');
    assertParam(p.end_time - p.start_time <= MAX_RANGE, '时间范围不能超过 92 天');
  }

  // 2. 组合查询条件：时间窗默认下限为 1 年前（R12 只查主表近 1 年，入参早于该线自动收窄）
  const { db } = getContext();
  const _ = db.command;
  const now = Date.now();
  const lowerBound = now - MAIN_TABLE_WINDOW;
  const since = p.start_time != null ? Math.max(p.start_time, lowerBound) : lowerBound;
  const until = p.end_time != null ? Math.min(p.end_time, now) : null;

  const conditions = [];
  conditions.push(
    until != null
      ? { created_at: _.gte(since).and(_.lte(until)) }
      : { created_at: _.gte(since) },
  );
  if (p.operator_id != null) conditions.push({ operator_id: p.operator_id });
  if (p.module != null) conditions.push({ module: p.module });
  if (p.action != null) conditions.push({ action: p.action });
  if (p.result != null) conditions.push({ result: p.result });
  if (p.keyword != null) {
    const reg = db.RegExp({ regexp: escapeRegExp(p.keyword), options: 'i' });
    conditions.push(_.or([{ operator_name: reg }, { error_msg: reg }]));
  }

  return { p, query: db.collection('operation_log').where(_.and(conditions)) };
}

// §5.10 log/list — 日志分页查询（列表项不含 detail 大字段）
async function logListImpl(event, auth) {
  const { p, query } = buildLogFilter(event, false);
  const { page, pageSize } = normalizePagination(pick(event, 'page', 'page_size'));

  // count + 分页（created_at 倒序）
  const { total } = await query.count();
  const { data } = await query
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .field(LOG_FIELDS)
    .get();

  const list = data.map((x) => ({
    log_id: x._id,
    operator_id: x.operator_id,
    operator_name: x.operator_name,
    operator_role: x.operator_role,
    module: x.module,
    action: x.action,
    target_type: x.target_type,
    target_id: x.target_id,
    result: x.result,
    error_msg: x.error_msg,
    created_at: x.created_at,
  }));

  return { total, list };
}

// §5.11 log/detail — 日志详情（含 detail.before/after，供前后对比展示）
// detail 写入时已脱敏（R11/§6.2），查询侧不再二次处理。
async function logDetailImpl(event, auth) {
  const p = pick(event, 'log_id');
  assertString(p.log_id, 'log_id', { min: 1, max: 64 });
  const { db } = getContext();

  const { data } = await db.collection('operation_log')
    .where({ _id: p.log_id }).limit(1).get();
  if (!data.length) {
    throw new BizError(ADMIN_BIZ.NOT_FOUND, '日志不存在'); // 文档 1004 口径 → 5016
  }
  const row = data[0];

  return {
    log_id: row._id,
    operator_id: row.operator_id,
    operator_name: row.operator_name,
    operator_role: row.operator_role,
    module: row.module,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: row.detail || null,
    result: row.result,
    error_msg: row.error_msg,
    created_at: row.created_at,
  };
}

// §5.12 log/export — 按当前筛选条件导出日志为 Excel（E9/E14）
// 计数 > 10000 行返回 5013；xlsx 内存组装 → 云存储 exports/operation_log/ → 临时开链 2 小时。
async function logExportImpl(event, auth) {
  const { query } = buildLogFilter(event, true);

  // 1. 行数上限（E9：> 10000 行提示缩小范围）
  const { total } = await query.count();
  if (total > EXPORT_MAX_ROWS) {
    throw new BizError(ADMIN_BIZ.EXPORT_TOO_LARGE, `导出范围过大（${total} 行），请缩小时间范围或筛选条件`);
  }

  // 2. 逐批拉取（created_at 倒序，与列表口径一致）
  const rows = [];
  while (rows.length < total) {
    const { data } = await query
      .orderBy('created_at', 'desc')
      .skip(rows.length)
      .limit(EXPORT_BATCH)
      .field(LOG_FIELDS)
      .get();
    if (!data.length) break; // 总数动态减少时防死循环
    rows.push(...data);
  }

  // 3. 组装 xlsx 并上传开链（生成/上传/开链失败 → 5014；业务错误原样抛出）
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('操作日志');
    ws.addRow(['时间', '操作人', '角色', '模块', '动作', '对象', '结果', '错误信息']);
    rows.forEach((x) => {
      ws.addRow([
        x.created_at ? fmtTime(x.created_at) : '',
        x.operator_name || '',
        x.operator_role || '',
        x.module || '',
        x.action || '',
        [x.target_type, x.target_id].filter(Boolean).join(':'),
        x.result === 'fail' ? '失败' : '成功',
        x.error_msg || '',
      ]);
    });
    const buffer = await wb.xlsx.writeBuffer();

    const { cloud } = getContext();
    // 随机后缀防同秒并发导出互相覆盖（模板类固定路径幂等覆盖，导出文件不可覆盖）
    const cloudPath = `exports/operation_log/${fmtStamp(Date.now())}-${Math.random().toString(36).slice(2, 6)}.xlsx`;
    const up = await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(buffer) });

    const urlRes = await cloud.getTempFileURL({
      fileList: [{ fileID: up.fileID, maxAge: URL_MAX_AGE }],
    });
    const url = urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL;
    if (!url) throw new Error('临时链接生成失败');

    return {
      file_id: up.fileID,
      download_url: url,
      total: rows.length,
      expire_at: Date.now() + URL_MAX_AGE * 1000,
    };
  } catch (err) {
    if (err && err.code && err.msg) throw err; // BizError 原样透传
    throw new BizError(ADMIN_BIZ.EXPORT_FAILED, '导出文件生成失败，请重试');
  }
}

module.exports = {
  // §5.10 log/list — 日志分页查询（module/operator/时间段/keyword 筛选）
  'log/list': wrapAdminAction('log.list', logListImpl, {
    permission: 'view_operation_log', module: 'admin', targetType: 'log',
    log: false, // 读操作不写日志
  }),
  // §5.11 log/detail — 日志详情（含脱敏后 detail）
  'log/detail': wrapAdminAction('log.detail', logDetailImpl, {
    permission: 'view_operation_log', module: 'admin', targetType: 'log',
    targetId: (event) => (event.payload || {}).log_id,
    log: false, // 读操作不写日志
  }),
  // §5.12 log/export — 日志导出 Excel；导出动作本身留痕（R9），detail 记筛选条件与导出行数
  'log/export': wrapAdminAction('log.export', logExportImpl, {
    permission: 'view_operation_log', module: 'admin', targetType: 'log',
    detail: (event, result) => ({
      filters: pick(event, 'module', 'action', 'result', 'operator_id', 'keyword', 'start_time', 'end_time'),
      total: result ? result.total : null,
    }),
  }),
};
