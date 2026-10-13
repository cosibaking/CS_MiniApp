// app.js — 全局入口：云环境初始化 + 静默登录 + 权限预取
// 依据：docs/architecture.md §6（技术底座）、docs/design/user-module.md §5.2（login）
const { ENV_ID } = require('./utils/config');
const { callCloud } = require('./utils/cloud');
const { CODE } = require('./utils/constants');

App({
  globalData: {
    userInfo: null,   // user/login 返回的用户概要
    permissions: [],  // admin/permission/my 返回的权限点（管理端菜单可见性）
    envId: ENV_ID,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('基础库版本过低，请升级至 2.2.3 以上以使用云能力');
      return;
    }
    wx.cloud.init({
      env: ENV_ID || undefined, // 留空使用默认环境；部署时在 utils/config.js 配置
      traceUser: true,
    });
    // 暴露启动登录 Promise（含权限预取），供页面等待以避免读到半初始化状态
    this._loginReady = this.silentLogin();
  },

  // 静默登录：换取用户概要；封禁(1003)时仅记录状态不弹窗
  async silentLogin() {
    try {
      const res = await callCloud('user', 'login', {});
      this.globalData.userInfo = res.data;
      wx.setStorageSync('userInfo', res.data);
      await this.loadPermissions();
      return res.data;
    } catch (e) {
      if (e.code === CODE.BANNED) {
        this.globalData.userInfo = { banned: true };
      } else {
        console.error('[login] 静默登录失败', e);
      }
      return null;
    }
  },

  // 权限预取：普通成员无权限点属正常态，失败不阻断
  async loadPermissions() {
    try {
      const res = await callCloud('admin', 'permission/my', {});
      const data = res.data || {};
      this.globalData.permissions = data.permissions || [];
      this.globalData.role = data.operator ? data.operator.role : 'member';
    } catch (e) {
      this.globalData.permissions = [];
    }
  },

  // 前端入口可见性判断（云函数侧 checkPermission 仍是硬校验，双层防线）
  hasPermission(permissionKey) {
    const perms = this.globalData.permissions || [];
    return perms.includes('*') || perms.includes(permissionKey);
  },
});
