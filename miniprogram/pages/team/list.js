// pages/team/list.js — 战队列表（team-module §2.1-1 / §5.2 list、§5.4 my）
// 接口：team/list（分页 + keyword 搜索）、team/my（置顶「我的战队」卡）
// 交互：搜索队名、下拉刷新、触底分页；「创建战队」「我的战队」入口；未登录引导（§2.2）
// 注：本页为 tabBar 页（onLoad 仅触发一次，刷新走下拉；onShow 轻刷置顶卡）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

const PAGE_SIZE = 10;

const ROLE_LABEL = { captain: '队长', member: '队员' };

// win_rate 为 0~1 小数（§6.2 保留 4 位）→ 百分比标签；null（无战绩）→ ''
function winRateText(wr) {
  if (wr === null || wr === undefined) return '';
  return Math.round(wr * 100) + '%';
}

Page({
  data: {
    logged: true,
    keyword: '',
    list: [],
    total: 0,
    page: 1,
    loading: false,
    finished: false, // 已到末页
    empty: false,    // 空态（按 hasKeyword 区分文案，§2.2）
    hasKeyword: false,
    myTeam: null,    // 已在职置顶卡（my.active_team 加工后）
  },

  onLoad() {
    this.init();
  },

  onShow() {
    // 从 detail/manage 返回后轻刷置顶卡（onLoad 仅触发一次）
    if (this._ready && this.data.logged) this.fetchMy();
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
    this.fetchMy();
  },

  onReachBottom() {
    if (this.data.finished || this.data.loading) return;
    this.fetch(false);
  },

  async init() {
    const user = await requireLogin();
    if (!user) {
      this.setData({ logged: false });
      return;
    }
    this._ready = true;
    this.fetch(true);
    this.fetchMy();
  },

  // 未登录引导重试（§2.2：登录后可见战队广场）
  async retryLogin() {
    const info = await getApp().silentLogin();
    if (info && info.user && info.user.user_id) {
      this.setData({ logged: true });
      this.init();
    } else {
      wx.showToast({ title: '登录失败，请稍后再试', icon: 'none' });
    }
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.fetch(true);
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.fetch(true);
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/team/create' });
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/team/detail?team_id=' + e.currentTarget.dataset.id });
  },

  goManage() {
    wx.navigateTo({ url: '/pages/team/manage?team_id=' + this.data.myTeam.team_id });
  },

  // 置顶卡数据（team/my active_team；失败静默，不影响列表浏览）
  fetchMy() {
    return callCloud('team', 'my', {}).then((res) => {
      const t = (res.data || {}).active_team;
      this.setData({
        myTeam: t ? {
          team_id: t.team_id,
          name: t.name,
          logo: t.logo,
          roleLabel: ROLE_LABEL[t.role] || '队员',
          isCaptain: t.role === 'captain',
          member_count: t.member_count || 0,
          win_rate_text: winRateText(t.win_rate),
        } : null,
      });
    }).catch(() => { /* 静默 */ });
  },

  // reset=true 重置到第一页
  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    const kw = (this.data.keyword || '').trim();
    this.setData({ loading: true });
    return callCloud('team', 'list', {
      page,
      page_size: PAGE_SIZE,
      keyword: kw || undefined,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((it) => ({
        team_id: it.team_id,
        name: it.name,
        logo: it.logo,
        slogan: it.slogan || '',
        member_count: it.member_count || 0,
        win_rate_text: winRateText(it.win_rate),
        captain_name: it.captain_name,
      }));
      this.setData({
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        hasKeyword: !!kw,
        loading: false,
      });
    }).catch((e) => {
      this.setData({ loading: false, empty: this.data.list.length === 0, hasKeyword: !!kw });
      showError(e, '加载失败，下拉重试');
    });
  },
});
