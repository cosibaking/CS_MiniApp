// pages/team/ranking.js — 战队排行榜（login，team-module §2 页面7 / §5.17）
// 接口：team/ranking（R7：胜率降序 → 场次降序 → 建队时间升序；上榜门槛 total_games ≥ 5）
// 出参：total / my_rank（所在战队全量名次，未上榜或未入队为 null）/ 分页 list
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

const PAGE_SIZE = 20;

Page({
  data: {
    loading: true,
    loadingMore: false,
    finished: false,   // 已加载完全部分页
    page: 1,
    myRank: null,      // null=未入队或未上榜
    list: [],
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

  fetch(reset) {
    const page = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, page: 1 });
    else this.setData({ loadingMore: true });

    callCloud('team', 'ranking', { page, page_size: PAGE_SIZE }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((t) => ({
        rank: t.rank,
        team_id: t.team_id,
        name: t.name || '战队',
        logo: t.logo || '',
        memberCount: t.member_count || 0,
        totalGames: t.total_games || 0,
        wins: t.wins || 0,
        winRateText: `${t.win_rate || 0}%`,
      }));
      this.setData({
        loading: false,
        loadingMore: false,
        page,
        myRank: d.my_rank || null,
        list: reset ? items : this.data.list.concat(items),
        finished: page * PAGE_SIZE >= (d.total || 0),
      });
    }).catch((e) => {
      this.setData({ loading: false, loadingMore: false });
      showError(e, '加载失败');
    });
  },

  onReachBottom() {
    if (this.data.loading || this.data.loadingMore || this.data.finished) return;
    this.fetch(false);
  },

  goTeam(e) {
    wx.navigateTo({ url: '/pages/team/detail?id=' + e.currentTarget.dataset.id });
  },
});
