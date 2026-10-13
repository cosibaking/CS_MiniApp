// actions/refund.js — 退款（payment-module §5.8/§5.9）
// refundApply：普通 handler —— 手工校验 + return fail()（order/index.js 路由层
//   不识别 BizError，与 activity 模块同约定）；用户直调与内部互调（activity
//   runCancelFlow / cancelSignup）共用一入口。
// refundAudit：wrapAdminAction 包装 —— 内部可抛 BizError（包装器统一捕获转
//   fail + 审计日志 module=order / action=order.refund.audit / target=refund_no）。
const common = require('@club/admin-common');
const S = require('./shared');

const { ok, fail, BizError } = common;
const { BIZ, CODE } = S;

// ---------- §5.8 refundApply 申请退款 ----------

// 入参（payload 或顶层均可）：{ order_no, reason?, refund_type?, refund_user_ids? }
// 内部调用（source=internal + internal_token）：身份取订单本人（付款人），
//   refund_type 允许 'club_cancel'（俱乐部取消 → 全额 auto，§3.6）；
// 用户直调：登录 + 本人校验，refund_type 强制 'user'（防伪造 club_cancel
//   绕过 24h/50% 规则）。
// 分流（Q17 默认）：≥24h 全额 auto 直接执行；<24h 未开始 50% manual 待审；
//   已开始/已签到/无可退余额 → 42002 前置拦截，不生成退款单。
// §3.9 按人退款：refund_user_ids 指定成员 → 单人分摊计算，同受三档时间规则约束；
//   全选成员时前端省略参数走整单路径；多次申请以 per-item 退款标记 + 余额门禁去重。
// §3.11：用户自助申请退款不写 operation_log（业务留痕在 refund 本身）；
//   auto 执行的系统留痕由 executeRefund/对账链路负责。
async function refundApply(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'order_no', 'reason', 'refund_type', 'refund_user_ids');
  const internal = S.isInternal(event);

  // 参数
  if (!p.order_no || typeof p.order_no !== 'string') {
    return fail(CODE.PARAM, '参数错误：order_no');
  }

  // 订单定位
  const order = await S.getOrderByNo(db, p.order_no);
  if (!order) return fail(BIZ.NOT_FOUND, '订单不存在');

  // 身份：内部调用以订单本人为申请主体；用户调用须本人
  let applyUserId;
  if (internal) {
    applyUserId = order.user_id;
  } else {
    const user = await S.getCurrentUser(cloud, db);
    if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
    if (order.user_id !== user._id) return fail(BIZ.NOT_OWNER, '无权操作该订单');
    applyUserId = user._id;
  }

  // 状态门：paid/partial_refunded 才可退（42001）
  if (!S.ORDER_REFUNDABLE.includes(order.status)) {
    return fail(BIZ.REFUND_STATE, `订单状态 ${order.status} 不可退款`);
  }

  // 重复申请：已存在未终态（pending/processing）退款单 → 42004
  const open = await S.findOpenRefund(db, order._id);
  if (open) return fail(BIZ.REFUND_DUP, '已有退款申请处理中，请勿重复提交');

  // 规则计算（§3.4；start_time 以活动最新值为准，快照仅展示）。
  // 带 refund_user_ids → §3.9 按人路径（单人分摊 + per-item 去重 + 逐人签到校验），
  // 否则整单路径；两条路径产出 amount/type/items 后共用建单与后续。
  const refundType = internal && p.refund_type === 'club_cancel' ? 'club_cancel' : 'user';
  const ctx = await S.getActivityRefundContext(db, order);
  let amount;
  let type;
  let refundItems = null;
  if (Array.isArray(p.refund_user_ids) && p.refund_user_ids.length) {
    const pr = await S.calcPerUserRefund(db, order, ctx, p.refund_user_ids, refundType);
    if (!pr.ok) return fail(pr.code, pr.msg); // 42001/42002/42003/42006 前置拦截
    amount = pr.amount;
    type = pr.type;
    refundItems = pr.items;
  } else {
    const rule = S.calcActivityRefundRule({
      payAmount: order.pay_amount,
      refundedTotal: order.refunded_total || 0,
      startTime: ctx ? ctx.start_time : null,
      checkedIn: !!(ctx && ctx.checked_in),
      refundType,
    });
    if (!rule.allowed) return fail(rule.code, rule.msg); // 42002 前置拦截
    if (rule.amount <= 0) return fail(BIZ.REFUND_ZERO, '退款金额为零'); // 42003
    amount = rule.amount;
    type = rule.type;
  }

  // 建单：auto → status=processing 直接待执行；manual → pending 待审。
  // per_user 标记供 refundAudit 走逐人重算；items 传勾选子集（整单为 null → 全量映射）。
  const refund = await S.createRefundDoc(db, {
    order,
    amount,
    type,
    reason: p.reason,
    refundType,
    applyUserId,
    items: refundItems,
    perUser: !!refundItems,
  });

  if (type === 'auto') {
    // 直接执行（cloudPay.refund + 记账事务 + 逐人联动释放 + 到账通知）
    const res = await S.executeRefund(cloud, db, refund);
    if (!res.ok) {
      // 微信侧失败：退款单已置 failed 待对账重试（§8.4 沿用同 refund_no），
      // 返回错误并携带退款单信息供调用方提示
      return fail(BIZ.WX_PAY, res.fail_reason || '退款发起失败，将自动重试', {
        refund_no: refund.refund_no,
        amount: refund.amount,
        status: res.status,
      });
    }
    return ok({
      refund_no: refund.refund_no,
      amount: refund.amount,
      status: res.status,
      need_audit: false,
    });
  }

  // manual：待审核（M1 无管理端订阅模板：管理端退款审核列表 + 日志可见，M2 补通知）
  console.info(`[refund] 待审核退款单：${refund.refund_no}（${order.order_no}，${refund.amount}分）`);
  return ok({
    refund_no: refund.refund_no,
    amount: refund.amount,
    status: refund.status, // pending
    need_audit: true,
  });
}

// ---------- §5.9 refundAudit 管理员退款审核（audit_refund） ----------

// 入参：{ refund_no, audit_action: 'approve'|'reject', audit_remark }
// 同意：以执行时刻重算可退金额（与申请时取较小值，§3.4）→ 条件更新
//   pending→processing（防并发重复审核）→ executeRefund；
// 驳回：必填理由（42005）→ 条件更新 pending→rejected + 通知申请人
//   （M1 无专用驳回模板——REFUND_SUCCESS 语义不符，暂记日志，M2 模板到位后补）。
// 审计日志由 wrapAdminAction 统一落（§3.11 action=order.refund.audit）。
async function refundAudit(event, auth) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'refund_no', 'audit_action', 'audit_remark');

  // 参数
  if (!p.refund_no || typeof p.refund_no !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：refund_no');
  }
  if (p.audit_action !== 'approve' && p.audit_action !== 'reject') {
    throw new BizError(CODE.PARAM, '参数错误：audit_action 须为 approve/reject');
  }

  // 退款单
  const refund = await S.getRefundByNo(db, p.refund_no);
  if (!refund) throw new BizError(BIZ.NOT_FOUND, '退款单不存在');
  if (refund.status !== 'pending') {
    throw new BizError(BIZ.REFUND_DUP, `退款单状态 ${refund.status} 不可审核`);
  }

  const now = Date.now();
  const auditFields = {
    auditor_id: auth.operator.id,
    audit_at: now,
    audit_remark: String(p.audit_remark || '').slice(0, 200) || null,
    updated_at: now,
  };

  // —— 驳回分支 ——
  if (p.audit_action === 'reject') {
    if (!p.audit_remark || !String(p.audit_remark).trim()) {
      throw new BizError(BIZ.REFUND_REMARK, '驳回必须填写理由'); // 42005
    }
    const upd = await db.collection('refund')
      .where({ _id: refund._id, status: 'pending' }) // 条件更新防并发重复审核
      .update({ data: Object.assign({ status: 'rejected' }, auditFields) });
    if (!upd.stats || upd.stats.updated !== 1) {
      throw new BizError(BIZ.REFUND_DUP, '退款单已被处理'); // 42004
    }
    console.info(`[refund] 驳回通知申请人（M1 无专用模板暂跳过）：${refund.refund_no}`);
    return { refund_no: refund.refund_no, status: 'rejected' };
  }

  // —— 同意分支：执行时刻重算（取申请与执行两次计算较小值，§3.4）——
  const order = await S.getDoc(db, 'order', refund.order_id);
  if (!order) throw new BizError(BIZ.NOT_FOUND, '关联订单不存在');
  if (!S.ORDER_REFUNDABLE.includes(order.status)) {
    throw new BizError(BIZ.REFUND_STATE, `订单状态 ${order.status} 不可退款`);
  }
  const ctx = await S.getActivityRefundContext(db, order);
  let ruleAmount;
  if (refund.per_user) {
    // §3.9 按人退款单：以执行时刻逐人重算（分摊/时间比例/签到态/per-item 去重）。
    // 审核时本单 items 尚未标记 refunded，去重检查天然通过；
    // 申请→审核之间有人签到或活动已开始则重算拦截，管理员改走驳回。
    const userIds = (refund.items || []).map((it) => it.user_id).filter(Boolean);
    const pr = await S.calcPerUserRefund(db, order, ctx, userIds, refund.refund_type || 'user');
    if (!pr.ok) {
      throw new BizError(pr.code, `执行时重算不可退：${pr.msg}`);
    }
    ruleAmount = pr.amount;
  } else {
    const rule = S.calcActivityRefundRule({
      payAmount: order.pay_amount,
      refundedTotal: order.refunded_total || 0,
      startTime: ctx ? ctx.start_time : null,
      checkedIn: !!(ctx && ctx.checked_in),
      refundType: refund.refund_type || 'user',
    });
    if (!rule.allowed) {
      // 重算不可退（活动已开始等）：退款单保持 pending，提示管理员改走驳回
      throw new BizError(rule.code, `执行时重算不可退：${rule.msg}`);
    }
    ruleAmount = rule.amount;
  }
  const amount = Math.min(refund.amount, ruleAmount); // 取较小值
  if (amount <= 0) throw new BizError(BIZ.REFUND_ZERO, '退款金额为零'); // 42003

  // 条件更新 pending→processing（claim 防并发；金额被重算调小则同笔更新）
  const claim = { status: 'processing' };
  if (amount !== refund.amount) claim.amount = amount;
  const upd = await db.collection('refund')
    .where({ _id: refund._id, status: 'pending' })
    .update({ data: Object.assign(claim, auditFields) });
  if (!upd.stats || upd.stats.updated !== 1) {
    throw new BizError(BIZ.REFUND_DUP, '退款单已被处理'); // 42004
  }

  // 执行（cloudPay.refund + 记账事务 + 逐人联动释放 + 到账通知）
  const fresh = await S.getRefundByNo(db, p.refund_no);
  const res = await S.executeRefund(cloud, db, fresh);
  if (!res.ok) {
    // 微信侧失败 → failed 待重试（§8.4）；本地事务失败 → processing 待对账修正
    throw new BizError(BIZ.WX_PAY, res.fail_reason || '退款执行失败，已进入重试队列');
  }
  return { refund_no: refund.refund_no, status: res.status, amount };
}

// ---------- §5.9 补充 refundList — 管理端退款审核列表（audit_refund） ----------

// 管理端「退款审核列表」页数据源（§5.9：order/list 管理端变体——order/list 仅
// 返回本人订单，不可复用；此为只读接口，手动 checkPermission，不走 wrapAdminAction）。
// 入参：{ status?, page?, page_size? }
//   status 缺省 'pending'（主场景）；'processed' = 全部非待审（processing/success/failed/
//   rejected）；或传单个状态精确查询。
// 返回：退款单摘要 + 联单快照（标题/开始时间/实付/已退）与付款人昵称，供审核判断。
async function refundList(event) {
  const { cloud, db } = common.getContext();
  const p = S.pick(event, 'status', 'page', 'page_size');

  const { OPENID } = cloud.getWXContext();
  const auth = await common.checkPermission(OPENID, 'audit_refund');
  if (!auth.hasPermission) return fail(CODE.FORBIDDEN, '无退款审核权限');

  const page = Number.isInteger(p.page) && p.page > 0 ? p.page : 1;
  const rawSize = Number.isInteger(p.page_size) && p.page_size > 0 ? p.page_size : 20;
  const pageSize = Math.min(rawSize, S.PAGE_SIZE_MAX);

  const _ = db.command;
  const allStatuses = S.REFUND_OPEN_STATUSES.concat(S.REFUND_FINAL_STATUSES);
  let where;
  if (!p.status || p.status === 'pending') {
    where = { status: 'pending' };
  } else if (p.status === 'processed') {
    where = { status: _.in(S.REFUND_FINAL_STATUSES.concat(['processing'])) };
  } else if (allStatuses.includes(p.status)) {
    where = { status: p.status };
  } else {
    return fail(CODE.PARAM, '参数错误：status 取值不合法');
  }

  const cnt = await db.collection('refund').where(where).count();
  const res = await db.collection('refund').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  // 联单快照与付款人（批量 in 查询，避免逐单读取）
  const rows = res.data || [];
  const orderIds = Array.from(new Set(rows.map((r) => r.order_id).filter(Boolean)));
  const orderRes = orderIds.length
    ? await db.collection('order').where({ _id: _.in(orderIds) }).limit(orderIds.length).get()
    : { data: [] };
  const orderMap = {};
  (orderRes.data || []).forEach((o) => { orderMap[o._id] = o; });
  const userIds = Array.from(new Set((orderRes.data || []).map((o) => o.user_id).filter(Boolean)));
  const userRes = userIds.length
    ? await db.collection('user').where({ _id: _.in(userIds) }).limit(userIds.length).get()
    : { data: [] };
  const userMap = {};
  (userRes.data || []).forEach((u) => { userMap[u._id] = u; });

  const list = rows.map((r) => {
    const o = orderMap[r.order_id] || {};
    const payer = userMap[o.user_id] || {};
    return {
      refund_no: r.refund_no,
      order_no: r.order_no,
      amount: r.amount,
      type: r.type, // auto/manual
      status: r.status,
      reason: r.reason || '',
      audit_remark: r.audit_remark || null,
      fail_reason: r.fail_reason || null,
      created_at: r.created_at,
      audit_at: r.audit_at || null,
      refunded_at: r.refunded_at || null,
      order_title: (o.snapshot && o.snapshot.title) || '',
      start_time: (o.snapshot && o.snapshot.start_time) || null,
      pay_amount: o.pay_amount || 0,
      refunded_total: o.refunded_total || 0,
      payer_name: payer.nickname || '',
      per_user: !!r.per_user,
      refund_members: (r.items || []).map((it) => it.nickname || '').filter(Boolean).join('、'),
    };
  });
  return ok({ list, total: (cnt && cnt.total) || 0, page, page_size: pageSize });
}

module.exports = {
  // §5.8/§3.9 refundApply — 用户申请退款（整单或按人勾选；≥24h 全额 / <24h 50% / 已开始不退）
  refundApply,
  // §5.9 refundList — 管理端退款审核列表数据源（order/list 管理端变体，audit_refund）
  refundList,
  // §5.9 refundAudit — 管理端退款审核（audit_refund）→ 日志 order.refund.audit
  refundAudit: wrapAdminAction('order.refund.audit', refundAudit, {
    permission: 'audit_refund', module: 'order', targetType: 'refund',
    targetId: (event) => S.pick(event, 'refund_no') || null,
    detail: (event, result) => ({
      audit_action: S.pick(event, 'audit_action') || null,
      status: (result && result.status) || null,
      amount: (result && result.amount) || null,
    }),
  }),
};
