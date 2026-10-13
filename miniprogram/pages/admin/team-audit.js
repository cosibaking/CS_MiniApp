// pages/admin/team-audit.js — 战队审核（team-module §2.1-10 / §2.2 / §5.15-§5.16）
// 接口：team/audit-list（pending/rejected 分 Tab）、team/audit（approve/reject）
// 边界（§2.2）：待审核空态「暂无待审核战队」；拒绝理由必填 2~100 字（前端校验不发空请求）；
//       40907 已被处理 → 刷新列表；40901（通过时创建人已在他队）等失败 → 行内标记原因不打断列表
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { TEAM_BIZ } = require('../../utils/constants');
const { formatDate } = require('../../utils/format');

const PAGE_SIZE = 20;

Page({
  data: {
    checking: true,       // 权限预检中
    noPermission: false,  // audit_team 门控（入口体验层；云函数侧 checkPermission 硬校验）
    activeTab: 'pending', // pending 待审核 / rejected 已拒绝
    pending: [],
    rejected: [],
    listLoading: false,
    tabFailed: false,
    acting: false,
  },

  onLoad() {
    this._tabLoading = false;
    this._tabState = {};
    ['pending', 'rejected'].forEach((t) => {
      this._tabState[t] = { page: 1, finished: false, loaded: false };
    });
    requirePermission('audit_team').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadTab('pending', true);
    });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  onReachBottom() {
    this.loadTab(this.data.activeTab, false);
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!this._tabState[tab] || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, tabFailed: false });
    if (!this._tabState[tab].loaded) this.loadTab(tab, true);
  },

  retryTab() {
    this.loadTab(this.data.activeTab, true);
  },

  // reset=true 重置当前 Tab 第一页（audit-list：status 分 Tab 查询，§5.16）
  loadTab(tab, reset) {
    const st = this._tabState[tab];
    if (!st || this._tabLoading) return;
    if (!reset && st.finished) return;
    const page = reset ? 1 : st.page + 1;
    this._tabLoading = true;
    this.setData({ listLoading: true });
    callCloud('team', 'audit-list', {
      status: tab,
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((t) => this.mapItem(t));
      st.page = page;
      st.finished = items.length < PAGE_SIZE;
      st.loaded = true;
      const patch = { listLoading: false, tabFailed: false };
      patch[tab] = reset ? items : this.data[tab].concat(items);
      this.setData(patch);
    }).catch((e) => {
      this.setData({ listLoading: false, tabFailed: !st.loaded });
      showError(e, '列表加载失败，请重试');
    }).then(() => {
      this._tabLoading = false;
    });
  },

  mapItem(t) {
    const c = t.creator || {};
    return {
      team_id: t.team_id,
      name: t.name || '未命名战队',
      logo: t.logo || '',
      slogan: t.slogan || '',
      intro: t.intro || '',
      creator_name: c.nickname || '会员',
      creator_phone: c.phone || '',
      created_text: t.created_at ? formatDate(t.created_at) + ' 提交' : '',
      audit_text: t.audit_at ? formatDate(t.audit_at) + ' 审核' : '',
      reject_reason: t.reject_reason || '',
      failMsg: '',
    };
  },

  // 通过（§5.15：审核生效事务 CP-6；通过后战队立即生效，创建人成为队长）
  onApprove(e) {
    if (this.data.acting) return;
    const idx = Number(e.currentTarget.dataset.index);
    const t = this.data.pending[idx];
    if (!t) return;
    wx.showModal({
      title: '通过审核',
      content: '通过后「' + t.name + '」立即生效，创建人「' + t.creator_name + '」成为队长。',
      confirmText: '通过',
      success: (res) => {
        if (res.confirm) this.handleAudit(idx, 'approve', null);
      },
    });
  },

  // 拒绝（§2.2：理由必填 2~100 字；创建人收到附理由的通知）
  onReject(e) {
    if (this.data.acting) return;
    const idx = Number(e.currentTarget.dataset.index);
    const t = this.data.pending[idx];
    if (!t) return;
    wx.showModal({
      title: '拒绝审核',
      content: '拒绝后创建人需修改信息重新提交。',
      editable: true,
      placeholderText: '拒绝理由（必填，2~100 字）',
      confirmText: '拒绝',
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim();
        if (reason.length < 2 || reason.length > 100) {
          wx.showToast({ title: '拒绝理由需为 2~100 字', icon: 'none' });
          return;
        }
        this.handleAudit(idx, 'reject', reason);
      },
    });
  },

  // 执行审核（§2.2：40907 已被处理 → 刷新；其余失败行内标记不打断列表）
  handleAudit(idx, operate, reason) {
    const t = this.data.pending[idx];
    if (!t) return;
    this.setData({ acting: true });
    callCloud('team', 'audit', {
      team_id: t.team_id,
      operate,
      reject_reason: reason || null,
    }).then(() => {
      wx.showToast({ title: operate === 'approve' ? '已通过' : '已拒绝', icon: 'success' });
      this.refreshAfterAudit();
    }).catch((err) => {
      if (err && err.code === TEAM_BIZ.RECORD_HANDLED) {
        wx.showToast({ title: '该战队已被处理', icon: 'none' });
        this.refreshAfterAudit();
      } else {
        // 40901（通过时创建人已在他队）等：行内标记失败原因（§2.2）
        showError(err, '操作失败，请稍后重试');
        const patch = {};
        patch['pending[' + idx + '].failMsg'] = (err && err.msg) || '操作失败，请稍后重试';
        this.setData(patch);
      }
    }).then(() => this.setData({ acting: false }));
  },

  // 审核落定后：重取待审核列表；已拒绝 Tab 标记待重取（条目会迁移过来）
  refreshAfterAudit() {
    const st = this._tabState.rejected;
    if (st) st.loaded = false;
    if (this.data.activeTab === 'pending') {
      this.loadTab('pending', true);
    } else if (st) {
      this.loadTab('rejected', true);
    }
  },
});
