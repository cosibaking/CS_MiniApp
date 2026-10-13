// cloudfunctions/admin — 管理与权限模块云函数（docs/design/admin-module.md）
const cloud = require('wx-server-sdk');
const common = require('@club/admin-common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
common.setup({ cloud, db });

const actions = {
  ...require('./actions/role'),   // §5.1-§5.5 角色 CRUD
  ...require('./actions/perm'),   // §5.6-§5.7 权限点（permission/my 为真实实现）
  ...require('./actions/grant'),  // §5.8-§5.10 用户角色授权
  ...require('./actions/log'),    // §5.11-§5.13 操作日志
  ...require('./actions/import'), // §5.14-§5.17 Excel 导入
};

// 注册 Excel 导入业务 def（§5.20：进程内注册表，需与 import action 同进程）
common.registerImporter(require('./importers/stats'));

exports.main = async (event, context) => {
  // 定时触发器入口（config.json：monthly-archive 每月1日03:00 / daily-guard 每日04:00）
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
    console.error(`[admin] action=${action} 未捕获异常`, e);
    return common.fail(common.CODE.INTERNAL, '服务器开小差了');
  }
};
