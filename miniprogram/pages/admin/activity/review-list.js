// pages/admin/activity/review-list.js — 评价管理（登录即可查看，activity-module §5.29/§3.11）
// 接口：activity/reviewList（summary 均分 + 1~5 星分布；list 分页；仅查看，无回复/删除能力）
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');
const { formatTime } = require('../../../utils/format');

const PAGE_SIZE = 20;

Page({
  data: {
    activityId: '',
    summary: null,
    distRows: [],
    list: [],
    total: 0,
    page: 1,
    loading: false,
    finished: false,
    empty: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({ activityId: options.id || '' });
    requireLogin().then((user) => {
      if (!user) return;
      this.fetch(true);
    });
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.finished || this.data.loading) return;
    this.fetch(false);
  },

  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('activity', 'reviewList', {
      activity_id: this.data.activityId,
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((r) => ({
        id: r._id,
        nickname: r.nickname || '未设置昵称',
        avatar: r.avatar || '',
        starsText: '★★★★★'.slice(0, r.stars) + '☆☆☆☆☆'.slice(0, 5 - (r.stars || 0)),
        content: r.content || '',
        createdAtText: formatTime(r.created_at),
      }));
      const patch = {
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        loading: false,
      };
      if (reset) {
        const s = d.summary || {};
        const avg = Number(s.avg_stars) || 0;
        const full = Math.round(avg);
        patch.summary = {
          avgText: s.count ? avg.toFixed(1) : '-',
          avgStarsText: s.count
            ? '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full)
            : '☆☆☆☆☆',
          count: s.count || 0,
        };
        // 分布行：5 星 → 1 星
        const dist = s.distribution || {};
        patch.distRows = [5, 4, 3, 2, 1].map((star) => ({
          star,
          count: dist[star] || 0,
          pct: s.count ? Math.round((dist[star] || 0) * 100 / s.count) : 0,
        }));
      }
      this.setData(patch);
    }).catch((err) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(err, '加载失败，下拉重试');
    });
  },
});
