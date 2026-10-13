// state.js — 依赖注入容器
// 各云函数 index.js 在 cloud.init 之后调用 common.setup({ cloud, db })。
// 说明：common 包不自行 require wx-server-sdk，避免 file: 依赖安装产生多份 SDK 实例。
module.exports = { cloud: null, db: null };
