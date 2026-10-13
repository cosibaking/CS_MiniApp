// pages/admin/user/detail.js — 用户详情（user-module §5.21-§5.24 / admin-module §2.3）
// 接口：user/adminDetail（只读）+ adminUpdateRole / adminSetStatus / adminAdjustCard（user_card_adjust 等）
// 权限点分按钮显隐：user_role_assign（角色）/ user_ban（封禁）/ user_card_adjust（调卡）
// 边界：§6.5 敏感操作二次确认；R13 调卡 remark/reason 必填（前端不发空请求）；
//       本人不可改自己的角色 / 封禁（后端 2010 硬校验，前端入口同步隐藏）
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { ROLE_NAMES } = require('../../../utils/constants');
const { formatTime } = require('../../../utils/format');

const CARD_STATUS_TEXT = { active: '生效中', expired: '已过期', voided: '已作废' };
const SOURCE_TEXT = { purchase: '购买', admin: '人工开卡' };
const WAIVER_TYPE_TEXT = { adult: '成人版', guardian: '监护人版' };

// 角色下拉取预置五角色；自定义角色原样追加展示
const PRESET_ROLE_KEYS = ['guest', 'member', 'captain', 'staff', 'admin'];

Page({
  data: {
    checking: true,
    noPermission: false,
    user_id: '',
    loading: false,
    failed: false,
    profile: null,
    cards: [],
    waivers: [],
    // 权限点（入口体验层；云函数侧硬校验）
    canRole: false,
    canBan: false,
    canCard: false,
    isSelf: false,
    showActions: false,
    // 角色下拉
    roleKeys: [],
    roleNames: [],
    roleIndex: 0,
    // 人工开卡表单
    grant: { visible: false, name: '', typeIndex: 0, times: '', months: '', remark: '' },
    grantTypes: [{ key: 'count', name: '次卡' }, { key: 'period', name: '期限卡' }],
    acting: false,
  },

  onLoad(options) {
    const userId = options.user_id || '';
    this.setData({ user_id: userId });
    requirePermission('user_manage').then((pass) => {
      const app = getApp();
      const info = app.globalData.userInfo;
      const meId = info && info.user && info.user.user_id;
      const canRole = app.hasPermission('user_role_assign');
      const canBan = app.hasPermission('user_ban');
      const canCard = app.hasPermission('user_card_adjust');
      const isSelf = !!meId && meId === userId;
      this.setData({
        checking: false,
        noPermission: !pass,
        canRole, canBan, canCard, isSelf,
        showActions: canCard || ((canRole || canBan) && !isSelf),
      });
      if (pass) this.loadDetail();
    });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  onRetry() {
    this.loadDetail();
  },

  // ---------- 数据加载 ----------
  loadDetail() {
    this.setData({ loading: true });
    callCloud('user', 'adminDetail', { user_id: this.data.user_id }).then((res) => {
      const d = res.data || {};
      const roleOpt = this.buildRoleOptions((d.profile && d.profile.role) || 'member');
      this.setData({
        loading: false,
        failed: false,
        profile: this.mapProfile(d.profile || {}),
        cards: (d.cards || []).map((c) => this.mapCard(c)),
        waivers: (d.waivers || []).map((w) => this.mapWaiver(w)),
        roleKeys: roleOpt.keys,
        roleNames: roleOpt.names,
        roleIndex: roleOpt.idx,
      });
    }).catch((e) => {
      this.setData({ loading: false, failed: true });
      showError(e, '详情加载失败，请重试');
    });
  },

  buildRoleOptions(currentRole) {
    const keys = PRESET_ROLE_KEYS.slice();
    const names = keys.map((k) => ROLE_NAMES[k] || k);
    let idx = keys.indexOf(currentRole);
    if (idx < 0) {
      keys.push(currentRole);
      names.push(currentRole + '（自定义）');
      idx = keys.length - 1;
    }
    return { keys, names, idx };
  },

  mapProfile(p) {
    return {
      user_id: p.user_id,
      nickname: p.nickname || '未命名',
      avatar_char: (p.nickname || '未命名').charAt(0),
      avatar: p.avatar || '',
      phone_text: p.phone || '未绑定',
      phone_owner_text: p.phone_owner === 'guardian' ? '（监护人号）' : '',
      role: p.role || 'member',
      role_text: ROLE_NAMES[p.role] || p.role || '会员',
      banned: p.status === 'banned',
      status_text: p.status === 'banned' ? '已封禁' : '正常',
      is_minor: !!p.is_minor,
      level_text: p.level ? (p.level_name ? p.level + ' ' + p.level_name : p.level) : '—',
      rank_name: p.rank_name || '—',
      total_games: p.total_games || 0,
      total_kills: p.total_kills || 0,
      total_wins: p.total_wins || 0,
      gender_text: p.gender === 1 ? '男' : p.gender === 2 ? '女' : '未知',
      birthday: p.birthday || '—',
      created_text: p.created_at ? formatTime(p.created_at) : '—',
      last_login_text: p.last_login_at ? formatTime(p.last_login_at) : '—',
    };
  },

  mapCard(c) {
    const isCount = c.card_type === 'count';
    return {
      card_id: c.card_id,
      card_name: c.card_name || '会员卡',
      card_type: c.card_type,
      is_count: isCount,
      times_text: isCount
        ? '剩余 ' + (c.remain_times || 0) + '/' + (c.total_times || 0) + ' 次（已用 ' + (c.used_times || 0) + '）'
        : '期限内常规活动免费',
      expire_text: c.expire_at ? formatTime(c.expire_at) : '—',
      status: c.status,
      status_text: CARD_STATUS_TEXT[c.status] || c.status,
      source_text: SOURCE_TEXT[c.source] || '',
      remark: c.remark || '',
      // 操作可见性（与后端口径一致：加次 count+active；延期非 voided；作废仅 active）
      can_add: isCount && c.status === 'active',
      can_extend: c.status === 'active' || c.status === 'expired',
      can_void: c.status === 'active',
    };
  },

  mapWaiver(w) {
    return {
      type_text: WAIVER_TYPE_TEXT[w.agreement_type] || w.agreement_type || '协议',
      version_text: w.agreement_version ? '版本 ' + w.agreement_version : '版本未知',
      signed_text: w.signed_at ? formatTime(w.signed_at) : '—',
    };
  },

  // ---------- 角色变更（user_role_assign） ----------
  onRoleChange(e) {
    if (this.data.acting) return;
    const idx = Number(e.detail.value);
    const role = this.data.roleKeys[idx];
    const p = this.data.profile;
    if (!role || !p || role === p.role) return;
    wx.showModal({
      title: '变更角色',
      content: '将「' + p.nickname + '」的角色从「' + p.role_text + '」变更为「' + this.data.roleNames[idx] + '」，操作将记入审计日志，确认执行？',
      confirmText: '确认变更',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ acting: true });
        callCloud('user', 'adminUpdateRole', { user_id: this.data.user_id, role })
          .then(() => {
            wx.showToast({ title: '已变更角色', icon: 'success' });
            this.loadDetail();
          })
          .catch((err) => showError(err, '操作失败，请稍后重试'))
          .then(() => this.setData({ acting: false }));
      },
    });
  },

  // ---------- 封禁 / 解封（user_ban） ----------
  onToggleBan() {
    if (this.data.acting) return;
    const p = this.data.profile;
    if (!p) return;
    if (p.banned) {
      wx.showModal({
        title: '解封账号',
        content: '将解除「' + p.nickname + '」的封禁，恢复其全部功能使用，确认执行？',
        confirmText: '确认解封',
        success: (res) => {
          if (res.confirm) this.setStatus('normal', null);
        },
      });
      return;
    }
    // 封禁：输入原因即确认（同 refund-audit 驳回的单弹窗模式；后端 reason 必填 §5.23）
    wx.showModal({
      title: '封禁账号',
      content: '封禁后「' + p.nickname + '」将无法登录与使用任何功能。请填写封禁原因（必填，≤200 字）。',
      editable: true,
      placeholderText: '封禁原因（必填，≤200 字）',
      confirmText: '确认封禁',
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '请填写封禁原因', icon: 'none' });
          return;
        }
        if (reason.length > 200) {
          wx.showToast({ title: '封禁原因不可超过 200 字', icon: 'none' });
          return;
        }
        this.setStatus('banned', reason);
      },
    });
  },

  setStatus(status, reason) {
    this.setData({ acting: true });
    callCloud('user', 'adminSetStatus', {
      user_id: this.data.user_id,
      status,
      reason: reason || null,
    }).then(() => {
      wx.showToast({ title: status === 'banned' ? '已封禁' : '已解封', icon: 'success' });
      this.loadDetail();
    }).catch((err) => showError(err, '操作失败，请稍后重试')).then(() => {
      this.setData({ acting: false });
    });
  },

  // ---------- 人工调卡（user_card_adjust） ----------
  // 加次：输入次数 → 二次确认 + 留痕备注（R13 remark 必填）
  onAddTimes(e) {
    if (this.data.acting) return;
    const card = this.data.cards[Number(e.currentTarget.dataset.index)];
    const p = this.data.profile;
    if (!card || !p) return;
    wx.showModal({
      title: '会员卡加次',
      content: '「' + card.card_name + '」当前剩余 ' + (card.remain_times || 0) + ' 次。请输入增加次数（正整数）。',
      editable: true,
      placeholderText: '增加次数（正整数）',
      success: (r1) => {
        if (!r1.confirm) return;
        const times = parseInt(r1.content, 10);
        if (!times || times <= 0) {
          wx.showToast({ title: '请输入正整数次数', icon: 'none' });
          return;
        }
        wx.showModal({
          title: '确认加次',
          content: '将为「' + p.nickname + '」的「' + card.card_name + '」增加 ' + times + ' 次（剩余 ' + (card.remain_times || 0) + ' → ' + ((card.remain_times || 0) + times) + '）。请填写操作备注（必填，≤200 字）。',
          editable: true,
          placeholderText: '操作备注（必填，≤200 字）',
          confirmText: '确认加次',
          success: (r2) => {
            if (!r2.confirm) return;
            const remark = String(r2.content || '').trim();
            if (!this.checkRemark(remark)) return;
            this.adjustCard({ adjust_type: 'add_times', card_id: card.card_id, times, remark });
          },
        });
      },
    });
  },

  // 延期：输入天数 → 二次确认 + 留痕备注（expired 卡续期即复活 R13 ⑤）
  onExtend(e) {
    if (this.data.acting) return;
    const card = this.data.cards[Number(e.currentTarget.dataset.index)];
    const p = this.data.profile;
    if (!card || !p) return;
    const reviveHint = card.status === 'expired' ? '该卡已过期，延期后自动恢复生效。' : '';
    wx.showModal({
      title: '会员卡延期',
      content: '「' + card.card_name + '」当前有效期至 ' + card.expire_text + '。' + reviveHint + '请输入延长天数（正整数自然日）。',
      editable: true,
      placeholderText: '延长天数（正整数）',
      success: (r1) => {
        if (!r1.confirm) return;
        const days = parseInt(r1.content, 10);
        if (!days || days <= 0) {
          wx.showToast({ title: '请输入正整数天数', icon: 'none' });
          return;
        }
        wx.showModal({
          title: '确认延期',
          content: '将为「' + p.nickname + '」的「' + card.card_name + '」延长 ' + days + ' 天。请填写操作备注（必填，≤200 字）。',
          editable: true,
          placeholderText: '操作备注（必填，≤200 字）',
          confirmText: '确认延期',
          success: (r2) => {
            if (!r2.confirm) return;
            const remark = String(r2.content || '').trim();
            if (!this.checkRemark(remark)) return;
            this.adjustCard({ adjust_type: 'extend', card_id: card.card_id, days, remark });
          },
        });
      },
    });
  },

  // 作废：填原因 → 二次确认（不可恢复）
  onVoid(e) {
    if (this.data.acting) return;
    const card = this.data.cards[Number(e.currentTarget.dataset.index)];
    const p = this.data.profile;
    if (!card || !p) return;
    wx.showModal({
      title: '作废会员卡',
      content: '作废后「' + card.card_name + '」立即失效且不可恢复。请填写作废原因（必填，≤200 字）。',
      editable: true,
      placeholderText: '作废原因（必填，≤200 字）',
      confirmText: '下一步',
      confirmColor: '#B03030',
      success: (r1) => {
        if (!r1.confirm) return;
        const reason = String(r1.content || '').trim();
        if (!this.checkRemark(reason, '作废原因')) return;
        wx.showModal({
          title: '二次确认',
          content: '确认作废「' + p.nickname + '」的「' + card.card_name + '」？该操作将记入审计日志且不可恢复。',
          confirmText: '确认作废',
          confirmColor: '#B03030',
          success: (r2) => {
            if (r2.confirm) this.adjustCard({ adjust_type: 'void', card_id: card.card_id, reason });
          },
        });
      },
    });
  },

  checkRemark(text, label) {
    if (!text) {
      wx.showToast({ title: (label || '备注') + '不可为空', icon: 'none' });
      return false;
    }
    if (text.length > 200) {
      wx.showToast({ title: (label || '备注') + '不可超过 200 字', icon: 'none' });
      return false;
    }
    return true;
  },

  adjustCard(payload) {
    this.setData({ acting: true });
    callCloud('user', 'adminAdjustCard', Object.assign({ user_id: this.data.user_id }, payload))
      .then(() => {
        wx.showToast({ title: '操作成功', icon: 'success' });
        this.loadDetail();
      })
      .catch((err) => showError(err, '操作失败，请稍后重试'))
      .then(() => this.setData({ acting: false }));
  },

  // ---------- 人工开卡表单（grant，R13 ①：source=admin / price=null） ----------
  onToggleGrant() {
    this.setData({ 'grant.visible': !this.data.grant.visible });
  },

  onGrantInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch['grant.' + field] = e.detail.value;
    this.setData(patch);
  },

  onGrantTypeChange(e) {
    this.setData({ 'grant.typeIndex': Number(e.detail.value) });
  },

  onGrantSubmit() {
    if (this.data.acting) return;
    const g = this.data.grant;
    const type = this.data.grantTypes[g.typeIndex].key;
    const p = this.data.profile;
    if (!p) return;
    const name = g.name.trim();
    const remark = g.remark.trim();
    if (!name || name.length > 50) {
      wx.showToast({ title: '请填写卡名称（≤50 字）', icon: 'none' });
      return;
    }
    let extra = {};
    let typeDesc = '';
    if (type === 'count') {
      const times = parseInt(g.times, 10);
      if (!times || times <= 0) {
        wx.showToast({ title: '请填写次数（正整数）', icon: 'none' });
        return;
      }
      extra = { times, valid_months: 12 }; // 次卡有效期默认 12 个月（R7）
      typeDesc = '次卡 ' + times + ' 次（12 个月有效）';
    } else {
      const months = parseInt(g.months, 10);
      if (!months || months <= 0) {
        wx.showToast({ title: '请填写期限月数（正整数）', icon: 'none' });
        return;
      }
      extra = { period_months: months };
      typeDesc = '期限卡 ' + months + ' 个月';
    }
    if (!this.checkRemark(remark)) return;
    wx.showModal({
      title: '确认开卡',
      content: '将为「' + p.nickname + '」人工开通「' + name + '」（' + typeDesc + '），不产生支付流水。请确认执行。',
      confirmText: '确认开卡',
      success: (res) => {
        if (!res.confirm) return;
        this.adjustCard(Object.assign({
          adjust_type: 'grant',
          card_name: name,
          card_type: type,
          remark,
        }, extra));
        this.resetGrantForm();
      },
    });
  },

  resetGrantForm() {
    this.setData({ grant: { visible: false, name: '', typeIndex: 0, times: '', months: '', remark: '' } });
  },
});
