// actions/pay.js — 支付回调（payment-module §5.3 / §6.1 支付时序）
// 云调用模式：回调由微信侧推送至本云函数（云开发控制台配置指向），推送+验签/解密
// 由微信平台完成，event 即解析后的支付结果 JSON。
// 出参为微信协议 { errcode, errmsg } —— 全模块唯一不走统一 { code, msg, data } 的出口
// （§3 出口约定）；错误一律应答 errcode != 0 让微信按策略重推，幂等保护重入。
const common = require('@club/admin-common');
const S = require('./shared');

const { ORDER_PAID_STATUSES } = S;

// 微信应答
function answer(errcode, errmsg) {
  return { errcode, errmsg };
}

// timeEnd（yyyyMMddHHmmss，北京时间）→ 毫秒时间戳
function parseTimeEnd(timeEnd) {
  const s = String(timeEnd || '');
  if (!/^\d{14}$/.test(s)) return Date.now();
  return Date.UTC(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)
  ) - 8 * 3600 * 1000;
}

// 回调原文存档（§6.2：单条 < 2KB；浅拷贝剔除云函数路由注入字段）
function pickRaw(p) {
  const raw = { ...p };
  delete raw.action;
  delete raw.userInfo;
  return raw;
}

// callback — 支付结果回调
// ① returnCode + resultCode 均 SUCCESS 才继续；其他通知记日志应答成功（不改变订单）
// ② 幂等：按 outTradeNo 定位订单；已 paid/partial_refunded/refunded → 直接应答成功
// ③ 金额校验 totalFee == pay_amount（§8.7）；不一致 → payment 存证（state=fail +
//    callback_raw 原文）+ 告警日志 + 应答成功但不置已支付（防无限重推，转人工）
// ④ markPaid 入账（§5.3 ④⑤）：事务 pending|closed → paid + payment 落库；
//    closed 晚付 → 自动原路全额退款（§8.2，不恢复名额）；联动 activity notifyPaid
//    生效（失败仅记日志，对账/人工兜底）——均封装在 shared.markPaid
// ⑤ 事务冲突 → 应答 errcode != 0 等微信重推；订单不存在 → 告警 + 应答成功（转人工）
async function callback(event) {
  const { cloud, db } = common.getContext();
  const p = event || {};

  try {
    // ① 只处理支付成功通知（失败/中间态：记日志 + 应答成功，不动订单）
    if (p.returnCode !== 'SUCCESS' || p.resultCode !== 'SUCCESS') {
      console.warn('[order] callback 非成功通知（应答成功不处理）',
        JSON.stringify({ returnCode: p.returnCode, resultCode: p.resultCode, errCode: p.errCode }));
      return answer(0, 'OK');
    }

    // ② 定位订单（缺单号无法定位：告警 + 应答成功防无限重推）
    const outTradeNo = p.outTradeNo;
    if (!outTradeNo || typeof outTradeNo !== 'string') {
      console.error('[order] callback 缺少 outTradeNo（告警转人工）', JSON.stringify(p).slice(0, 512));
      S.logSystemAction('order.intervene', {
        targetType: 'order', targetId: null,
        detail: { issue: 'callback_missing_out_trade_no', raw: JSON.stringify(p).slice(0, 256) },
        result: 'fail', errorMsg: '回调缺少商户订单号',
      });
      return answer(0, 'OK');
    }

    const order = await S.getOrderByNo(db, outTradeNo);
    if (!order) {
      console.error(`[order] callback 订单不存在（告警转人工）：${outTradeNo}`);
      S.logSystemAction('order.intervene', {
        targetType: 'order', targetId: outTradeNo,
        detail: { issue: 'order_not_found', order_no: outTradeNo },
        result: 'fail', errorMsg: '回调订单不存在',
      });
      return answer(0, 'OK');
    }
    if (ORDER_PAID_STATUSES.includes(order.status)) {
      return answer(0, 'OK'); // 重复回调（§8.1 微信重试推送）幂等
    }

    // ③ 金额校验（服务端金额计算 + 回调校验双保险，§8.7）
    const totalFee = Number(p.totalFee);
    if (!Number.isFinite(totalFee) || totalFee !== order.pay_amount) {
      console.error(`[order] callback 金额不一致（告警转人工）：${outTradeNo} expect=${order.pay_amount} actual=${totalFee}`);
      try {
        // 存证：payment 落 state=fail + callback_raw 原文（对账/纠纷追溯）
        await db.collection('payment').add({
          data: {
            order_id: order._id,
            order_no: order.order_no,
            transaction_id: p.transactionId || null,
            channel: 'wxpay',
            amount: Number.isFinite(totalFee) ? totalFee : 0,
            state: 'fail',
            openid: p.openid || null,
            paid_at: Date.now(),
            callback_raw: pickRaw(p),
            created_at: Date.now(),
          },
        });
      } catch (e2) {
        console.error('[order] callback 金额不一致存证失败', outTradeNo, e2);
      }
      S.logSystemAction('order.intervene', {
        targetType: 'order', targetId: order._id,
        detail: { issue: 'amount_mismatch', order_no: outTradeNo, expect: order.pay_amount, actual: totalFee },
        result: 'fail', errorMsg: '回调金额与订单不一致',
      });
      return answer(0, 'OK'); // 不置已支付；应答成功防无限重推，转人工核查
    }

    // ④ 入账（事务条件更新 + payment 落库 + 活动联动 + 晚付自动退款）
    const res = await S.markPaid(cloud, db, {
      order,
      transactionId: p.transactionId || null,
      paidAt: parseTimeEnd(p.timeEnd),
      openid: p.openid || null,
      callbackRaw: pickRaw(p),
    });

    if (res.state === 'conflict') {
      // 事务异常（并发快照冲突/payment 唯一索引冲突）→ 应答失败，微信重推（幂等保护重入）
      console.error('[order] callback 入账事务冲突（应答失败等重推）', outTradeNo);
      return answer(1, 'RETRY_LATER');
    }
    // paid / late_paid（已自动退款）/ duplicate / not_found → 应答成功
    return answer(0, 'OK');
  } catch (e) {
    // 未捕获异常：应答失败，由微信重推兜底（幂等保护重入）
    console.error('[order] callback 未捕获异常（应答失败等重推）', e);
    return answer(1, 'INTERNAL_ERROR');
  }
}

module.exports = { callback };
