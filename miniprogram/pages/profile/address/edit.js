// pages/profile/address/edit.js — 编辑地址（login，user-module §2 页面10 / §5.12-§5.13）
// 接口：user/saveAddress（无 address_id 为新增，有则为编辑）、user/deleteAddress（仅编辑态）
// 表单：收件人 / 手机号 / 地区选择器（picker mode=region，顿号分隔）/ 详细地址 / 设为默认
// 说明：列表出参电话脱敏（§5.11），编辑态手机号不回显原值，留空=保留原手机号
const { callCloud } = require('../../../utils/cloud');
const { requireLogin, showError } = require('../../../utils/auth');

Page({
  data: {
    addressId: '',
    isNew: true,
    receiver: '',
    phone: '',
    region: '',          // 省、市、区（顿号分隔，§6.5）
    regionArr: [],       // picker 回显用
    detail: '',
    isDefault: false,
    phoneMasked: '',     // 编辑态原手机号脱敏展示
    submitting: false,
  },

  onLoad(options) {
    this.setData({
      addressId: options.address_id || '',
      isNew: !options.address_id,
    });
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      if (!this.data.isNew) this.fetch();
    });
  },

  // 编辑态：列表接口取本条回显（无单条详情接口）
  fetch() {
    callCloud('user', 'listAddress', {}).then((res) => {
      const list = (res.data && res.data.list) || [];
      const addr = list.find((it) => it.address_id === this.data.addressId);
      if (!addr) {
        wx.showModal({
          title: '提示', content: '地址不存在或已被删除', showCancel: false,
          success: () => wx.navigateBack(),
        });
        return;
      }
      this.setData({
        receiver: addr.receiver,
        region: addr.region,
        regionArr: addr.region.split('、'),
        detail: addr.detail,
        isDefault: addr.is_default,
        phoneMasked: addr.phone_masked,
      });
    }).catch((e) => {
      showError(e, '加载失败');
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  onReceiverInput(e) { this.setData({ receiver: e.detail.value }); },
  onPhoneInput(e) { this.setData({ phone: e.detail.value }); },
  onDetailInput(e) { this.setData({ detail: e.detail.value }); },

  onRegionChange(e) {
    const arr = e.detail.value || [];
    this.setData({ regionArr: arr, region: arr.join('、') });
  },

  onDefaultChange(e) { this.setData({ isDefault: e.detail.value }); },

  // 校验失败返回提示文案；通过返回 null。新增态手机号必填
  validate() {
    const d = this.data;
    const receiver = d.receiver.trim();
    const phone = d.phone.trim();
    const detail = d.detail.trim();
    if (!receiver || receiver.length > 20) return '请输入 1-20 字的收件人姓名';
    if (d.isNew && !/^1\d{10}$/.test(phone)) return '请输入 11 位手机号';
    if (!d.isNew && phone && !/^1\d{10}$/.test(phone)) return '请输入 11 位手机号';
    if (!d.region) return '请选择所在地区';
    if (!detail || detail.length > 100) return '请输入 1-100 字的详细地址';
    return null;
  },

  onSave() {
    if (this.data.submitting) return;
    const errMsg = this.validate();
    if (errMsg) {
      wx.showToast({ title: errMsg, icon: 'none' });
      return;
    }
    const d = this.data;
    const payload = {
      receiver: d.receiver.trim(),
      region: d.region,
      detail: d.detail.trim(),
      is_default: d.isDefault,
    };
    if (d.phone.trim()) payload.phone = d.phone.trim();
    if (!d.isNew) payload.address_id = d.addressId;

    this.setData({ submitting: true });
    callCloud('user', 'saveAddress', payload).then(() => {
      wx.showToast({ title: d.isNew ? '已新增' : '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    }).catch((e) => {
      this.setData({ submitting: false });
      showError(e, '保存失败，请重试');
    });
  },

  onDelete() {
    const that = this;
    wx.showModal({
      title: '删除地址',
      content: '删除后不可恢复，确定删除吗？',
      confirmColor: '#C8552F',
      success(res) {
        if (!res.confirm) return;
        callCloud('user', 'deleteAddress', { address_id: that.data.addressId }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        }).catch((err) => showError(err, '删除失败'));
      },
    });
  },
});
