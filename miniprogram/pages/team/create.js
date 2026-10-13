// pages/team/create.js — 创建战队（team-module §2.1-2 / §2.2 / §5.1）
// 接口：team/my（进入态拦截 + 被拒重提判定）、team/detail（重提回填原资料）、
//       team/list（队名失焦查重，仅 normal；审核中同名由提交 40902 兜底）、team/create
// 队徽：chooseMedia 选图（≤2MB）→ wx.cloud.uploadFile → fileID 提交
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { TEAM_BIZ } = require('../../utils/constants');

const LOGO_MAX = 2 * 1024 * 1024; // 单图 ≤ 2MB（§2.2 建议值）

Page({
  data: {
    loading: true,
    blocked: '',      // 在职（40901）/ 审核中（40904）拦截文案，非空禁表单
    rejected: null,   // { reject_reason }（R1 被拒重提横幅）
    name: '',
    slogan: '',
    intro: '',
    logoFileID: '',   // 已有队徽（重提回填，cloud://）
    logoTemp: '',     // 新选临时图（提交时上传）
    nameChecking: false,
    nameTaken: false,
    saving: false,
  },

  onLoad() {
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false });
        return;
      }
      this.loadState();
    });
  },

  // 进入态（team/my）：在职拦截 / 审核中禁提交 / 被拒可重提（§2.2）
  loadState() {
    callCloud('team', 'my', {}).then((res) => {
      const d = res.data || {};
      let blocked = '';
      if (d.active_team) {
        blocked = '你已属于战队「' + d.active_team.name + '」，须先退出后才能创建';
      } else if (d.creating && d.creating.status === 'pending') {
        blocked = '你的创建申请「' + d.creating.name + '」审核中，请耐心等待';
      }
      const rejected = d.creating && d.creating.status === 'rejected' ? d.creating : null;
      this.setData({
        loading: false,
        blocked,
        rejected: rejected ? { reject_reason: rejected.reject_reason || '' } : null,
      });
      if (rejected) this.loadRejected(rejected.team_id);
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败，请稍后重试');
    });
  },

  // R1 被拒重提：回填原资料（detail 对创建者可见 rejected 战队）
  loadRejected(teamId) {
    callCloud('team', 'detail', { team_id: teamId }).then((res) => {
      const t = (res.data || {}).team || {};
      this.setData({
        name: t.name || '',
        slogan: t.slogan || '',
        intro: t.intro || '',
        logoFileID: t.logo || '',
      });
    }).catch(() => { /* 回填失败不阻断，可手动填写 */ });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/team/list' }) });
  },

  onName(e) {
    this.setData({ name: e.detail.value, nameTaken: false });
  },

  // 失焦实时查重（team/list 仅 normal；pending/rejected 同名由提交 40902 兜底）
  onNameBlur() {
    const name = String(this.data.name || '').trim();
    if (!name || this.data.nameChecking) return;
    this.setData({ nameChecking: true });
    callCloud('team', 'list', { keyword: name, page: 1, page_size: 20 }).then((res) => {
      const list = (res.data && res.data.list) || [];
      const lower = name.toLowerCase();
      const taken = list.some((it) => String(it.name || '').trim().toLowerCase() === lower);
      this.setData({ nameChecking: false, nameTaken: taken });
    }).catch(() => {
      this.setData({ nameChecking: false });
    });
  },

  onSlogan(e) {
    this.setData({ slogan: e.detail.value });
  },

  onIntro(e) {
    this.setData({ intro: e.detail.value });
  },

  // 选择队徽（§2.2：单图 ≤ 2MB）
  chooseLogo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (!f) return;
        if (f.size > LOGO_MAX) {
          wx.showToast({ title: '队徽需不超过 2MB', icon: 'none' });
          return;
        }
        this.setData({ logoTemp: f.tempFilePath });
      },
    });
  },

  onSubmit() {
    if (this.data.saving || this.data.blocked) return;
    const name = String(this.data.name || '').trim();
    const slogan = String(this.data.slogan || '').trim();
    const intro = String(this.data.intro || '').trim();

    if (name.length < 2 || name.length > 20) {
      wx.showToast({ title: '队名需 2~20 个字符', icon: 'none' });
      return;
    }
    if (this.data.nameTaken) {
      wx.showToast({ title: '该队名已被使用，请换一个', icon: 'none' });
      return;
    }
    if (slogan.length > 30) {
      wx.showToast({ title: '口号不能超过 30 字', icon: 'none' });
      return;
    }
    if (intro.length > 200) {
      wx.showToast({ title: '简介不能超过 200 字', icon: 'none' });
      return;
    }
    if (!this.data.logoTemp && !this.data.logoFileID) {
      wx.showToast({ title: '请上传队徽', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    this.uploadLogoIfNeeded()
      .then((logo) => this.submit(name, slogan, intro, logo))
      .catch(() => this.setData({ saving: false }));
  },

  // 新队徽先上传云存储（fileID 提交后端；重提未换图直接用原 fileID）
  uploadLogoIfNeeded() {
    const temp = this.data.logoTemp;
    if (!temp) return Promise.resolve(this.data.logoFileID);
    const extMatch = /\.(\w+)$/.exec(temp);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const cloudPath = 'team/logo_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.' + ext;
    return wx.cloud.uploadFile({ cloudPath, filePath: temp })
      .then((res) => res.fileID)
      .catch((e) => {
        console.warn('[team/create] 队徽上传失败', e);
        wx.showToast({ title: '队徽上传失败，请重试', icon: 'none' });
        return Promise.reject(e);
      });
  },

  submit(name, slogan, intro, logo) {
    callCloud('team', 'create', {
      name,
      logo,
      slogan: slogan || null,
      intro: intro || null,
    }).then((res) => {
      this.setData({ saving: false });
      const teamId = (res.data || {}).team_id;
      wx.showToast({ title: '已提交审核', icon: 'success' });
      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/team/detail?team_id=' + teamId,
          fail: () => this.goBack(),
        });
      }, 600);
    }).catch((e) => {
      this.setData({ saving: false });
      if (e && e.code === TEAM_BIZ.ALREADY_IN_TEAM) {
        this.setData({ blocked: e.msg || '你已属于战队，须先退出后才能创建' });
        return;
      }
      if (e && e.code === TEAM_BIZ.DUP_PENDING) {
        this.setData({ blocked: e.msg || '已有战队在审核中，请耐心等待' });
        return;
      }
      if (e && e.code === TEAM_BIZ.NAME_TAKEN) {
        this.setData({ nameTaken: true });
        wx.showToast({ title: e.msg || '队名已被使用，请换一个', icon: 'none' });
        return;
      }
      showError(e, '提交失败，请稍后重试');
    });
  },
});
