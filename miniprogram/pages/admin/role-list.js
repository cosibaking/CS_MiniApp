// pages/admin/role-list.js — 角色列表（admin-module §2.2-2）
// 接口：admin/role/list（读操作）、admin/role/delete（写操作，5004 预置保护/5005 引用检查）
// 删除仅对自定义角色开放；编辑跳 role-edit（返回后 onShow 刷新）
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');
const { CODE, ADMIN_BIZ } = require('../../utils/constants');

Page({
  data: {
    checking: true,
    noPermission: false,
    loading: false,
    list: [],
  },

  onLoad() {
    requirePermission('role_manage').then((pass) => {
      this._permPass = pass;
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadData();
    });
  },

  // 从 role-edit 保存/删除后返回时刷新（onLoad 首载先于 requirePermission resolve，不会双载）
  onShow() {
    if (this._permPass && this._loaded) this.loadData();
  },

  loadData() {
    if (this.data.loading) return;
    this._loaded = true;
    this.setData({ loading: true });
    callCloud('admin', 'role/list', {})
      .then((res) => {
        const list = (res.data.list || []).map((r) => ({
          role_key: r.role_key,
          name: r.name,
          is_preset: !!r.is_preset,
          perm_count: (r.permissions || []).length,
          has_wildcard: (r.permissions || []).includes('*'),
          user_count: r.user_count || 0,
          updated_text: formatTime(r.updated_at),
          description: r.description || '',
        }));
        this.setData({ list, loading: false });
      })
      .catch((e) => {
        this.setData({ loading: false });
        showError(e, '角色列表加载失败');
      });
  },

  // 点击角色卡进编辑
  onNav(e) {
    wx.navigateTo({ url: `/pages/admin/role-edit?role_key=${e.currentTarget.dataset.key}` });
  },

  // 新建角色
  onCreate() {
    wx.navigateTo({ url: '/pages/admin/role-edit' });
  },

  // 删除（仅自定义角色；5004 预置/5005 使用中弹窗说明）
  onDelete(e) {
    const { index } = e.currentTarget.dataset;
    const role = this.data.list[index];
    if (!role || role.is_preset) return;
    wx.showModal({
      title: '删除角色',
      content: `确定删除「${role.name}」？该操作将记入操作日志。`,
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        callCloud('admin', 'role/delete', { role_key: role.role_key })
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' });
            this.loadData();
          })
          .catch((err) => {
            // 5004 预置保护 / 5005 角色使用中：弹窗说明（含迁移提示）
            if (err.code === ADMIN_BIZ.PRESET_PROTECTED || err.code === ADMIN_BIZ.ROLE_IN_USE) {
              wx.showModal({ title: '无法删除', content: err.msg || '角色不可删除', showCancel: false });
            } else if (err.code === CODE.FORBIDDEN) {
              wx.showToast({ title: '无权限', icon: 'none' });
            } else {
              showError(err, '删除失败');
            }
          });
      },
    });
  },
});
