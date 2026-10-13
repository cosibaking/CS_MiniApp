// pages/team/detail.js — 战队主页（team-module §2.1-3 / §2.2）
// 接口：team/detail、team/join-apply（申请加入）、team/quit（队员退出）、
//       team/invite-handle（处理收到的邀请，NEW_INVITE 通知直达本页）、
//       team/my（定位本队邀请记录 record_id）
// 视角（my_relation）：队长→管理战队；队员→退出；applying→等待处理；invited→接受/拒绝；
//       其余（含被移除/已退出，§2.2）→ 申请加入（R10 冷却由后端 40904 兜底）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { TEAM_BIZ, RANKS } = require('../../utils/constants');
const { formatDate } = require('../../utils/format');

const MEMBER_LIMIT = 100; // R2 上限（与 shared.js MEMBER_LIMIT 对齐）

const RANK_NAME = {};
RANKS.forEach((r) => { RANK_NAME[r.key] = r.name; });

// win_rate 为 0~1 小数（§6.2 保留 4 位）→ 百分比
function winRateText(wr) {
  if (wr === null || wr === undefined) return '--';
  return Math.round(wr * 100) + '%';
}

Page({
  data: {
    loading: true,
    failed: false,
    notFound: false, // 40401 → 统一「战队不存在或已解散」
    logged: true,
    team: null,
    pendingBanner: false, // 创建者视角：审核中横幅（§2.2）
    rejectReason: null,   // 创建者视角：被拒横幅 + 重提入口
    stats: null,
    members: [],          // members_preview（队长置顶，≤10）
    memberFull: false,
    inTeam: false,
    isCaptain: false,
    memberStatus: null,   // !in_team 时：applying / invited / quit / removed / …
    acting: false,
  },

  onLoad(options) {
    this.teamId = options.team_id || '';
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false, logged: false });
        return;
      }
      this.userId = user.user_id;
      this.fetch();
    });
  },

  // 从 manage 返回后轻刷（静默，不闪 loading）
  onShow() {
    if (this._ready && this.data.logged && !this.data.notFound) this.fetch(true);
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

  // silent=true 静默刷新（不闪 loading、失败不打断已有内容）
  fetch(silent) {
    if (!silent) this.setData({ loading: true, failed: false, notFound: false });
    return callCloud('team', 'detail', { team_id: this.teamId }).then((res) => {
      this._ready = true;
      const d = res.data || {};
      const t = d.team || {};
      const my = d.my_relation || {};
      const isCreator = t.captain_user_id === this.userId;
      const stats = d.stats || null;
      const members = (d.members_preview || []).map((m) => ({
        user_id: m.user_id,
        nickname: m.nickname || '会员',
        avatar: m.avatar || '',
        isCaptain: m.role === 'captain',
        rankName: RANK_NAME[m.rank] || '新兵',
        joined_text: m.joined_at ? formatDate(m.joined_at) : '',
      }));
      this.setData({
        loading: false,
        failed: false,
        notFound: false,
        team: {
          team_id: t.team_id,
          name: t.name,
          logo: t.logo,
          slogan: t.slogan || '',
          intro: t.intro || '',
          member_count: t.member_count || 0,
          status: t.status,
          created_text: t.created_at ? formatDate(t.created_at) : '',
        },
        pendingBanner: t.status === 'pending' && isCreator,
        rejectReason: t.status === 'rejected' && isCreator ? (t.reject_reason || '未通过审核') : null,
        stats: stats ? {
          total_games: stats.total_games || 0,
          wins: stats.wins || 0,
          win_rate_text: winRateText(stats.win_rate),
          participated_members: stats.participated_members || 0,
        } : null,
        members,
        memberFull: (t.member_count || 0) >= MEMBER_LIMIT,
        inTeam: !!my.in_team,
        isCaptain: !!my.in_team && my.role === 'captain',
        memberStatus: my.in_team ? null : my.member_status,
      });
      // 被邀请人（NEW_INVITE 通知直达本页）：定位本队邀请记录供「接受/拒绝」
      if (!my.in_team && my.member_status === 'invited') this.loadInviteRecord();
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

  // 被邀请人：从 team/my invited 列表匹配本队记录
  loadInviteRecord() {
    callCloud('team', 'my', {}).then((res) => {
      const rec = ((res.data || {}).invited || []).find((r) => r.team_id === this.teamId);
      this.inviteRecordId = rec ? rec.record_id : null;
    }).catch(() => { /* 静默，接受时兜底提示 */ });
  },

  goManage() {
    wx.navigateTo({ url: '/pages/team/manage?team_id=' + this.teamId });
  },

  // R1 被拒重提：create 页经 team/my 自动回填原资料
  goResubmit() {
    wx.navigateTo({ url: '/pages/team/create' });
  },

  // 非成员：申请加入（留言选填 ≤100，§5.6；40901/40903/40904 由后端校验 toast）
  onApplyJoin() {
    if (this.data.acting || this.data.memberFull) return;
    const team = this.data.team;
    wx.showModal({
      title: '申请加入',
      content: '确定申请加入「' + team.name + '」？',
      editable: true,
      placeholderText: '给队长留言（选填，100 字内）',
      confirmText: '提交申请',
      success: (res) => {
        if (!res.confirm) return;
        const note = String(res.content || '').trim().slice(0, 100);
        this.setData({ acting: true });
        callCloud('team', 'join-apply', { team_id: this.teamId, apply_note: note || null })
          .then(() => {
            wx.showToast({ title: '申请已提交', icon: 'success' });
            this.fetch(true);
          })
          .catch((e) => showError(e, '提交失败，请稍后重试'))
          .then(() => this.setData({ acting: false }));
      },
    });
  },

  // 在职队员：退出战队（队长不可直接退出，40910 由后端提示，§5.13）
  onQuit() {
    if (this.data.acting) return;
    wx.showModal({
      title: '退出战队',
      content: '退出后需重新申请才能加入（被拒或移除后 7 天内不可重新申请），确定退出？',
      confirmText: '退出',
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ acting: true });
        callCloud('team', 'quit', { team_id: this.teamId })
          .then(() => {
            wx.showToast({ title: '已退出战队', icon: 'success' });
            this.fetch(true);
          })
          .catch((e) => showError(e, '退出失败，请稍后重试'))
          .then(() => this.setData({ acting: false }));
      },
    });
  },

  onAcceptInvite() {
    if (this.data.acting) return;
    this.handleInvite('accept');
  },

  onRejectInvite() {
    if (this.data.acting) return;
    wx.showModal({
      title: '拒绝邀请',
      content: '确定拒绝加入「' + this.data.team.name + '」？',
      success: (res) => {
        if (res.confirm) this.handleInvite('reject');
      },
    });
  },

  // 被邀请人处理邀请（§5.10：接受即入队事务，拒绝置 invite_rejected）
  handleInvite(operate) {
    if (!this.inviteRecordId) {
      wx.showToast({ title: '邀请记录加载中，请稍后重试', icon: 'none' });
      this.loadInviteRecord();
      return;
    }
    this.setData({ acting: true });
    callCloud('team', 'invite-handle', { record_id: this.inviteRecordId, operate })
      .then(() => {
        wx.showToast({ title: operate === 'accept' ? '已加入战队' : '已拒绝邀请', icon: 'success' });
        this.fetch(true);
      })
      .catch((e) => showError(e, '操作失败，请稍后重试'))
      .then(() => this.setData({ acting: false }));
  },
});
