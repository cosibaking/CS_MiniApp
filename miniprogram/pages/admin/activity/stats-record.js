// pages/admin/activity/stats-record.js — 战绩录入（record_stats，activity-module §5.23/§3.9）
// 接口：activity/statsCandidates（选人，仅已签到）、activity/recordStats（upsert + 荣誉重评定 + 军衔重算）
// 批量导入入口：/pages/admin/import-excel?biz_id=<activity_id>（§5.24 importStats）
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');

const FIELDS = ['kills', 'deaths', 'heals', 'supplies', 'captures'];
const HONOR_LABELS = {
  mvp: 'MVP', svp: 'SVP',
  best_heal: '最佳治疗', best_supply: '最佳补给', best_capture: '最佳占领',
};

Page({
  data: {
    activityId: '',
    noPermission: false,
    // 选人
    candidates: [],
    candNames: [],
    pickIndex: -1,
    userId: '',
    // 表单（六项：五数值 + 胜负）
    kills: '0',
    deaths: '0',
    heals: '0',
    supplies: '0',
    captures: '0',
    isWin: true,
    submitting: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({ activityId: options.id || '' });
    // 战绩列表「修改」入口携带的预填参数（recordStats 为 upsert，覆盖同一 user_id）
    if (options.user_id) {
      this._prefill = {
        user_id: options.user_id,
        kills: Number(options.kills) || 0,
        deaths: Number(options.deaths) || 0,
        heals: Number(options.heals) || 0,
        supplies: Number(options.supplies) || 0,
        captures: Number(options.captures) || 0,
        is_win: options.is_win !== '0',
      };
    }
    requirePermission('record_stats').then((pass) => {
      this.setData({ noPermission: !pass });
      if (!pass) return;
      this.loadCandidates();
    });
  },

  onPullDownRefresh() {
    this.loadCandidates().finally(() => wx.stopPullDownRefresh());
  },

  loadCandidates() {
    return callCloud('activity', 'statsCandidates', { activity_id: this.data.activityId })
      .then((res) => {
        const d = res.data || {};
        const candidates = d.list || [];
        // 应用预填：定位被改会员并回填数值（不在名单时仍锁定 user_id，保证覆盖正确）
        const pre = this._prefill;
        let idx = -1;
        const patch = {};
        if (pre) {
          this._prefill = null;
          idx = candidates.findIndex((c) => c.user_id === pre.user_id);
          patch.kills = String(pre.kills);
          patch.deaths = String(pre.deaths);
          patch.heals = String(pre.heals);
          patch.supplies = String(pre.supplies);
          patch.captures = String(pre.captures);
          patch.isWin = pre.is_win;
        }
        this.setData(Object.assign({
          candidates,
          candNames: candidates.map((c) => c.nickname || '未设置昵称'),
          pickIndex: idx,
          userId: idx >= 0 ? candidates[idx].user_id : (pre ? pre.user_id : ''),
        }, patch));
      })
      .catch((err) => showError(err, '选人名单加载失败，下拉重试'));
  },

  // ---------- 选人 ----------
  onPickChange(e) {
    const idx = Number(e.detail.value);
    const c = this.data.candidates[idx];
    if (!c) return;
    this.setData({ pickIndex: idx, userId: c.user_id });
  },

  // ---------- 表单 ----------
  onNumInput(e) {
    const field = e.currentTarget.dataset.field;
    const val = String(e.detail.value || '').replace(/[^\d]/g, '').slice(0, 3);
    this.setData({ [field]: val });
  },

  onWinToggle(e) {
    this.setData({ isWin: e.currentTarget.dataset.win === '1' });
  },

  parseNum(v) {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
  },

  onSubmitTap() {
    if (this.data.submitting) return;
    if (!this.data.userId) {
      wx.showToast({ title: '请先选择会员', icon: 'none' });
      return;
    }
    const payload = { activity_id: this.data.activityId, user_id: this.data.userId };
    for (const f of FIELDS) {
      const n = this.parseNum(this.data[f]);
      if (n === null) {
        wx.showToast({ title: '数值需为 0~999 的整数', icon: 'none' });
        return;
      }
      payload[f] = n;
    }
    payload.is_win = this.data.isWin;

    this.setData({ submitting: true });
    callCloud('activity', 'recordStats', payload)
      .then((res) => {
        const d = res.data || {};
        const mine = (d.honors_of_match || []).find((h) => h.user_id === payload.user_id);
        const honors = mine ? mine.honors.map((h) => HONOR_LABELS[h] || h).join('、') : '';
        wx.showToast({
          title: honors ? `录入成功，获得荣誉：${honors}` : '录入成功',
          icon: 'none',
          duration: 3000,
        });
        // 重置选人与数值，便于连续录入下一位
        this.setData({ pickIndex: -1, userId: '', kills: '0', deaths: '0', heals: '0', supplies: '0', captures: '0' });
      })
      .catch((err) => showError(err, '录入失败，请重试'))
      .then(() => this.setData({ submitting: false }));
  },

  // ---------- 批量导入入口（§5.24） ----------
  onImportTap() {
    wx.navigateTo({
      url: `/pages/admin/import-excel?biz_id=${this.data.activityId}`,
    });
  },
});
