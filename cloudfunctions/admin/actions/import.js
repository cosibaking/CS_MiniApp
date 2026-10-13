// actions/import.js — Excel 导入框架（admin-module §5.14-§5.17 + §5.20 runImport）
// 权限随 biz_type 动态取注册表 def.permission（R17），故 wrap permission: null + handler 内鉴权。
// 日志：template/status/result 为读操作不写日志；submit 由 handler 完成后自写一条批量日志
//   （module/action 取 def，如 stats/stats.import），避免与 wrap 埋点重复。
const common = require('@club/admin-common');
const {
  wrapAdminAction, getContext, getImporter, listImporters,
  writeOperationLog, sanitizeDetail, withTimeout,
  assertString, BizError, CODE,
} = common;
const ExcelJS = require('exceljs');
const { ADMIN_BIZ, pick, hasAnyPermission } = require('./shared');

const FILE_MAX_SIZE = 2 * 1024 * 1024; // R14：文件 ≤ 2MB
const ROW_MAX = 500;                   // R14：数据行 ≤ 500
const FAILED_ROWS_KEEP = 50;           // 失败明细最多保留/返回 50 条
const LOG_WRITE_TIMEOUT = 800;         // 日志写入限时（ms，E3 方案 A）

// biz_type 动态鉴权（R17）：无权限时告警并拒绝（与 wrap 越权口径一致：不写日志）
function requireBizPermission(auth, def, action) {
  if (!hasAnyPermission(auth, def.permission)) {
    console.warn(`[authz-deny] operator=${auth.operator.id} permission=${def.permission} action=${action}`);
    throw new BizError(CODE.FORBIDDEN, '无权限执行该操作');
  }
}

// ExcelJS 单元格值 → 去空格字符串（数字/文本/richText/公式结果统一归一）
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
    return String(v).trim();
  }
  return String(v).trim();
}

// 下载并解析 xlsx：表头逐列比对（5011）→ 提取数据行（{ _row: Excel 行号, A..I: 文本 }）
async function parseWorkbook(fileId, def) {
  const { cloud } = getContext();
  let fileContent;
  try {
    const dl = await cloud.downloadFile({ fileID: fileId });
    fileContent = dl.fileContent;
  } catch (e) {
    throw new BizError(ADMIN_BIZ.FILE_INVALID, '文件下载失败，请重新上传');
  }
  if (!fileContent) throw new BizError(ADMIN_BIZ.FILE_INVALID, '文件内容为空');
  if (fileContent.length > FILE_MAX_SIZE) {
    throw new BizError(ADMIN_BIZ.FILE_OVER_LIMIT, '文件大小不能超过 2MB');
  }

  let ws;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileContent);
    ws = wb.worksheets && wb.worksheets[0];
    if (!ws) throw new Error('no worksheet');
  } catch (e) {
    throw new BizError(ADMIN_BIZ.FILE_INVALID, '文件解析失败（非有效 xlsx）');
  }

  // 表头逐列匹配（第 1 行，顺序固定）
  const headerRow = ws.getRow(1);
  for (let i = 0; i < def.columns.length; i++) {
    const col = def.columns[i];
    if (cellText(headerRow.getCell(i + 1).value) !== col.title) {
      throw new BizError(ADMIN_BIZ.FILE_INVALID, `表头第 ${col.col} 列应为「${col.title}」`);
    }
  }

  // 数据行提取（跳过表头；整行全空跳过；_row 记原始 Excel 行号）
  const rows = [];
  const maxRow = ws.rowCount || 1;
  for (let r = 2; r <= maxRow; r++) {
    const excelRow = ws.getRow(r);
    const row = { _row: r };
    let hasValue = false;
    for (let i = 0; i < def.columns.length; i++) {
      const text = cellText(excelRow.getCell(i + 1).value);
      row[def.columns[i].col] = text;
      if (text) hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

// §5.14 import/template — 生成模板 xlsx 上传云存储（固定路径幂等覆盖）+ 临时开链
async function importTemplateImpl(event, auth) {
  const p = pick(event, 'biz_type');
  assertString(p.biz_type, 'biz_type', { min: 1, max: 32 });
  const def = getImporter(p.biz_type);
  if (!def) throw new BizError(ADMIN_BIZ.BIZ_TYPE_UNREGISTERED, `不支持的导入类型：${p.biz_type}`);
  requireBizPermission(auth, def, 'import.template');

  const { cloud } = getContext();
  // 表头行 + 示例行（模板与代码 columns 定义保持一致，每次覆盖上传）
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('导入模板');
  ws.addRow(def.columns.map((c) => c.title));
  ws.addRow(def.columns.map((c) => c.example));
  const buffer = await wb.xlsx.writeBuffer();

  const cloudPath = `templates/import/${def.bizType}-template-${def.version}.xlsx`;
  const up = await cloud.uploadFile({ cloudPath, fileContent: Buffer.from(buffer) });
  const urlRes = await cloud.getTempFileURL({ fileList: [up.fileID] });
  const url = urlRes.fileList && urlRes.fileList[0] && urlRes.fileList[0].tempFileURL;
  if (!url) throw new BizError(CODE.INTERNAL, '模板下载链接生成失败，请重试');

  return {
    biz_type: def.bizType, version: def.version,
    file_id: up.fileID, download_url: url,
    columns: def.columns,
  };
}

// §5.15 import/submit — 同步导入：建 import_record → 框架校验 → 逐行 validate/write → 汇总 + 一条批量日志
async function importSubmitImpl(event, auth) {
  const p = pick(event, 'biz_type', 'biz_id', 'file_id', 'file_name');
  assertString(p.biz_type, 'biz_type', { min: 1, max: 32 });
  const def = getImporter(p.biz_type);
  if (!def) throw new BizError(ADMIN_BIZ.BIZ_TYPE_UNREGISTERED, `不支持的导入类型：${p.biz_type}`);
  requireBizPermission(auth, def, 'import.submit');
  if (def.requireBizId) assertString(p.biz_id, 'biz_id', { min: 1, max: 64 });
  assertString(p.file_id, 'file_id', { min: 1, max: 512 });

  const { db } = getContext();
  const now = Date.now();

  // ① 创建 import_record（status=processing；悬挂任务由 daily-guard 兜底标记 failed，E12）
  const addRes = await db.collection('import_record').add({
    data: {
      biz_type: def.bizType, biz_id: p.biz_id || null,
      file_id: p.file_id, file_name: p.file_name || null,
      status: 'processing', total: 0, success_count: 0, fail_count: 0, failed_rows: [],
      submitter_id: auth.operator.id, submitter_name: auth.operator.name,
      error_msg: null, created_at: now, finished_at: null,
    },
  });
  const importId = addRes._id;

  // 框架级/前置失败（E4）：import_record 置 failed + error_msg，不写业务日志（未产生业务变更）
  const failWhole = async (err) => {
    try {
      await db.collection('import_record').doc(importId).update({
        data: { status: 'failed', error_msg: (err && err.msg) || '导入失败', finished_at: Date.now() },
      });
    } catch (e) { console.warn('[import] 更新失败记录异常', e); }
  };

  try {
    // ② 框架级校验：xlsx 后缀（5011）→ 下载 → ≤2MB（5010）→ 解析 + 表头比对（5011）→ 行数 ≤500（5010）
    if (!/\.xlsx$/i.test(p.file_id)) {
      throw new BizError(ADMIN_BIZ.FILE_INVALID, '仅支持 xlsx 文件');
    }
    const rows = await parseWorkbook(p.file_id, def);
    if (rows.length > ROW_MAX) {
      throw new BizError(ADMIN_BIZ.FILE_OVER_LIMIT, `数据行数不能超过 ${ROW_MAX} 行`);
    }
    if (!rows.length) {
      throw new BizError(ADMIN_BIZ.FILE_INVALID, '文件无有效数据行');
    }

    // ③ 业务前置（stats：活动状态 + 预取已签到名单/已有战绩）
    const ctx = {
      db,
      biz_type: def.bizType, biz_id: p.biz_id, file_id: p.file_id, file_name: p.file_name || null,
      operator: auth.operator, // { id, name, role }
      warnings: [],            // 业务警告（姓名不一致等，不阻断）
      extra: {},               // 业务自定义状态（importers/stats.js 维护）
    };
    if (def.beforeImport) await def.beforeImport(ctx);

    // ④ 逐行：required 列非空 → validateRow → writeRow（逐行独立提交，失败行不影响已成功行，R15/E5）
    const failed = [];
    let successCount = 0;
    for (const row of rows) {
      let reason = null;
      const missCol = def.columns.find((c) => c.required && !row[c.col]);
      if (missCol) {
        reason = `${missCol.col} 列「${missCol.title}」必填`;
      } else {
        try {
          reason = await def.validateRow(row, ctx);
        } catch (e) {
          reason = (e && e.msg) || '校验异常';
        }
      }
      if (reason) {
        failed.push({ row: row._row, reason });
        continue;
      }
      try {
        await def.writeRow(row, ctx);
        successCount += 1;
      } catch (e) {
        failed.push({ row: row._row, reason: (e && e.msg) || '写入失败' });
      }
    }

    // ⑤ 业务后置（stats：荣誉重评定 + 军衔重算）——失败仅告警，不影响导入结果
    const summary = { total: rows.length, success_count: successCount, fail_count: failed.length };
    if (def.afterImport && successCount > 0) {
      try {
        await def.afterImport(ctx, summary);
      } catch (e) {
        console.warn('[import] afterImport 失败（不阻断导入返回）', e);
      }
    }

    // ⑥ 更新 import_record（failed_rows 最多保留 50 条，超出截断 + 汇总行）
    const status = failed.length === 0 ? 'succeeded' : 'partial';
    const storedFailed = failed.slice(0, FAILED_ROWS_KEEP);
    if (failed.length > FAILED_ROWS_KEEP) {
      storedFailed.push({ row: 0, reason: `另有 ${failed.length - FAILED_ROWS_KEEP} 条失败明细未保存（页面仅展示前 ${FAILED_ROWS_KEEP} 条）` });
    }
    await db.collection('import_record').doc(importId).update({
      data: {
        status, total: rows.length, success_count: successCount, fail_count: failed.length,
        failed_rows: storedFailed, finished_at: Date.now(),
      },
    });

    // ⑦ 一条批量导入操作日志（module/action 取 def，detail 记 biz_id/计数/失败摘要，E3 非阻断）
    try {
      await withTimeout(writeOperationLog({
        operator: auth.operator,
        module: def.module, action: def.logAction,
        targetType: 'import', targetId: importId,
        detail: sanitizeDetail({
          biz_id: p.biz_id || null, total: rows.length,
          success_count: successCount, fail_count: failed.length,
          fail_summary: failed.slice(0, 5).map((f) => `第${f.row}行：${f.reason}`),
          warnings: ctx.warnings.slice(0, 10),
        }),
        result: 'success', errorMsg: null,
      }), LOG_WRITE_TIMEOUT);
    } catch (logErr) {
      console.warn('[op-log] write failed (非阻断):', logErr);
    }

    return { import_id: importId, status, total: rows.length, success_count: successCount, fail_count: failed.length };
  } catch (err) {
    await failWhole(err);
    throw err; // 交回 wrap 统一返回错误码
  }
}

// import_record 读取 + 访问控制（§5.16/§5.17：本人或有 def 权限）
async function loadImportRecord(event, auth) {
  const p = pick(event, 'import_id');
  assertString(p.import_id, 'import_id', { min: 1, max: 64 });
  const { db } = getContext();

  const { data } = await db.collection('import_record')
    .where({ _id: p.import_id }).limit(1).get();
  if (!data.length) throw new BizError(ADMIN_BIZ.IMPORT_NOT_FOUND, '导入任务不存在');
  const rec = data[0];

  if (rec.submitter_id !== auth.operator.id) {
    const def = getImporter(rec.biz_type);
    if (!def || !hasAnyPermission(auth, def.permission)) {
      throw new BizError(CODE.FORBIDDEN, '无权限执行该操作'); // 非本人且无对应权限点
    }
  }
  return rec;
}

// §5.16 import/status — 任务状态查询（不含 failed_rows 大字段）
async function importStatusImpl(event, auth) {
  const rec = await loadImportRecord(event, auth);
  return {
    import_id: rec._id, biz_type: rec.biz_type, biz_id: rec.biz_id,
    status: rec.status, total: rec.total, success_count: rec.success_count, fail_count: rec.fail_count,
    submitter_id: rec.submitter_id, submitter_name: rec.submitter_name,
    created_at: rec.created_at, finished_at: rec.finished_at,
  };
}

// §5.17 import/result — 失败明细（行号 + 原因，最多 50 条）
async function importResultImpl(event, auth) {
  const rec = await loadImportRecord(event, auth);
  return {
    import_id: rec._id, status: rec.status,
    failed_rows: (rec.failed_rows || []).slice(0, FAILED_ROWS_KEEP),
  };
}

module.exports = {
  // §5.14 import/template — 模板下载（权限随 biz_type，R17；读操作不写日志）
  'import/template': wrapAdminAction('import.template', importTemplateImpl, {
    permission: null, module: 'admin', targetType: 'import', log: false,
  }),
  // §5.15 import/submit — 同步导入（批量日志由 handler 自写：def.module/def.logAction）
  'import/submit': wrapAdminAction('import.submit', importSubmitImpl, {
    permission: null, module: 'admin', targetType: 'import', log: false,
    targetId: (event, result) => (result && result.import_id) || null,
  }),
  // §5.16 import/status — 状态查询（本人或 def 权限；读操作不写日志）
  'import/status': wrapAdminAction('import.status', importStatusImpl, {
    permission: null, module: 'admin', targetType: 'import', log: false,
    targetId: (event) => (event.payload || {}).import_id,
  }),
  // §5.17 import/result — 失败明细（本人或 def 权限；读操作不写日志）
  'import/result': wrapAdminAction('import.result', importResultImpl, {
    permission: null, module: 'admin', targetType: 'import', log: false,
    targetId: (event) => (event.payload || {}).import_id,
  }),
};
