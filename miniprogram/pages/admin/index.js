// pages/admin/index.js — 管理端工作台（admin-module §2.1 / §2.2-1）
// 接口：admin/permission/my（权限点数组，会话级缓存于 globalData.permissions）
// 入口：我的页「管理后台」入口（requireLogin 等待权限预取后，按权限点命中显示）；本页仅登录即可进，
//       无权限点时展示空态（云函数侧 checkPermission 为第二防线）。
// 交互：按权限点动态渲染分组入口卡片（未命中不渲染，R1）；下拉刷新重新拉取（权限变更即时生效）。
const { callCloud } = require('../../utils/cloud');
const { requireLogin } = require('../../utils/auth');
const { ROLE_NAMES } = require('../../utils/constants');

// 功能入口分组（§2.2-1 分组：活动运营/战队/订单/用户/管理；每张卡片绑定权限点）
const GROUPS = [
  {
    name: '活动运营',
    items: [
      { perm: 'publish_activity', icon: '📋', name: '活动管理', desc: '发布与编辑活动', url: '/pages/admin/activity/list' },
      { perm: 'checkin_activity', icon: '✅', name: '签到核验', desc: '现场签到核验', url: '/pages/admin/activity/checkin' },
      { perm: 'record_stats', icon: '🎯', name: '战绩录入', desc: '手动录入与 Excel 批量导入', url: '/pages/admin/activity/stats-list' },
      { perm: 'upload_album', icon: '📷', name: '相册管理', desc: '上传与管理俱乐部相册', url: '/pages/admin/activity/album-manage' },
    ],
  },
  {
    name: '战队',
    items: [
      { perm: 'audit_team', icon: '🛡️', name: '战队审核', desc: '创建申请审核', url: '/pages/admin/team-audit' },
    ],
  },
  {
    name: '订单',
    items: [
      { perm: 'audit_refund', icon: '💰', name: '退款审核', desc: '退款二次确认', url: '/pages/admin/refund-audit' },
    ],
  },
  {
    name: '用户',
    items: [
      { perm: 'user_manage', icon: '👥', name: '用户管理', desc: '用户搜索与详情', url: '/pages/admin/user/list' },
      { perm: 'user_role_assign', icon: '🔑', name: '用户授权', desc: '设置/撤销用户角色', url: '/pages/admin/user-role' },
    ],
  },
  {
    name: '管理',
    items: [
      { perm: 'role_manage', icon: '⚙️', name: '角色权限', desc: '角色与权限点配置', url: '/pages/admin/role-list' },
      { perm: 'view_operation_log', icon: '🗂️', name: '操作日志', desc: '审计日志查询', url: '/pages/admin/log-list' },
    ],
  },
];

Page({
  data: {
    loading: true,
    operatorName: '',
    roleName: '',
    groups: [],
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false, groups: [] });
        return;
      }
      this.loadData();
    });
  },

  onPullDownRefresh() {
    this.loadData(() => wx.stopPullDownRefresh());
  },

  // 拉取权限点并渲染入口（R1 前端隐藏为第一防线；云函数侧硬校验为第二防线）
  loadData(done) {
    callCloud('admin', 'permission/my', {}).then((res) => {
      const d = res.data || {};
      const perms = d.permissions || [];

      // 同步会话级缓存（app.hasPermission 供主页入口与各页守卫使用）
      const app = getApp();
      app.globalData.permissions = perms;
      if (d.operator && d.operator.role) app.globalData.role = d.operator.role;

      const hit = (perm) => perms.includes('*') || perms.includes(perm);
      const groups = GROUPS
        .map((g) => ({ name: g.name, items: g.items.filter((it) => hit(it.perm)) }))
        .filter((g) => g.items.length > 0);

      const role = (d.operator && d.operator.role) || 'member';
      this.setData({
        loading: false,
        operatorName: (d.operator && d.operator.name) || '',
        roleName: ROLE_NAMES[role] || role,
        groups,
      });
    }).catch(() => {
      this.setData({ loading: false, groups: [] });
    }).then(() => {
      if (done) done();
    });
  },

  onNav(e) {
    wx.navigateTo({
      url: e.currentTarget.dataset.url,
      fail: () => wx.showToast({ title: '页面跳转失败', icon: 'none' }),
    });
  },
});
