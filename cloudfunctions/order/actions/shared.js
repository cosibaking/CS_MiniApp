// actions/shared.js — order 模块共享助手（payment-module §3/§5/§6/§8）
// 供 order / pay / refund / cron 复用：业务错误码、取参兼容、internal 校验、
// cloudPay 包装（unifiedOrder/queryOrder/refund/closeOrder）、支付入账 markPaid、
// 退款执行 executeRefund、自动退款 createAutoRefund、活动联动、订阅消息、系统日志。
//
// 错误码口径：基础码用 CODE.*（common/constants.js 为数值权威）；order 业务码
// 40xxx/5xxxx 本地定义（payment-module §5.0，文档基础码 40001/40101/40301/50000
// 与框架 CODE 段冲突时以框架为准，仅占用文档独有号位）。
const common = require('@club/admin-common');
const { CODE } = common;

// ---------- 常量 ----------

const PAGE_SIZE_MAX = 50;              // 列表分页上限（§5.5）
const SCAN_BATCH = 100;                // 定时扫描分批（§3.2/§5.11）
const REFUND_RETRY_MAX = 5;            // 退款失败重试上限（§8.4）
const HOUR_24 = 24 * 3600 * 1000;      // 退款规则 24h 分界（§3.4）

const ORDER_STATUSES = ['pending', 'paid', 'partial_refunded', 'refunded', 'closed'];
const ORDER_PAID_STATUSES = ['paid', 'partial_refunded', 'refunded'];  // 幂等判断（重复回调）
const ORDER_REFUNDABLE = ['paid', 'partial_refunded'];                 // 可退款状态（§5.8 ②）
const REFUND_OPEN_STATUSES = ['pending', 'processing'];               // 未终态退款单（42004 重复申请）
const REFUND_FINAL_STATUSES = ['success', 'failed', 'rejected'];       // 终态

// order 业务错误码（§5.0 的 40xxx/5xxxx 独有号位）
const BIZ = {
  NOT_OWNER: 40302,        // 无权访问该资源（非订单本人/非本人退款单）
  NOT_FOUND: 40401,        // 资源不存在（订单/退款单）
  STATE_CONFLICT: 40901,   // 状态冲突（订单非待支付等）
  PAID_ALREADY: 40902,     // 已完成支付，取消失败（查单发现已支付）
  PRODUCT_OFF: 41004,      // 商品不可购（卡种已下架/不存在，§5.1 41004）
  REFUND_STATE: 42001,     // 订单状态不允许退款（pending/closed/refunded）
  REFUND_NOT_ALLOWED: 42002, // 不满足退款条件（已开始/已签到/无可退余额）
  REFUND_ZERO: 42003,      // 退款金额为零
  REFUND_DUP: 42004,       // 重复申请 / 退款单状态不允许审核
  REFUND_REMARK: 42005,    // 驳回必须填写理由
  REFUND_EXCEED: 42006,    // 退款金额超出可退余额
  WX_PAY: 50001,           // 微信支付接口调用失败
  TX: 50002,               // 数据库事务失败（可重试）
  CARD_NONE: 43001,        // 无可用次卡（verifyCard §5.13）
  CARD_INSUFFICIENT: 43002, // 次卡次数不足（条件更新竞争失败）
  CARD_DUP: 43003,         // 重复核销（该活动该用户已有核销流水）
};

// ---------- 取参与身份 ----------

// 双取参兼容：前端 callCloud 走 event.payload 嵌套；activity callOrderInternal
// 走 event 顶层展开（data:Object.assign({action,...}, payload)）。先 payload 再顶层。
function pick(event, ...keys) {
  const payload = (event && event.payload) || {};
  const top = event || {};
  const out = {};
  for (const k of keys) {
    if (payload[k] !== undefined) out[k] = payload[k];
    else if (top[k] !== undefined) out[k] = top[k];
  }
  return out;
}

// 内部调用校验（activity/user 同款：source=internal + internal_token 比对）
function isInternal(event) {
  const token = process.env.internal_token || '';
  return !!(token && event && event.source === 'internal' && event.internal_token === token);
}

// openid → user 文档（未注册/未登录返回 null）
async function getCurrentUser(cloud, db) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

// 单文档读取（doc 不存在时 SDK 抛错 → 返回 null）
async function getDoc(db, coll, id) {
  if (!id) return null;
  try {
    const res = await db.collection(coll).doc(id).get();
    return (res && res.data) || null;
  } catch (e) {
    return null;
  }
}

async function getOrderByNo(db, orderNo) {
  if (!orderNo || typeof orderNo !== 'string') return null;
  const res = await db.collection('order').where({ order_no: orderNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function getRefundByNo(db, refundNo) {
  if (!refundNo || typeof refundNo !== 'string') return null;
  const res = await db.collection('refund').where({ refund_no: refundNo }).limit(1).get();
  return (res.data && res.data[0]) || null;
}

// 未终态退款单查重（§5.8 ② / §5.10 幂等）
async function findOpenRefund(db, orderId) {
  const _ = db.command;
  const res = await db.collection('refund')
    .where({ order_id: orderId, status: _.in(REFUND_OPEN_STATUSES) })
    .orderBy('created_at', 'desc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

// ---------- 单号 ----------

const INSTANCE_ID = String(Math.floor(Math.random() * 10000)).padStart(4, '0');

function padNum(n, len) {
  return String(n).padStart(len, '0');
}

// 退款单号（§6.4）：'RF' + yyMMddHHmmss(12) + 实例(4) + 随机(6) = 24 位
// 与 activity/shared.js genOrderNo 同法（东八区，UTC 方法偏移 8h）
function genRefundNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const ts = String(d.getUTCFullYear()).slice(2)
    + padNum(d.getUTCMonth() + 1, 2) + padNum(d.getUTCDate(), 2)
    + padNum(d.getUTCHours(), 2) + padNum(d.getUTCMinutes(), 2) + padNum(d.getUTCSeconds(), 2);
  return `RF${ts}${INSTANCE_ID}${padNum(Math.floor(Math.random() * 1000000), 6)}`;
}

// 订单号（§6.4）：'CS' + yyMMddHHmmss(12) + 实例(4) + 随机(6) = 24 位
function genOrderNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const ts = String(d.getUTCFullYear()).slice(2)
    + padNum(d.getUTCMonth() + 1, 2) + padNum(d.getUTCDate(), 2)
    + padNum(d.getUTCHours(), 2) + padNum(d.getUTCMinutes(), 2) + padNum(d.getUTCSeconds(), 2);
  return `CS${ts}${INSTANCE_ID}${padNum(Math.floor(Math.random() * 1000000), 6)}`;
}

function genNonce(len = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---------- 云函数互调（activity 模块） ----------

// 调 activity 内部接口（notifyPaid/notifyRefund，wrapInternal 校验 internal_token）
async function callActivityInternal(cloud, action, payload) {
  const token = process.env.internal_token || '';
  if (!token) return { ok: false, code: null, msg: 'internal_token 未配置' };
  try {
    const res = await cloud.callFunction({
      name: 'activity',
      data: Object.assign({ action, source: 'internal', internal_token: token }, payload),
    });
    const body = res && res.result;
    if (body && body.code === 0) return { ok: true, data: body.data };
    return { ok: false, code: body && body.code, msg: (body && body.msg) || 'activity 模块返回失败' };
  } catch (e) {
    return { ok: false, code: null, msg: (e && e.errMsg) || String(e) };
  }
}

// 调 user 内部接口（activateCard 等，wrapInternal 校验 internal_token；§7.3）
async function callUserInternal(cloud, action, payload) {
  const token = process.env.internal_token || '';
  if (!token) return { ok: false, code: null, msg: 'internal_token 未配置' };
  try {
    const res = await cloud.callFunction({
      name: 'user',
      data: Object.assign({ action, source: 'internal', internal_token: token }, payload),
    });
    const body = res && res.result;
    if (body && body.code === 0) return { ok: true, data: body.data };
    return { ok: false, code: body && body.code, msg: (body && body.msg) || 'user 模块返回失败' };
  } catch (e) {
    return { ok: false, code: null, msg: (e && e.errMsg) || String(e) };
  }
}

// ---------- cloudPay 包装（统一商户号读取与错误归一） ----------

function getSubMchId() {
  return process.env.SUB_MCH_ID || '';
}

// 统一下单（§5.2 ③）：outTradeNo=order_no、totalFee=pay_amount、body=快照标题
// 同一待支付订单重复调用可直接复用未过期 prepay（微信侧同单可重调）
async function callUnifiedOrder(cloud, order) {
  const subMchId = getSubMchId();
  if (!subMchId) return { ok: false, msg: 'SUB_MCH_ID 未配置' };
  const title = (order.snapshot && order.snapshot.title) || '俱乐部订单';
  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: '活动报名-' + String(title).slice(0, 120),
      outTradeNo: order.order_no,
      subMchId,
      totalFee: order.pay_amount,
      spbillCreateIp: '127.0.0.1',
      envId: process.env.PAY_CALLBACK_ENV || process.env.TCB_ENV || '',
      functionName: 'order', // 支付回调指向本模块（控制台支付回调配置一致）
    });
    const payment = res && res.payment;
    if (!payment) return { ok: false, msg: 'unifiedOrder 未返回 payment 参数' };
    return { ok: true, payment };
  } catch (e) {
    return { ok: false, msg: (e && e.errMsg) || String(e) };
  }
}

// 查单（§5.7 ③ 取消前查单 / §5.11 ③ 关单前查单 / §5.4 ③ 轮询兜底）
// 返回 { ok, tradeState, raw }；接口异常（含订单不存在）→ { ok:false, msg }
async function callQueryOrder(cloud, orderNo) {
  const subMchId = getSubMchId();
  if (!subMchId) return { ok: false, msg: 'SUB_MCH_ID 未配置' };
  try {
    const res = await cloud.cloudPay.queryOrder({ subMchId, outTradeNo: orderNo });
    return { ok: true, tradeState: (res && res.tradeState) || null, raw: res || null };
  } catch (e) {
    return { ok: false, msg: (e && e.errMsg) || String(e) };
  }
}

// 退款（§4.3）：outRefundNo=refund_no 原路退回；云调用退款无独立回调，
// returnCode+resultCode 均 SUCCESS 即受理成功（同步确认，到账有延迟但状态已定）
async function callWxRefund(cloud, { orderNo, refundNo, totalFee, refundFee }) {
  const subMchId = getSubMchId();
  if (!subMchId) return { ok: false, msg: 'SUB_MCH_ID 未配置' };
  try {
    const res = await cloud.cloudPay.refund({
      subMchId,
      outTradeNo: orderNo,
      outRefundNo: refundNo,
      totalFee,
      refundFee,
      nonceStr: genNonce(),
    });
    const success = res && res.returnCode === 'SUCCESS' && res.resultCode === 'SUCCESS';
    if (success) {
      return { ok: true, wxRefundId: res.refundId || null, raw: res };
    }
    return {
      ok: false,
      msg: String((res && (res.errCodeDes || res.returnMsg || res.errMsg)) || '退款受理失败'),
      raw: res,
    };
  } catch (e) {
    return { ok: false, msg: (e && e.errMsg) || String(e) };
  }
}

// 微信侧关单（§5.7 ⑤ / §5.11 ③，建议项，失败不阻断本地关单）
async function callCloseOrder(cloud, orderNo) {
  const subMchId = getSubMchId();
  if (!subMchId) return { ok: false, msg: 'SUB_MCH_ID 未配置' };
  try {
    const res = await cloud.cloudPay.closeOrder({ subMchId, outTradeNo: orderNo });
    const success = res && res.returnCode === 'SUCCESS';
    return { ok: !!success, raw: res || null };
  } catch (e) {
    return { ok: false, msg: (e && e.errMsg) || String(e) };
  }
}

// ---------- 活动退款规则（§3.4/§3.6/§8.2） ----------

// 活动单退款上下文：start_time 以活动模块最新值为准（§6.4，快照仅展示）；
// 已签到判定取 enrollment.status；M1 单人单（items[0]），批量单 M3 扩展。
// biz_type 兼容：activity 侧写 'activity_enroll'（权威），payment 文档写 'activity_signup'。
async function getActivityRefundContext(db, order) {
  const isActivityOrder = order.biz_type === 'activity_enroll' || order.biz_type === 'activity_signup';
  if (!isActivityOrder) return null; // 会员卡单 M2 按 §3.5 计算
  const item = (order.items || [])[0];
  const enrollmentId = (item && item.enrollment_id) || order.biz_id;
  const snapStart = (order.snapshot && order.snapshot.start_time) || null;
  if (!enrollmentId) return { start_time: snapStart, checked_in: false, enrollment: null };
  const enr = await getDoc(db, 'activity_enrollment', enrollmentId);
  if (!enr) return { start_time: snapStart, checked_in: false, enrollment: null };
  const act = enr.activity_id ? await getDoc(db, 'activity', enr.activity_id) : null;
  const startTime = (act && act.start_time) || enr.activity_start_time || snapStart;
  return {
    start_time: startTime,
    checked_in: enr.status === 'checked_in',
    enrollment: enr,
  };
}

// 退款规则三档（§3.4 默认提案 Q17）：
// ① 俱乐部取消 / 晚付退款 → 全额 auto（§3.6/§8.2）；
// ② start−now ≥ 24h → 全额 auto；③ <24h 且未开始 → round(pay_amount×50%) manual（与可退余额取小）；
// ④ 已开始（now≥start）或已签到 → 不退（42002 前置拦截）。
// 返回 { allowed, amount, type } 或 { allowed:false, code, msg }
function calcActivityRefundRule({ payAmount, refundedTotal, startTime, checkedIn, refundType, now }) {
  const refundable = (payAmount || 0) - (refundedTotal || 0);
  if (refundable <= 0) {
    return { allowed: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '已无可退余额' };
  }
  if (checkedIn) {
    return { allowed: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '已签到，不可退款' };
  }
  if (refundType === 'club_cancel' || refundType === 'late_paid') {
    return { allowed: true, amount: refundable, type: 'auto', refundable };
  }
  const t = now || Date.now();
  if (startTime && t >= startTime) {
    return { allowed: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '活动已开始，不可退款' };
  }
  if (!startTime || startTime - t >= HOUR_24) {
    return { allowed: true, amount: refundable, type: 'auto', refundable };
  }
  const half = Math.round((payAmount || 0) * 0.5);
  return { allowed: true, amount: Math.min(half, refundable), type: 'manual', refundable };
}

// ---------- 按人部分退款（§3.9，批量单以人为最小单位） ----------

// 实付分摊：unit = floor(pay_amount / n)，余数锚定 order.items 末位（固定锚点）。
// 文档「余数计入最后一个勾选人」若按每轮勾选动态归属，多轮退款会破坏
// Σ单人均摊 ≡ pay_amount 的不变量（如 100/3 人：34+34+33=101 超退），
// 故实现锚定明细末位；无折扣时 floor 除法自然还原 unit_price、余数为 0。
function calcPerUserShares(order) {
  const items = order.items || [];
  const n = items.length;
  const shares = new Map();
  if (n <= 0) return shares;
  const unit = Math.floor((order.pay_amount || 0) / n);
  let remainder = (order.pay_amount || 0) - unit * n;
  items.forEach((it, idx) => {
    let share = unit;
    if (idx === n - 1 && remainder > 0) {
      share += remainder;
      remainder = 0;
    }
    shares.set(it.user_id, share);
  });
  return shares;
}

// 按人退款规则（§3.9，时间比例沿用 §3.4 套用到单人分摊）：
// ① per-item 退款标记去重（§6.5，已退款成员不可再勾选）；
// ② 已签到成员 → 42002（单人粒度，先于 refundType 判定，与整单规则一致）；
// ③ club_cancel/late_paid → 全额分摊 auto；④ 已开始 → 42002；
// ⑤ <24h 且未开始 → round(share×50%) manual；⑥ refunded_total + 本次 ≤ pay_amount。
// 返回 { ok:true, amount, type, items } 或 { ok:false, code, msg }——
// 不抛异常：refundApply 是普通 handler（return fail），refundAudit 可抛 BizError，
// 由调用方各自转换。refundType='user' 之外的语义与整单 calcActivityRefundRule 对齐。
async function calcPerUserRefund(db, order, ctx, refundUserIds, refundType, now) {
  const t = now || Date.now();
  if (!ctx) {
    return { ok: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '该订单类型不支持按人退款' };
  }
  const orderItems = order.items || [];
  if (orderItems.length < 2) {
    return { ok: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '单人订单不支持按人退款，请直接申请整单退款' };
  }
  if (!Array.isArray(refundUserIds) || refundUserIds.length === 0) {
    return { ok: false, code: CODE.PARAM, msg: 'refund_user_ids 不能为空' };
  }
  if (!refundUserIds.every((id) => typeof id === 'string' && id)) {
    return { ok: false, code: CODE.PARAM, msg: 'refund_user_ids 格式错误' };
  }
  const picked = [...new Set(refundUserIds)];
  if (picked.length !== refundUserIds.length) {
    return { ok: false, code: CODE.PARAM, msg: 'refund_user_ids 存在重复' };
  }
  const itemMap = new Map(orderItems.map((it) => [it.user_id, it]));
  for (const uid of picked) {
    const it = itemMap.get(uid);
    if (!it) return { ok: false, code: CODE.PARAM, msg: '所选成员不在此订单中' };
    if (it.refund_status === 'refunded') {
      return { ok: false, code: BIZ.REFUND_STATE, msg: '所选成员中已有已退款者，请调整勾选' };
    }
    if (!it.enrollment_id) {
      return { ok: false, code: BIZ.REFUND_STATE, msg: '订单明细缺少报名记录，无法按人退款' };
    }
  }
  // 逐人签到态：批量取勾选成员的 enrollment（ctx.enrollment 仅 items[0]，不可复用）
  const _ = db.command;
  const enrIds = picked.map((uid) => itemMap.get(uid).enrollment_id);
  const enrRes = await db.collection('activity_enrollment').where({ _id: _.in(enrIds) }).get();
  const enrMap = new Map((enrRes.data || []).map((e) => [e._id, e]));
  for (const uid of picked) {
    const it = itemMap.get(uid);
    const enr = enrMap.get(it.enrollment_id);
    if (!enr) return { ok: false, code: BIZ.REFUND_STATE, msg: `成员 ${it.nickname || uid} 报名记录不存在` };
    if (enr.status === 'checked_in') {
      return { ok: false, code: BIZ.REFUND_NOT_ALLOWED, msg: `成员 ${it.nickname || uid} 已签到，不可退款` };
    }
  }
  // 时间门禁（全局判定一次，比例落到单人分摊）
  if (refundType !== 'club_cancel' && refundType !== 'late_paid') {
    if (ctx.start_time && t >= ctx.start_time) {
      return { ok: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '活动已开始，不可退款' };
    }
  }
  const manual = refundType !== 'club_cancel' && refundType !== 'late_paid'
    && !!(ctx.start_time && ctx.start_time - t < HOUR_24);
  const shares = calcPerUserShares(order);
  const refundItems = [];
  let total = 0;
  for (const uid of picked) {
    const it = itemMap.get(uid);
    const share = shares.get(uid) || 0;
    const amt = manual ? Math.round(share * 0.5) : share;
    if (amt <= 0) return { ok: false, code: BIZ.REFUND_ZERO, msg: '退款金额为零' };
    total += amt;
    refundItems.push({ user_id: uid, enrollment_id: it.enrollment_id, nickname: it.nickname || '' });
  }
  // 余额门禁（§3.9 边界：多次按人退叠加，累计不超 pay_amount）
  if ((order.refunded_total || 0) + total > (order.pay_amount || 0)) {
    return { ok: false, code: BIZ.REFUND_EXCEED, msg: '退款金额超过可退余额' };
  }
  return { ok: true, amount: total, type: manual ? 'manual' : 'auto', items: refundItems };
}

// ---------- 退款单创建与执行（§5.8/§5.9/§5.10/§8.4） ----------

// 建退款单（§6.3）。type=auto → status=processing 直接待执行；manual → pending 待审核。
// refund_type 为联动扩展字段（notifyRefund 据此判定是否递补）：'user'|'club_cancel'|'late_paid'
// perUser=true 标记按人退款单（§3.9）：refundAudit 据此走逐人重算分支；旧文档无此字段走整单重算。
async function createRefundDoc(db, { order, amount, type, reason, refundType, applyUserId, items, perUser }) {
  const now = Date.now();
  let refundNo = genRefundNo();
  // refund_no 唯一索引兜底：冲突重试一次（§6.4）
  for (let i = 0; i < 2; i += 1) {
    const doc = {
      refund_no: refundNo,
      order_id: order._id,
      order_no: order.order_no,
      type,
      amount,
      reason: String(reason || '').slice(0, 200),
      status: type === 'auto' ? 'processing' : 'pending',
      apply_user_id: applyUserId,
      refund_type: refundType || 'user',
      per_user: !!perUser,
      items: items && items.length
        ? items
        : (order.items || []).map((it) => ({
          user_id: it.user_id,
          enrollment_id: it.enrollment_id || null,
          nickname: it.nickname || '',
        })),
      auditor_id: null,
      audit_at: null,
      audit_remark: null,
      wx_refund_id: null,
      refunded_at: null,
      fail_reason: null,
      retry_count: 0,
      created_at: now,
      updated_at: now,
    };
    try {
      const res = await db.collection('refund').add({ data: doc });
      return Object.assign({}, doc, { _id: res._id });
    } catch (e) {
      if (i === 0) {
        refundNo = genRefundNo();
        continue;
      }
      throw e;
    }
  }
  return null; // 不可达（循环内 return/throw）
}

// 退款联动（事务外）：逐人 notifyRefund 释放名额 + 候补递补（§4.3）
// club_cancel 不递补（活动已取消）；enrollment 已 cancelled → notifyRefund 幂等直接成功
async function notifyRefundItems(cloud, db, order, refund) {
  const items = refund.items || [];
  for (const it of items) {
    if (!it.enrollment_id) continue;
    const res = await callActivityInternal(cloud, 'notifyRefund', {
      order_id: order._id,
      enrollment_id: it.enrollment_id,
      refund_id: refund._id,
      refund_type: refund.refund_type || 'user',
    });
    if (!res.ok) {
      console.error(`[refund] notifyRefund 联动失败（enrollment=${it.enrollment_id}）`, res.msg);
    }
  }
}

// 退款执行核心（§4.3/§6.4/§8.4）：
// ① cloudPay.refund 同步确认；② 事务：refund→success + order.refunded_total 累加 +
// items.refund_status 标记 + 状态流转（partial_refunded/refunded）——强一致，失败整体回滚；
// ③ 事务外：notifyRefund 联动 + 退款到账订阅消息。
// 微信侧失败 → failed + fail_reason + retry_count+1（对账重试沿用同 refund_no，§8.4）；
// 微信已受理但本地记账事务失败 → 保持 processing + 告警（防二次退款，对账人工修正）。
async function executeRefund(cloud, db, refund) {
  const order = await getDoc(db, 'order', refund.order_id);
  if (!order) {
    await db.collection('refund').doc(refund._id).update({
      data: { status: 'failed', fail_reason: '关联订单不存在', updated_at: Date.now() },
    });
    return { ok: false, status: 'failed', fail_reason: '关联订单不存在' };
  }

  // ① 云调用退款（out_refund_no = refund_no，微信侧唯一，重试沿用）
  const wxRes = await callWxRefund(cloud, {
    orderNo: order.order_no,
    refundNo: refund.refund_no,
    totalFee: order.pay_amount,
    refundFee: refund.amount,
  });
  const now = Date.now();
  if (!wxRes.ok) {
    await db.collection('refund').doc(refund._id).update({
      data: {
        status: 'failed',
        fail_reason: String(wxRes.msg).slice(0, 200),
        retry_count: (refund.retry_count || 0) + 1,
        updated_at: now,
      },
    });
    return { ok: false, status: 'failed', fail_reason: wxRes.msg };
  }

  // ② 本地记账事务（§6.4：refund 置 success 与 refunded_total 累加同事务强一致）
  const refundUserIds = new Set((refund.items || []).map((it) => it.user_id));
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('order').doc(order._id).get();
    const doc = cur && cur.data;
    const newTotal = (doc.refunded_total || 0) + refund.amount;
    if (newTotal > doc.pay_amount) {
      // §8.5 超限保护（正常路径入口已拦，防御并发叠加）
      await transaction.rollback();
      await db.collection('refund').doc(refund._id).update({
        data: { status: 'failed', fail_reason: '退款金额超出可退余额', updated_at: now },
      });
      return { ok: false, status: 'failed', fail_reason: '退款金额超出可退余额' };
    }
    const items = (doc.items || []).map((it) => (
      refundUserIds.has(it.user_id)
        ? Object.assign({}, it, { refund_status: 'refunded' })
        : it
    ));
    const newStatus = newTotal >= doc.pay_amount ? 'refunded' : 'partial_refunded';
    await transaction.collection('order').doc(order._id).update({
      data: { refunded_total: newTotal, items, status: newStatus, updated_at: now },
    });
    await transaction.collection('refund').doc(refund._id).update({
      data: {
        status: 'success',
        wx_refund_id: wxRes.wxRefundId || null,
        refunded_at: now,
        updated_at: now,
        fail_reason: null,
      },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[executeRefund] 记账事务失败（微信侧已退款，本地待修正）', refund.refund_no, e);
    return { ok: false, status: 'processing', fail_reason: '本地记账事务失败，待对账修正' };
  }

  // ③ 事务外联动：逐人释放 + 到账通知（M1 记日志靠告警兜底，退款状态已强一致不回滚）
  const freshRefund = await getDoc(db, 'refund', refund._id);
  await notifyRefundItems(cloud, db, order, freshRefund);
  const payer = await getDoc(db, 'user', order.user_id);
  if (payer && payer.openid) {
    sendRefundMsg(cloud, payer.openid, {
      title: (order.snapshot && order.snapshot.title) || '订单退款',
      amount: refund.amount,
    });
  }
  return { ok: true, status: 'success', refund: freshRefund };
}

// 系统自动退款（单笔，§5.10/§8.2）：late_paid / club_cancel（activity runCancelFlow
// 逐单驱动 refundApply，故本入口 M1 仅单笔模式；activity_id 批量由调用方自行逐单）。
// 幂等：已存在未终态退款单 → 直接复用（重复系统触发安全）；无可退余额 → 42002。
async function createAutoRefund(cloud, db, { order, reason, refundType }) {
  const fresh = await getDoc(db, 'order', order._id);
  if (!fresh) return { ok: false, code: BIZ.NOT_FOUND, msg: '订单不存在' };
  if (!ORDER_REFUNDABLE.includes(fresh.status)) {
    return { ok: false, code: BIZ.REFUND_STATE, msg: `订单状态 ${fresh.status} 不可退款` };
  }
  const open = await findOpenRefund(db, fresh._id);
  if (open) return { ok: true, refund: open, existed: true };

  const refundable = fresh.pay_amount - (fresh.refunded_total || 0);
  if (refundable <= 0) {
    return { ok: false, code: BIZ.REFUND_NOT_ALLOWED, msg: '已无可退余额' };
  }
  const refund = await createRefundDoc(db, {
    order: fresh,
    amount: refundable,
    type: 'auto',
    reason,
    refundType: refundType || 'late_paid',
    applyUserId: 'system',
  });
  logSystemAction('order.refund.auto', {
    targetType: 'order',
    targetId: fresh.order_no,
    detail: { refund_no: refund.refund_no, amount: refundable, reason, refund_type: refund.refund_type },
  });
  const res = await executeRefund(cloud, db, refund);
  return res.ok
    ? { ok: true, refund: res.refund, existed: false }
    : { ok: false, code: BIZ.WX_PAY, msg: res.fail_reason, refund: res.refund };
}

// ---------- 支付入账（§3.3 ④⑤ / §8.2） ----------

// 支付入账（callback / status 兜底 / cron 补记共用）：
// 事务：pending|closed → paid + payment 落库（transaction_id 唯一索引兜底，并发事务快照冲突
// 由 commit 抛错承载）；事务外：联动 activity notifyPaid（失败记日志告警，M1 无重试队列，
// 靠对账/人工兜底）；晚付（closed 入账，§8.2）或报名失效（notifyPaid 返回 refund_needed）
// → 全额自动退款，不恢复名额（notifyRefund 幂等处理已释放报名，不重复递补）。
// 返回 { state: 'paid'|'late_paid'|'duplicate'|'conflict'|'not_found'|<其他状态>, order }
//   conflict = 事务异常（调用方应答失败让微信重推 / 上层记日志重试）
async function markPaid(cloud, db, { order, transactionId, paidAt, openid, callbackRaw }) {
  const now = Date.now();
  let state = null;
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('order').doc(order._id).get();
    const doc = cur && cur.data;
    if (!doc) {
      await transaction.rollback();
      return { state: 'not_found', order };
    }
    if (ORDER_PAID_STATUSES.includes(doc.status)) {
      await transaction.rollback();
      return { state: 'duplicate', order: doc }; // 幂等：重复回调/并发补记
    }
    if (doc.status === 'pending' || doc.status === 'closed') {
      state = doc.status === 'closed' ? 'late_paid' : 'paid'; // §8.2 回调晚于关单
      await transaction.collection('order').doc(order._id).update({
        data: { status: 'paid', paid_at: paidAt || now, updated_at: now },
      });
    } else {
      await transaction.rollback();
      return { state: doc.status, order: doc };
    }
    await transaction.collection('payment').add({
      data: {
        order_id: doc._id,
        order_no: doc.order_no,
        transaction_id: transactionId,
        channel: 'wxpay',
        amount: doc.pay_amount,
        state: 'success',
        openid: openid || null,
        paid_at: paidAt || now,
        callback_raw: callbackRaw || null,
        created_at: now,
      },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[markPaid] 事务失败', order._id, e);
    return { state: 'conflict', order };
  }

  const fresh = await getDoc(db, 'order', order._id);
  let refund = null;

  if (state === 'paid') {
    // ⑤ 联动活动报名生效（逐 item；M1 单人单）
    let refundNeeded = false;
    for (const it of fresh.items || []) {
      if (!it.enrollment_id) continue;
      const r = await callActivityInternal(cloud, 'notifyPaid', {
        order_id: fresh._id,
        enrollment_id: it.enrollment_id,
        paid_at: fresh.paid_at,
      });
      if (r.ok && r.data && r.data.refund_needed) refundNeeded = true;
      if (!r.ok) {
        console.error(`[markPaid] notifyPaid 联动失败（enr=${it.enrollment_id}）`, r.msg);
      }
    }
    // §7.3 联动：会员卡购买单支付成功 → 激活会员卡（幂等，失败仅记日志，靠对账/人工兜底）
    if (fresh.biz_type === 'member_card') {
      const snap = fresh.snapshot || {};
      const r = await callUserInternal(cloud, 'activateCard', {
        order_id: fresh._id,
        order_no: fresh.order_no,
        user_id: fresh.user_id,
        card_name: snap.title,
        card_type: snap.card_type,
        times: snap.total_times,
        valid_months: snap.valid_months,
        period_months: snap.period_months,
        price: fresh.pay_amount,
      });
      if (!r.ok) {
        console.error('[markPaid] activateCard 联动失败', fresh.order_no, r.code, r.msg);
      }
    }
    if (refundNeeded) {
      // 报名已失效（超时释放/主动取消后晚付等）→ 全额自动退款（§8.2/§8.3）
      const res = await createAutoRefund(cloud, db, {
        order: fresh,
        reason: 'late_paid_after_enrollment_released',
        refundType: 'late_paid',
      });
      refund = res.ok ? res.refund : null;
      if (!res.ok) console.error('[markPaid] 晚付自动退款失败', fresh.order_no, res.msg);
    }
  } else if (state === 'late_paid') {
    // §8.2：closed 后晚付 → 置 paid（closed_at/closed_reason 留痕）+ 全额自动退款
    const res = await createAutoRefund(cloud, db, {
      order: fresh,
      reason: 'late_paid_after_closed',
      refundType: 'late_paid',
    });
    refund = res.ok ? res.refund : null;
    if (!res.ok) console.error('[markPaid] 晚付自动退款失败', fresh.order_no, res.msg);
  }

  return { state, order: fresh, refund };
}

// 待支付关单（§5.7 ④ / §5.2 过期关单 / §5.11 cron 超时批量关单复用）：
// ① 事务条件更新 pending → closed（closed_reason=user_cancel/timeout）；
// ② 微信侧关单（建议项，失败不阻断本地状态）；
// ③ 调 activity notifyClose 释放 pending 报名 + 候补递补（幂等；联动失败仅记日志，
//    报名自身 expire_at 到点后由 activity cron 兜底释放）。
// 返回 { closed: true } / { closed: false, reason }
async function closePendingOrder(cloud, db, order, reason) {
  const now = Date.now();
  const transaction = await db.startTransaction();
  try {
    const cur = await transaction.collection('order').doc(order._id).get();
    const doc = cur && cur.data;
    if (!doc) {
      await transaction.rollback();
      return { closed: false, reason: 'not_found' };
    }
    if (doc.status !== 'pending') {
      await transaction.rollback();
      return { closed: false, reason: doc.status };
    }
    await transaction.collection('order').doc(order._id).update({
      data: { status: 'closed', closed_at: now, closed_reason: reason, updated_at: now },
    });
    await transaction.commit();
  } catch (e) {
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[closePendingOrder] 事务失败', order.order_no, e);
    return { closed: false, reason: 'conflict' };
  }

  // ② 微信侧关单（建议可调，失败不阻断）
  const wxRes = await callCloseOrder(cloud, order.order_no);
  if (!wxRes.ok) console.warn('[closePendingOrder] 微信关单未确认（不阻断）', order.order_no);

  // ③ 联动释放 pending 报名（逐 item；M1 单人单 items[0]，战队批量单 §5.19 多 item）
  const relItems = (order.items || []).filter((it) => it && it.enrollment_id);
  for (const it of relItems) {
    const r = await callActivityInternal(cloud, 'notifyClose', {
      order_id: order._id,
      enrollment_id: it.enrollment_id,
      reason,
    });
    if (!r.ok) {
      console.error('[closePendingOrder] notifyClose 联动失败（cron 兜底）',
        order.order_no, it.enrollment_id, r.msg);
    }
  }
  return { closed: true };
}

// 查单补记（§5.4 ③ 收银台轮询兜底 / §5.11 cron 已支付补记复用）：
// 微信查单，tradeState=SUCCESS 且本地仍待支付 → markPaid 补记（幂等，重复返回 duplicate）
async function queryAndMarkPaid(cloud, db, order) {
  const q = await callQueryOrder(cloud, order.order_no);
  if (!q.ok || q.tradeState !== 'SUCCESS') return { paid: false, query: q };
  const payer = await getDoc(db, 'user', order.user_id);
  const txId = (q.raw && (q.raw.transactionId || q.raw.transaction_id)) || null;
  const res = await markPaid(cloud, db, {
    order,
    transactionId: txId,
    openid: (payer && payer.openid) || null,
  });
  return { paid: true, state: res.state, order: res.order, query: q };
}

// ---------- 订阅消息与系统日志 ----------

// 东八区时间格式化：yyyy-MM-dd HH:mm（与 activity/shared.js 同法）
function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 退款到账订阅消息（§7.5）：模板 ID 走环境变量 SUB_TMPL_REFUND_SUCCESS，
// 未配置静默跳过；fire-and-forget，失败仅记日志（同 activity 模式）
function sendRefundMsg(cloud, openid, { title, amount }) {
  setImmediate(async () => {
    try {
      const templateId = process.env.SUB_TMPL_REFUND_SUCCESS;
      if (!templateId || !openid) return;
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: 'pages/order/list/list',
        data: {
          thing1: { value: String(title || '订单退款').slice(0, 20) },
          amount2: { value: ((amount || 0) / 100).toFixed(2) + '元' },
        },
        miniprogramState: 'formal',
      });
    } catch (e) {
      console.info('[subscribe] REFUND_SUCCESS 发送失败（不阻断）：', (e && e.errMsg) || e);
    }
  });
}

// 系统操作日志（§3.11：operator=system；fire-and-forget 非阻断）
// action 枚举：order.refund.auto / order.refund.retry / order.reconcile
function logSystemAction(action, { targetType, targetId, detail, result, errorMsg } = {}) {
  setImmediate(async () => {
    try {
      await common.writeOperationLog({
        operator: { id: 'system', name: 'system', role: 'system' },
        module: 'order',
        action,
        targetType: targetType || null,
        targetId: targetId || null,
        detail: detail || null,
        result: result || 'success',
        errorMsg: errorMsg || null,
      });
    } catch (e) {
      console.warn('[order/op-log] write failed (非阻断):', e);
    }
  });
}

module.exports = {
  // 常量与错误码
  BIZ, CODE, PAGE_SIZE_MAX, SCAN_BATCH, REFUND_RETRY_MAX, HOUR_24,
  ORDER_STATUSES, ORDER_PAID_STATUSES, ORDER_REFUNDABLE,
  REFUND_OPEN_STATUSES, REFUND_FINAL_STATUSES,
  // 取参与身份
  pick, isInternal, getCurrentUser, getDoc, getOrderByNo, getRefundByNo, findOpenRefund,
  // 单号与工具
  genOrderNo, genRefundNo, genNonce, formatDateTime,
  // 互调与支付
  callActivityInternal, callUserInternal, callUnifiedOrder, callQueryOrder, callWxRefund, callCloseOrder,
  // 退款规则
  getActivityRefundContext, calcActivityRefundRule, calcPerUserShares, calcPerUserRefund,
  // 退款核心
  createRefundDoc, executeRefund, createAutoRefund, notifyRefundItems,
  // 支付核心
  markPaid, closePendingOrder, queryAndMarkPaid,
  // 消息与日志
  sendRefundMsg, logSystemAction,
};
