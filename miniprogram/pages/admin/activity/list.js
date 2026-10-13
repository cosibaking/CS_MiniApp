// pages/admin/activity/list.js — 活动管理列表（publish_activity，activity-module §2.1-8 / §5.2.5）
// 接口：activity/adminList（分页 + status/keyword 筛选，全状态含草稿/已取消）
// 操作：发布（publish）、取消（cancel，触发自动全额退款）→ 编辑/报名名单/会员端详情入口
// 交互：状态 chips、标题搜索、下拉刷新、触底加载；从编辑/名单页返回自动刷新（onShow）
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatMoney, formatTime } = require('../../../utils/format');

const PAGE_SIZE = 10;

// 状态筛选（管理端全状态，§5.2.5 status=all|draft|...）
const STATUS_CHIPS = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '报名中' },
  { value: 'signup_closed', label: '报名截止' },
  { value: 'ongoing', label: '进行中' },
  { value: 'finished', label: '已结束' },
  { value: 'cancelled', label: '已取消' },
];

const TYPE_LABELS = {
  novice: '新手体验课',
  regular: '常规对抗赛',
  theme: '主题赛事',
  league: '俱乐部联赛',
  custom: '团建定制',
};

const STATUS_LABELS = {
  draft: '草稿', published: '报名中', signup_closed: '报名截止',
  ongoing: '进行中', finished: '已结束', cancelled: '已取消',
};
const STATUS_CLASS = {
  draft: 'st-grey', published: 'st-green', signup_closed: 'st-orange',
  ongoing: 'st-blue', finished: 'st-grey', cancelled: 'st-red',
};

// 起止时间合并展示（同一天只展示一个日期；草稿可能未设置时间）
function rangeText(start, end) {
  if (!start && !end) return '时间未设置';
  const s = formatTime(start);
  if (!end) return s;
  const e = formatTime(end);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s} ~ ${e.slice(11)}` : `${s} ~ ${e}`;
}

Page({
  data: {
    statusChips: STATUS_CHIPS,
    status: 'all',
    keyword: '',
    list: [],
    total: 0,
    page: 1,
    loading: false,
    finished: false, // 已到末页
    empty: false,
    noPermission: false,
  },

  onLoad(options) {
    requirePermission('publish_activity').then((pass) => {
      this.setData({ noPermission: !pass });
      if (pass) this.fetch(true);
    });
  },

  // 从编辑/名单/发布等页面返回后刷新（onLoad 仅首次触发一次）
  onShow() {
    if (this.loaded) this.fetch(true);
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.finished || this.data.loading) return;
    this.fetch(false);
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.fetch(true);
  },

  onStatusTap(e) {
    const status = e.currentTarget.dataset.value;
    if (status === this.data.status || this.data.loading) return;
    this.setData({ status });
    this.fetch(true);
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/admin/activity/edit' });
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/admin/activity/edit?id=' + e.currentTarget.dataset.id });
  },

  goEnrollList(e) {
    const { id, title } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/admin/activity/enroll-list?id=${id}&title=${encodeURIComponent(title || '')}`,
    });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/activity/detail?id=' + e.currentTarget.dataset.id });
  },

  // 发布（仅 draft；发布后会员端可见并开放报名）
  onPublish(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.canPublish) return;
    wx.showModal({
      title: '发布活动',
      content: `发布后会员即可在活动列表看到「${it.title}」并报名，确认发布？`,
      confirmText: '发布',
      confirmColor: '#C8552F',
      success: (r) => {
        if (!r.confirm) return;
        callCloud('activity', 'publish', { activity_id: it.id }).then(() => {
          wx.showToast({ title: '已发布', icon: 'success' });
          this.fetch(true);
        }).catch((err) => showError(err, '发布失败'));
      },
    });
  },

  // 取消活动（§3.8：自动全额退款 + 全员通知；仅 published/signup_closed）
  onCancel(e) {
    const it = this.data.list[e.currentTarget.dataset.index];
    if (!it || !it.canCancel) return;
    wx.showModal({
      title: '取消活动',
      content: '取消后不可恢复，已支付报名费将原路全额退回，候补同步释放。请填写取消原因：',
      editable: true,
      placeholderText: '取消原因（必填，≤100 字）',
      confirmText: '确认取消',
      confirmColor: '#B03030',
      success: (r) => {
        if (!r.confirm) return;
        const reason = (r.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写取消原因', icon: 'none' });
          return;
        }
        callCloud('activity', 'cancel', {
          activity_id: it.id,
          cancel_reason: reason,
        }).then((res) => {
          const d = res.data || {};
          const refundNote = d.refund_created
            ? `创建退款单 ${d.refund_created} 张`
              + (d.refund_failed ? `，${d.refund_failed} 张失败需人工跟进` : '')
            : '无需退款';
          wx.showModal({
            title: '活动已取消',
            content: `已取消报名 ${d.cancelled || 0} 条\n${refundNote}\n已通知 ${d.notified || 0} 人`,
            showCancel: false,
          });
          this.fetch(true);
        }).catch((err) => showError(err, '取消失败'));
      },
    });
  },

  // reset=true 重置到第一页
  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('activity', 'adminList', {
      page,
      page_size: PAGE_SIZE,
      status: this.data.status === 'all' ? undefined : this.data.status,
      keyword: (this.data.keyword || '').trim() || undefined,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((it) => ({
        id: it._id,
        title: it.title,
        typeLabel: TYPE_LABELS[it.type] || it.type || '类型未设置',
        statusLabel: STATUS_LABELS[it.status] || it.status,
        statusClass: STATUS_CLASS[it.status] || 'st-grey',
        timeText: rangeText(it.start_time, it.end_time),
        deadlineText: it.signup_deadline ? '报名截止 ' + formatTime(it.signup_deadline) : '',
        priceText: it.price > 0 ? '¥' + formatMoney(it.price) : '免费',
        statText: `报名 ${it.signup_count || 0}/${it.max_num || 0} · 候补 ${it.waitlist_count || 0} · 签到 ${it.checkin_count || 0}`,
        // 操作可见性（状态机：§2.1-8）
        canEdit: it.status === 'draft' || it.status === 'published',
        canPublish: it.status === 'draft',
        canCancel: it.status === 'published' || it.status === 'signup_closed',
        canViewDetail: it.status !== 'draft',
      }));
      this.setData({
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        loading: false,
      });
      this.loaded = true;
    }).catch((err) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(err, '加载失败，下拉重试');
    });
  },
});
