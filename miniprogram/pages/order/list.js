// pages/order/list.js — 我的订单（payment-module §2 页面3）
// 接口：order/list（分页 + status 单值筛选）。
// Tab：全部/待支付/已支付/已退款/已关闭。设计文档另列「退款中」，但订单无该状态
// （退款进行中订单仍为 paid，order/list 仅支持单一 status 值），故实现为五档。
// 待支付单：15 分钟倒计时 +「去支付」快捷入口（跳收银台）；卡片点击进订单详情。
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const PAGE_SIZE = 10;

// 分组 tab → order/list.status 入参（单值，shared.js ORDER_STATUSES）
const TABS = [
  { key: 'all', label: '全部', status: null },
  { key: 'pending', label: '待支付', status: 'pending' },
  { key: 'paid', label: '已支付', status: 'paid' },
  { key: 'refunded', label: '已退款', status: 'refunded' },
  { key: 'closed', label: '已关闭', status: 'closed' },
];

const STATUS_LABELS = {
  pending: '待支付', paid: '已支付', partial_refunded: '部分退款',
  refunded: '已退款', closed: '已关闭',
};
const STATUS_CLASS = {
  pending: 'st-orange', paid: 'st-green', partial_refunded: 'st-blue',
  refunded: 'st-blue', closed: 'st-grey',
};

Page({
  data: {
    tabs: TABS.map((t) => ({ key: t.key, label: t.label })),
    activeTab: 'all',
    loading: false,
    list: [],
    total: 0,
    page: 0,
    finished: false,
    empty: false,
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.fetch(true);
    });
  },

  // 从收银台/订单详情返回 → 刷新（支付/取消/退款后状态变化；首次 onShow 不重复拉取）
  onShow() {
    if (this.loaded) this.fetch(true);
  },

  onHide() { this.stopTicker(); },
  onUnload() { this.stopTicker(); },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.finished && !this.data.loading) this.fetch(false);
  },

  onTabTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeTab) return;
    this.stopTicker();
    this.setData({ activeTab: key, list: [], page: 0, finished: false, empty: false });
    this.fetch(true);
  },

  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    if (reset) this.stopTicker();
    const tab = TABS.find((t) => t.key === this.data.activeTab) || TABS[0];
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('order', 'list', {
      page,
      page_size: PAGE_SIZE,
      status: tab.status || undefined,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((e) => this.buildItem(e));
      this.loaded = true;
      this.setData({
        loading: false,
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: items.length < PAGE_SIZE,
        empty: reset && items.length === 0,
      });
      this.startTicker();
    }).catch((e) => {
      this.setData({ loading: false, empty: !this.data.list.length });
      showError(e, '订单加载失败');
    });
  },

  buildItem(e) {
    return {
      orderNo: e.order_no,
      title: e.title || '俱乐部活动',
      cover: e.cover || '',
      timeText: e.start_time ? formatTime(e.start_time) : '',
      createdText: e.created_at ? formatTime(e.created_at) : '',
      itemCount: e.item_count || 0,
      amountText: formatMoney(e.pay_amount),
      refundedText: e.refunded_total > 0 ? `已退 ¥${formatMoney(e.refunded_total)}` : '',
      status: e.status,
      statusLabel: STATUS_LABELS[e.status] || e.status,
      statusClass: STATUS_CLASS[e.status] || 'st-grey',
      expireAt: e.status === 'pending' ? (e.expire_at || 0) : 0,
      countdownText: '',
    };
  },

  // 待支付倒计时（仅存在 pending 项时启动，1s 刷新；与 my-enrollments 同款）
  startTicker() {
    this.stopTicker();
    const hasPending = this.data.list.some((it) => it.status === 'pending' && it.expireAt > 0);
    if (!hasPending) return;
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.tick();
  },

  stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  },

  tick() {
    const now = Date.now();
    let changed = false;
    const list = this.data.list.map((it) => {
      if (it.status !== 'pending' || !it.expireAt) return it;
      const left = it.expireAt - now;
      let text;
      if (left <= 0) {
        text = '已超时，系统释放中';
      } else {
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        text = `剩 ${m}:${s < 10 ? '0' + s : s} 支付`;
      }
      if (text !== it.countdownText) {
        changed = true;
        return Object.assign({}, it, { countdownText: text });
      }
      return it;
    });
    if (changed) this.setData({ list });
  },

  // 待支付 → 收银台补单
  goPay(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.orderNo) return;
    wx.navigateTo({ url: '/pages/order/cashier?order_no=' + it.orderNo });
  },

  goDetail(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.orderNo) return;
    wx.navigateTo({ url: '/pages/order/detail?order_no=' + it.orderNo });
  },
});
