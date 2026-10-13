// pages/admin/role-edit.js — 角色编辑（admin-module §2.2-3，新建/编辑双模式）
// 接口：admin/permission/list（权限点总表分组勾选）、admin/role/detail（编辑回显）、
//       admin/role/create（新建）、admin/role/update（乐观锁 base_updated_at，5007 冲突提示刷新）
// 预置角色：标识不可改（编辑模式只读展示）；admin 角色的 * 通配为固有配置，锁定不可取消
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { CODE, ADMIN_BIZ } = require('../../utils/constants');

// 模块分组中文名（permission/list 出参 module_group 为英文 key）
const GROUP_LABEL = {
  activity: '活动运营',
  team: '战队',
  user: '用户',
  order: '订单',
  admin: '管理',
};

const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;

Page({
  data: {
    checking: true,
    noPermission: false,
    mode: 'create',          // create | edit
    loading: false,          // 编辑模式详情加载中
    roleKey: '',             // 编辑模式固定标识
    inputKey: '',            // 新建模式输入标识
    name: '',
    description: '',
    groups: [],              // [{ label, points: [{ key, name, desc, checked, locked }] }]
    selected: [],            // 权限点数组（提交口径）
    isPreset: false,
    userCount: 0,
    baseUpdatedAt: 0,        // 乐观锁基准（role/detail updated_at）
    saving: false,
  },

  onLoad(options) {
    const roleKey = options.role_key || '';
    const mode = roleKey ? 'edit' : 'create';
    this.setData({ mode, roleKey });
    wx.setNavigationBarTitle({ title: mode === 'edit' ? '编辑角色' : '新建角色' });
    requirePermission('role_manage').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadData();
    });
  },

  loadData() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    // 编辑模式并行拉详情 + 权限总表；新建模式只拉权限总表
    const tasks = [
      callCloud('admin', 'permission/list', {}),
      this.data.mode === 'edit'
        ? callCloud('admin', 'role/detail', { role_key: this.data.roleKey })
        : Promise.resolve(null),
    ];
    Promise.all(tasks)
      .then(([permRes, detailRes]) => {
        const detail = detailRes ? detailRes.data : null;
        // admin 角色的 * 固有（R15：role_manage 界面不向普通角色开放勾选 *，仅预置 admin 固有）
        const lockWildcard = !!detail && detail.role_key === 'admin';
        const selected = detail ? (detail.permissions || []) : [];
        // 缓存原始总表，勾选切换时本地 rebuild（避免重复请求）
        this._rawPermGroups = permRes.data.groups || [];
        const groups = this.buildGroups(this._rawPermGroups, selected, lockWildcard);
        this.setData({
          loading: false,
          groups,
          selected,
          lockWildcard,
          name: detail ? detail.name : '',
          description: detail ? (detail.description || '') : '',
          isPreset: detail ? !!detail.is_preset : false,
          userCount: detail ? detail.user_count || 0 : 0,
          baseUpdatedAt: detail ? detail.updated_at : 0,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        showError(e, '数据加载失败');
      });
  },

  // 权限总表 → 分组勾选视图（status 非 enabled 的点不渲染）
  buildGroups(rawGroups, selected, lockWildcard) {
    return rawGroups.map((g) => ({
      label: GROUP_LABEL[g.module_group] || g.module_group,
      points: (g.points || [])
        .filter((p) => (p.status || 'enabled') === 'enabled')
        .map((p) => ({
          key: p.key,
          name: p.name,
          desc: p.description || p.name,
          checked: selected.includes(p.key),
          locked: lockWildcard && p.key === '*',
        })),
    }));
  },

  onKeyInput(e) {
    this.setData({ inputKey: e.detail.value });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value });
  },

  // 勾选/取消权限点（locked：admin 的 * 固有）
  togglePerm(e) {
    const { key, locked } = e.currentTarget.dataset;
    if (locked) {
      wx.showToast({ title: 'admin 全权限为固有配置', icon: 'none' });
      return;
    }
    let selected = this.data.selected.slice();
    const i = selected.indexOf(key);
    if (i >= 0) selected.splice(i, 1);
    else selected.push(key);
    const groups = this.buildGroups(this._rawPermGroups || [], selected, this.data.lockWildcard);
    this.setData({ selected, groups });
  },

  // 保存（新建/编辑）
  onSave() {
    if (this.data.saving) return;
    const { mode, name, description, selected } = this.data;

    if (!name || !name.trim()) {
      wx.showToast({ title: '请输入角色名称', icon: 'none' });
      return;
    }
    if (selected.length === 0) {
      wx.showToast({ title: '请至少勾选一个权限点', icon: 'none' });
      return;
    }
    let payload;
    if (mode === 'create') {
      const roleKey = (this.data.inputKey || '').trim();
      if (!ROLE_KEY_RE.test(roleKey)) {
        wx.showToast({ title: '标识需以小写字母开头，可含数字/下划线（2-31位）', icon: 'none' });
        return;
      }
      payload = { role_key: roleKey, name: name.trim(), permissions: selected, description: description.trim() };
    } else {
      payload = {
        role_key: this.data.roleKey,
        name: name.trim(),
        permissions: selected,
        description: description.trim(),
        base_updated_at: this.data.baseUpdatedAt,
      };
    }

    this.setData({ saving: true });
    const action = mode === 'create' ? 'role/create' : 'role/update';
    callCloud('admin', action, payload)
      .then(() => {
        wx.showToast({ title: mode === 'create' ? '已创建' : '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((e) => {
        this.setData({ saving: false });
        // 5007 乐观锁冲突：提示后重新拉取最新配置
        if (e.code === ADMIN_BIZ.OPTIMISTIC_LOCK) {
          wx.showModal({
            title: '配置已变更',
            content: '该角色已被他人修改，请基于最新配置重新调整后保存。',
            showCancel: false,
            success: () => this.loadData(),
          });
        } else if (e.code === ADMIN_BIZ.DUP_ROLE || e.code === ADMIN_BIZ.UNREGISTERED_PERM || e.code === ADMIN_BIZ.PRESET_PROTECTED) {
          wx.showToast({ title: e.msg || '保存失败', icon: 'none' });
        } else if (e.code === CODE.FORBIDDEN) {
          wx.showToast({ title: '无权限', icon: 'none' });
        } else {
          showError(e, '保存失败');
        }
      });
  },
});
