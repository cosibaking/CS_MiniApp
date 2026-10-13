// pages/index/index.js — 首页（guest，TabBar 页）
// 数据：activity/list 两次并行（报名中 4 条 + 进行中 2 条，start_time 升序）
// 结构：品牌 Hero + 快捷入口宫格 + 近期活动（复用活动 tab 卡片样式）+ 下拉刷新
// 注：本页为 tabBar 页（onLoad 仅触发一次，刷新走下拉，与活动 tab 同法）
const { callCloud } = require('../../utils/cloud');
const { showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

// 活动类型展示（§3.1：novice/regular/theme/league/custom）
const TYPE_LABELS = {
  novice: '新手体验课',
  regular: '常规对抗赛',
  theme: '主题赛事',
  league: '俱乐部联赛',
  custom: '团建定制',
};

const TYPE_CLASS = {
  novice: 'type-novice',
  regular: 'type-regular',
  theme: 'type-theme',
  league: 'type-league',
  custom: 'type-custom',
};

// 起止时间合并展示（同一天只展示一个日期，与活动 tab 口径一致）
function rangeText(start, end) {
  const s = formatTime(start);
  if (!end) return s;
  const e = formatTime(end);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s} ~ ${e.slice(11)}` : `${s} ~ ${e}`;
}

function mapCard(it) {
  const published = it.status === 'published';
  let badge = '';
  let badgeClass = '';
  if (published) {
    if (it.remain_num != null && it.remain_num > 0) {
      badge = `剩 ${it.remain_num} 名`;
      badgeClass = 'badge-remain';
    } else {
      badge = '已满员';
      badgeClass = 'badge-full';
    }
  } else if (it.status === 'ongoing') {
    badge = '进行中';
    badgeClass = 'badge-ongoing';
  }
  return {
    id: it._id,
    title: it.title,
    cover: it.cover,
    typeLabel: TYPE_LABELS[it.type] || it.type,
    typeClass: TYPE_CLASS[it.type] || '',
    timeText: rangeText(it.start_time, it.end_time),
    priceText: it.price > 0 ? '¥' + formatMoney(it.price) : '免费',
    badge,
    badgeClass,
  };
}

Page({
  data: {
    loading: false,
    list: [],
    empty: false,
  },

  onLoad() {
    this.fetch();
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  // 报名中（主推）+ 进行中（正在打）合并展示；已结束/已截止不上首页
  fetch() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });
    return Promise.all([
      callCloud('activity', 'list', { page: 1, page_size: 4, status: 'published' }),
      callCloud('activity', 'list', { page: 1, page_size: 2, status: 'ongoing' }),
    ]).then(([a, b]) => {
      const items = []
        .concat((a.data && a.data.list) || [])
        .concat((b.data && b.data.list) || [])
        .map(mapCard);
      this.setData({ list: items, empty: items.length === 0, loading: false });
    }).catch((e) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(e, '加载失败，下拉重试');
    });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/activity/detail?id=' + e.currentTarget.dataset.id });
  },

  // TabBar 页用 switchTab，普通页用 navigateTo
  goActivities() {
    wx.switchTab({ url: '/pages/activity/list' });
  },
  goEnrollments() {
    wx.navigateTo({ url: '/pages/activity/my-enrollments' });
  },
  goCards() {
    wx.navigateTo({ url: '/pages/profile/card/list' });
  },
  goTeam() {
    wx.switchTab({ url: '/pages/team/list' });
  },
});
