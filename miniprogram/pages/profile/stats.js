// pages/profile/stats.js — 我的战绩（login，activity-module §5.1.8 / §3.9.5）
// 接口：activity/myStats（页面归属 user 模块，数据由 activity 提供，§6.9 消费关系）
// 入口：我的 → 功能入口「我的战绩」
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    loadError: false,
    hasData: false, // 有参战记录才展示统计区
    // 军衔块（读 user 冗余字段，R15 口径）
    rank: null,
    killsPct: 0,
    winsPct: 0,
    nextKills: 0,
    nextWins: 0,
    nextText: '',
    // 统计区
    stats: null,
    winRateText: '—',
    honors: [],
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.loadStats();
    });
  },

  loadStats() {
    this.setData({ loading: true, loadError: false });
    callCloud('activity', 'myStats', {})
      .then((res) => {
        const d = res.data || {};
        const rank = d.rank || {};
        const next = rank.next_thresholds || null;
        const hc = d.honor_counts || {};

        // 下一军衔双进度（R15 与门，短板决定；少将封顶无下一档 → 满进度）
        let killsPct = 100;
        let winsPct = 100;
        let nextText = '已达最高军衔';
        if (next) {
          killsPct = next.total_kills
            ? Math.min(100, Math.round(((rank.total_kills || 0) / next.total_kills) * 100))
            : 100;
          winsPct = next.total_wins
            ? Math.min(100, Math.round(((rank.total_wins || 0) / next.total_wins) * 100))
            : 100;
          nextText = '距下一军衔：击杀 ' + Math.max(0, next.total_kills - (rank.total_kills || 0)) +
            ' / 胜场 ' + Math.max(0, next.total_wins - (rank.total_wins || 0));
        }

        const hasData = (d.total_matches || 0) > 0;
        this.setData({
          loading: false,
          hasData,
          rank,
          killsPct,
          winsPct,
          nextKills: next ? next.total_kills : rank.total_kills || 0,
          nextWins: next ? next.total_wins : rank.total_wins || 0,
          nextText,
          stats: {
            total_matches: d.total_matches || 0,
            wins: d.wins || 0,
            losses: d.losses || 0,
            total_kills: d.total_kills || 0,
            total_deaths: d.total_deaths || 0,
            kd: d.kd === null || d.kd === undefined ? '—' : d.kd,
            total_heals: d.total_heals || 0,
            total_supplies: d.total_supplies || 0,
            total_captures: d.total_captures || 0,
          },
          winRateText: d.win_rate === null || d.win_rate === undefined ? '—' : d.win_rate + '%',
          honors: [
            { key: 'mvp', icon: '🥇', label: 'MVP', count: hc.mvp || 0 },
            { key: 'svp', icon: '🥈', label: 'SVP', count: hc.svp || 0 },
            { key: 'best_heal', icon: '💚', label: '最佳治疗', count: hc.best_heal || 0 },
            { key: 'best_supply', icon: '📦', label: '最佳补给', count: hc.best_supply || 0 },
            { key: 'best_capture', icon: '🚩', label: '最佳占领', count: hc.best_capture || 0 },
          ],
        });
      })
      .catch((err) => {
        this.setData({ loading: false, loadError: true });
        showError(err, '战绩加载失败，请稍后重试');
      });
  },

  onRetry() {
    this.loadStats();
  },
});
