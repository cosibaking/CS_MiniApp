// pages/profile/card/list.js — 我的会员卡（login）
// 接口：user/getMyCards（M2 §5.9）
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');
const { formatDate } = require('../../../utils/format');

Page({
  data: {
    loading: false,
    loaded: false,
    activeCards: [],
    historyCards: [],
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

  onShow() {
    if (this.data.loaded) this.fetch(); // 购买/核销返回后刷新
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { data } = await callCloud('user', 'getMyCards');
      this.setData({
        loaded: true,
        activeCards: (data.active_cards || []).map((c) => this.buildCard(c)),
        historyCards: (data.history_cards || []).map((c) => this.buildCard(c, true)),
      });
    } catch (e) {
      showError(e, '加载会员卡失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  // 视图模型：后端已按「实时校验」分好组，这里只补展示文案
  buildCard(c, isHistory) {
    const isCount = c.card_type === 'count';
    let statusLabel = '有效';
    if (isHistory) {
      if (c.status === 'voided') statusLabel = '已作废';
      else if (isCount && (c.remain_times || 0) <= 0) statusLabel = '已用完';
      else statusLabel = '已过期';
    }
    return {
      ...c,
      isCount,
      typeLabel: isCount ? '次卡' : '期限卡',
      remainText: isCount ? `剩余 ${c.remain_times}/${c.total_times} 次` : '期限内常规对抗赛免费',
      expireText: c.expire_at ? `${formatDate(c.expire_at)} 到期` : '长期有效',
      statusLabel,
      metaText: isHistory && isCount ? `已用 ${c.used_times || 0} 次` : '',
    };
  },

  goBuy() {
    wx.navigateTo({ url: '/pages/profile/card/buy' });
  },

  goDetail(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/profile/card/detail?card_id=${id}` });
  },
});
