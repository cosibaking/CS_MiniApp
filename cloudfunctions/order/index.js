// cloudfunctions/order — 订单支付模块云函数（docs/design/payment-module.md）
// 支付方案：云调用 cloudPay（免验签）；金额单位分；订单号 CS+yyMMddHHmmss+实例4+随机6
const cloud = require('wx-server-sdk');
const common = require('@club/admin-common');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
common.setup({ cloud, db });

const actions = {
  ...require('./actions/order'),  // §5.1-§5.5、§5.7-§5.9 下单/支付/查询/取消
  ...require('./actions/pay'),    // §5.6 支付回调（特殊返回结构）
  ...require('./actions/refund'), // §5.10-§5.12 退款
  ...require('./actions/card'),   // §5.13 次卡核销（P1）
};

exports.main = async (event, context) => {
  // 定时触发器入口（config.json：order-close-timeout 每分钟 / order-reconcile 每日05:00）
  if (event && event.Type === 'Timer') {
    return require('./actions/cron').main(event);
  }

  // 微信支付回调入口（§5.3）：无 action，event 为微信侧解析后的回调 JSON；
  // 出参 { errcode, errmsg } 微信协议结构 —— callback 内部自行兜异常，
  // 不走下方统一 catch（统一 fail 结构会让微信无法识别应答）
  if (event && !event.action && (event.outTradeNo || event.returnCode)) {
    return actions.callback(event, context);
  }

  const action = event && event.action;
  const handler = actions[action];
  if (!handler) {
    return common.fail(common.CODE.PARAM, `未知操作：${action || '(空)'}`);
  }

  try {
    return await handler(event, context);
  } catch (e) {
    console.error(`[order] action=${action} 未捕获异常`, e);
    return common.fail(common.CODE.INTERNAL, '服务器开小差了');
  }
};
