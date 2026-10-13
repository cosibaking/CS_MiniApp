// actions/cron.js — 定时任务入口（按 TriggerName 分发）
// 触发器定义见 config.json；云开发 cron 为 7 字段：秒 分 时 日 月 星期 年
const TASKS = {
  'user-expire-cards': {
    doc: 'user-module §5.22 — 每日 00:05 会员卡到期处理',
    fn: require('./internal').expireCards,
  },
};

async function main(event) {
  const name = (event && event.TriggerName) || 'unknown';
  const task = TASKS[name];
  if (!task) {
    console.warn(`[user/cron] 未注册的触发器: ${name}`);
    return;
  }
  console.log(`[user/cron] ${name} 开始执行 — ${task.doc}`);
  try {
    await task.fn(event);
  } catch (e) {
    console.error(`[user/cron] ${name} 执行失败`, e);
  }
}

module.exports = { main };
