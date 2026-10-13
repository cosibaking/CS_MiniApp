// pages/admin/activity/enroll-list.js — 报名/候补名单（publish_activity，activity-module §2.1-10 / §5.2.6）
// 接口：activity/enrollList（group 分组 + 分页；summary 六状态计数 + 签到率；手机号服务端已脱敏）
// 功能：分组浏览 + 汇总 + 候补手动递补（promoteWaitlist）；导出 Excel 属后续版本（§9.1）
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatTime } = require('../../../utils/format');

const PAGE_SIZE = 20;

const GROUP_CHIPS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待支付' },
  { value: 'enrolled', label: '已报名' },
  { value: 'waitlist', label: '候补' },
  { value: 'checked_in', label: '已签到' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
];

const STATUS_LABELS = {
  pending: '待支付', enrolled: '已报名', waitlist: '候补中',
  checked_in: '已签到', completed: '已完成', cancelled: '已取消',
};
const STATUS_CLASS = {
  pending: 'st-orange', enrolled: 'st-green', waitlist: 'st-blue',
  checked_in: 'st-green', completed: 'st-grey', cancelled: 'st-red',
};
const PAY_TYPE_LABELS = {
  wxpay: '微信支付', times_card: '次卡', period_card: '期限卡', free: '免费',
};

Page({
  data: {
    groups: GROUP_CHIPS,
    group: 'all',
    activityId: '',
    title: '',
    // 汇总（全量，切换分组不重拉）
    summary: null,
    checkinRateText: '',
    // 列表
    list: [],
    total: 0,
    page: 1,
    loading: false,
    finished: false,
    empty: false,
    noPermission: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({
      activityId: options.id || '',
      title,
    });
    requirePermission('publish_activity').then((pass) => {
      this.setData({ noPermission: !pass });
      if (pass) this.fetch(true);
    });
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.finished || this.data.loading) return;
    this.fetch(false);
  },

  onGroupTap(e) {
    const group = e.currentTarget.dataset.value;
    if (group === this.data.group || this.data.loading) return;
    this.setData({ group });
    this.fetch(true);
  },

  // 候补递补：确认后该成员进入待支付并获得支付时限，自动通知（promoteWaitlist，publish_activity）
  onPromoteTap(e) {
    if (this._promoting) return;
    const { userId, nickname } = e.currentTarget.dataset;
    wx.showModal({
      title: '候补递补',
      content: `确认为「${nickname}」递补名额？将通知对方限期完成支付`,
      confirmColor: '#C8552F',
      success: (r) => {
        if (!r.confirm) return;
        this._promoting = true;
        callCloud('activity', 'promoteWaitlist', {
          activity_id: this.data.activityId,
          user_id: userId,
        }).then(() => {
          wx.showToast({ title: '已递补', icon: 'success' });
          return this.fetch(true);
        }).catch((err) => {
          showError(err, '递补失败，请重试');
        }).then(() => {
          this._promoting = false;
        });
      },
    });
  },

  // reset=true 重置到第一页；group 切换/刷新时重拉 summary
  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('activity', 'enrollList', {
      activity_id: this.data.activityId,
      group: this.data.group,
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const summary = d.summary || {};
      const items = (d.list || []).map((it) => ({
        id: it._id,
        nickname: it.nickname || '未设置昵称',
        avatar: it.avatar || '',
        phone: it.phone || '',
        payTypeLabel: PAY_TYPE_LABELS[it.pay_type] || it.pay_type || '-',
        userId: it.user_id || '',
        isWaitlist: it.status === 'waitlist',
        statusLabel: STATUS_LABELS[it.status] || it.status,
        statusClass: STATUS_CLASS[it.status] || 'st-grey',
        positionText: it.status === 'waitlist' && it.position ? `候补第 ${it.position} 位` : '',
        checkinText: it.checkin_time ? '签到 ' + formatTime(it.checkin_time) : '',
        createdAtText: formatTime(it.created_at),
      }));
      this.setData({
        summary: reset ? summary : this.data.summary,
        checkinRateText: reset && summary.checkin_rate != null
          ? '签到率 ' + Math.round(summary.checkin_rate * 100) + '%' : this.data.checkinRateText,
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        loading: false,
      });
    }).catch((err) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(err, '加载失败，下拉重试');
    });
  },
});
