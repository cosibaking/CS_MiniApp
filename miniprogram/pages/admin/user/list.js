// pages/admin/user/list.js — 用户管理列表（user-module §5.20 / admin-module §2.3）
// 接口：user/adminList（user_manage，只读）
// 筛选（§2.4）：关键词（昵称模糊 / 完整手机号）+ 角色 + 状态；默认每页 20 条
// 点击条目进入详情页执行角色 / 封禁 / 调卡操作
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { ROLE_NAMES, levelOf } = require('../../../utils/constants');
const { formatTime } = require('../../../utils/format');

const PAGE_SIZE = 20;

// 角色下拉（PRESET_ROLES；自定义角色暂不在筛选项内，仅详情可见）
const ROLE_OPTIONS = [
  { key: '', name: '全部角色' },
  { key: 'guest', name: '游客' },
  { key: 'member', name: '会员' },
  { key: 'captain', name: '战队队长' },
  { key: 'staff', name: '工作人员' },
  { key: 'admin', name: '管理员' },
];
const STATUS_OPTIONS = [
  { key: '', name: '全部状态' },
  { key: 'normal', name: '正常' },
  { key: 'banned', name: '已封禁' },
];

Page({
  data: {
    checking: true,
    noPermission: false,
    keyword: '',
    roleIndex: 0,
    statusIndex: 0,
    roleOptions: ROLE_OPTIONS,
    statusOptions: STATUS_OPTIONS,
    list: [],
    total: 0,
    listLoading: false,
    finished: false,
    failed: false,
  },

  onLoad() {
    this._page = 1;
    requirePermission('user_manage').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadPage(true);
    });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  // ---------- 筛选 ----------
  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadPage(true);
  },

  onRoleChange(e) {
    this.setData({ roleIndex: Number(e.detail.value) });
    this.loadPage(true);
  },

  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) });
    this.loadPage(true);
  },

  onRetry() {
    this.loadPage(true);
  },

  // ---------- 数据加载 ----------
  // reset=true 回到第一页（筛选变更 / 搜索 / 失败重试）
  loadPage(reset) {
    if (this.data.listLoading) return;
    if (!reset && this.data.finished) return;
    const page = reset ? 1 : this._page + 1;
    const role = ROLE_OPTIONS[this.data.roleIndex].key;
    const status = STATUS_OPTIONS[this.data.statusIndex].key;
    this.setData({ listLoading: true });
    callCloud('user', 'adminList', {
      page,
      page_size: PAGE_SIZE,
      keyword: this.data.keyword.trim() || null,
      role: role || null,
      status: status || null,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((u) => this.mapItem(u));
      this._page = page;
      this.setData({
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        finished: items.length < PAGE_SIZE,
        failed: false,
      });
    }).catch((e) => {
      if (reset) this.setData({ list: [], total: 0 });
      this.setData({ failed: true });
      showError(e, '列表加载失败，请重试');
    }).then(() => {
      this.setData({ listLoading: false });
    });
  },

  mapItem(u) {
    const lv = levelOf(u.total_games);
    return {
      user_id: u.user_id,
      role: u.role,
      nickname: u.nickname || '未命名',
      phone_text: u.phone || '未绑定手机号',
      role_text: ROLE_NAMES[u.role] || u.role,
      status_text: u.status === 'banned' ? '已封禁' : '正常',
      banned: u.status === 'banned',
      level_text: lv.level > 0 ? 'LV' + lv.level + ' ' + lv.name : lv.name,
      is_minor: !!u.is_minor,
      games_text: String(u.total_games || 0),
      created_text: u.created_at ? formatTime(u.created_at) : '',
    };
  },

  onReachBottom() {
    this.loadPage(false);
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/admin/user/detail?user_id=' + e.currentTarget.dataset.id });
  },
});
