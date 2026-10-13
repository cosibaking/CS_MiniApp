// cloudfunctions/team — 战队模块云函数（docs/design/team-module.md）
// 该模块无定时触发器（config.json 仅占位）
const cloud = require('wx-server-sdk');
const common = require('@club/admin-common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
common.setup({ cloud, db });

const actions = {
  ...require('./actions/basic'),   // §5.1-§5.5 基础
  ...require('./actions/member'),  // §5.6-§5.14 成员管理
  ...require('./actions/admin'),   // §5.15-§5.16 审核、§5.20 解散
  ...require('./actions/contest'), // §5.17-§5.19 排名与报名
};

exports.main = async (event, context) => {
  const action = event && event.action;
  const handler = actions[action];
  if (!handler) {
    return common.fail(common.CODE.PARAM, `未知操作：${action || '(空)'}`);
  }

  try {
    return await handler(event, context);
  } catch (e) {
    console.error(`[team] action=${action} 未捕获异常`, e);
    return common.fail(common.CODE.INTERNAL, '服务器开小差了');
  }
};
