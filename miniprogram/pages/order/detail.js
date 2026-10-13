// pages/order/detail.js — 订单详情（payment-module §2 页面4）
// 接口：order/detail（快照/金额明细（应付/实付/已退）/支付流水（transaction_id 脱敏）/退款记录）。
// 操作按状态：待支付 → 去支付（跳收银台，支付/倒计时统一由收银台处理）+ 取消订单；
// 已支付/部分退款 → 申请退款（§2 页面5）；存在退款单 → 退款进度（§2 页面6）。
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const STATUS_LABELS = {
  pending: '待支付', paid: '已支付', partial_refunded: '部分退款',
  refunded: '已退款', closed: '已关闭',
};
// 大字状态用纯色（区别于退款记录的底色徽章）
const STATUS_TEXT_CLASS = {
  pending: 'tx-orange', paid: 'tx-green', partial_refunded: 'tx-blue',
  refunded: 'tx-blue', closed: 'tx-grey',
};
const CLOSED_REASON_LABELS = { user_cancel: '主动取消', timeout: '超时未支付', admin_close: '管理员关闭' };
const REFUND_STATUS_LABELS = {
  pending: '待审核', processing: '处理中', success: '已退款',
  failed: '退款失败', rejected: '已驳回',
};
const REFUND_STATUS_CLASS = {
  pending: 'st-orange', processing: 'st-blue', success: 'st-green',
  failed: 'st-red', rejected: 'st-red',
};
// type 值域 auto|manual（§6.3）：auto=规则内自动退（≥24h/俱乐部取消），manual=人工审核
const REFUND_TYPE_LABELS = { auto: '自动退款', manual: '人工审核' };
const PAY_CHANNEL_LABELS = { wxpay: '微信支付' };

Page({
  data: {
    loading: true,
    orderNo: '',
    order: null,       // 快照 + 金额 + 状态
    items: [],         // 报名明细（按人）
    payments: [],      // 支付流水
    refunds: [],       // 退款记录
    statusSubText: '', // 状态副标题（关闭原因/支付时间）
    countdownText: '', // 待支付倒计时
    canPay: false,
    canCancel: false,
    canRefund: false,
    hasRefund: false,
  },

  onLoad(options) {
    this.orderNo = options.order_no || '';
    this.setData({ orderNo: this.orderNo });
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

  // 从收银台/退款页返回 → 刷新状态（支付/取消/退款后变化）
  onShow() {
    if (this.user && this.orderNo && !this.data.loading) this.fetch();
  },

  onHide() { this.stopTicker(); },
  onUnload() { this.stopTicker(); },

  fetch() {
    this.stopTicker();
    // 首次进入显示加载态；返回刷新保持内容不闪烁
    this.setData({ loading: !this.data.order });
    callCloud('order', 'detail', { order_no: this.orderNo }).then((res) => {
      const d = res.data || {};
      const o = d.order || null;
      if (!o) throw new Error('订单不存在');
      const snap = o.snapshot || {};
      const pending = o.status === 'pending';
      const expired = pending && o.expire_at && o.expire_at <= Date.now();

      const order = {
        title: snap.title || '俱乐部活动',
        timeText: snap.start_time ? formatTime(snap.start_time) : '',
        venue: snap.venue || '',
        orderNo: o.order_no,
        createdText: o.created_at ? formatTime(o.created_at) : '-',
        status: o.status,
        statusLabel: STATUS_LABELS[o.status] || o.status,
        statusClass: STATUS_TEXT_CLASS[o.status] || 'tx-grey',
        amountText: formatMoney(o.amount),        // 应付
        payAmountText: formatMoney(o.pay_amount), // 实付
        refundedTotalText: o.refunded_total > 0 ? formatMoney(o.refunded_total) : '',
      };

      const items = (o.items || []).map((it, i) => ({
        key: 'm' + i,
        nickname: it.nickname || '成员',
        priceText: '¥' + formatMoney(it.unit_price),
        refunded: it.refund_status === 'refunded',
        refundLabel: it.refund_status === 'refunded' ? '已退款' : '',
      }));

      const payments = (d.payments || []).map((p, i) => ({
        key: 'p' + i,
        txId: p.transaction_id || '-',
        channelLabel: PAY_CHANNEL_LABELS[p.channel] || p.channel || '-',
        amountText: formatMoney(p.amount),
        paidText: p.paid_at ? formatTime(p.paid_at) : '-',
      }));

      const refunds = (d.refunds || []).map((r) => ({
        refundNo: r.refund_no,
        typeLabel: REFUND_TYPE_LABELS[r.type] || r.type || '',
        amountText: formatMoney(r.amount),
        statusLabel: REFUND_STATUS_LABELS[r.status] || r.status,
        statusClass: REFUND_STATUS_CLASS[r.status] || 'st-grey',
        reason: r.reason || '',
        remark: r.audit_remark || r.fail_reason || '',
        timeText: r.refunded_at ? formatTime(r.refunded_at)
          : (r.created_at ? formatTime(r.created_at) : '-'),
      }));

      // 状态副标题
      let statusSubText = '';
      if (pending) {
        statusSubText = expired ? '已超时，系统释放中' : '';
      } else if (o.status === 'closed') {
        statusSubText = CLOSED_REASON_LABELS[o.closed_reason] || '订单已关闭';
      } else if (o.paid_at) {
        statusSubText = '支付时间：' + formatTime(o.paid_at);
      }

      this.setData({
        loading: false,
        order, items, payments, refunds, statusSubText,
        countdownText: '',
        canPay: pending && !expired,
        canCancel: pending && !expired,
        canRefund: o.status === 'paid' || o.status === 'partial_refunded',
        hasRefund: refunds.length > 0,
      });
      if (pending && !expired && o.expire_at) this.startTicker(o.expire_at);
    }).catch((e) => {
      this.setData({ loading: false });
      if (this.data.order) {
        showError(e, '刷新失败');
        return;
      }
      wx.showModal({
        title: '提示', content: (e && e.msg) || '订单加载失败', showCancel: false,
        success: () => wx.navigateBack(),
      });
    });
  },

  // 待支付倒计时（15 分钟锁单，超时置灰；cron 兜底关单）
  startTicker(expireAt) {
    this.stopTicker();
    this.expireAt = expireAt;
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 1000);
  },

  stopTicker() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  },

  tick() {
    const left = Math.floor((this.expireAt - Date.now()) / 1000);
    if (left <= 0) {
      this.stopTicker();
      this.setData({
        countdownText: '已超时，系统释放中',
        statusSubText: '已超时，系统释放中',
        canPay: false,
        canCancel: false,
      });
      return;
    }
    const m = Math.floor(left / 60);
    const s = left % 60;
    const text = `剩 ${m}:${s < 10 ? '0' + s : s} 完成支付`;
    if (text !== this.data.countdownText) this.setData({ countdownText: text });
  },

  // ---------- 操作 ----------
  // 待支付 → 收银台（支付/取消流程统一在收银台处理）
  onTapPay() {
    wx.navigateTo({ url: '/pages/order/cashier?order_no=' + this.orderNo });
  },

  // 已支付/部分退款 → 申请退款（payment-module §2 页面5）
  onTapRefund() {
    wx.navigateTo({ url: '/pages/order/refund-apply?order_no=' + this.orderNo });
  },

  // 存在退款单 → 退款进度（§2 页面6）
  onTapRefundProgress() {
    wx.navigateTo({ url: '/pages/order/refund-progress?order_no=' + this.orderNo });
  },

  // 待支付 → 取消订单（联动释放名额；40902 已支付/40901 已关闭 → 刷新展示真实状态）
  onTapCancel() {
    if (this.cancelling) return;
    wx.showModal({
      title: '取消订单',
      content: '确定取消该订单？名额将立即释放，候补用户自动递补。',
      success: (r) => {
        if (!r.confirm) return;
        this.cancelling = true;
        callCloud('order', 'cancel', { order_no: this.orderNo }).then(() => {
          this.cancelling = false;
          wx.showToast({ title: '已取消', icon: 'success' });
          this.fetch();
        }).catch((e) => {
          this.cancelling = false;
          if (e && (e.code === 40902 || e.code === 40901)) {
            this.fetch();
            return;
          }
          showError(e, '取消失败');
        });
      },
    });
  },
});
