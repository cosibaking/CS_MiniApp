// cloudfunctions/activity — 活动模块云函数（docs/design/activity-module.md）
const cloud = require('wx-server-sdk');
const common = require('@club/admin-common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
common.setup({ cloud, db });

// Excel 导入：bizType 'stats' 注册于 admin 云函数（cloudfunctions/admin/importers/stats.js），
// 前端 import-excel 页走 admin 云函数 import/* 接口，本函数不再注册。

const actions = {
  ...require('./actions/view'),    // §5.1-§5.9 会员端
  ...require('./actions/signup'),  // §5.10-§5.13 报名/签到/评价
  ...require('./actions/manage'),  // §5.15-§5.29 管理端（wrapAdminAction）
  ...require('./actions/notify'),  // §5.30-§5.31 内部回调
};

exports.main = async (event, context) => {
  // 定时触发器入口（config.json 4 个触发器，见 actions/cron.js）
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
    console.error(`[activity] action=${action} 未捕获异常`, e);
    return common.fail(common.CODE.INTERNAL, '服务器开小差了');
  }
};
