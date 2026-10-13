// pages/team/manage.js — 成员管理（login（队长），team-module §2.1-4 / §2.2）
// 接口：team/detail（头部信息 + 队长鉴权）、member-list（成员 status='active' / 已发邀请 status='invited'）、
//       apply-list（入队申请）、apply-handle、remove-member、transfer-captain
// 边界（§2.2）：满员禁用邀请与通过入口；通过失败（40901/40903）记录行内标记原因不打断列表；
//       40907 已被处理 → 刷新列表；移除二次确认+原因选填；转让后本人降为队员返回主页
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { TEAM_BIZ, RANKS } = require('../../utils/constants');
const { formatDate } = require('../../utils/format');

const PAGE_SIZE = 20;
const MEMBER_LIMIT = 100;    // R2 上限（与 shared.js MEMBER_LIMIT 对齐）
const COUNT_WARN_FROM = 97;  // §2.2 人数条预警线（97/100）

const RANK_NAME = {};
RANKS.forEach((r) => { RANK_NAME[r.key] = r.name; });

// Tab 三页（§2.1-4）：成员 / 入队申请 / 已发邀请（member-list 复用 status 区分）
const TAB_ACTION = { members: 'member-list', invites: 'member-list', applies: 'apply-list' };
const TAB_STATUS = { members: 'active', invites: 'invited', applies: 'applying' };

Page({
  data: {
    loading: true,
    failed: false,
    notFound: false, // 40401 → 统一「战队不存在或已解散」
    logged: true,
    forbidden: false, // 非队长（my_relation 校验，仅队长可进入）
    team: null,       // { name, logo, member_count }
    memberFull: false,
    countWarn: false, // ≥97 人数条预警（§2.2）
    activeTab: 'members',
    members: [],
    applies: [],
    invites: [],
    listLoading: false, // 当前 Tab 分页加载中
    tabFailed: false,   // 当前 Tab 首次加载失败
    acting: false,
  },

  onLoad(options) {
    this.teamId = options.team_id || '';
    this._tabLoading = false;
    this._tabState = {};
    ['members', 'applies', 'invites'].forEach((t) => {
      this._tabState[t] = { page: 1, finished: false, loaded: false };
    });
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false, logged: false });
        return;
      }
      this.userId = user.user_id;
      this.fetch();
    });
  },

  // 从 invite 页返回后轻刷（新邀请入列表）；静默，不打断已有内容
  onShow() {
    if (this._ready && this.data.logged && !this.data.notFound && !this.data.forbidden) {
      this.fetch(true);
      this.loadTab(this.data.activeTab, true);
    }
  },

  onReachBottom() {
    this.loadTab(this.data.activeTab, false);
  },

  async retryLogin() {
    const info = await getApp().silentLogin();
    if (info && info.user && info.user.user_id) {
      this.setData({ logged: true, loading: true });
      this.userId = info.user.user_id;
      this.fetch();
    } else {
      wx.showToast({ title: '登录失败，请稍后再试', icon: 'none' });
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/team/list' }) });
  },

  retry() {
    this.fetch();
  },

  // silent=true 静默刷新（不闪 loading、失败只 toast）
  fetch(silent) {
    if (!silent) this.setData({ loading: true, failed: false, notFound: false });
    return callCloud('team', 'detail', { team_id: this.teamId }).then((res) => {
      this._ready = true;
      const d = res.data || {};
      const t = d.team || {};
      const my = d.my_relation || {};
      if (!my.in_team || my.role !== 'captain') {
        this.setData({ loading: false, forbidden: true });
        return;
      }
      this.setData(Object.assign({
        loading: false,
        failed: false,
        notFound: false,
        forbidden: false,
        team: { name: t.name, logo: t.logo, member_count: t.member_count || 0 },
      }, this.applyCount(t.member_count || 0)));
      const st = this._tabState[this.data.activeTab];
      if (st && !st.loaded) this.loadTab(this.data.activeTab, true);
    }).catch((e) => {
      this._ready = true;
      if (e && e.code === TEAM_BIZ.TEAM_NOT_FOUND) {
        this.setData({ loading: false, notFound: true });
        return;
      }
      if (silent) {
        showError(e, '刷新失败，请稍后重试');
        return;
      }
      this.setData({ loading: false, failed: true });
      showError(e, '加载失败，请重试');
    });
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!this._tabState[tab] || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, tabFailed: false });
    const st = this._tabState[tab];
    if (!st.loaded) this.loadTab(tab, true);
  },

  retryTab() {
    this.loadTab(this.data.activeTab, true);
  },

  // reset=true 重置当前 Tab 第一页；member-list 附带 member_count → 同步人数条
  loadTab(tab, reset) {
    const st = this._tabState[tab];
    if (!st || this._tabLoading) return;
    if (!reset && st.finished) return;
    const page = reset ? 1 : st.page + 1;
    this._tabLoading = true;
    this.setData({ listLoading: true });
    callCloud('team', TAB_ACTION[tab], {
      team_id: this.teamId,
      status: TAB_STATUS[tab],
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const raw = d.list || [];
      st.page = page;
      st.finished = raw.length < PAGE_SIZE;
      st.loaded = true;
      const items = this.mapItems(tab, raw);
      const patch = { listLoading: false, tabFailed: false };
      patch[tab] = reset ? items : this.data[tab].concat(items);
      if (tab === 'members' || tab === 'invites') {
        if (typeof d.member_count === 'number') {
          patch.team = Object.assign({}, this.data.team, { member_count: d.member_count });
          Object.assign(patch, this.applyCount(d.member_count));
        }
      }
      this.setData(patch);
    }).catch((e) => {
      this.setData({ listLoading: false, tabFailed: !st.loaded });
      showError(e, '加载失败，请重试');
    }).then(() => {
      this._tabLoading = false;
    });
  },

  mapItems(tab, raw) {
    if (tab === 'applies') {
      return raw.map((r) => ({
        record_id: r.record_id,
        nickname: r.nickname || '会员',
        avatar: r.avatar || '',
        note: r.apply_note || '',
        applied_text: r.applied_at ? formatDate(r.applied_at) : '',
        failMsg: '',
      }));
    }
    return raw.map((m) => ({
      user_id: m.user_id,
      nickname: m.nickname || '会员',
      avatar: m.avatar || '',
      isCaptain: m.role === 'captain',
      rankName: RANK_NAME[m.rank] || '新兵',
      // invited 记录 joined_at 为空 → 状态查看文案
      joined_text: m.joined_at ? formatDate(m.joined_at) + ' 加入' : (tab === 'invites' ? '等待对方处理' : ''),
    }));
  },

  // 人数条三态（§2.2：普通 / 97+ 预警 / 满员）
  applyCount(count) {
    return {
      memberFull: count >= MEMBER_LIMIT,
      countWarn: count >= COUNT_WARN_FROM && count < MEMBER_LIMIT,
    };
  },

  goInvite() {
    if (this.data.memberFull) {
      wx.showToast({ title: '战队已满员（100/100）', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/team/invite?team_id=' + this.teamId });
  },

  // 移除队员（§2.2：二次确认 + 原因选填 ≤100；队长行无操作按钮）
  onRemove(e) {
    if (this.data.acting) return;
    const m = this.data.members[Number(e.currentTarget.dataset.index)];
    if (!m || m.isCaptain) return;
    wx.showModal({
      title: '移除队员',
      content: '移除后「' + m.nickname + '」将解除与本战队的关系，且 7 天内不可重新申请。',
      editable: true,
      placeholderText: '移除原因（选填，100 字内）',
      confirmText: '移除',
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim().slice(0, 100);
        this.setData({ acting: true });
        callCloud('team', 'remove-member', {
          team_id: this.teamId,
          target_user_id: m.user_id,
          reason: reason || null,
        }).then((r) => {
          wx.showToast({ title: '已移除', icon: 'success' });
          const count = (r.data || {}).member_count;
          const patch = typeof count === 'number' ? Object.assign({
            team: Object.assign({}, this.data.team, { member_count: count }),
          }, this.applyCount(count)) : {};
          this.setData(patch);
          this.loadTab('members', true);
        }).catch((err) => showError(err, '移除失败，请稍后重试'))
          .then(() => this.setData({ acting: false }));
      },
    });
  },

  // 转让队长（§2.2：二次确认；成功后本人降为队员，返回战队主页）
  onTransfer(e) {
    if (this.data.acting) return;
    const m = this.data.members[Number(e.currentTarget.dataset.index)];
    if (!m || m.isCaptain) return;
    wx.showModal({
      title: '转让队长',
      content: '将队长转让给「' + m.nickname + '」？转让后你将变为队员，此操作不可自助撤回。',
      confirmText: '确认转让',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ acting: true });
        callCloud('team', 'transfer-captain', {
          team_id: this.teamId,
          target_user_id: m.user_id,
        }).then(() => {
          wx.showToast({ title: '已转让队长', icon: 'success' });
          wx.navigateBack({
            fail: () => wx.redirectTo({ url: '/pages/team/detail?team_id=' + this.teamId }),
          });
        }).catch((err) => showError(err, '转让失败，请稍后重试'))
          .then(() => this.setData({ acting: false }));
      },
    });
  },

  onAcceptApply(e) {
    if (this.data.acting) return;
    if (this.data.memberFull) {
      wx.showToast({ title: '战队已满员（100/100）', icon: 'none' });
      return;
    }
    const idx = Number(e.currentTarget.dataset.index);
    const r = this.data.applies[idx];
    if (!r) return;
    wx.showModal({
      title: '通过申请',
      content: '通过后「' + r.nickname + '」将加入战队。',
      confirmText: '通过',
      success: (res) => {
        if (res.confirm) this.handleApply(idx, 'accept');
      },
    });
  },

  onRejectApply(e) {
    if (this.data.acting) return;
    const idx = Number(e.currentTarget.dataset.index);
    const r = this.data.applies[idx];
    if (!r) return;
    wx.showModal({
      title: '拒绝申请',
      content: '确定拒绝「' + r.nickname + '」的入队申请？',
      confirmText: '拒绝',
      confirmColor: '#B03030',
      success: (res) => {
        if (res.confirm) this.handleApply(idx, 'reject');
      },
    });
  },

  // 处理入队申请（§2.2：40901/40903 → 记录行内标记失败原因不打断列表；40907 → 刷新）
  handleApply(idx, operate) {
    const r = this.data.applies[idx];
    if (!r) return;
    this.setData({ acting: true });
    callCloud('team', 'apply-handle', {
      team_id: this.teamId,
      record_id: r.record_id,
      operate,
    }).then((res) => {
      wx.showToast({ title: operate === 'accept' ? '已通过' : '已拒绝', icon: 'success' });
      if (operate === 'accept') {
        const count = (res.data || {}).member_count;
        const patch = typeof count === 'number' ? Object.assign({
          team: Object.assign({}, this.data.team, { member_count: count }),
        }, this.applyCount(count)) : {};
        this.setData(patch);
      }
      this.loadTab('applies', true);
    }).catch((err) => {
      if (err && err.code === TEAM_BIZ.RECORD_HANDLED) {
        wx.showToast({ title: '该申请已被处理', icon: 'none' });
        this.loadTab('applies', true);
        return;
      }
      // 目标已入其他队（40901）/ 已满员（40903）：弹层提示 + 记录行内标记（§2.2）
      showError(err, '处理失败，请稍后重试');
      const patch = {};
      patch['applies[' + idx + '].failMsg'] = (err && err.msg) || '处理失败，请稍后重试';
      this.setData(patch);
    }).then(() => this.setData({ acting: false }));
  },
});
