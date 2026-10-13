// pages/profile/bind-phone.js — 绑定手机号（user-module §2.2、§5.5）
// 接口：user/getProfile（当前绑定态）、user/bindPhone（绑定/换绑）
// 成年流程：getPhoneNumber 按钮一键获取微信手机号（phone_owner=self）
// 未成年人流程：监护人手机号表单 + 未成年人声明勾选（phone_owner=guardian）
// 已绑定态：脱敏号码展示 + 换绑（§8.2：不提供解绑，报名强制绑定）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

Page({
  data: {
    loading: true,
    isMinor: false,
    // 已绑定态
    bound: false,
    boundMasked: '',
    boundOwner: 'self',
    showForm: false, // 已绑定时点「换绑」展开表单
    // 表单
    mode: 'self', // self | guardian
    phone: '',
    declared: false, // 未成年人声明勾选
    submitting: false,
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false });
        return;
      }
      this.loadProfile();
    });
  },

  loadProfile() {
    callCloud('user', 'getProfile', {})
      .then((res) => {
        const u = (res.data && res.data.user) || {};
        const bound = !!u.phone_bound && !!u.phone_masked;
        this.setData({
          loading: false,
          isMinor: !!u.is_minor,
          bound,
          boundMasked: bound ? u.phone_masked : '',
          boundOwner: bound ? u.phone_owner || 'self' : 'self',
          showForm: !bound,
          // 未成年默认监护人流程（§2.2 流程图），成年默认微信一键获取
          mode: u.is_minor ? 'guardian' : 'self',
          phone: '',
          declared: false,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        showError(e, '加载失败，请稍后重试');
      });
  },

  // 切换绑定流程（本人 / 监护人）
  switchMode(e) {
    if (this.data.submitting) return;
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value });
  },

  toggleDeclared() {
    this.setData({ declared: !this.data.declared });
  },

  // 已绑定态点「换绑」展开表单
  startRebind() {
    this.setData({ showForm: true, mode: this.data.boundOwner === 'guardian' ? 'guardian' : this.data.isMinor ? 'guardian' : 'self' });
  },

  // 成年流程：微信手机号快捷验证（code 一次性，失败可重试或改走监护人表单）
  onGetPhone(e) {
    if (this.data.submitting) return;
    if (e.detail.errMsg !== 'getPhoneNumber:ok' || !e.detail.code) {
      // 用户主动取消不打扰；组件侧失败提示重试（8.11）
      const errMsg = e.detail.errMsg || '';
      console.warn('[bindPhone] getPhoneNumber 失败详情:', JSON.stringify(e.detail));
      if (errMsg.indexOf('deny') < 0 && errMsg.indexOf('cancel') < 0) {
        wx.showToast({ title: '手机号获取失败，请重试', icon: 'none' });
      }
      return;
    }
    this.submit({ phone_owner: 'self', phone_code: e.detail.code });
  },

  // 未成年人流程：监护人手机号表单提交
  onBindGuardian() {
    if (this.data.submitting) return;
    const phone = String(this.data.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请填写正确的监护人手机号', icon: 'none' });
      return;
    }
    if (!this.data.declared) {
      wx.showToast({ title: '请先勾选未成年人声明', icon: 'none' });
      return;
    }
    this.submit({ phone_owner: 'guardian', phone });
  },

  submit(payload) {
    this.setData({ submitting: true });
    callCloud('user', 'bindPhone', payload)
      .then((res) => {
        const d = res.data || {};
        this.setData({
          submitting: false,
          bound: true,
          boundMasked: d.phone_masked || '',
          boundOwner: d.phone_owner || 'self',
          showForm: false,
          phone: '',
          declared: false,
        });
        if (d.warning) {
          // 监护人号码与协议留痕不一致（不阻断，仅提示确认）
          wx.showModal({ title: '提示', content: d.warning, showCancel: false });
        } else {
          wx.showToast({ title: '绑定成功', icon: 'success' });
        }
      })
      .catch((e) => {
        // 2001 手机号获取失败（showError 按 msg toast，可重试）
        this.setData({ submitting: false });
        showError(e, '绑定失败，请稍后重试');
      });
  },
});
