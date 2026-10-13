// pages/profile/edit.js — 编辑资料（user-module §2.2、§5.4）
// 接口：user/getProfile（回填）、user/updateProfile（保存）
// 头像：chooseAvatar 取临时路径 → wx.cloud.uploadFile 上传 → fileID 提交
// 紧急联系人电话后端仅返回脱敏，故输入框留空=不修改，填写=整体更新
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

// 时间戳 → YYYY-MM-DD（本地口径）
function tsToDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// YYYY-MM-DD → 本地零点时间戳（手动正则解析，规避 iOS new Date(str) 兼容问题）
function dateStrToTs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return isFinite(ts) ? ts : null;
}

Page({
  data: {
    loading: true,
    saving: false,
    userId: '',
    genders: [
      { value: 0, label: '保密' },
      { value: 1, label: '男' },
      { value: 2, label: '女' },
    ],
    nickname: '',
    avatar: '', // 已保存头像（fileID/URL）
    avatarTemp: '', // chooseAvatar 临时路径（保存时上传）
    gender: 0,
    birthdayStr: '',
    todayStr: '',
    ecName: '',
    ecPhoneMasked: '', // 后端脱敏（仅提示）
    ecPhone: '', // 新输入的完整手机号（留空=不修改）
    hasEc: false, // 档案已有紧急联系人
  },

  onLoad() {
    this.setData({ todayStr: tsToDateStr(Date.now()) });
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false });
        return;
      }
      this.setData({ userId: user.user_id });
      this.loadProfile();
    });
  },

  loadProfile() {
    callCloud('user', 'getProfile', {})
      .then((res) => {
        const u = (res.data && res.data.user) || {};
        const ec = u.emergency_contact || null;
        const birthdayStr = u.birthday ? tsToDateStr(u.birthday) : '';
        // 载入基线（保存时比对，未改动不提交）
        this._origin = {
          nickname: u.nickname || '',
          gender: u.gender === undefined ? 0 : u.gender,
          birthdayStr,
          ecName: ec ? ec.name || '' : '',
        };
        this.setData({
          loading: false,
          nickname: this._origin.nickname,
          avatar: u.avatar || '',
          avatarTemp: '',
          gender: this._origin.gender,
          birthdayStr,
          ecName: this._origin.ecName,
          ecPhoneMasked: ec && ec.phone_masked ? ec.phone_masked : '',
          ecPhone: '',
          hasEc: !!ec,
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        showError(e, '加载失败，请稍后重试');
      });
  },

  // 头像（微信官方头像昵称填写能力）
  onChooseAvatar(e) {
    this.setData({ avatarTemp: e.detail.avatarUrl || '' });
  },

  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  onGender(e) {
    this.setData({ gender: Number(e.currentTarget.dataset.value) });
  },

  onBirthdayChange(e) {
    this.setData({ birthdayStr: e.detail.value });
  },

  onEcName(e) {
    this.setData({ ecName: e.detail.value });
  },

  onEcPhone(e) {
    this.setData({ ecPhone: e.detail.value });
  },

  onSave(e) {
    if (this.data.saving) return;

    // type="nickname" 快捷填充不触发 bindinput（部分基础库 blur 事件值也滞后），
    // 以 form bindsubmit 收集到的输入框真实值为准，回写 data 后再走校验
    const formVals = (e && e.detail && e.detail.value) || {};
    const patch = {};
    ['nickname', 'ecName', 'ecPhone'].forEach((k) => {
      if (typeof formVals[k] === 'string' && formVals[k] !== this.data[k]) patch[k] = formVals[k];
    });
    if (Object.keys(patch).length) this.setData(patch);

    const nickname = String(this.data.nickname || '').trim();
    if (!nickname.length || nickname.length > 20) {
      wx.showToast({ title: '昵称需为 1-20 个字符', icon: 'none' });
      return;
    }

    // 紧急联系人：姓名有改动或填了新手机号才提交；两者都清空=清除联系人
    const ecName = String(this.data.ecName || '').trim();
    const ecPhone = String(this.data.ecPhone || '').trim();
    const origin = this._origin || {};
    const ecChanged = ecPhone.length > 0 || ecName !== origin.ecName;
    if (ecChanged && (ecName || ecPhone)) {
      if (!ecName.length || ecName.length > 20) {
        wx.showToast({ title: '紧急联系人姓名需为 1-20 个字符', icon: 'none' });
        return;
      }
      if (!/^1\d{10}$/.test(ecPhone)) {
        wx.showToast({ title: '请填写完整的紧急联系人手机号', icon: 'none' });
        return;
      }
    }

    this.setData({ saving: true });
    this.uploadAvatarIfNeeded()
      .then((avatarFileId) => {
        this.submit(nickname, ecName, ecPhone, ecChanged, avatarFileId);
      })
      .catch(() => {
        this.setData({ saving: false });
      });
  },

  // 头像有更新时先上传云存储（fileID 提交后端）
  uploadAvatarIfNeeded() {
    const temp = this.data.avatarTemp;
    if (!temp) return Promise.resolve(null);
    const extMatch = /\.(\w+)$/.exec(temp);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const cloudPath = 'avatar/' + (this.data.userId || 'user') + '_' + Date.now() + '.' + ext;
    return wx.cloud
      .uploadFile({ cloudPath, filePath: temp })
      .then((res) => res.fileID)
      .catch((e) => {
        console.warn('[edit] 头像上传失败', e);
        wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
        return Promise.reject(e);
      });
  },

  submit(nickname, ecName, ecPhone, ecChanged, avatarFileId) {
    const payload = { nickname, gender: this.data.gender };
    if (avatarFileId) payload.avatar = avatarFileId;
    if (this.data.birthdayStr) {
      const ts = dateStrToTs(this.data.birthdayStr);
      if (ts !== null) payload.birthday = ts; // 后端按 R4 重算 is_minor
    }
    if (ecChanged) {
      payload.emergency_contact = ecName || ecPhone ? { name: ecName, phone: ecPhone } : null;
    }

    callCloud('user', 'updateProfile', payload)
      .then(() => {
        this.setData({ saving: false });
        wx.showToast({ title: '保存成功', icon: 'success' });
        // 「我的」页 onShow 会自动刷新，延迟返回避免 toast 被打断
        setTimeout(() => {
          wx.navigateBack({
            fail: () => wx.switchTab({ url: '/pages/profile/profile' }),
          });
        }, 600);
      })
      .catch((e) => {
        this.setData({ saving: false });
        showError(e, '保存失败，请稍后重试');
      });
  },
});
