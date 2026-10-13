// pages/profile/level.js — 等级与军衔（login，user-module §2 页面8 / §5.3 / R14 / R15）
// 接口：user/getProfile（聚合出 level + rank 块）
// 布局：等级区（徽章 + 折扣 + 距下一级进度条 + LV1–LV4 规则表）；
//       军衔区（徽章 + 击杀/胜场双进度条 + R15 十四档规则表）
// 边界：0 场显示解锁引导；军衔块缺失时军衔区隐藏（rank 按 recruit 兜底 §2）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { RANKS } = require('../../utils/constants');

// 等级规则表（R14，与 utils/constants.js levelOf 同口径，仅作展示）
const LEVEL_RULES = [
  { key: 'LV1', name: '新兵', rangeText: '1-9 场', discountText: '—' },
  { key: 'LV2', name: '老兵', rangeText: '10-29 场', discountText: '—' },
  { key: 'LV3', name: '精英', rangeText: '30-59 场', discountText: '95 折' },
  { key: 'LV4', name: '王牌', rangeText: '60 场及以上', discountText: '9 折' },
];

function clampPercent(cur, target) {
  if (!target || target <= 0) return 100;
  return Math.min(100, Math.round(((cur || 0) / target) * 100));
}

Page({
  data: {
    loading: true,
    nickname: '',
    level: null,      // { key, name, discountText, current, nextThreshold, percent, guideText, isMax }
    rank: null,       // { name, kills, wins, next, killPercent, winPercent, guideText, isMax }
    levelRules: [],
    rankRules: [],    // RANKS + current 标记
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.fetch();
    });
  },

  fetch() {
    this.setData({ loading: true });
    callCloud('user', 'getProfile', {}).then((res) => {
      const d = res.data || {};
      const u = d.user || {};
      this.setData({
        loading: false,
        nickname: u.nickname || '会员',
        level: this.buildLevel(d.level, u.total_games),
        rank: this.buildRank(d.rank),
        levelRules: LEVEL_RULES,
        rankRules: RANKS.map((r) => ({
          name: r.name,
          kills: r.kills,
          wins: r.wins,
          current: d.rank && d.rank.key === r.key,
        })),
      });
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败');
    });
  },

  // 等级区视图模型（R14 恒等式：0 未定级；1-9 LV1；10-29 LV2；30-59 LV3；60+ LV4）
  buildLevel(level, totalGames) {
    if (!level) return null;
    const cur = totalGames || 0;
    const next = level.next_threshold || 0;
    const discountText = level.discount_percent
      ? `${level.discount_percent / 10} 折` : '暂无折扣';
    let guideText = '';
    if (cur <= 0) {
      guideText = '参加 1 场解锁 LV1 新兵';
    } else if (next) {
      const idx = LEVEL_RULES.findIndex((r) => r.key === level.key);
      const nextName = (LEVEL_RULES[idx + 1] || {}).name || '下一级';
      guideText = `再参加 ${next - cur} 场升级${nextName}`;
    } else {
      guideText = '已达最高等级';
    }
    return {
      key: level.key || 'LV1',
      name: level.name,
      discountText,
      current: cur,
      nextThreshold: next,
      percent: clampPercent(cur, next),
      guideText,
      isMax: !next,
    };
  },

  // 军衔区视图模型（R15 与门口径；rank 块缺失返回 null → 军衔区隐藏）
  buildRank(rank) {
    if (!rank || !rank.key) return null;
    const next = rank.next_thresholds || null;
    const kills = rank.total_kills || 0;
    const wins = rank.total_wins || 0;
    let guideText = '已达最高军衔';
    if (next) {
      // 引导文案门槛值随 R15 规则动态读取（§2，不硬编码）
      const nextName = (RANKS.find((r) => r.kills === next.total_kills && r.wins === next.total_wins) || {}).name || '下一档';
      guideText = `获得 ${next.total_kills} 击杀 + ${next.total_wins} 胜场晋升${nextName}`;
    }
    return {
      name: rank.name,
      kills,
      wins,
      next,
      killPercent: clampPercent(kills, next && next.total_kills),
      winPercent: clampPercent(wins, next && next.total_wins),
      guideText,
      isMax: !next,
    };
  },
});
