// pages/order/confirm.js — 订单确认（payment-module §2 页面1）
// 入口：会员卡购买页「立即购买」（pages/profile/card/buy）。
// 活动报名确认由 activity/signup-confirm 直连（订单在 activity/signup 事务内直建，不经过本页）。
// 流程：user/getCardShop 取卡种快照展示 →「提交订单」order/create（金额仅展示，
// 入参不含金额字段 §3.1）→ redirectTo 收银台（含 is_exist 幂等单继续支付）。
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney } = require('../../utils/format');

const TYPE_LABEL = { count: '次卡', period: '期限卡' };

Page({
  data: {
    loading: true,
    bizType: '',
    bizId: '',
    product: null, // { name, typeLabel, benefit_desc, priceText }
    submitting: false,
  },

  onLoad(options) {
    this.setData({
      bizType: options.biz_type || '',
      bizId: options.biz_id || '',
    });
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
    const { bizType, bizId } = this.data;
    if (bizType !== 'member_card' || !bizId) {
      this.backWith('暂不支持的订单类型');
      return;
    }
    callCloud('user', 'getCardShop').then((res) => {
      const p = ((res.data && res.data.list) || []).find((it) => it.product_id === bizId);
      if (!p) {
        this.backWith('该卡种已下架或不存在');
        return;
      }
      this.setData({
        loading: false,
        product: {
          name: p.name,
          typeLabel: TYPE_LABEL[p.card_type] || p.card_type,
          benefit_desc: p.benefit_desc || '',
          priceText: formatMoney(p.price),
        },
      });
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败');
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  backWith(msg) {
    this.setData({ loading: false });
    wx.showModal({ title: '提示', content: msg, showCancel: false, success: () => wx.navigateBack() });
  },

  onSubmit() {
    if (this.data.submitting || !this.data.product) return;
    this.setData({ submitting: true });
    callCloud('order', 'create', {
      biz_type: 'member_card',
      biz_id: this.data.bizId,
      pay_type: 'wxpay',
      items: [{ qty: 1 }],
    }).then((res) => {
      const d = res.data || {};
      // is_exist=true（同卡种未过期待支付单）同样引导至收银台继续支付（§3.1 幂等）
      wx.redirectTo({ url: '/pages/order/cashier?order_no=' + d.order_no });
    }).catch((e) => {
      this.setData({ submitting: false });
      if (e && e.code === 41004) { // PRODUCT_OFF 卡种已下架
        this.backWith('该卡种已下架，请返回重新选择');
        return;
      }
      showError(e, '下单失败，请重试');
    });
  },
});
