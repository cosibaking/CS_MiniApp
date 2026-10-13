// actions/manage.js — 活动管理端接口（activity-module §5.2.1-§5.2.6，§3.1/§3.8）
// 全部 wrapAdminAction：权限硬校验 + 审计日志（admin-module §5.18 埋点清单）。
// 注意：wrap 内 handler 业务错误一律 throw new BizError(code, msg)（wrap 捕获后转 fail）。
const common = require('@club/admin-common');
const { wrapAdminAction, stub, BizError, CODE, maskPhone } = common;
const S = require('./shared');
const { BIZ, ACTIVITY_TYPES, ACTIVITY_STATUSES, PAGE_SIZE_MAX } = S;

const PAY_TYPES = ['wxpay', 'times_card', 'period_card'];
// update 可编辑字段白名单（§3.1）
const EDITABLE_FIELDS = [
  'title', 'type', 'cover', 'venue', 'address', 'location',
  'start_time', 'end_time', 'signup_deadline', 'price',
  'max_num', 'min_num', 'intro', 'pay_types',
];
const MAX_DURATION_MS = 12 * 3600 * 1000; // 活动时长上限（§3.1）
const PUBLISH_LEAD_MS = 30 * 60 * 1000;   // 发布需晚于当前至少 30 分钟（§3.1）

const P = (event) => (event.payload || {}).activity_id;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 分页解析（page ≥1；page_size 默认 20、上限 50）
function parsePaging(p) {
  const page = Number.isInteger(p.page) && p.page > 0 ? p.page : 1;
  let pageSize = Number.isInteger(p.page_size) && p.page_size > 0 ? p.page_size : 20;
  if (pageSize > PAGE_SIZE_MAX) pageSize = PAGE_SIZE_MAX;
  return { page, pageSize };
}

// 字段级校验（§3.1）：present 才校验；full=true 时追加发布态必填（title/cover/venue/address/type）
function validateActivityFields(p, full) {
  const err = (msg) => { throw new BizError(CODE.PARAM, `参数错误：${msg}`); };

  if (full && !p.title) err('title 必填');
  if (p.title != null && (typeof p.title !== 'string' || p.title.length < 1 || p.title.length > 30)) {
    err('title 需为 1~30 字');
  }
  if (full && !ACTIVITY_TYPES.includes(p.type)) err('type 必填且取值不合法');
  if (p.type != null && !ACTIVITY_TYPES.includes(p.type)) err('type 取值不合法');
  if (full && !p.cover) err('cover 必填');
  if (p.cover != null && (typeof p.cover !== 'string' || !p.cover)) err('cover 需为云存储 fileID');
  if (full && !p.cover.startsWith('cloud://')) err('cover 需为云存储 fileID（cloud:// 开头）');
  if (full && !p.venue) err('venue 必填');
  if (p.venue != null && (typeof p.venue !== 'string' || !p.venue.trim())) err('venue 不能为空');
  if (full && !p.address) err('address 必填');
  if (p.address != null && (typeof p.address !== 'string' || !p.address.trim())) err('address 不能为空');
  if (p.location != null) {
    const loc = p.location;
    if (!loc || typeof loc !== 'object' || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      err('location 需为含 lat/lng 数字的坐标对象');
    }
  }
  ['start_time', 'end_time', 'signup_deadline'].forEach((k) => {
    if (p[k] != null && (!Number.isInteger(p[k]) || p[k] <= 0)) err(`${k} 需为正整数毫秒时间戳`);
  });
  if (p.price != null && (!Number.isInteger(p.price) || p.price < 0)) err('price 需为 ≥0 的整数（单位：分）');
  if (p.max_num != null && (!Number.isInteger(p.max_num) || p.max_num < 1 || p.max_num > 500)) {
    err('max_num 需为 1~500 的整数');
  }
  if (p.min_num != null && (!Number.isInteger(p.min_num) || p.min_num < 1)) err('min_num 需 ≥1');
  if (p.intro != null) {
    if (typeof p.intro !== 'string' || p.intro.length > 5000) err('intro 需为不超过 5000 字的文本');
  }
  if (p.pay_types != null) {
    if (!Array.isArray(p.pay_types) || !p.pay_types.length
      || p.pay_types.some((t) => !PAY_TYPES.includes(t))) {
      err('pay_types 需为非空的支付方式数组（wxpay/times_card/period_card）');
    }
  }
}

// 跨字段校验（§3.1）：对合并视图执行；full=true 时追加发布态时效校验
function validateCrossFields(a, full) {
  const err = (msg) => { throw new BizError(CODE.PARAM, `参数错误：${msg}`); };

  if (full) {
    ['start_time', 'end_time', 'signup_deadline', 'max_num', 'min_num'].forEach((k) => {
      if (a[k] == null) err(`${k} 必填`);
    });
  }
  if (a.start_time != null && a.end_time != null) {
    if (a.end_time <= a.start_time) err('end_time 需晚于 start_time');
    if (a.end_time - a.start_time > MAX_DURATION_MS) err('活动时长不能超过 12 小时');
  }
  if (a.signup_deadline != null && a.start_time != null && a.signup_deadline > a.start_time) {
    err('signup_deadline 不能晚于 start_time');
  }
  if (a.min_num != null && a.max_num != null && a.min_num > a.max_num) {
    err('min_num 不能大于 max_num');
  }
  if (full) {
    const now = Date.now();
    if (a.start_time <= now + PUBLISH_LEAD_MS) err('start_time 需晚于当前时间至少 30 分钟');
    if (a.signup_deadline <= now) err('signup_deadline 需晚于当前时间');
  }
}

// §5.15 create — 创建草稿（title 必填；其余字段 present 校验，§3.1 草稿宽松口径）
async function create(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};

  if (!p.title || typeof p.title !== 'string' || p.title.length > 30) {
    throw new BizError(CODE.PARAM, '参数错误：title 需为 1~30 字');
  }
  validateActivityFields(p, false);
  validateCrossFields(p, false);

  const now = Date.now();
  const maxNum = Number.isInteger(p.max_num) ? p.max_num : 20;
  const doc = {
    title: p.title,
    type: p.type || null,
    cover: p.cover || '',
    venue: p.venue || '',
    address: p.address || '',
    location: p.location || null,
    start_time: p.start_time || null,
    end_time: p.end_time || null,
    signup_deadline: p.signup_deadline || null,
    price: Number.isInteger(p.price) ? p.price : 0,
    max_num: maxNum,
    min_num: Number.isInteger(p.min_num) ? p.min_num : 1,
    remain_num: maxNum,          // §6.1：初始 = max_num
    signup_count: 0,
    waitlist_count: 0,
    checkin_count: 0,
    status: 'draft',
    cancel_reason: '',
    pay_types: Array.isArray(p.pay_types) && p.pay_types.length ? [...p.pay_types] : [...PAY_TYPES],
    intro: p.intro || '',
    published_at: null,
    created_by: auth.operator.id,
    created_at: now,
    updated_at: now,
  };
  const res = await db.collection('activity').add({ data: doc });
  return { activity_id: res._id };
}

// §5.16 update — 编辑活动（draft 全量改 / published 受限改，§3.1 边界2）
async function update(event, auth) {
  const { cloud, db } = common.getContext();
  const _ = db.command;
  const p = event.payload || {};

  if (!p.activity_id || typeof p.activity_id !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const patch = {};
  Object.keys(p).forEach((k) => {
    if (EDITABLE_FIELDS.includes(k) && p[k] !== undefined) patch[k] = p[k];
  });
  if (!Object.keys(patch).length) {
    throw new BizError(CODE.PARAM, '参数错误：无可更新字段（仅支持 title/type/cover/venue/address/location/时间/price/max_num/min_num/intro/pay_types）');
  }

  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'draft' && activity.status !== 'published') {
    throw new BizError(BIZ.STATE_CONFLICT, '当前状态不可编辑');
  }

  // 字段级 + 合并视图跨字段校验
  validateActivityFields(patch, false);
  validateCrossFields(Object.assign({}, activity, patch), false);

  const now = Date.now();
  const data = Object.assign({}, patch, { updated_at: now });

  if (activity.status === 'draft') {
    // 草稿：全量可改；人数上限变化时重置剩余名额
    if (patch.max_num != null) data.remain_num = patch.max_num;
  } else {
    // 已发布：受限编辑（§3.1 边界2）
    // ① 价格锁定：存在有效报名（pending/enrolled/waitlist/checked_in）时不可改价
    if (patch.price != null && patch.price !== activity.price) {
      const cnt = await db.collection('activity_enrollment')
        .where({ activity_id: activity._id, status: _.in(S.ENROLLMENT_NOT_FINISHED) })
        .count();
      if ((cnt.total || 0) > 0) {
        throw new BizError(BIZ.STATE_CONFLICT, '已有有效报名，价格不可修改');
      }
    }
    // ② 人数上限只能调大（增量同步 remain_num）
    if (patch.max_num != null && patch.max_num < activity.max_num) {
      throw new BizError(BIZ.STATE_CONFLICT, '人数上限只能调大不能调小');
    }
    if (patch.max_num != null && patch.max_num > activity.max_num) {
      data.remain_num = _.inc(patch.max_num - activity.max_num);
    }
    // ③ 报名已截止或活动已开始：时间字段锁定
    const timeLocked = (activity.signup_deadline && now >= activity.signup_deadline)
      || (activity.start_time && now >= activity.start_time);
    if (timeLocked && ['start_time', 'end_time', 'signup_deadline'].some((k) => patch[k] !== undefined)) {
      throw new BizError(BIZ.NOT_ALLOWED, '报名已截止或活动已开始，不可修改时间字段');
    }
    // ④ 报名截止时间只能延长
    if (patch.signup_deadline != null && activity.signup_deadline
      && patch.signup_deadline < activity.signup_deadline) {
      throw new BizError(BIZ.STATE_CONFLICT, '报名截止时间只能延长');
    }
  }

  const upd = await db.collection('activity')
    .where({ _id: activity._id, status: activity.status })
    .update({ data });
  if (!upd.stats || upd.stats.updated !== 1) {
    throw new BizError(BIZ.STATE_CONFLICT, '状态已变化，请刷新后重试');
  }

  // ⑤ 开始时间推迟 → 异步通知已报名者（建议项，fire-and-forget）
  if (activity.status === 'published' && patch.start_time != null
    && patch.start_time > (activity.start_time || 0)) {
    notifyTimeChange(cloud, db, activity, patch.start_time);
  }

  return { updated_fields: Object.keys(patch) };
}

// 开始时间变更通知（pending/enrolled 各最多 100 条，非阻断）
function notifyTimeChange(cloud, db, activity, newStartTime) {
  setImmediate(async () => {
    try {
      const res = await db.collection('activity_enrollment')
        .where({ activity_id: activity._id, status: db.command.in(['pending', 'enrolled']) })
        .limit(100).get();
      const userMap = await S.fetchUserMap(db, res.data.map((e) => e.user_id));
      res.data.forEach((e) => {
        const u = userMap.get(e.user_id);
        if (u && u.openid) {
          S.sendSubscribeMsg(cloud, u.openid, 'ACTIVITY_TIME_CHANGE', {
            thing1: { value: String(activity.title).slice(0, 20) },
            time2: { value: S.formatDateTime(newStartTime) },
          }, 'pages/activity/detail?id=' + activity._id);
        }
      });
    } catch (e) {
      console.info('[notify] ACTIVITY_TIME_CHANGE 发送失败（不阻断）：', (e && e.errMsg) || e);
    }
  });
}

// §5.17 publish — 发布（仅 draft；§3.1 发布态全量校验）
async function publish(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};

  if (!p.activity_id || typeof p.activity_id !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'draft') {
    throw new BizError(BIZ.STATE_CONFLICT, '仅草稿状态可发布');
  }

  // 发布口径：字段必填 + 跨字段 + 时效（start>now+30min、deadline>now）
  validateActivityFields(activity, true);
  validateCrossFields(activity, true);

  const now = Date.now();
  const upd = await db.collection('activity')
    .where({ _id: activity._id, status: 'draft' })
    .update({ data: { status: 'published', published_at: now, updated_at: now } });
  if (!upd.stats || upd.stats.updated !== 1) {
    throw new BizError(BIZ.STATE_CONFLICT, '状态已变化，请刷新后重试');
  }
  return { status: 'published', published_at: now };
}

// §5.18 cancel — 取消活动（§3.8：事务置 cancelled + 名额冻结清零 + 批量联动 + 全员通知）
async function cancel(event, auth) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};

  if (!p.activity_id || typeof p.activity_id !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const reason = p.cancel_reason;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 100) {
    throw new BizError(CODE.PARAM, '参数错误：cancel_reason 需为 1~100 字');
  }
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'published' && activity.status !== 'signup_closed') {
    throw new BizError(BIZ.NOT_ALLOWED, '进行中或已结束的活动不可取消');
  }

  // §3.8 取消联动全流程（shared 共用：人工取消 activity_cancel / 成团校验自动取消 not_reached_min）
  const result = await S.runCancelFlow(cloud, db, activity, reason);
  if (result.conflict) {
    if (result.retryable) throw new BizError(BIZ.CONCURRENCY, '操作繁忙，请稍后重试');
    throw new BizError(BIZ.STATE_CONFLICT, '状态已变化，请刷新后重试');
  }
  return {
    cancelled: result.cancelled,
    refund_created: result.refund_created,
    refund_failed: result.refund_failed,
    notified: result.notified,
  };
}

// §5.19 adminList — 管理侧活动列表（全状态，分页 + status/type/keyword 筛选）
async function adminList(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};
  const { page, pageSize } = parsePaging(p);

  const where = {};
  if (p.status && p.status !== 'all') {
    if (!ACTIVITY_STATUSES.includes(p.status)) {
      throw new BizError(CODE.PARAM, '参数错误：status 取值不合法');
    }
    where.status = p.status;
  }
  if (p.type) {
    if (!ACTIVITY_TYPES.includes(p.type)) {
      throw new BizError(CODE.PARAM, '参数错误：type 取值不合法');
    }
    where.type = p.type;
  }
  if (p.keyword && typeof p.keyword === 'string') {
    const kw = p.keyword.trim();
    if (kw) where.title = db.RegExp({ regexp: escapeRegExp(kw), options: 'i' });
  }

  const cnt = await db.collection('activity').where(where).count();
  const res = await db.collection('activity').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .field({
      title: true, type: true, status: true,
      start_time: true, end_time: true, signup_deadline: true,
      price: true, max_num: true, min_num: true, remain_num: true,
      signup_count: true, waitlist_count: true, checkin_count: true,
      created_at: true, updated_at: true,
    })
    .get();

  return { total: cnt.total || 0, page, page_size: pageSize, list: res.data };
}

// §5.20 enrollList — 报名名单（分组 + 汇总 + 候补位次 + 手机号脱敏）
async function enrollList(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};

  if (!p.activity_id || typeof p.activity_id !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, p.activity_id);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');

  const group = p.group || 'all';
  const GROUPS = ['pending', 'enrolled', 'waitlist', 'checked_in', 'completed', 'cancelled', 'all'];
  if (!GROUPS.includes(group)) {
    throw new BizError(CODE.PARAM, '参数错误：group 取值不合法');
  }
  const { page, pageSize } = parsePaging(p);

  // 汇总：全状态计数 + 签到率（checked_in / (enrolled+checked_in)）
  const statuses = ['pending', 'enrolled', 'waitlist', 'checked_in', 'completed', 'cancelled'];
  const counts = await Promise.all(statuses.map((st) =>
    db.collection('activity_enrollment')
      .where({ activity_id: activity._id, status: st }).count()));
  const summary = {};
  statuses.forEach((st, i) => { summary[st] = counts[i].total || 0; });
  const shouldCheckin = summary.enrolled + summary.checked_in;
  summary.checkin_rate = shouldCheckin
    ? Math.round((summary.checked_in / shouldCheckin) * 100) / 100 : 0;

  // 列表：候补按入队序、已取消按最近变更倒序、其余按报名先后
  const where = { activity_id: activity._id };
  if (group !== 'all') where.status = group;
  let orderBy = 'created_at';
  let orderDir = 'asc';
  if (group === 'waitlist') orderBy = 'enqueue_at';
  else if (group === 'cancelled') { orderBy = 'updated_at'; orderDir = 'desc'; }

  const cnt = await db.collection('activity_enrollment').where(where).count();
  const res = await db.collection('activity_enrollment').where(where)
    .orderBy(orderBy, orderDir)
    .skip((page - 1) * pageSize).limit(pageSize)
    .get();

  // 联表脱敏手机号（enrollment 冗余昵称/头像，user 表兜底）
  const userMap = await S.fetchUserMap(db, res.data.map((e) => e.user_id));
  const list = res.data.map((e, i) => {
    const u = userMap.get(e.user_id) || null;
    return {
      _id: e._id,
      user_id: e.user_id,
      nickname: e.nickname || (u && u.nickname) || '',
      avatar: e.avatar || (u && u.avatar) || '',
      phone: u && u.phone ? maskPhone(u.phone) : '',
      pay_type: e.pay_type,
      status: e.status,
      order_id: e.order_id || null,
      checkin_time: e.checkin_time || null,
      team_id: e.team_id || null,
      created_at: e.created_at,
      position: group === 'waitlist' ? (page - 1) * pageSize + i + 1 : null,
    };
  });

  return { summary, total: cnt.total || 0, page, page_size: pageSize, list };
}

// ---------- M2：签到（§5.21/§5.22，§3.7）----------

// 到场汇总口径（与 enrollList summary 一致）：应到 = enrolled + checked_in
async function checkinCounts(db, activityId) {
  const _ = db.command;
  const [enr, chkin] = await Promise.all([
    db.collection('activity_enrollment')
      .where({ activity_id: activityId, status: 'enrolled' }).count(),
    db.collection('activity_enrollment')
      .where({ activity_id: activityId, status: 'checked_in' }).count(),
  ]);
  return { enrolled: enr.total || 0, checked_in: chkin.total || 0 };
}

// §5.21 getCheckinCode — 生成签到二维码（动态 token 60s 轮换；会员端扫码 selfCheckin 验签用）
async function getCheckinCode(event) {
  const { cloud, db } = common.getContext();
  const activityId = P(event);
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'signup_closed' && activity.status !== 'ongoing') {
    throw new BizError(BIZ.NOT_ALLOWED, '活动未到签到时段（报名截止后/进行中才可签到）');
  }
  const token = S.signCheckinToken(activityId);
  const { APPID } = cloud.getWXContext();
  return {
    qrcode_payload: `https://servicewechat.com/${APPID}/pages/activity/checkin-verify?activity_id=${activityId}&token=${token}`,
    token,
    expire_in: 60,
  };
}

// §5.22 confirmCheckin — 现场核验签到（幂等；次卡经 order/verifyCard 收口核销，§5.13/§3.7）
async function confirmCheckin(event, auth) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const enrollmentId = p.enrollment_id;
  if (!enrollmentId || typeof enrollmentId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：enrollment_id');
  }
  const enr = await S.getEnrollmentById(db, enrollmentId);
  if (!enr) throw new BizError(BIZ.NOT_FOUND, '报名记录不存在');
  const activity = await S.getActivityById(db, enr.activity_id);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');

  const now = Date.now();
  // 签到窗口（§3.7）：状态 ∈ signup_closed/ongoing，时间 ∈ [start_time-30min, end_time]
  const statusOk = activity.status === 'signup_closed' || activity.status === 'ongoing';
  const timeOk = now >= (activity.start_time || 0) - 30 * 60 * 1000
    && now <= (activity.end_time || 0);
  if (!statusOk || !timeOk) {
    throw new BizError(BIZ.NOT_ALLOWED, '当前不在签到时间窗口内');
  }

  // 幂等：已签到直接成功（不重复扣卡/计数）
  if (enr.status === 'checked_in') {
    const counts = await checkinCounts(db, activity._id);
    return {
      checkin_time: enr.checkin_time || now,
      card_write_off: 'skipped',
      checkin_count: activity.checkin_count || 0,
      total_enrolled: counts.enrolled + counts.checked_in,
    };
  }
  if (enr.status !== 'enrolled') {
    throw new BizError(BIZ.STATE_CONFLICT, '该报名状态不可签到（需已报名待到场）');
  }

  // 次卡核销收口（§5.13）：签到事务外调 order/verifyCard — 扣次 + used_times 同步 + 0 元核销单落库。
  // 失败不阻断签到（§3.7）：无卡/次数不足/事务异常 → failed；43003 幂等命中视为已核销
  //（覆盖「先核销后签到事务失败再重试」路径，保证卡只扣一次）。
  let cardWriteOff = enr.pay_type === 'times_card' ? 'failed' : 'skipped';
  if (enr.pay_type === 'times_card') {
    const v = await S.callOrderInternal(cloud, 'verifyCard', {
      user_id: enr.user_id,
      activity_id: activity._id,
    });
    if (v.ok || v.code === 43003 /* order CARD_DUP：该活动该用户已有核销单 */) {
      cardWriteOff = 'success';
    } else {
      console.error('[checkin] 次卡核销失败（不阻断）', enrollmentId, v.code, v.msg);
    }
  }
  let checkinCount = activity.checkin_count || 0;
  const transaction = await db.startTransaction();
  try {
    // 复检状态（防并发双核验）
    const cur = await transaction.collection('activity_enrollment').doc(enrollmentId).get();
    const doc = cur && cur.data;
    if (!doc || doc.status !== 'enrolled') {
      await transaction.rollback();
      throw new BizError(BIZ.STATE_CONFLICT, '该报名状态已变化，请刷新后重试');
    }
    await transaction.collection('activity_enrollment').doc(enrollmentId).update({
      data: {
        status: 'checked_in',
        checkin_time: now,
        checkin_by: auth.operator.id,
        checkin_request: null, // 待核验标记已消费
        updated_at: now,
      },
    });
    // checkin_count +1（事务内先读后写）
    const actCur = await transaction.collection('activity').doc(activity._id).get();
    const actDoc = actCur && actCur.data;
    if (actDoc) {
      checkinCount = (actDoc.checkin_count || 0) + 1;
      await transaction.collection('activity').doc(activity._id).update({
        data: { checkin_count: checkinCount, updated_at: now },
      });
    }
    await transaction.commit();
  } catch (e) {
    if (e instanceof BizError) throw e; // 状态复检失败（已回滚）
    try { await transaction.rollback(); } catch (e2) { /* 忽略回滚失败 */ }
    console.error('[checkin] 核验事务失败', enrollmentId, e);
    throw new BizError(BIZ.CONCURRENCY, '操作繁忙，请稍后重试');
  }

  const counts = await checkinCounts(db, activity._id);
  return {
    checkin_time: now,
    card_write_off: cardWriteOff,
    checkin_count: checkinCount,
    total_enrolled: counts.enrolled + counts.checked_in,
  };
}

// checkinWaiting — 签到工作台轮询（待核验队列 + 到场汇总）。
// 设计未单列的 M2 前端支撑接口：staff 角色无 publish_activity、无法复用 enrollList，故独立只读口。
async function checkinWaiting(event) {
  const { db } = common.getContext();
  const activityId = P(event);
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');

  const waitRes = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, status: 'enrolled', 'checkin_request.status': 'waiting' })
    .limit(200).get();
  const waiting = waitRes.data
    .sort((a, b) => ((a.checkin_request && a.checkin_request.requested_at) || 0)
      - ((b.checkin_request && b.checkin_request.requested_at) || 0))
    .map((e) => ({
      _id: e._id,
      user_id: e.user_id,
      nickname: e.nickname || '',
      avatar: e.avatar || '',
      pay_type: e.pay_type,
      requested_at: (e.checkin_request && e.checkin_request.requested_at) || null,
    }));
  const counts = await checkinCounts(db, activityId);
  return {
    waiting,
    summary: { checkin_count: counts.checked_in, total_enrolled: counts.enrolled + counts.checked_in },
  };
}

// ---------- M2：战绩（§5.23/§5.25，§3.9）----------

const STAT_FIELDS = ['kills', 'deaths', 'heals', 'supplies', 'captures'];

// §5.23 recordStats — 手动录入战绩（upsert）→ 荣誉重评定 → 军衔重算（fire-and-forget）
async function recordStats(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};
  const activityId = p.activity_id;
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const userId = p.user_id;
  if (!userId || typeof userId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：user_id');
  }
  const nums = {};
  for (const k of STAT_FIELDS) {
    const v = p[k];
    if (!Number.isInteger(v) || v < 0 || v > 999) {
      throw new BizError(CODE.PARAM, `参数错误：${k} 需为 0~999 的整数`);
    }
    nums[k] = v;
  }
  if (typeof p.is_win !== 'boolean') {
    throw new BizError(CODE.PARAM, '参数错误：is_win 必填（布尔）');
  }

  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'ongoing' && activity.status !== 'finished') {
    throw new BizError(BIZ.STATE_CONFLICT, '活动状态不允许录入战绩（进行中/已结束）');
  }
  // 资格：已报名且已签到（checked_in/completed）
  const _ = db.command;
  const enrRes = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, user_id: userId, status: _.in(['checked_in', 'completed']) })
    .limit(1).get();
  const enr = enrRes.data[0];
  if (!enr) throw new BizError(BIZ.STATE_CONFLICT, '该用户未报名或未签到，不可录入战绩');

  const now = Date.now();
  const user = await S.getDoc(db, 'user', userId);
  const payload = {
    activity_id: activityId,
    user_id: userId,
    nickname: (user && user.nickname) || enr.nickname || '',
    kills: nums.kills, deaths: nums.deaths, heals: nums.heals,
    supplies: nums.supplies, captures: nums.captures,
    is_win: p.is_win,
    honors: [], // 由重评定统一写回
    source: 'manual',
    recorded_by: auth.operator.id,
    updated_at: now,
  };
  let statsId = null;
  const existRes = await db.collection('activity_stats')
    .where({ activity_id: activityId, user_id: userId }).limit(1).get();
  const existing = existRes.data[0];
  if (existing) {
    statsId = existing._id;
    await db.collection('activity_stats').doc(existing._id).update({ data: payload });
  } else {
    const addRes = await db.collection('activity_stats')
      .add({ data: Object.assign({ created_at: now }, payload) });
    statsId = addRes._id;
  }

  // 荣誉重评定（同步）+ 军衔重算（fire-and-forget，失败自愈）
  const { touched, honored } = await S.reevaluateHonors(db, activityId);
  setImmediate(() => { S.recomputeRanks(db, touched).catch(() => {}); });

  return { stats_id: statsId, honors_of_match: honored };
}

// §5.25 statsList — 单场全员战绩（kills 倒序 + 荣誉汇总）
async function statsList(event) {
  const { db } = common.getContext();
  const activityId = P(event);
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');

  const res = await db.collection('activity_stats')
    .where({ activity_id: activityId })
    .orderBy('kills', 'desc').limit(1000).get();
  const list = res.data.map((s) => ({
    _id: s._id,
    user_id: s.user_id,
    nickname: s.nickname || '',
    kills: s.kills, deaths: s.deaths, heals: s.heals,
    supplies: s.supplies, captures: s.captures,
    is_win: s.is_win,
    honors: s.honors || [],
    source: s.source || 'manual',
    recorded_by: s.recorded_by || null,
    created_at: s.created_at || null,
  }));
  const pick = (honor) => list.filter((s) => s.honors.includes(honor)).map((s) => s.user_id);
  return {
    total: list.length,
    list,
    honor_summary: {
      mvp: pick('mvp'),
      svp: pick('svp'),
      best_heal: pick('best_heal'),
      best_supply: pick('best_supply'),
      best_capture: pick('best_capture'),
    },
  };
}

// statsCandidates — 战绩录入选人名单（已签到成员，按签到先后）。
// 权限隔离只读口：staff 无 publish_activity、无法复用 enrollList。
async function statsCandidates(event) {
  const { db } = common.getContext();
  const activityId = P(event);
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  const _ = db.command;
  const res = await db.collection('activity_enrollment')
    .where({ activity_id: activityId, status: _.in(['checked_in', 'completed']) })
    .limit(1000).get();
  const list = res.data
    .sort((a, b) => ((a.checkin_time || 0) - (b.checkin_time || 0)))
    .map((e) => ({ user_id: e.user_id, nickname: e.nickname || '' }));
  return { list };
}

// ---------- M2：相册（§5.26/§5.27，§3.12）----------

const ALBUM_IMG_LIMIT = 200;               // 图片容量上限（§3.12）
const ALBUM_VIDEO_LIMIT = 10;              // 视频容量上限
const ALBUM_IMG_MAX_SIZE = 1024 * 1024;    // 单图 ≤ 1MB
const ALBUM_VIDEO_MAX_SIZE = 50 * 1024 * 1024; // 单视频 ≤ 50MB

// §5.26 uploadAlbum — 批量上传相册（冗余活动标题/封面与上传者快照，§6.5/§6.6）
async function uploadAlbum(event, auth) {
  const { db } = common.getContext();
  const p = event.payload || {};
  const activityId = p.activity_id;
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const items = p.items;
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    throw new BizError(CODE.PARAM, '参数错误：items 需为 1~50 个的文件数组');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');

  // 清洗与单文件校验
  const clean = items.map((it) => {
    if (!it || typeof it.file_id !== 'string' || !it.file_id.startsWith('cloud://')) {
      throw new BizError(CODE.PARAM, '参数错误：file_id 需为云存储 fileID（cloud:// 开头）');
    }
    if (it.media_type !== 'image' && it.media_type !== 'video') {
      throw new BizError(CODE.PARAM, '参数错误：media_type 仅支持 image/video');
    }
    const size = Number(it.size) || 0;
    if (it.media_type === 'image' && size > ALBUM_IMG_MAX_SIZE) {
      throw new BizError(CODE.PARAM, '单张图片不能超过 1MB（请压缩后上传）');
    }
    if (it.media_type === 'video' && size > ALBUM_VIDEO_MAX_SIZE) {
      throw new BizError(CODE.PARAM, '单个视频不能超过 50MB');
    }
    return { file_id: it.file_id, media_type: it.media_type, size };
  });

  // 容量校验（status=normal 计数，§3.12）
  const _ = db.command;
  const [imgCnt, vidCnt] = await Promise.all(['image', 'video'].map((t) =>
    db.collection('activity_album')
      .where({ activity_id: activityId, media_type: t, status: 'normal' }).count()
      .then((r) => r.total || 0)));
  const addImg = clean.filter((c) => c.media_type === 'image').length;
  const addVid = clean.length - addImg;
  if (imgCnt + addImg > ALBUM_IMG_LIMIT) {
    throw new BizError(BIZ.NOT_ALLOWED, `图片容量不足（现有 ${imgCnt}/${ALBUM_IMG_LIMIT}，本次拟加 ${addImg}）`);
  }
  if (vidCnt + addVid > ALBUM_VIDEO_LIMIT) {
    throw new BizError(BIZ.NOT_ALLOWED, `视频容量不足（现有 ${vidCnt}/${ALBUM_VIDEO_LIMIT}，本次拟加 ${addVid}）`);
  }

  const now = Date.now();
  const docs = clean.map((c) => ({
    activity_id: activityId,
    activity_title: activity.title,
    activity_cover: activity.cover || '',
    file_id: c.file_id,
    media_type: c.media_type,
    size: c.size,
    uploader_id: auth.operator.id,
    uploader_name: auth.operator.name || '',
    status: 'normal',
    created_at: now,
  }));
  await Promise.all(docs.map((d) => db.collection('activity_album').add({ data: d })));

  return {
    created: docs.length,
    album_total: imgCnt + vidCnt + docs.length,
    image_total: imgCnt + addImg,
    video_total: vidCnt + addVid,
    limit: ALBUM_IMG_LIMIT,
  };
}

// §5.27 deleteAlbum — 批量删除（云存储 + db 记录物理删除）
async function deleteAlbum(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const ids = p.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100) {
    throw new BizError(CODE.PARAM, '参数错误：ids 需为 1~100 个的记录 ID 数组');
  }
  const _ = db.command;
  const res = await db.collection('activity_album').where({ _id: _.in(ids) }).limit(100).get();
  const docs = res.data;
  if (!docs.length) return { deleted: 0 };

  // 云存储删除（失败不阻断，存储残留可人工清理）
  const fileIds = [...new Set(docs.map((d) => d.file_id).filter(Boolean))];
  if (fileIds.length) {
    try {
      await cloud.deleteFile({ fileList: fileIds });
    } catch (e) {
      console.warn('[album] 云存储删除失败（不阻断）', e);
    }
  }
  let deleted = 0;
  for (const d of docs) {
    const del = await db.collection('activity_album').doc(d._id).remove();
    if (del.stats && del.stats.removed === 1) deleted += 1;
  }
  return { deleted };
}

// ---------- M2：候补递补与评价（§5.28/§5.29）----------

// §5.28 promoteWaitlist — 候补递补（user_id 指定 / 缺省按队首自动，复用 §3.6 流程）
async function promoteWaitlist(event) {
  const { cloud, db } = common.getContext();
  const p = event.payload || {};
  const activityId = p.activity_id;
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  if (activity.status !== 'published' || (activity.signup_deadline || 0) <= Date.now()) {
    throw new BizError(BIZ.NOT_ALLOWED, '活动不在可递补状态（需已发布且未过报名截止）');
  }

  if (p.user_id) {
    // 运营指定递补：该用户须在候补队列中（取其最早一条候补记录）
    const _ = db.command;
    const candRes = await db.collection('activity_enrollment')
      .where({ activity_id: activityId, user_id: p.user_id, status: 'waitlist' })
      .orderBy('enqueue_at', 'asc').limit(1).get();
    const candidate = candRes.data[0];
    if (!candidate) throw new BizError(BIZ.NOT_FOUND, '该用户不在候补队列中');
    const res = await S.promoteCandidate(cloud, db, activity, candidate);
    if (res && res.promoted) {
      return { promoted_user_id: res.promoted.userId, expire_at: res.promoted.expireAt, notified: true };
    }
    if (res && res.skipped) {
      throw new BizError(BIZ.STATE_CONFLICT, `递补校验未通过：${res.skipped}（该候补已转为取消）`);
    }
    throw new BizError(BIZ.CONCURRENCY, '名额已被抢占或操作繁忙，请刷新后重试');
  }

  // 缺省：按队首顺序自动递补（shared §3.6 完整流程，含冲突跳过）
  const promoted = await S.promoteWaitlist(cloud, db, activityId);
  if (!promoted) {
    throw new BizError(BIZ.STATE_CONFLICT, '暂无可递补对象（名额未空出或候补均校验未通过）');
  }
  return { promoted_user_id: promoted.userId, expire_at: promoted.expireAt, notified: true };
}

// §5.29 reviewList — 评价列表（星级汇总 + 分布，仅查看）
async function reviewList(event) {
  const { db } = common.getContext();
  const p = event.payload || {};
  const activityId = p.activity_id;
  if (!activityId || typeof activityId !== 'string') {
    throw new BizError(CODE.PARAM, '参数错误：activity_id');
  }
  const activity = await S.getActivityById(db, activityId);
  if (!activity) throw new BizError(BIZ.NOT_FOUND, '活动不存在');
  const { page, pageSize } = parsePaging(p);

  const where = { activity_id: activityId };
  const cnt = await db.collection('activity_review').where(where).count();
  const res = await db.collection('activity_review').where(where)
    .orderBy('created_at', 'desc')
    .skip((page - 1) * pageSize).limit(pageSize)
    .get();

  // 汇总：全量拉一次算均分与分布（单场评价量有限，limit 1000 兜底）
  const all = await db.collection('activity_review').where(where).limit(1000).get();
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let starSum = 0;
  all.data.forEach((r) => {
    const s = Math.min(5, Math.max(1, Number(r.stars) || 0));
    dist[s] += 1;
    starSum += s;
  });
  const count = cnt.total || 0;

  // 联表头像（评价快照昵称，user 表兜底头像）
  const userMap = await S.fetchUserMap(db, res.data.map((r) => r.user_id));
  const list = res.data.map((r) => {
    const u = userMap.get(r.user_id) || null;
    return {
      _id: r._id,
      user_id: r.user_id,
      nickname: r.nickname || (u && u.nickname) || '',
      avatar: (u && u.avatar) || '',
      stars: r.stars,
      content: r.content || '',
      created_at: r.created_at,
    };
  });
  return {
    summary: {
      avg_stars: count ? Math.round((starSum / count) * 10) / 10 : 0,
      count,
      distribution: dist,
    },
    total: count,
    page,
    page_size: pageSize,
    list,
  };
}

module.exports = {
  // §5.15 create — 创建活动（publish_activity）→ 日志 activity.create
  create: wrapAdminAction('activity.create', create, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity',
    targetId: (event, result) => (result && result.activity_id) || null,
    detail: (event) => ({ title: (event.payload || {}).title }),
  }),
  // §5.16 update — 编辑活动 → 日志 activity.update
  update: wrapAdminAction('activity.update', update, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity', targetId: P,
    detail: (event, result) => ({ fields: (result && result.updated_fields) || [] }),
  }),
  // §5.17 publish — 发布活动 → 日志 activity.publish
  publish: wrapAdminAction('activity.publish', publish, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity', targetId: P,
  }),
  // §5.18 cancel — 取消活动（触发自动全额退款）→ 日志 activity.cancel
  cancel: wrapAdminAction('activity.cancel', cancel, {
    permission: 'cancel_activity', module: 'activity', targetType: 'activity', targetId: P,
    detail: (event, result) => ({
      reason: (event.payload || {}).cancel_reason,
      cancelled: result && result.cancelled,
      refund_created: result && result.refund_created,
      refund_failed: result && result.refund_failed,
    }),
  }),
  // §5.19 adminList — 管理侧活动列表
  adminList: wrapAdminAction('activity.admin.list', adminList, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity',
    detail: (event) => ({
      keyword: (event.payload || {}).keyword || null,
      status: (event.payload || {}).status || null,
    }),
  }),
  // §5.20 enrollList — 报名名单（含候补）
  enrollList: wrapAdminAction('activity.enroll.list', enrollList, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity', targetId: P,
    detail: (event) => ({ group: (event.payload || {}).group || 'all' }),
  }),

  // ---------- M2 落地实现（activity-module §5.21-§5.29）----------

  // §5.21 getCheckinCode — 生成签到二维码（checkin_activity；查询不记日志 R9，前端 60s 轮换拉取频繁）
  getCheckinCode: wrapAdminAction('activity.checkin.code', getCheckinCode, {
    permission: 'checkin_activity', module: 'activity', targetType: 'activity', targetId: P,
    log: false,
  }),
  // §5.22 confirmCheckin — 现场核验签到（联动次卡核销 order/verifyCard）→ 日志 activity.checkin
  // payload 为 enrollment_id（无 activity_id），targetId 记报名记录 id；detail 输出次卡核销结果
  confirmCheckin: wrapAdminAction('activity.checkin', confirmCheckin, {
    permission: 'checkin_activity', module: 'activity', targetType: 'activity',
    targetId: (event) => (event.payload || {}).enrollment_id || null,
    detail: (event, result) => ({ card_write_off: result && result.card_write_off }),
  }),
  // 签到工作台待核验列表（checkin_activity；查询不记日志 R9。
  // staff 无 publish_activity 无法复用 enrollList，故单列只读口，设计契约外补充）
  checkinWaiting: wrapAdminAction('activity.checkin.waiting', checkinWaiting, {
    permission: 'checkin_activity', module: 'activity', targetType: 'activity', targetId: P,
    log: false,
  }),
  // §5.23 recordStats — 手动录入战绩（record_stats；荣誉自动评定 MVP/SVP）→ 日志 stats.record
  recordStats: wrapAdminAction('stats.record', recordStats, {
    permission: 'record_stats', module: 'stats', targetType: 'stats', targetId: P,
    detail: (event, result) => ({ honors_of_match: (result && result.honors_of_match) || [] }),
  }),
  // §5.24 importStats — Excel 批量导入战绩（record_stats）
  // 入口归并（admin-module §7）：内部转发 admin/import/submit——解析/校验/逐行写入/批量日志
  // 均在 admin 侧完成，本侧 log:false 避免重复埋点；云函数间调用透传原始用户上下文。
  importStats: wrapAdminAction('stats.import', async (event) => {
    const { cloud } = common.getContext();
    const res = await cloud.callFunction({
      name: 'admin',
      data: { action: 'import/submit', payload: event.payload || {} },
    });
    const r = (res && res.result) || {};
    if (r.code !== 0) throw new BizError(r.code, r.msg || '导入失败');
    return r.data;
  }, {
    permission: 'record_stats', module: 'stats', targetType: 'stats', targetId: P, log: false,
  }),
  // §5.25 statsList — 战绩查询（record_stats；查询不记日志 R9）
  statsList: wrapAdminAction('stats.list', statsList, {
    permission: 'record_stats', module: 'stats', targetType: 'stats', targetId: P,
    log: false,
  }),
  // 战绩录入选人名单（record_stats；查询不记日志 R9。
  // 只读口：录入页选人无需 publish_activity，不依赖 enrollList）
  statsCandidates: wrapAdminAction('stats.candidates', statsCandidates, {
    permission: 'record_stats', module: 'stats', targetType: 'stats', targetId: P,
    log: false,
  }),
  // §5.26 uploadAlbum — 上传相册（upload_album）→ 日志 album.upload
  uploadAlbum: wrapAdminAction('album.upload', uploadAlbum, {
    permission: 'upload_album', module: 'album', targetType: 'album', targetId: P,
    detail: (event, result) => ({ created: result && result.created }),
  }),
  // §5.27 deleteAlbum — 删除相册图片 → 日志 album.delete
  deleteAlbum: wrapAdminAction('album.delete', deleteAlbum, {
    permission: 'upload_album', module: 'album', targetType: 'album', targetId: P,
    detail: (event, result) => ({ deleted: result && result.deleted }),
  }),
  // §5.28 promoteWaitlist — 候补递补（publish_activity）→ 日志 activity.promote
  promoteWaitlist: wrapAdminAction('activity.promote', promoteWaitlist, {
    permission: 'publish_activity', module: 'activity', targetType: 'activity', targetId: P,
    detail: (event, result) => ({ promoted_user_id: result && result.promoted_user_id }),
  }),
  // §5.29 reviewList — 评价列表（登录即可：不挂权限点，仅登录态校验；查询不记日志 R9）
  reviewList: wrapAdminAction('activity.review.list', reviewList, {
    module: 'activity', targetType: 'activity', targetId: P,
    log: false,
  }),
};
