// pages/profile/profile.js — 我的（user-module §2.1、§5.3）
// 接口：user/getProfile；onShow 刷新（协议签署/资料编辑返回后即时更新）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatDate } = require('../../utils/format');

// tabBar 页面路径（入口跳转需用 wx.switchTab 而非 navigateTo）
const TAB_PATHS = ['pages/index/index', 'pages/activity/list', 'pages/team/list', 'pages/profile/profile'];

Page({
  data: {
    loading: true,
    guest: false, // 静默登录失败（未登录）
    banned: false, // 账号封禁
    user: null,
    level: null,
    rank: null,
    cards: [],
    waiver: null,
    avatarText: '', // 无头像时昵称首字兜底
    tasks: [], // 前置任务条（完善资料/绑定手机/签协议）
    isAdmin: false, // 命中任一权限点（管理员）时显示管理后台入口
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    requireLogin().then((user) => {
      if (!user) {
        // requireLogin 为 null：封禁（globalData.userInfo.banned）或静默登录失败
        const info = getApp().globalData.userInfo;
        this.setData({
          loading: false,
          banned: !!(info && info.banned),
          guest: !(info && info.banned),
        });
        return;
      }
      // requireLogin 已等待启动登录（含权限预取）完成，此处权限点为最终态
      this.setData({ isAdmin: (getApp().globalData.permissions || []).length > 0 });
      this.loadData();
    });
  },

  loadData() {
    this.setData({ loading: true });
    callCloud('user', 'getProfile', {})
      .then((res) => {
        const d = res.data || {};
        const u = d.user || {};
        const waiver = d.waiver || {};

        // 前置任务条
        const tasks = [];
        if (!u.nickname || u.nickname === '微信用户') {
          tasks.push({ key: 'nickname', label: '完善资料', url: '/pages/profile/edit' });
        }
        if (!u.phone_bound) {
          tasks.push({ key: 'phone', label: '绑定手机号', url: '/pages/profile/bind-phone' });
        }
        if (waiver.need_resign) {
          tasks.push({ key: 'waiver', label: '签署免责协议', url: '/pages/profile/waiver', highlight: true });
        }

        // 会员卡到期时间预格式化
        const cards = (d.cards || []).map((c) => ({
          card_id: c.card_id,
          card_type: c.card_type,
          card_name: c.card_name,
          remain_times: c.remain_times,
          expireText: c.expire_at ? formatDate(c.expire_at) : '—',
        }));

        this.setData({
          loading: false,
          guest: false,
          banned: false,
          user: u,
          level: d.level || null,
          rank: d.rank || null,
          cards,
          waiver,
          avatarText: u.nickname ? String(u.nickname).trim().charAt(0) || 'C' : 'C',
          tasks,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        showError(e, '加载失败，请稍后重试');
      });
  },

  // 游客态重试登录
  relogin() {
    this.setData({ loading: true });
    getApp()
      .silentLogin()
      .then(() => this.refresh());
  },

  // 入口跳转（tab 页用 switchTab）
  go(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    const clean = url.replace(/^\//, '');
    if (TAB_PATHS.indexOf(clean) >= 0) {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },
});
