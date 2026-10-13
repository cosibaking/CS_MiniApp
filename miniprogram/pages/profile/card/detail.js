// pages/profile/card/detail.js — 会员卡详情（login）
// 接口：user/getCardDetail（M2 §5.10）
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');
const { formatDate, formatTime } = require('../../../utils/format');

Page({
  data: {
    loading: false,
    loaded: false,
    card: null,
    records: [],
  },

  onLoad(options) {
    if (!options || !options.card_id) {
      wx.showModal({
        title: '提示',
        content: '缺少卡信息',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
      return;
    }
    this.cardId = options.card_id;
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.fetch();
    });
  },

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { data } = await callCloud('user', 'getCardDetail', { card_id: this.cardId });
      this.setData({
        loaded: true,
        card: this.buildCard(data.card || null),
        records: (data.usage_records || []).map((r) => ({
          ...r,
          timeText: formatTime(r.used_at),
        })),
      });
    } catch (e) {
      showError(e, '加载卡详情失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  // 视图模型：实时推导展示状态（DB 定时器可能滞后，口径同 getMyCards R12）
  buildCard(c) {
    if (!c) return null;
    const isCount = c.card_type === 'count';
    const now = Date.now();
    let statusLabel;
    if (c.status === 'voided') statusLabel = '已作废';
    else if (c.status === 'expired') statusLabel = '已过期';
    else if (isCount && (c.remain_times || 0) <= 0) statusLabel = '已用完';
    else if (c.expire_at && c.expire_at <= now) statusLabel = '已过期';
    else statusLabel = '有效';
    return {
      ...c,
      isCount,
      typeLabel: isCount ? '次卡' : '期限卡',
      remainText: isCount ? `剩余 ${c.remain_times}/${c.total_times} 次` : '期限内常规对抗赛免费',
      expireText: c.expire_at ? `${formatDate(c.expire_at)} 到期` : '长期有效',
      activatedText: c.activated_at ? formatDate(c.activated_at) : '-',
      statusLabel,
      valid: statusLabel === '有效',
    };
  },

  goBuy() {
    wx.navigateTo({ url: '/pages/profile/card/buy' });
  },
});
