// actions/cron.js — 管理端定时任务（admin-module §5.13）
//   admin-monthly-archive  0 0 3 1 * * * 每月1日03:00：operation_log 按月归档至
//     operation_log_archive（month="YYYYMM"，保留原 _id），归档后删除主表数据，
//     主表只保留近 1 年（R12/§4.4）
//   admin-daily-guard      0 0 4 * * * * 每日04:00：兜底巡检（E12 悬挂导入任务清理 +
//     user_count 冗余校正，§5.13.2）
// 定时任务无用户上下文，写日志 operator 固定 "system"（writeOperationLog 缺省值）
const common = require('@club/admin-common');

const BATCH = 100;                  // 每批拉取/写入/删除条数（≤ 单次批量写上限）
const MAX_BATCHES_PER_MONTH = 200;  // 单月搬移批数保护（2 万条）
const MAX_BACKFILL_MONTHS = 24;     // 历史缺口回补月份上限
const BJ_OFFSET = 8 * 3600 * 1000;  // 归档月份按北京时间口径

// ---- 月份工具 ----

function monthKeyOf(ts) {
  const d = new Date(ts + BJ_OFFSET);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// key 往前/往后推 n 个月（n 可为负）
function shiftMonthKey(key, n) {
  let y = Number(key.slice(0, 4));
  let m = Number(key.slice(4, 6)); // 1-based
  m += n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}${String(m).padStart(2, '0')}`;
}

// 该自然月（北京时间）的 [start, end) 绝对时间戳
function monthRange(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6)) - 1;
  return [Date.UTC(y, m, 1) - BJ_OFFSET, Date.UTC(y, m + 1, 1) - BJ_OFFSET];
}

// ---- 月度归档（§5.13.1 / §4.4 / R12 / E8）----

// 待归档月份：主表最早数据月份 .. 归档线（当前月往前推 12 个月，含）。
// 历史缺口（某月归档中断）靠本函数逐月回补，无需额外状态。
async function monthsToProcess(db, now) {
  const cutoffKey = shiftMonthKey(monthKeyOf(now), -12);
  const res = await db.collection('operation_log')
    .orderBy('created_at', 'asc').limit(1).field({ created_at: true }).get();
  const earliest = res.data && res.data[0];
  if (!earliest || earliest.created_at == null) return [];

  const first = monthKeyOf(earliest.created_at);
  if (first > cutoffKey) return [];

  const list = [];
  let k = first;
  while (k <= cutoffKey && list.length < MAX_BACKFILL_MONTHS) {
    list.push(k);
    k = shiftMonthKey(k, 1);
  }
  return list;
}

async function archiveMonth(db, key) {
  const _ = db.command;
  const [start, end] = monthRange(key);
  const log = db.collection('operation_log');
  const archive = db.collection('operation_log_archive');

  // 幂等重归档：先清空归档表该月旧记录（以主表为准，宁重复不丢，E8/§6.4）
  for (;;) {
    const rm = await archive.where({ month: key }).remove();
    const removed = (rm && rm.stats && rm.stats.removed) || 0;
    if (!removed) break;
  }

  let moved = 0;
  for (let i = 0; i < MAX_BATCHES_PER_MONTH; i++) {
    // 每轮拉该月最早的 100 条（已删除的不再返回，天然支持断点续跑）
    const res = await log.where({ created_at: _.gte(start).and(_.lt(end)) })
      .orderBy('created_at', 'asc').limit(BATCH).get();
    const rows = res.data || [];
    if (!rows.length) break;

    // 整批写入归档表（原样搬移、写入时已脱敏；保留原 _id：month + _id 组成唯一性，§6.4）
    const docs = rows.map((r) => ({ ...r, month: key }));
    await archive.add(docs);

    // 确认归档表该月条数一致（E8：宁重复不丢，计数不符即中断保留主表）
    const c = await archive.where({ month: key }).count();
    if (c.total !== moved + rows.length) {
      throw new Error(`归档写入计数不一致：month=${key} 预期 ${moved + rows.length} 实际 ${c.total}`);
    }

    // 条数确认后删除主表对应记录
    const del = await log.where({ _id: _.in(rows.map((r) => r._id)) }).remove();
    const delCount = (del && del.stats && del.stats.removed) || 0;
    if (delCount !== rows.length) {
      throw new Error(`主表删除计数不一致：month=${key} 预期 ${rows.length} 实际 ${delCount}`);
    }
    moved += rows.length;
  }
  return moved;
}

async function monthlyArchive(now) {
  const { db } = common.getContext();
  const t0 = Date.now();
  const months = await monthsToProcess(db, now);
  let total = 0;
  for (const key of months) {
    const moved = await archiveMonth(db, key);
    if (moved > 0) {
      // 归档动作日志（module=admin / action=log.archive，operator 缺省 system，§5.13.1）
      await common.writeOperationLog({
        module: 'admin',
        action: 'log.archive',
        result: 'success',
        detail: { month: key, moved },
      });
    }
    total += moved;
    console.log(`[admin/cron] monthly-archive ${key} 搬移 ${moved} 条`);
  }
  console.log(`[admin/cron] monthly-archive 完成：${months.length} 个月共 ${total} 条，耗时 ${Date.now() - t0}ms`);
  return { months: months.length, total, ms: Date.now() - t0 };
}

// ---- 每日守护（§5.13.2）----
// ① E12：悬挂导入任务清理——status=processing 且 created_at 超过 10 分钟的 import_record
//   标记 failed（同步导入进程被杀/超时中断时的兜底；submit 正常路径总会落到终态，
//   只有进程级中断才会悬挂）。error_msg 说明原因，finished_at 置巡检时刻。
// ② N/A：操作日志为方案 A 同步落库，无进程内缓冲，无需补偿。
// ③ role_permission.user_count 冗余校正（§6.6）：与 user 表实际计数比对，偏差 > 5 重算。
//   角色量级小（预置 5 + 自定义），逐角色全量校验等价于抽样兜底，成本可控。
// 巡检动作不写操作日志（避免自激产生日志），结果仅记云函数运行日志。
const HANGING_MS = 10 * 60 * 1000;      // 悬挂判定阈值：10 分钟（§5.13.2 ①）
const COUNT_DRIFT_TOLERANCE = 5;        // user_count 偏差容忍（§5.13.2 ③，> 5 才重算）

async function cleanHangingImports(db, now) {
  const _ = db.command;
  const cutoff = now - HANGING_MS;
  let cleaned = 0;
  for (;;) {
    const res = await db.collection('import_record')
      .where({ status: 'processing', created_at: _.lt(cutoff) })
      .limit(BATCH).get();
    const rows = res.data || [];
    if (!rows.length) break;
    await db.collection('import_record')
      .where({ _id: _.in(rows.map((r) => r._id)) })
      .update({
        data: {
          status: 'failed',
          error_msg: '导入任务中断（云函数执行超时或异常终止），请重新提交',
          finished_at: now,
        },
      });
    cleaned += rows.length;
    if (rows.length < BATCH) break;
  }
  return cleaned;
}

async function correctUserCounts(db) {
  const roles = await db.collection('role_permission')
    .field({ role_key: true, user_count: true }).limit(1000).get();
  let corrected = 0;
  for (const r of roles.data || []) {
    const cnt = await db.collection('user').where({ role: r.role_key }).count();
    const actual = cnt.total || 0;
    const stored = r.user_count != null ? r.user_count : 0;
    if (Math.abs(actual - stored) > COUNT_DRIFT_TOLERANCE) {
      await db.collection('role_permission')
        .where({ role_key: r.role_key })
        .update({ data: { user_count: actual } });
      corrected += 1;
      console.log(`[admin/cron] user_count 校正 role=${r.role_key} ${stored} → ${actual}`);
    }
  }
  return corrected;
}

async function dailyGuard(now) {
  const { db } = common.getContext();
  const cleaned = await cleanHangingImports(db, now);
  const corrected = await correctUserCounts(db);
  console.log(`[admin/cron] daily-guard：悬挂导入任务清理 ${cleaned} 条，user_count 校正 ${corrected} 个角色`);
  return { hanging_imports_cleaned: cleaned, user_count_corrected: corrected };
}

const TASKS = {
  'admin-monthly-archive': monthlyArchive,
  'admin-daily-guard': dailyGuard,
};

async function main(event) {
  const name = (event && event.TriggerName) || 'unknown';
  const task = TASKS[name];
  if (!task) {
    console.warn(`[admin/cron] 未注册的触发器: ${name}`);
    return null;
  }
  try {
    return await task(Date.now());
  } catch (e) {
    // E8：任一批次失败立即中断并保留主表数据（宁重复不丢）；下月触发按 month 幂等补齐
    console.error(`[admin/cron] ${name} 执行失败`, e);
    return null;
  }
}

module.exports = { main };
