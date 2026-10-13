// pages/activity/my-enrollments.js — 我的报名（login，activity-module §2.1 页面4 / §5.1.7）
// 接口：activity/myEnrollments（分组/分页）、activity/cancelSignup（取消报名/退出候补）
// 待支付 15 分钟倒计时；「去支付」跳收银台（/pages/order/cashier?order_no=，payment-module §2 页面2）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const PAGE_SIZE = 10;

// 分组 tab → myEnrollments.status 入参（数组）
const TABS = [
  { key: 'all', label: '全部', statuses: null },
  { key: 'pending', label: '待支付', statuses: ['pending'] },
  { key: 'enrolled', label: '已报名', statuses: ['enrolled', 'checked_in'] },
  { key: 'waitlist', label: '候补', statuses: ['waitlist'] },
  { key: 'history', label: '历史', statuses: ['completed', 'cancelled'] },
];

const STATUS_LABELS = {
  pending: '待支付', enrolled: '已报名', waitlist: '候补中',
  checked_in: '已签到', completed: '已参加', cancelled: '已取消',
};
const STATUS_CLASS = {
  pending: 'st-orange', enrolled: 'st-green', waitlist: 'st-blue',
  checked_in: 'st-green', completed: 'st-grey', cancelled: 'st-red',
};
const PAY_TYPE_LABELS = { wxpay: '微信支付', times_card: '次卡', period_card: '期限卡' };
const CANCEL_TYPE_LABELS = {
  user_cancel: '主动取消', pay_timeout: '超时未支付', activity_cancel: '活动取消',
  waitlist_conflict: '递补冲突', refund: '退款取消', not_reached_min: '未成团取消',
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

  // 从收银台支付完成返回 → 刷新列表（首次 onShow 不重复拉取）
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
    return callCloud('activity', 'myEnrollments', {
      page,
      page_size: PAGE_SIZE,
      status: tab.statuses || undefined,
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
      showError(e, '加载失败');
    });
  },

  buildItem(e) {
    return {
      id: e._id,
      activityId: e.activity_id,
      title: e.activity_title,
      cover: e.activity_cover,
      timeText: formatTime(e.activity_start_time),
      status: e.status,
      statusLabel: STATUS_LABELS[e.status] || e.status,
      statusClass: STATUS_CLASS[e.status] || 'st-grey',
      payType: e.pay_type,
      payTypeLabel: PAY_TYPE_LABELS[e.pay_type] || '',
      priceText: e.price_snapshot > 0 ? '¥' + formatMoney(e.price_snapshot) : '免费',
      positionText: e.status === 'waitlist' && e.waitlist_position ? `候补第 ${e.waitlist_position} 位` : '',
      cancelTypeLabel: e.status === 'cancelled' && e.cancel_type
        ? '取消原因：' + (CANCEL_TYPE_LABELS[e.cancel_type] || e.cancel_type) : '',
      expireAt: e.status === 'pending' ? (e.expire_at || 0) : 0,
      countdownText: '',
      orderNo: e.order_no || '',
    };
  },

  // 待支付倒计时（仅存在 pending 项时启动，1s 刷新）
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

  // 待支付 → 收银台补单（order_no 由 activity/myEnrollments 附带）
  goPay(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it) return;
    if (!it.orderNo) {
      wx.showToast({ title: '订单信息缺失，请下拉刷新后重试', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/order/cashier?order_no=' + it.orderNo });
  },

  // 取消报名 / 退出候补（cancelSignup 四分支：released / refund_applied / waitlist_quited）
  onCancel(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || this.cancelling) return;
    let content;
    if (it.status === 'pending') {
      content = '确定取消该报名？名额将立即释放，候补用户自动递补。';
    } else if (it.status === 'waitlist') {
      content = '确定退出候补？退出后候补位次不保留。';
    } else {
      content = it.payType === 'wxpay'
        ? '取消后报名费将原路全额退回（一般 24 小时内到账），确定取消？'
        : '确定取消该报名？名额将立即释放，候补用户自动递补。';
    }
    wx.showModal({
      title: it.status === 'waitlist' ? '退出候补' : '取消报名',
      content,
      success: (r) => {
        if (!r.confirm) return;
        this.cancelling = true;
        callCloud('activity', 'cancelSignup', { enrollment_id: it.id }).then((res) => {
          this.cancelling = false;
          const d = res.data || {};
          if (d.result === 'refund_applied') {
            wx.showModal({
              title: '退款申请已提交',
              content: d.notice || '报名费将原路退回，请留意到账通知',
              showCancel: false,
              success: () => this.fetch(true),
            });
          } else if (d.result === 'waitlist_quited') {
            wx.showToast({ title: '已退出候补', icon: 'success' });
            this.fetch(true);
          } else { // released
            wx.showModal({
              title: '已取消',
              content: d.notice || '名额已释放，候补用户已自动递补',
              showCancel: false,
              success: () => this.fetch(true),
            });
          }
        }).catch((err) => {
          this.cancelling = false;
          showError(err, '操作失败');
        });
      },
    });
  },

  // 已参加的历史记录 → 评价页（§2.1 页面6；completed 仅在活动结束后出现，资格由后端复核）
  goReview(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.activityId) return;
    wx.navigateTo({
      url: '/pages/activity/review?activity_id=' + it.activityId
        + '&title=' + encodeURIComponent(it.title || ''),
    });
  },

  goDetail(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.activityId) return;
    wx.navigateTo({ url: '/pages/activity/detail?id=' + it.activityId });
  },
});
