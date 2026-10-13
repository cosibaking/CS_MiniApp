// cloudfunctions/user — 用户模块云函数（docs/design/user-module.md）
// action 路由 + 定时触发器分发。前端调用：wx.cloud.callFunction({ name: 'user', data: { action, payload } })
const cloud = require('wx-server-sdk');
const common = require('@club/admin-common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
common.setup({ cloud, db });

const actions = {
  ...require('./actions/profile'),  // §5.2-§5.7 login/profile/phone/waiver
  ...require('./actions/card'),      // §5.8-§5.10 会员卡
  ...require('./actions/address'),   // §5.11-§5.13 收货地址（P2）
  ...require('./actions/internal'),  // §5.14-§5.17 内部接口 + §5.22 expireCards
  ...require('./actions/admin'),     // §5.18-§5.21 管理端
};

exports.main = async (event, context) => {
  // 定时触发器入口（config.json: user-expire-cards，每日 00:05）
  if (event && event.Type === 'Timer') {
    return require('./actions/cron').main(event);
  }

  const action = event && event.action;
  const handler = actions[action];
  if (!handler) {
    return common.fail(common.CODE.PARAM, `未知操作：${action || '(空)'}`);
  }

  try {
    return await handler(event, context);
  } catch (e) {
    console.error(`[user] action=${action} 未捕获异常`, e);
    return common.fail(common.CODE.INTERNAL, '服务器开小差了');
  }
};
