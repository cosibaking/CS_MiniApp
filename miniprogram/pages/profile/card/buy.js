// pages/profile/card/buy.js — 购买会员卡（login）
// 接口：user/getCardShop（M2 §5.8）；选卡后进入订单确认页，下单由确认页调 order/create
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');
const { formatMoney } = require('../../../utils/format');

Page({
  data: {
    loading: false,
    loaded: false,
    products: [],
    selectedId: '',
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

  onPullDownRefresh() {
    this.fetch().finally(() => wx.stopPullDownRefresh());
  },

  async fetch() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const { data } = await callCloud('user', 'getCardShop');
      const products = (data.list || []).map((p) => ({
        ...p,
        priceText: formatMoney(p.price),
      }));
      this.setData({
        loaded: true,
        products,
        // 默认选中第一个在售卡种；刷新时保留已选
        selectedId: this.data.selectedId || (products[0] && products[0].product_id) || '',
      });
    } catch (e) {
      showError(e, '加载卡种失败');
    } finally {
      this.setData({ loading: false });
    }
  },

  onSelect(e) {
    this.setData({ selectedId: e.currentTarget.dataset.id });
  },

  getSelected() {
    return this.data.products.find((p) => p.product_id === this.data.selectedId) || null;
  },

  // 进入订单确认页（快照确认 → 提交订单 → 收银台）
  onTapBuy() {
    const product = this.getSelected();
    if (!product) {
      wx.showToast({ title: '请选择卡种', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/order/confirm?biz_type=member_card&biz_id=${product.product_id}`,
    });
  },
});
