// actions/cron.js — 订单定时任务（payment-module §5.11/§5.12）
//   order-close-timeout  0 * * * * * * 每分钟：扫描 pending && expire_at<now，
//     微信查单定真实状态——未支付 → closed(timeout) + 释放名额；已支付 → 补记入账；
//   order-reconcile     0 0 5 * * * *  每日05:00：退款失败重试（failed && retry_count<5，
//     沿用原 refund_no，§8.4）+ 汇总日志；微信账单下载比对 M2 落地（§5.12 ②）。
// 契约：main 仅接受 Timer 触发；task 返回裸数据由 main 统一包 ok；
// runReconcile 供 order.js reconcile action 内部调用（返回统一结构）。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;
const S = require('./shared');

// §5.11 超时关单（每批 SCAN_BATCH=100，单笔失败不阻断，skipped 下轮重扫）
async function closeTimeoutCore() {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const now = Date.now();

  const res = await db.collection('order')
    .where({ status: 'pending', expire_at: _.lt(now) })
    .limit(S.SCAN_BATCH)
    .get();
  const orders = res.data || [];

  let closed = 0;
  let paidLate = 0;
  let skipped = 0;
  for (const order of orders) {
    try {
      // ① 先查单：回调丢失场景下可能已支付（NOTPAY/CLOSED 才走关单）
      const q = await S.queryAndMarkPaid(cloud, db, order);
      if (q.paid) { paidLate += 1; continue; }
      if (!q.query.ok) { skipped += 1; continue; } // 查单失败，下轮再试
      // ② 未支付 → 关单（事务幂等 + 微信关单 + notifyClose 释放名额）
      const c = await S.closePendingOrder(cloud, db, order, 'timeout');
      if (c.closed) closed += 1; else skipped += 1;
    } catch (e) {
      skipped += 1;
      console.error('[order/cron] closeTimeout 单笔失败（跳过）', order.order_no, e);
    }
  }

  return { scanned: orders.length, closed, paid_late: paidLate, skipped };
}

// §5.12 对账核心：M1 = 退款失败重试；账单比对 M2（需商户侧账单下载能力）
async function reconcileCore() {
  const { cloud, db } = common.getContext();
  const _ = db.command;

  const res = await db.collection('refund')
    .where({ status: 'failed', retry_count: _.lt(S.REFUND_RETRY_MAX) })
    .limit(S.SCAN_BATCH)
    .get();
  const refunds = res.data || [];

  let retryOk = 0;
  let retryFailed = 0;
  for (const refund of refunds) {
    try {
      // 沿用同 refund_no 重试（微信侧 out_refund_no 唯一，受理幂等）；
      // executeRefund 失败分支自增 retry_count，达到上限后不再入扫
      const r = await S.executeRefund(cloud, db, refund);
      if (r.ok) retryOk += 1; else retryFailed += 1;
      S.logSystemAction('order.refund.retry', {
        targetType: 'refund',
        targetId: refund.refund_no,
        detail: { attempt: (refund.retry_count || 0) + 1, amount: refund.amount },
        result: r.ok ? 'success' : 'fail',
        errorMsg: r.ok ? null : String(r.fail_reason || '').slice(0, 200),
      });
    } catch (e) {
      retryFailed += 1;
      console.error('[order/cron] reconcile 单笔重试异常（跳过）', refund.refund_no, e);
      S.logSystemAction('order.refund.retry', {
        targetType: 'refund',
        targetId: refund.refund_no,
        detail: { attempt: (refund.retry_count || 0) + 1, amount: refund.amount },
        result: 'fail',
        errorMsg: String((e && e.errMsg) || e).slice(0, 200),
      });
    }
  }

  const summary = {
    bill_date: S.formatDateTime(Date.now() - S.HOUR_24).slice(0, 10), // 对账自然日（昨日账单）
    refund_retried: refunds.length,
    refund_retry_ok: retryOk,
    refund_retry_failed: retryFailed,
    bill_compare: 'M2', // 微信账单下载比对未落地
  };
  S.logSystemAction('order.reconcile', { detail: summary });
  return summary;
}

const TASKS = {
  'order-close-timeout': closeTimeoutCore,
  'order-reconcile': reconcileCore,
};

async function main(event) {
  if (!event || event.Type !== 'Timer') {
    return fail(CODE.FORBIDDEN, '仅限定时触发调用');
  }
  const name = event.TriggerName || 'unknown';
  const task = TASKS[name];
  if (!task) {
    return fail(CODE.PARAM, `未注册的触发器：${name}`);
  }
  try {
    const data = await task(event);
    console.log(`[order/cron] ${name} 完成`, JSON.stringify(data));
    return ok(data);
  } catch (e) {
    console.error(`[order/cron] ${name} 执行失败`, e);
    return fail(CODE.INTERNAL, `${name} 执行失败`);
  }
}

// 手动补跑对账入口（order.js reconcile action 惰性 require 本导出）
async function runReconcile(event) {
  return ok(await reconcileCore(event));
}

module.exports = { main, runReconcile };
