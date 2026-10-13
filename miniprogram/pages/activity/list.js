// pages/activity/list.js — 活动列表（guest，activity-module §2.1-1 / §5.1.1）
// 接口：activity/list（分页 + type/status 筛选 + keyword 搜索）
// 交互：下拉刷新、触底加载、类型 chips、状态筛选、搜索标题；展示剩余名额/已满员角标
// 注：本页为 tabBar 页（onLoad 仅触发一次，刷新走下拉）
const { callCloud } = require('../../utils/cloud');
const { showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const PAGE_SIZE = 10;

// 类型筛选（§3.1：novice/regular/theme/league/custom）
const TYPE_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'novice', label: '新手体验课' },
  { value: 'regular', label: '常规对抗赛' },
  { value: 'theme', label: '主题赛事' },
  { value: 'league', label: '俱乐部联赛' },
  { value: 'custom', label: '团建定制' },
];

// 状态筛选（会员端可见状态，§5.1.1：published/signup_closed/ongoing/finished）
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'published', label: '报名中' },
  { value: 'signup_closed', label: '报名截止' },
  { value: 'ongoing', label: '进行中' },
  { value: 'finished', label: '已结束' },
];

const TYPE_CLASS = {
  novice: 'type-novice',
  regular: 'type-regular',
  theme: 'type-theme',
  league: 'type-league',
  custom: 'type-custom',
};

// 起止时间合并展示（同一天只展示一个日期）
function rangeText(start, end) {
  const s = formatTime(start);
  if (!end) return s;
  const e = formatTime(end);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s} ~ ${e.slice(11)}` : `${s} ~ ${e}`;
}

Page({
  data: {
    types: TYPE_OPTIONS,
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    type: '',
    status: '',
    keyword: '',
    list: [],
    total: 0,
    page: 1,
    loading: false,
    finished: false, // 已到末页
    empty: false,
  },

  onLoad() {
    this.fetch(true);
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

  onTypeTap(e) {
    const type = e.currentTarget.dataset.value;
    if (type === this.data.type || this.data.loading) return;
    this.setData({ type });
    this.fetch(true);
  },

  onStatusChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ statusIndex: idx, status: STATUS_OPTIONS[idx].value });
    this.fetch(true);
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/activity/detail?id=' + e.currentTarget.dataset.id });
  },

  // reset=true 重置到第一页
  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('activity', 'list', {
      page,
      page_size: PAGE_SIZE,
      type: this.data.type || undefined,
      status: this.data.status || undefined,
      keyword: (this.data.keyword || '').trim() || undefined,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((it) => {
        const published = it.status === 'published';
        const remain = it.remain_num == null ? null : it.remain_num;
        let badge = '';
        let badgeClass = '';
        if (published) {
          if (remain != null && remain > 0) {
            badge = `剩 ${remain} 名`;
            badgeClass = 'badge-remain';
          } else {
            badge = '已满员';
            badgeClass = 'badge-full';
          }
        } else if (it.status === 'signup_closed') {
          badge = '报名截止';
          badgeClass = 'badge-grey';
        } else if (it.status === 'ongoing') {
          badge = '进行中';
          badgeClass = 'badge-ongoing';
        } else if (it.status === 'finished') {
          badge = '已结束';
          badgeClass = 'badge-grey';
        }
        return {
          id: it._id,
          title: it.title,
          cover: it.cover,
          typeLabel: (TYPE_OPTIONS.find((t) => t.value === it.type) || {}).label || it.type,
          typeClass: TYPE_CLASS[it.type] || '',
          timeText: rangeText(it.start_time, it.end_time),
          deadlineText: it.signup_deadline ? '报名截止 ' + formatTime(it.signup_deadline) : '',
          priceText: it.price > 0 ? '¥' + formatMoney(it.price) : '免费',
          badge,
          badgeClass,
        };
      });
      this.setData({
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        loading: false,
      });
    }).catch((e) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(e, '加载失败，下拉重试');
    });
  },
});
