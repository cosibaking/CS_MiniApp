// utils/auth.js — 页面级登录/权限守卫（骨架）
// 云函数侧 checkPermission 为硬校验，此处仅控制入口体验（双层防线）
const { CODE } = require('./constants');

// 登录守卫：返回用户概要；未登录/封禁返回 null
// 注：app.silentLogin 把 login 返回的 { is_new, user } 包装对象存入 globalData.userInfo，此处解包 user
async function requireLogin() {
  const app = getApp();
  await app._loginReady; // 等待启动登录（含权限预取）落定；silentLogin 内部已兜错不会 reject
  let info = app.globalData.userInfo;
  if (!info || !info.user) info = await app.silentLogin();
  const user = info && info.user;
  return user && user.user_id ? user : null;
}

// 权限守卫：返回 boolean；无权限时可选跳回
async function requirePermission(perm) {
  const app = getApp();
  if (!app.globalData.userInfo) await app.silentLogin();
  const info = app.globalData.userInfo;
  if (info && (info.banned || (info.user && info.user.banned))) return false;
  return app.hasPermission(perm);
}

// 错误统一 toast（按 code 语义分流）
function showError(e, fallbackMsg) {
  const msg = (e && e.msg) || fallbackMsg || '操作失败';
  if (e && e.code === CODE.FORBIDDEN) {
    wx.showToast({ title: '无权限执行该操作', icon: 'none' });
    return;
  }
  if (e && e.code === CODE.BANNED) {
    wx.showModal({ title: '提示', content: msg, showCancel: false });
    return;
  }
  wx.showToast({ title: msg, icon: 'none' });
}

module.exports = { requireLogin, requirePermission, showError };
