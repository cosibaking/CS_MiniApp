// pages/admin/activity/stats-list.js — 战绩查询（record_stats，activity-module §5.25/§3.9）
// 接口：activity/statsList（kills 倒序 + 荣誉汇总）；修改入口跳 stats-record 预填
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatTime } = require('../../../utils/format');

const HONOR_LABELS = {
  mvp: 'MVP', svp: 'SVP',
  best_heal: '最佳治疗', best_supply: '最佳补给', best_capture: '最佳占领',
};
const HONOR_CLASS = {
  mvp: 'h-gold', svp: 'h-silver',
  best_heal: 'h-green', best_supply: 'h-blue', best_capture: 'h-orange',
};

Page({
  data: {
    activityId: '',
    noPermission: false,
    loading: false,
    // 荣誉汇总
    honorRows: [],
    honorCount: 0,
    // 战绩列表
    list: [],
    total: 0,
    empty: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({ activityId: options.id || '' });
    requirePermission('record_stats').then((pass) => {
      this.setData({ noPermission: !pass });
      if (pass) this.fetch();
    });
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  fetch() {
    if (this.data.loading) return Promise.resolve();
    this.setData({ loading: true });
    return callCloud('activity', 'statsList', { activity_id: this.data.activityId })
      .then((res) => {
        const d = res.data || {};
        const nameMap = {};
        (d.list || []).forEach((s) => { nameMap[s.user_id] = s.nickname || '未设置昵称'; });
        // 荣誉汇总行（MVP/SVP/最佳治疗/最佳补给/最佳占领）
        const hs = d.honor_summary || {};
        const honorRows = Object.keys(HONOR_LABELS).map((key) => {
          const ids = hs[key] || [];
          return {
            key,
            label: HONOR_LABELS[key],
            cls: HONOR_CLASS[key],
            names: ids.map((uid) => nameMap[uid] || '已删除用户').join('、'),
          };
        }).filter((r) => r.names);
        const list = (d.list || []).map((s) => ({
          id: s._id,
          userId: s.user_id,
          nickname: s.nickname || '未设置昵称',
          kills: s.kills || 0,
          deaths: s.deaths || 0,
          heals: s.heals || 0,
          supplies: s.supplies || 0,
          captures: s.captures || 0,
          winText: s.is_win ? '胜' : '负',
          winClass: s.is_win ? 'st-green' : 'st-red',
          sourceText: s.source === 'excel' ? 'Excel 导入' : '手动录入',
          createdAtText: formatTime(s.created_at),
          honors: (s.honors || []).map((h) => ({
            label: HONOR_LABELS[h] || h,
            cls: HONOR_CLASS[h] || 'h-blue',
          })),
        }));
        this.setData({
          honorRows,
          honorCount: list.length,
          list,
          total: d.total || 0,
          empty: list.length === 0,
          loading: false,
        });
      })
      .catch((err) => {
        this.setData({ loading: false });
        showError(err, '加载失败，下拉重试');
      });
  },

  // 修改入口：跳录入页预填该条战绩（upsert 覆盖）
  onEditTap(e) {
    const it = e.currentTarget.dataset.item;
    if (!it) return;
    const q = [
      `id=${this.data.activityId}`,
      `user_id=${it.userId}`,
      `nickname=${encodeURIComponent(it.nickname)}`,
      `kills=${it.kills}`, `deaths=${it.deaths}`, `heals=${it.heals}`,
      `supplies=${it.supplies}`, `captures=${it.captures}`,
      `is_win=${it.winText === '胜' ? 1 : 0}`,
    ].join('&');
    wx.navigateTo({ url: `/pages/admin/activity/stats-record?${q}` });
  },
});
