// pages/profile/address/list.js — 收货地址（login，user-module §2 页面9 / §5.11）
// 接口：user/listAddress（默认地址置顶，电话脱敏）
// 交互：默认标记、点卡片进编辑、底部新增、左滑式行内删除（user/deleteAddress）
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');

Page({
  data: {
    loading: true,
    list: [],
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

  // 新增/编辑页返回后刷新，保证默认地址标记最新
  onShow() {
    if (!this.data.loading) this.fetch();
  },

  fetch() {
    this.setData({ loading: true });
    callCloud('user', 'listAddress', {}).then((res) => {
      this.setData({ loading: false, list: (res.data && res.data.list) || [] });
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败');
    });
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/profile/address/edit' });
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/profile/address/edit?address_id=' + e.currentTarget.dataset.id });
  },

  onDelete(e) {
    const { id, receiver } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除地址',
      content: `确定删除「${receiver}」的收货地址吗？`,
      confirmColor: '#C8552F',
      success: (res) => {
        if (!res.confirm) return;
        callCloud('user', 'deleteAddress', { address_id: id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.fetch();
        }).catch((err) => showError(err, '删除失败'));
      },
    });
  },
});
