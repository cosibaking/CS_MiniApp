// pages/team/invite.js — 邀请队员（队长，team-module §2.1-5 / §2.2）
// 接口：team/search-users（昵称/手机号搜索）、team/invite（§5.9 发出邀请）
// §2.2：目标已在其他战队/本队、已有本队未处理申请或邀请 → 列表项禁选标注
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { TEAM_BIZ } = require('../../utils/constants');

const PAGE_SIZE = 20;

// §2.2 禁选标注文案（不可邀请）
function tipOf(item) {
  if (item.pending === 'applying') return '已提交申请，请到申请列表处理';
  if (item.pending === 'invited') return '已邀请，等待对方处理';
  if (item.in_my_team) return '已在本战队';
  if (item.in_team) return '已属于其他战队';
  return '';
}

Page({
  data: {
    logged: false,
    keyword: '',
    searching: false,
    searched: false,   // 是否已发起过搜索（区分初始态与空结果态）
    failed: false,
    total: 0,
    results: [],
    acting: false,
  },

  onLoad(options) {
    this.teamId = options.team_id || '';
    requireLogin().then((user) => {
      this.setData({ logged: !!user });
    });
  },

  retryLogin() {
    requireLogin().then((user) => {
      this.setData({ logged: !!user });
    });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    if (this.data.searching) return;
    const keyword = String(this.data.keyword || '').trim();
    if (!keyword) {
      wx.showToast({ title: '请输入昵称或手机号', icon: 'none' });
      return;
    }
    if (keyword.length > 50) {
      wx.showToast({ title: '关键词不能超过 50 字', icon: 'none' });
      return;
    }
    this.fetch(keyword);
  },

  retry() {
    const keyword = String(this.data.keyword || '').trim();
    if (keyword) this.fetch(keyword);
  },

  onClear() {
    this.setData({ keyword: '', searched: false, failed: false, total: 0, results: [] });
  },

  fetch(keyword) {
    this.setData({ searching: true, failed: false });
    callCloud('team', 'search-users', {
      team_id: this.teamId,
      keyword,
      page: 1,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      this.setData({
        searching: false,
        searched: true,
        total: d.total || 0,
        results: (d.list || []).map((u) => ({
          user_id: u.user_id,
          nickname: u.nickname || '会员',
          avatar: u.avatar,
          phone_masked: u.phone_masked,
          tip: tipOf(u),
          failMsg: '',
        })),
      });
    }).catch((e) => {
      this.setData({ searching: false, searched: true, failed: true });
      showError(e);
    });
  },

  onPick(e) {
    const idx = e.currentTarget.dataset.index;
    const item = this.data.results[idx];
    if (!item || this.data.acting) return;
    if (item.tip) {
      wx.showToast({ title: item.tip, icon: 'none' });
      return;
    }
    wx.showModal({
      title: '邀请入队',
      content: '邀请「' + item.nickname + '」加入战队？',
      editable: true,
      placeholderText: '邀请留言（选填，100 字内）',
      confirmText: '发送邀请',
      success: (res) => {
        if (!res.confirm) return;
        this.sendInvite(idx, String(res.content || '').trim().slice(0, 100));
      },
    });
  },

  sendInvite(idx, note) {
    const item = this.data.results[idx];
    if (!item) return;
    this.setData({ acting: true });
    callCloud('team', 'invite', {
      team_id: this.teamId,
      target_user_id: item.user_id,
      invite_note: note || null,
    }).then(() => {
      const patch = {};
      patch['results[' + idx + '].tip'] = '已邀请，等待对方处理';
      patch['results[' + idx + '].failMsg'] = '';
      this.setData(patch);
      wx.showToast({ title: '已发送邀请', icon: 'success' });
    }).catch((e) => {
      // 发出后目标状态可能已变化（CP-3 软校验兜底）：失败原因行内标注，不打断列表
      const patch = {};
      patch['results[' + idx + '].failMsg'] = e.msg || '发送失败，请重试';
      if (e.code === TEAM_BIZ.TARGET_IN_TEAM) patch['results[' + idx + '].tip'] = '已属于其他战队';
      if (e.code === TEAM_BIZ.DUP_PENDING) patch['results[' + idx + '].tip'] = '已有未处理记录';
      this.setData(patch);
      showError(e);
    }).then(() => {
      this.setData({ acting: false });
    });
  },
});
