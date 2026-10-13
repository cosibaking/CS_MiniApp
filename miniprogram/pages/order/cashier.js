// pages/order/cashier.js — 收银台（payment-module §2）
// 入口：我的报名「去支付」→ /pages/order/cashier?order_no=xxx。
// 流程：order/detail 拉订单摘要 → 倒计时（expire_at，超时置灰）→「立即支付」
// order/getPayParams → wx.requestPayment → order/status 轮询确认（2s×30，§5.4 ③）
// → 支付成功弹窗跳订单详情；切后台回前台自动刷新兜底。
// 待支付单前端超时仅置灰（服务端 cron 兜底关单）；可主动取消（联动释放名额）。
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');

const STATUS_LABEL = {
  pending: '待支付',
  paid: '已支付',
  closed: '已关闭',
  partial_refunded: '部分退款',
  refunded: '已退款',
};
const POLL_INTERVAL = 2000;
const POLL_MAX = 30; // 2s × 30 = 60s

Page({
  data: {
    loading: true,
    orderNo: '',
    order: null, // { title, timeText, venue, count, amountText, status, statusLabel }
    countdownText: '',
    expired: false,
    paying: false,
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

  onShow() {
    // 从微信支付页/后台返回：静默刷新订单状态（onHide 已停轮询，此处兜底）
    if (this.user && this.orderNo && !this.data.loading && !this.data.paying && !this.pollTimer) {
      this.fetch();
    }
  },

  onHide() {
    this.stopTicker();
    this.stopPolling();
  },

  onUnload() {
    this.stopTicker();
    this.stopPolling();
  },

  fetch() {
    this.stopTicker();
    this.setData({ loading: true });
    callCloud('order', 'detail', { order_no: this.orderNo }).then((res) => {
      const o = (res.data && res.data.order) || null;
      if (!o) throw new Error('订单不存在');
      const snap = o.snapshot || {};
      const view = {
        title: snap.title || '俱乐部活动',
        timeText: snap.start_time ? formatTime(snap.start_time) : '',
        venue: snap.venue || '',
        count: (o.items || []).length,
        amountText: ((o.pay_amount || 0) / 100).toFixed(2), // §2：分转元保留两位
        status: o.status,
        statusLabel: STATUS_LABEL[o.status] || o.status,
      };
      const expired = o.status === 'pending' && o.expire_at && o.expire_at <= Date.now();
      this.setData({ loading: false, order: view, expired, countdownText: '' });
      if (o.status === 'pending' && !expired) this.startTicker(o.expire_at);
    }).catch((e) => {
      this.setData({ loading: false });
      wx.showModal({
        title: '提示', content: (e && e.msg) || '订单加载失败', showCancel: false,
        success: () => wx.navigateBack(),
      });
    });
  },

  // ---------- 倒计时（15 分钟锁单，超时置灰） ----------
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
      this.setData({ countdownText: '已超时', expired: true });
      return;
    }
    const m = Math.floor(left / 60);
    const s = left % 60;
    const text = `剩 ${m}:${s < 10 ? '0' + s : s} 完成支付`;
    if (text !== this.data.countdownText) this.setData({ countdownText: text });
  },

  // ---------- 支付 ----------
  onTapPay() {
    if (this.data.paying) return;
    if (this.data.expired) {
      wx.showToast({ title: '订单已超时，请重新报名', icon: 'none' });
      return;
    }
    this.setData({ paying: true });
    callCloud('order', 'getPayParams', { order_no: this.orderNo }).then((res) => {
      const d = res.data || {};
      if (d.expire_at && !this.tickTimer) this.startTicker(d.expire_at);
      this.requestPay(d);
    }).catch((e) => {
      this.setData({ paying: false });
      if (e && e.code === 40901) { // 服务端已超时关单
        wx.showToast({ title: '订单已关闭', icon: 'none' });
        this.fetch();
        return;
      }
      showError(e, '拉起支付失败');
    });
  },

  requestPay(d) {
    wx.requestPayment({
      ...d.pay_params,
      success: () => {
        this.setData({ paying: false });
        this.startPolling();
      },
      fail: () => {
        // 含用户取消：订单保留至 expire_at，停留本页可重试
        this.setData({ paying: false });
        wx.showToast({ title: '支付未完成，可稍后重试', icon: 'none' });
      },
    });
  },

  // ---------- 支付结果轮询（§5.4 ③） ----------
  startPolling() {
    this.stopPolling();
    this.pollCount = 0;
    wx.showLoading({ title: '支付结果确认中', mask: true });
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_INTERVAL);
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    wx.hideLoading();
  },

  pollOnce() {
    this.pollCount += 1;
    if (this.pollCount > POLL_MAX) {
      this.stopPolling();
      wx.showModal({
        title: '结果确认中',
        content: '支付结果暂时未同步，可稍后在「我的订单」中查看',
        showCancel: false,
        success: () => this.fetch(),
      });
      return;
    }
    callCloud('order', 'status', { order_no: this.orderNo }).then((res) => {
      const st = res.data && res.data.status;
      if (st && st !== 'pending') {
        this.stopPolling();
        this.onPaid();
      }
    }).catch(() => { /* 单次失败忽略，下轮重试 */ });
  },

  onPaid() {
    this.stopTicker();
    wx.showModal({
      title: '支付成功',
      content: '名额已确认，查看订单详情？',
      confirmText: '查看订单',
      cancelText: '留在本页',
      success: (r) => {
        if (r.confirm) {
          wx.redirectTo({ url: '/pages/order/detail?order_no=' + this.orderNo });
        } else {
          this.fetch();
        }
      },
    });
  },

  // ---------- 取消订单（pending → closed，联动释放名额） ----------
  onTapBack() {
    wx.navigateBack();
  },

  onTapCancel() {
    if (this.data.paying) return;
    wx.showModal({
      title: '取消订单',
      content: '确定取消该订单？名额将立即释放，候补用户自动递补。',
      success: (r) => {
        if (!r.confirm) return;
        callCloud('order', 'cancel', { order_no: this.orderNo }).then(() => {
          wx.showToast({ title: '已取消', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 1200);
        }).catch((e) => {
          if (e && (e.code === 40902 || e.code === 40901)) {
            // 取消前查单发现已支付 / 订单已关单 → 刷新展示实际状态
            this.fetch();
            return;
          }
          showError(e, '取消失败');
        });
      },
    });
  },
});
