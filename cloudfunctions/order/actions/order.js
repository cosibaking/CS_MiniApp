// actions/order.js — 支付参数/状态轮询/列表/详情/取消 + 内部自动退款/对账入口
//（payment-module §5.1/§5.2/§5.4/§5.5/§5.6/§5.7/§5.10/§5.12）
// 约定：普通 handler 业务错误一律 return fail(...)（order/index.js 路由层不识别 BizError）。
// §5.1 create：M1 活动报名单由 activity/signup 事务内直建（activity-module §3.4 模块边界：
// 报名与订单同事务），本入口仅落地 M2 会员卡购买单（member_card）。
const common = require('@club/admin-common');
const { ok, fail, CODE } = common;
const S = require('./shared');
const { BIZ } = S;

// 待支付时长（§6.1：expire_at = created_at + 15min；与 activity LOCK_MS 同口径）
const PENDING_TTL_MS = 15 * 60 * 1000;

// ---------- 本地助手 ----------

// transaction_id 脱敏（§5.6：4200****1230）
function maskTxId(txId) {
  const s = String(txId || '');
  if (!s) return null;
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// 登录 + 订单存在 + 本人校验（§5.2/§5.4/§5.6/§5.7 共用）
async function getOwnedOrder(cloud, db, event, orderNo) {
  const user = await S.getCurrentUser(cloud, db);
  if (!user) return { err: fail(CODE.UNAUTHORIZED, '请先登录') };
  const order = await S.getOrderByNo(db, orderNo);
  if (!order) return { err: fail(BIZ.NOT_FOUND, '订单不存在') };
  if (order.user_id !== user._id) return { err: fail(BIZ.NOT_OWNER, '无权访问该订单') };
  return { order };
}

// 待支付关单 / 查单补记：实现已提升至 shared.js
// （S.closePendingOrder / S.queryAndMarkPaid，§5.11 cron 超时关单与收银台轮询复用同一实现）

// ---------- action 处理器 ----------

module.exports = {

  // §5.1 create — 创建订单（member_card 会员卡购买单；活动报名单由 activity/signup 事务内直建）
  async create(event) {
    const { cloud, db } = common.getContext();
    const p = S.pick(event, 'biz_type', 'biz_id', 'pay_type');

    // ① 登录态校验
    const user = await S.getCurrentUser(cloud, db);
    if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

    // ② 参数校验：M1 仅支持会员卡单（activity_signup 由 activity 模块直建；team_build Q12 预留暂拒）
    if (p.biz_type !== 'member_card') {
      return fail(CODE.PARAM, '参数错误：biz_type 仅支持 member_card');
    }
    if (!p.biz_id || typeof p.biz_id !== 'string') return fail(CODE.PARAM, '参数错误：biz_id');
    if (p.pay_type != null && p.pay_type !== 'wxpay') {
      return fail(CODE.PARAM, '参数错误：会员卡购买仅支持微信支付');
    }

    const now = Date.now();
    // ③ 服务端取商品并计算金额（入参不含金额字段）：卡种须在售
    const product = await S.getDoc(db, 'card_product', p.biz_id);
    if (!product || product.status !== 'on') {
      return fail(BIZ.PRODUCT_OFF, '该卡种已下架或不存在');
    }

    // ④ 幂等：同用户同卡种未过期 pending 单 → 返回原单摘要
    //（已支付单不拦截：R9 允许多张会员卡并存，与活动报名单 41006 不同）
    const _ = db.command;
    const dup = await db.collection('order').where({
      user_id: user._id,
      biz_type: 'member_card',
      biz_id: p.biz_id,
      status: 'pending',
      expire_at: _.gt(now),
    }).orderBy('created_at', 'desc').limit(1).get();
    if (dup.data && dup.data[0]) {
      const o = dup.data[0];
      return ok({
        is_exist: true,
        order_no: o.order_no,
        amount: o.amount,
        pay_amount: o.pay_amount,
        status: o.status,
        expire_at: o.expire_at,
      });
    }

    // ⑤ 写单（无事务：会员卡单无名额锁，SDK 事务不支持 where 查询；并发双击至多产生两张
    // pending 单，超时由 cron 关单兜底，无资金影响）。入参 items=[{qty:1}] 忽略，服务端固化。
    const amount = product.price;
    const doc = {
      order_no: S.genOrderNo(),
      user_id: user._id,
      nickname: user.nickname || '',
      biz_type: 'member_card',
      biz_id: product._id,
      team_id: null,
      items: [{
        user_id: user._id,
        nickname: user.nickname || '',
        enrollment_id: null,
        unit_price: amount,
        refund_status: 'none',
      }],
      snapshot: {
        title: product.name,
        card_type: product.card_type,
        total_times: product.card_type === 'count' ? product.times : null,
        valid_months: product.card_type === 'count' ? product.valid_months : null,
        period_months: product.card_type === 'period' ? product.period_months : null,
        unit_price: amount,
      },
      amount,
      pay_amount: amount, // M1 无优惠（theme 折扣为线下购票权益，不影响购卡价）
      pay_type: 'wxpay',
      status: 'pending',
      expire_at: now + PENDING_TTL_MS,
      paid_at: null,
      closed_at: null,
      closed_reason: null,
      refunded_total: 0,
      created_at: now,
      updated_at: now,
    };
    await db.collection('order').add({ data: doc });

    // ⑦ 返回订单摘要
    return ok({
      is_exist: false,
      order_no: doc.order_no,
      amount: doc.amount,
      pay_amount: doc.pay_amount,
      status: doc.status,
      expire_at: doc.expire_at,
    });
  },

// §5.2 getPayParams — 待支付订单重取支付参数（收银台重试支付/页面刷新场景）
async getPayParams(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no');
  if (!p.order_no || typeof p.order_no !== 'string') return fail(CODE.PARAM, '参数错误：order_no');

  const owned = await getOwnedOrder(cloud, db, event, p.order_no);
  if (owned.err) return owned.err;
  const { order } = owned;

  if (order.status !== 'pending') {
    return fail(BIZ.STATE_CONFLICT, '订单非待支付状态');
  }
  if (order.expire_at && Date.now() >= order.expire_at) {
    // 过期 → 触发关单（幂等，含微信关单与报名释放联动）+ 40901
    await S.closePendingOrder(cloud, db, order, 'timeout');
    return fail(BIZ.STATE_CONFLICT, '订单已超时关闭');
  }

  // 统一下单：同一 order_no 可重调（微信侧复用未过期 prepay）
  const res = await S.callUnifiedOrder(cloud, order);
  if (!res.ok) {
    console.error('[getPayParams] unifiedOrder 失败', order.order_no, res.msg);
    return fail(BIZ.WX_PAY, '微信下单失败，请稍后重试');
  }
  return ok({ order_no: order.order_no, pay_params: res.payment, expire_at: order.expire_at });
},

// §5.4 status — 支付状态轮询（收银台）：pending 超 20s 主动查单兜底补记
async status(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no');
  if (!p.order_no || typeof p.order_no !== 'string') return fail(CODE.PARAM, '参数错误：order_no');

  const owned = await getOwnedOrder(cloud, db, event, p.order_no);
  if (owned.err) return owned.err;
  let order = owned.order;

  // 回调丢失兜底：下单超 20s 仍 pending → 微信查单，SUCCESS 即补记入账
  if (order.status === 'pending' && Date.now() - (order.created_at || 0) > 20 * 1000) {
    const res = await S.queryAndMarkPaid(cloud, db, order);
    if (res.paid && res.order) order = res.order;
  }

  return ok({
    order_no: order.order_no,
    status: order.status,
    pay_amount: order.pay_amount,
    refunded_total: order.refunded_total || 0,
    paid_at: order.paid_at || null,
    expire_at: order.expire_at || null,
  });
},

// §5.5 list — 我的订单列表（分页 + status/biz_type 筛选，摘要字段）
async list(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'status', 'biz_type', 'page', 'page_size');

  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  const page = Number.isInteger(p.page) && p.page > 0 ? p.page : 1;
  const rawSize = Number.isInteger(p.page_size) && p.page_size > 0 ? p.page_size : 10;
  const pageSize = Math.min(rawSize, S.PAGE_SIZE_MAX);

  const where = { user_id: user._id };
  if (p.status != null) {
    if (!S.ORDER_STATUSES.includes(p.status)) {
      return fail(CODE.PARAM, '参数错误：status 取值不合法');
    }
    where.status = p.status;
  }
  if (p.biz_type != null) {
    if (typeof p.biz_type !== 'string') return fail(CODE.PARAM, '参数错误：biz_type');
    where.biz_type = p.biz_type;
  }

  const cnt = await db.collection('order').where(where).count();
  const res = await db.collection('order').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize).get();

  const list = (res.data || []).map((o) => ({
    order_no: o.order_no,
    biz_type: o.biz_type,
    title: (o.snapshot && o.snapshot.title) || '',
    cover: (o.snapshot && o.snapshot.cover) || '',
    start_time: (o.snapshot && o.snapshot.start_time) || null,
    pay_amount: o.pay_amount,
    refunded_total: o.refunded_total || 0,
    item_count: (o.items || []).length,
    status: o.status,
    expire_at: o.status === 'pending' ? (o.expire_at || null) : null,
    created_at: o.created_at,
  }));
  return ok({ list, total: (cnt && cnt.total) || 0, page, page_size: pageSize });
},

// §5.6 detail — 订单详情（本人；管理员凭 audit_refund 可查：payment 建议的 view_order
// 未入框架权限表（admin-module §1.4 权威口径），以订单组现有权限代理查看权）
async detail(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no');
  if (!p.order_no || typeof p.order_no !== 'string') return fail(CODE.PARAM, '参数错误：order_no');

  const user = await S.getCurrentUser(cloud, db);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  const order = await S.getOrderByNo(db, p.order_no);
  if (!order) return fail(BIZ.NOT_FOUND, '订单不存在');

  if (order.user_id !== user._id) {
    const { OPENID } = cloud.getWXContext();
    const auth = await common.checkPermission(OPENID, 'audit_refund');
    if (!auth.hasPermission) return fail(BIZ.NOT_OWNER, '无权访问该订单');
  }

  // 支付流水摘要（transaction_id 脱敏，不含 callback_raw）
  const payRes = await db.collection('payment').where({ order_id: order._id })
    .orderBy('created_at', 'asc').limit(10).get();
  const payments = (payRes.data || []).map((t) => ({
    transaction_id: maskTxId(t.transaction_id),
    channel: t.channel,
    amount: t.amount,
    state: t.state,
    paid_at: t.paid_at,
  }));

  // 退款单列表（全部状态，创建时间倒序）
  const rfRes = await db.collection('refund').where({ order_id: order._id })
    .orderBy('created_at', 'desc').limit(20).get();
  const refunds = (rfRes.data || []).map((r) => ({
    refund_no: r.refund_no,
    type: r.type,
    amount: r.amount,
    status: r.status,
    reason: r.reason,
    fail_reason: r.fail_reason || null,
    audit_remark: r.audit_remark || null,
    retry_count: r.retry_count || 0,
    created_at: r.created_at,
    refunded_at: r.refunded_at || null,
  }));

  return ok({ order, payments, refunds });
},

// §5.7 cancel — 用户主动取消待支付订单（收银台/订单列表入口）
async cancel(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no');
  if (!p.order_no || typeof p.order_no !== 'string') return fail(CODE.PARAM, '参数错误：order_no');

  const owned = await getOwnedOrder(cloud, db, event, p.order_no);
  if (owned.err) return owned.err;
  const { order } = owned;

  if (order.status !== 'pending') {
    return fail(BIZ.STATE_CONFLICT, '订单非待支付状态，无法取消');
  }

  // ③ 取消前查单（建议可调）：已支付但回调未达 → 40902（等回调/轮询补记后走退款）
  const q = await S.callQueryOrder(cloud, order.order_no);
  if (q.ok && q.tradeState === 'SUCCESS') {
    return fail(BIZ.PAID_ALREADY, '订单已完成支付，无法取消');
  }

  // ④ 事务关单 + 微信关单 + 联动释放名额（幂等，失败重试由 cron 兜底）
  const res = await S.closePendingOrder(cloud, db, order, 'user_cancel');
  if (!res.closed) {
    return fail(BIZ.STATE_CONFLICT, '订单状态已变化，请刷新后重试');
  }
  // §3.11：用户自助操作不写操作日志
  return ok({ order_no: order.order_no, status: 'closed', closed_reason: 'user_cancel' });
},

// §5.10 autoRefund — 系统自动退款（仅内部调用：晚付/俱乐部取消补偿，人工补退入口）
// 单笔模式：{ order_no, reason, refund_type }；activity_id 批量（§5.10 ②）M3 战队批量单支持，
// 俱乐部取消的批量退款由 activity runCancelFlow 逐单调 refundApply 驱动（§3.6）。
async autoRefund(event) {
  if (!S.isInternal(event)) return fail(CODE.FORBIDDEN, '拒绝访问：内部接口');
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no', 'reason', 'refund_type', 'activity_id');

  if (p.activity_id) {
    return fail(CODE.NOT_IMPL, '按活动批量自动退款 M3 支持（请由 activity 取消流程逐单驱动）');
  }
  if (!p.order_no || typeof p.order_no !== 'string') return fail(CODE.PARAM, '参数错误：order_no');

  const order = await S.getOrderByNo(db, p.order_no);
  if (!order) return fail(BIZ.NOT_FOUND, '订单不存在');

  const res = await S.createAutoRefund(cloud, db, {
    order,
    reason: p.reason || '系统自动退款',
    refundType: p.refund_type || undefined,
  });
  if (!res.ok) {
    return fail(res.code || CODE.INTERNAL, res.msg || '自动退款失败');
  }
  return ok({
    refund_no: res.refund.refund_no,
    amount: res.refund.amount,
    status: res.refund.status,
    existed: !!res.existed,
  });
},

// §5.12 reconcile — 每日对账（Timer 触发为主：cron.js order-reconcile；内部调用可手动补跑）
// M1 简化：退款失败重试（failed && retry_count<5，沿用原 refund_no，§8.4）+ 系统日志；
// 微信账单下载比对 M2 落地（§5.12 ②）。核心逻辑在 cron.js（runReconcile）。
async reconcile(event) {
  if (!S.isInternal(event)) return fail(CODE.FORBIDDEN, '拒绝访问：内部接口');
  return require('./cron').runReconcile(event);
},

};
