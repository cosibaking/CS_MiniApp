// actions/cron.js — 活动定时任务（activity-module §3.5/§3.6/§3.11/§7.6，§8.15）
// 触发器见 config.json（云开发 cron 为 7 字段）：
//   activity-every-minute  0 * * * * * *   每分钟（超时未支付释放名额 + 候补递补）
//   activity-every-5min    0 */5 * * * * * 每5分钟（状态流转 published→signup_closed→ongoing→finished + 成团校验）
//   activity-daily-3am     0 0 3 * * * *   每日03:00（相册归档，M2）
//   activity-daily-9am     0 0 9 * * * *   每日09:00（活动开始前提醒，建议，M2）
// 任务幂等可重入（§8.15）：按状态条件扫描 + 事务/条件更新复检，重复执行无副作用；
// 单轮批量上限 200，超出部分下轮继续；执行结果落云函数日志可观测。
const common = require('@club/admin-common');
const S = require('./shared');

// 任务1（§3.5/§3.6）：超时未支付释放 + 候补递补。
// 释放与递补分步执行：先释放成功再递补，递补失败不影响释放结果（§3.5 边界2）；
// 活动已取消/已截止仍执行释放（保持数据一致），不再递补（§3.5 边界3）。
async function payTimeoutRelease() {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const now = Date.now();

  const res = await db.collection('activity_enrollment')
    .where({ status: 'pending', expire_at: _.lt(now) })
    .limit(200).get(); // §3.5 边界4：单轮 ≤200，超出下轮继续
  const expired = res.data || [];
  if (!expired.length) return { scanned: 0, released: 0, promoted: 0 };

  const releasedList = [];
  let promoted = 0;
  for (const enr of expired) {
    const rel = await S.releaseEnrollment(db, enr, {
      cancelType: 'pay_timeout', // §3.5 ②
      sourceStatus: 'pending',
      incRemain: true,
      closeOrder: true, // 同事务关单（架构 §6.2 订单状态机）
      orderReason: 'timeout',
    });
    if (!rel.released) continue; // 状态已变（幂等跳过）或事务冲突（下轮重试）
    releasedList.push(enr);

    // 事务提交后触发候补递补（§3.5 ②；活动已取消时内部直接返回 null）
    try {
      const p = await S.promoteWaitlist(cloud, db, enr.activity_id);
      if (p) promoted += 1;
    } catch (e) {
      console.warn('[activity/cron] 递补失败（不阻断，下轮重试）：', enr.activity_id, e);
    }
  }

  // 「报名超时释放」订阅消息（建议可调，模板未配置静默跳过，§7.5）
  if (releasedList.length) {
    const userMap = await S.fetchUserMap(db, releasedList.map((e) => e.user_id));
    releasedList.forEach((enr) => {
      const u = userMap.get(enr.user_id);
      if (u && u.openid) {
        S.sendSubscribeMsg(cloud, u.openid, 'PAY_TIMEOUT_RELEASED', {
          thing1: { value: String(enr.activity_title || '').slice(0, 20) },
        }, 'pages/activity/list/list');
      }
    });
  }

  return { scanned: expired.length, released: releasedList.length, promoted };
}

// 任务2（§3.11）：状态流转 + 成团校验。
// published→signup_closed（截止；成团校验不过→自动取消）/ signup_closed→ongoing（开始）/
// ongoing→finished（结束；checked_in 批量置 completed）。
async function statusShift() {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const now = Date.now();
  const result = {
    deadline_checked: 0, signup_closed: 0, auto_cancelled: 0,
    started: 0, finished: 0, completed: 0,
  };

  // ① published 且已过报名截止 → 成团校验 → signup_closed / 自动取消（§3.11，建议可调）
  const due = await db.collection('activity')
    .where({ status: 'published', signup_deadline: _.lte(now) })
    .limit(100).get();
  for (const act of due.data || []) {
    result.deadline_checked += 1;
    // 有效报名数 = 已报名 + 待支付 + 已签到（§3.11）
    const cnt = await db.collection('activity_enrollment')
      .where({ activity_id: act._id, status: _.in(['enrolled', 'pending', 'checked_in']) })
      .count();
    const valid = (cnt && cnt.total) || 0;
    if (valid < (act.min_num || 1)) {
      // 未成团：自动取消 + §3.8 全额退款联动 + 全员通知（enrollment.cancel_type=not_reached_min）
      const cancelRes = await S.runCancelFlow(cloud, db, act, '未达最低成团人数，自动取消', { cancelType: 'not_reached_min' });
      if (cancelRes.conflict) {
        console.warn(`[activity/cron] 成团取消冲突（下轮重试）：${act._id}`);
        continue;
      }
      result.auto_cancelled += 1;
      console.info(`[activity/cron] 未成团自动取消：${act._id}（有效报名 ${valid}/${act.min_num}，退款 ${cancelRes.refund_created}，通知 ${cancelRes.notified}）`);
      continue;
    }
    const upd = await db.collection('activity')
      .where({ _id: act._id, status: 'published' })
      .update({ data: { status: 'signup_closed', updated_at: now } });
    if (upd.stats && upd.stats.updated === 1) result.signup_closed += 1;
  }

  // ② signup_closed 且已到开始时间 → ongoing
  const starting = await db.collection('activity')
    .where({ status: 'signup_closed', start_time: _.lte(now) })
    .limit(100).get();
  for (const act of starting.data || []) {
    const upd = await db.collection('activity')
      .where({ _id: act._id, status: 'signup_closed' })
      .update({ data: { status: 'ongoing', updated_at: now } });
    if (upd.stats && upd.stats.updated === 1) result.started += 1;
  }

  // ③ ongoing 且已过结束时间 → finished + 该活动 checked_in 批量置 completed
  const ending = await db.collection('activity')
    .where({ status: 'ongoing', end_time: _.lte(now) })
    .limit(100).get();
  for (const act of ending.data || []) {
    const upd = await db.collection('activity')
      .where({ _id: act._id, status: 'ongoing' })
      .update({ data: { status: 'finished', updated_at: now } });
    if (!upd.stats || upd.stats.updated !== 1) continue;
    result.finished += 1;
    const chk = await db.collection('activity_enrollment')
      .where({ activity_id: act._id, status: 'checked_in' })
      .update({ data: { status: 'completed', updated_at: now } });
    if (chk.stats && chk.stats.updated) result.completed += chk.stats.updated;
  }

  return result;
}

// 任务3（§3.12）：相册归档清理（保留期 90 天，可调）。
// 每日 03:00 扫描 created_at < now-90d 且 status='normal' → 条件更新置 archived（会员端立即隐藏）；
// 幂等可重入（§8.15）：条件更新复检，status 已变更自动跳过；单轮上限 200，超出下轮继续。
// 物理删除由管理端 deleteAlbum（管理员下载留存后确认，两步防误删）执行，本任务仅做归档标记。
async function albumArchive() {
  const { db } = common.getContext();
  const _ = db.command;
  const RETENTION_DAYS = 90; // 保留期（§3.12 建议取 90 天，可调）
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const due = await db.collection('activity_album')
    .where({ status: 'normal', created_at: _.lt(cutoff) })
    .field({ activity_id: true, activity_title: true, file_id: true, media_type: true })
    .limit(200).get(); // 单轮 ≤200，超出下轮继续
  const list = due.data || [];
  if (!list.length) return { scanned: 0, archived: 0 };

  let archived = 0;
  const summary = new Map(); // 归档清单（§3.12：活动/数量，落日志供管理员留存对照）
  for (const alb of list) {
    // 条件更新复检：status 仍为 normal 才置 archived（并发/重复扫描幂等）
    const upd = await db.collection('activity_album')
      .where({ _id: alb._id, status: 'normal' })
      .update({ data: { status: 'archived' } });
    if (!upd.stats || upd.stats.updated !== 1) continue;
    archived += 1;
    const key = alb.activity_title || alb.activity_id;
    if (!summary.has(key)) {
      summary.set(key, { activity_id: alb.activity_id, image: 0, video: 0 });
    }
    const s = summary.get(key);
    if (alb.media_type === 'video') s.video += 1;
    else s.image += 1;
  }
  summary.forEach((s, title) => {
    console.info(`[activity/cron] 相册归档：${title}（图片 ${s.image} / 视频 ${s.video}）activity_id=${s.activity_id}`);
  });
  return { scanned: list.length, archived };
}

// 任务4（§3.11/§7.5，建议可调）：活动开始前提醒。
// 每日 09:00 扫描 24h 内开始（now < start_time ≤ now+24h）且已发布未开场的活动，
// 对已报名（enrolled）用户发「活动提醒」订阅消息；候补/待支付不提醒（未生效占位）。
// 幂等（§8.15）：活动级 start_remind_sent 标记 + 条件更新复检，重复触发不重发；
// 活动时间变更已由 update 单独发 ACTIVITY_TIME_CHANGE 通知，本任务不做二次提醒。
async function startRemind() {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const now = Date.now();
  const WINDOW = 24 * 60 * 60 * 1000; // 提前提醒窗口（§3.11 建议 24h，可调）

  const due = await db.collection('activity')
    .where({
      status: _.in(['published', 'signup_closed']),
      start_time: _.gt(now).and(_.lte(now + WINDOW)),
      start_remind_sent: _.neq(true), // 未提醒过（字段缺失视为未提醒）
    })
    .field({ title: true, start_time: true })
    .limit(100).get(); // 单轮 ≤100（同 statusShift），超出下轮继续
  const list = due.data || [];
  if (!list.length) return { scanned: 0, reminded: 0, notified: 0 };

  let reminded = 0;
  let notified = 0;
  for (const act of list) {
    // 条件更新复检：置标记成功才发送（并发/重复触发幂等，§8.15）
    const upd = await db.collection('activity')
      .where({ _id: act._id, start_remind_sent: _.neq(true) })
      .update({ data: { start_remind_sent: true, updated_at: now } });
    if (!upd.stats || upd.stats.updated !== 1) continue;
    reminded += 1;

    const enr = await db.collection('activity_enrollment')
      .where({ activity_id: act._id, status: 'enrolled' })
      .field({ user_id: true })
      .limit(1000).get(); // 报名上限内，limit 1000 兜底（同 detail 榜口径）
    if (!enr.data || !enr.data.length) continue;
    const userMap = await S.fetchUserMap(db, enr.data.map((e) => e.user_id));
    enr.data.forEach((e) => {
      const u = userMap.get(e.user_id);
      if (u && u.openid) {
        // 「活动提醒」模板未配置静默跳过（§7.5）；字段与 ACTIVITY_TIME_CHANGE 同构
        S.sendSubscribeMsg(cloud, u.openid, 'ACTIVITY_REMIND', {
          thing1: { value: String(act.title || '').slice(0, 20) },
          time2: { value: S.formatDateTime(act.start_time) },
        }, 'pages/activity/detail?id=' + act._id);
        notified += 1;
      }
    });
    console.info(`[activity/cron] 开始前提醒：${act.title}（${S.formatDateTime(act.start_time)} 开始，通知 ${enr.data.length} 人）`);
  }
  return { scanned: list.length, reminded, notified };
}

const TASKS = {
  'activity-every-minute': payTimeoutRelease,
  'activity-every-5min': statusShift,
  'activity-daily-3am': albumArchive,
  'activity-daily-9am': startRemind,
};

async function main(event) {
  const name = (event && event.TriggerName) || 'unknown';
  const task = TASKS[name];
  if (!task) {
    console.warn(`[activity/cron] 未注册的触发器: ${name}`);
    return null;
  }
  const startedAt = Date.now();
  try {
    const result = await task(event);
    console.info(`[activity/cron] ${name} 完成（${Date.now() - startedAt}ms）：`, JSON.stringify(result || {}));
    return result;
  } catch (e) {
    // 单轮失败不外抛：幂等可重入，下轮自动补漏（§8.15）
    console.error(`[activity/cron] ${name} 执行失败：`, e);
    return null;
  }
}

module.exports = { main };
