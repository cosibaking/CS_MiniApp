// pages/order/refund-progress.js — 退款进度（payment-module §2 页面6）
// 接口：order/detail（refunds 按 created_at 倒序，type 值域 auto|manual）。
// 时间线：提交申请 →（管理员审核，仅 manual）→ 退款处理 → 退款到账 / 驳回；
// failed 单由对账定时任务自动重试（§8.4），页面只读展示。
const { callCloud } = require('../../utils/cloud');
const { requireLogin } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const REFUND_STATUS_LABELS = {
  pending: '待审核',
  processing: '处理中',
  success: '已退款',
  failed: '退款失败',
  rejected: '已驳回',
};

const REFUND_STATUS_CLASS = {
  pending: 'st-orange',
  processing: 'st-blue',
  success: 'st-green',
  failed: 'st-red',
  rejected: 'st-red',
};

// type 值域 auto|manual（§6.3）：auto=规则内自动退，manual=人工审核
const REFUND_TYPE_LABELS = {
  auto: '自动退款',
  manual: '人工审核',
};

// 组装单个退款单时间线（state：done 已完成 / current 进行中 / pending 待开始 / danger 异常）
function buildSteps(r) {
  const steps = [{
    title: '提交申请',
    desc: r.created_at ? formatTime(r.created_at) : '-',
    state: 'done',
  }];
  const rejected = r.status === 'rejected';
  if (r.type === 'manual') {
    if (rejected) {
      steps.push({ title: '已驳回', desc: r.audit_remark || '', state: 'danger' });
    } else if (r.status === 'pending') {
      steps.push({ title: '管理员审核', desc: '等待管理员审核', state: 'current' });
    } else {
      steps.push({ title: '管理员审核', desc: '已通过', state: 'done' });
    }
  }
  if (!rejected) {
    if (r.status === 'failed') {
      steps.push({ title: '退款失败', desc: r.fail_reason || '系统将自动重试', state: 'danger' });
    } else if (r.status === 'processing') {
      steps.push({ title: '退款处理', desc: '退款将原路退回微信支付', state: 'current' });
    } else if (r.status === 'success') {
      steps.push({ title: '退款处理', desc: '原路退回微信支付', state: 'done' });
      steps.push({ title: '退款到账', desc: r.refunded_at ? formatTime(r.refunded_at) : '已到账', state: 'done' });
    } else {
      steps.push({ title: '退款处理', desc: '', state: 'pending' });
    }
  }
  return steps;
}

Page({
  data: {
    loading: true,
    refunds: [],  // 退款单列表（倒序，含时间线 steps）
    empty: false,
  },

  onLoad(options) {
    this.orderNo = options.order_no || '';
    requireLogin().then((user) => {
      this.user = user;
      if (!this.orderNo) {
        wx.showModal({ title: '提示', content: '缺少订单号', showCancel: false, success: () => wx.navigateBack() });
        return;
      }
      this.fetch();
    }).catch(() => {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  fetch() {
    this.setData({ loading: true });
    callCloud('order', 'detail', { order_no: this.orderNo }).then((res) => {
      const o = (res.data && res.data.order) || null;
      if (!o) throw new Error('订单不存在');
      const list = (o.refunds || []).map((r) => ({
        refundNo: r.refund_no,
        typeLabel: REFUND_TYPE_LABELS[r.type] || (r.type || '-'),
        amountText: formatMoney(r.amount || 0),
        statusLabel: REFUND_STATUS_LABELS[r.status] || (r.status || '-'),
        statusClass: REFUND_STATUS_CLASS[r.status] || 'st-grey',
        reason: r.reason || '',
        remark: r.audit_remark || '',  // 驳回理由/审核备注
        steps: buildSteps(r),
      }));
      this.setData({ loading: false, refunds: list, empty: !list.length });
    }).catch((e) => {
      this.setData({ loading: false });
      wx.showModal({
        title: '提示', content: (e && e.msg) || '订单加载失败', showCancel: false,
        success: () => wx.navigateBack(),
      });
    });
  },
});
