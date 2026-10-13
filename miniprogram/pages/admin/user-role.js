// pages/admin/user-role.js — 用户角色授权（admin-module §2.2-4 / §2.4）
// 接口：admin/user/role-list（搜索/角色筛选，分页 20/页）、admin/role/list（角色 chips/选择弹层）、
//       admin/user/grant-role、user/revoke-role（撤销回退 member；操作成功提示已记入操作日志）
// 保护：5008 不能操作本人、5003 角色不存在、5006 最后管理员、5016 用户不存在
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');
const { CODE, ADMIN_BIZ } = require('../../utils/constants');

const PAGE_SIZE = 20;

Page({
  data: {
    checking: true,
    noPermission: false,
    keyword: '',
    activeRole: '',           // '' = 全部
    roles: [],                // [{ role_key, name, user_count }]
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
    listLoading: false,
    firstLoaded: false,
    // 角色选择弹层（showActionSheet 有 6 项上限，自绘弹层）
    showRoleSheet: false,
    sheetUser: null,          // { user_id, nickname, role }
    sheetRoles: [],           // 排除用户当前角色的候选列表
  },

  onLoad(options) {
    requirePermission('user_role_assign').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (!pass) return;
      // 角色筛选 chips + 用户首屏并行加载；支持 URL 参数 role_key 预置筛选
      const presetRole = options && options.role_key ? options.role_key : '';
      this.setData({ activeRole: presetRole });
      this.loadRoles();
      this.loadUsers(true, presetRole);
    });
  },

  // 角色列表（chips + 授权弹层共用；role/list 权限为 role_manage/user_role_assign 任一）
  loadRoles() {
    callCloud('admin', 'role/list', {})
      .then((res) => {
        this.setData({
          roles: (res.data.list || []).map((r) => ({
            role_key: r.role_key,
            name: r.name,
            user_count: r.user_count || 0,
          })),
        });
      })
      .catch((e) => console.warn('[user-role] 角色列表加载失败', e));
  },

  // 用户列表（reset=true 重新搜索；否则翻页追加）
  loadUsers(reset, roleKey, page) {
    if (this.data.listLoading) return;
    const p = reset ? 1 : (page || this.data.page + 1);
    const payload = {
      page: p,
      page_size: PAGE_SIZE,
    };
    const role = roleKey !== undefined ? roleKey : this.data.activeRole;
    if (role) payload.role_key = role;
    const kw = (this.data.keyword || '').trim();
    if (kw) payload.keyword = kw;

    this.setData({ listLoading: true });
    callCloud('admin', 'user/role-list', payload)
      .then((res) => {
        const d = res.data;
        const items = (d.list || []).map((u) => ({
          user_id: u.user_id,
          nickname: u.nickname || '会员',
          avatar: u.avatar || '',
          phone: u.phone || '',
          role: u.role || 'member',
          role_name: u.role_name,
          is_banned: u.status === 'banned',
          created_text: formatTime(u.created_at),
          role_updated_text: u.role_updated_at ? formatTime(u.role_updated_at) : '',
        }));
        const list = reset ? items : this.data.list.concat(items);
        this.setData({
          list,
          total: d.total || 0,
          page: p,
          hasMore: list.length < (d.total || 0),
          listLoading: false,
          firstLoaded: true,
        });
      })
      .catch((e) => {
        this.setData({ listLoading: false, firstLoaded: true });
        showError(e, '用户列表加载失败');
      });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.listLoading) this.loadUsers(false);
  },

  // ---------- 搜索 / 筛选 ----------
  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadUsers(true, undefined, 1);
  },

  onPickRole(e) {
    const key = e.currentTarget.dataset.key || '';
    if (key === this.data.activeRole) return;
    this.setData({ activeRole: key });
    this.loadUsers(true, key, 1);
  },

  // ---------- 授权 / 撤销 ----------
  // 打开角色选择弹层（排除当前角色，避免同值幂等歧义）
  onOpenSheet(e) {
    const user = this.data.list[e.currentTarget.dataset.index];
    if (!user) return;
    if (user.is_banned) {
      wx.showToast({ title: '该账号已被封禁', icon: 'none' });
      return;
    }
    const sheetRoles = this.data.roles.filter((r) => r.role_key !== user.role);
    if (!sheetRoles.length) {
      wx.showToast({ title: '暂无可分配的其他角色', icon: 'none' });
      return;
    }
    this.setData({ showRoleSheet: true, sheetUser: user, sheetRoles });
  },

  onCloseSheet() {
    this.setData({ showRoleSheet: false, sheetUser: null });
  },

  // 阻止弹层内容区点击冒泡关闭
  noop() {},

  // 授予角色（role.grant 日志由云函数侧埋点）
  onGrant(e) {
    const roleKey = e.currentTarget.dataset.key;
    const role = this.data.sheetRoles.find((r) => r.role_key === roleKey);
    const user = this.data.sheetUser;
    if (!role || !user) return;
    callCloud('admin', 'user/grant-role', { user_id: user.user_id, role_key: roleKey })
      .then((res) => {
        this.onCloseSheet();
        wx.showToast({ title: `已设为「${res.data.role_name}」，已记入操作日志`, icon: 'none' });
        // 刷新列表（当前角色筛选下该用户可能移出）+ 角色计数
        this.loadUsers(true, undefined, 1);
        this.loadRoles();
      })
      .catch((err) => this.handleGrantError(err));
  },

  // 撤销角色（回退 member；5006 最后管理员保护）
  onRevoke(e) {
    const user = this.data.list[e.currentTarget.dataset.index];
    if (!user || user.is_banned) return;
    wx.showModal({
      title: '撤销角色',
      content: `将「${user.nickname}」的角色撤销并回退为会员？该操作将记入操作日志。`,
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        callCloud('admin', 'user/revoke-role', { user_id: user.user_id })
          .then(() => {
            wx.showToast({ title: '已撤销，回退为会员（已记入操作日志）', icon: 'none' });
            this.loadUsers(true, undefined, 1);
            this.loadRoles();
          })
          .catch((err) => this.handleGrantError(err));
      },
    });
  },

  // grant/revoke 业务错误统一处理（5008 本人/5003 角色/5006 最后管理员/5016 用户不存在）
  handleGrantError(err) {
    if (err.code === ADMIN_BIZ.SELF_OPERATION) {
      wx.showToast({ title: '不能对本人执行该操作', icon: 'none' });
    } else if (err.code === ADMIN_BIZ.LAST_ADMIN) {
      wx.showModal({ title: '无法撤销', content: '系统需保留至少一名管理员。', showCancel: false });
    } else if (err.code === ADMIN_BIZ.ROLE_NOT_FOUND || err.code === ADMIN_BIZ.NOT_FOUND) {
      wx.showModal({ title: '操作失败', content: err.msg || '角色或用户不存在，请刷新后重试', showCancel: false });
    } else if (err.code === CODE.UNAUTHORIZED) {
      wx.showModal({ title: '操作失败', content: '该账号已被封禁或登录态失效。', showCancel: false });
    } else if (err.code === CODE.FORBIDDEN) {
      wx.showToast({ title: '无权限', icon: 'none' });
    } else {
      showError(err, '操作失败');
    }
  },
});
