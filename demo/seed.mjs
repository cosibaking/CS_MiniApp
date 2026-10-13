// demo/seed.mjs — 演示数据构造（ESM，供 server.mjs 调用）
// 字段口径严格对齐云函数真实读写（调研自各 actions 写入方/读取方）：
//   - 时间全部毫秒时间戳；金额单位分；order_no = 'CS'+yyMMddHHmmss(东八区)+实例+随机
//   - 规避三处代码口径不一致：agreement 同时写 type/agreement_type；
//     activity_review 必须带 status:'published'（view.js 按 status 过滤）；
//     次卡核销单 biz_type 用 'activity_signup'（本次 seed 未构造核销单）
//   - team_stats 无代码创建方、队长本人需 active 的 team_member 记录，均在此手工构造

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const H = 3600 * 1000;
const D = 24 * H;

// ---------- 小工具 ----------

function pad(n) { return String(n).padStart(2, '0'); }

// 东八区 yyMMddHHmmss（与 activity/actions/shared.js:181 同口径）
function cstStamp(ts) {
  const d = new Date(ts + 8 * H);
  return `${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function orderNo(ts, seq) {
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  return `CS${cstStamp(ts)}D00${seq}${rand}`.slice(0, 24);
}

function refundNo(ts, seq) {
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  return `RF${cstStamp(ts)}D00${seq}${rand}`.slice(0, 24);
}

function endOfDay(ts) {
  const d = new Date(ts + 8 * H);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999) - 8 * H;
}

// ---------- SVG 素材（封面/头像/相册/队标） ----------

function svgCover(title, sub, c1, c2) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="750" height="420" viewBox="0 0 750 420">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="750" height="420" fill="url(#g)"/>
<circle cx="620" cy="80" r="140" fill="rgba(255,255,255,0.08)"/>
<circle cx="120" cy="360" r="100" fill="rgba(255,255,255,0.06)"/>
<text x="60" y="200" font-family="sans-serif" font-size="56" font-weight="bold" fill="#fff">${title}</text>
<text x="60" y="260" font-family="sans-serif" font-size="26" fill="rgba(255,255,255,0.8)">${sub}</text>
</svg>`;
}

function svgAvatar(letter, c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="100" fill="${c}"/><text x="100" y="132" text-anchor="middle" font-family="sans-serif" font-size="88" font-weight="bold" fill="#fff">${letter}</text></svg>`;
}

function svgPhoto(label, i) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
<rect width="640" height="480" fill="#2B3A4A"/>
<rect x="40" y="40" width="560" height="400" fill="#1F2A38" rx="16"/>
<circle cx="${160 + i * 100}" cy="200" r="70" fill="#C8552F" opacity="0.85"/>
<rect x="90" y="320" width="460" height="14" rx="7" fill="#4A5A6A"/>
<text x="320" y="270" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#8A9AAB"> ${label} </text>
</svg>`;
}

function buildDemoFiles() {
  return [
    { id: 'img_cover_1', mime: 'image/svg+xml', cloudPath: 'demo/cover_1.svg', content: Buffer.from(svgCover('周末主题对抗赛', '全天 4 场 · 含装备租赁', '#C8552F', '#7A2E1B')).toString('base64') },
    { id: 'img_cover_2', mime: 'image/svg+xml', cloudPath: 'demo/cover_2.svg', content: Buffer.from(svgCover('周三夜场排位', '今晚开战 · 次卡可用', '#2E6BC8', '#1B3A7A')).toString('base64') },
    { id: 'img_cover_3', mime: 'image/svg+xml', cloudPath: 'demo/cover_3.svg', content: Buffer.from(svgCover('上周末场 · 已结束', '战绩与相册已归档', '#3A8A5A', '#1F4A33')).toString('base64') },
    { id: 'img_avatar_1', mime: 'image/svg+xml', cloudPath: 'demo/avatar_1.svg', content: Buffer.from(svgAvatar('王', '#1F2A38')).toString('base64') },
    { id: 'img_avatar_2', mime: 'image/svg+xml', cloudPath: 'demo/avatar_2.svg', content: Buffer.from(svgAvatar('张', '#2E6BC8')).toString('base64') },
    { id: 'img_avatar_3', mime: 'image/svg+xml', cloudPath: 'demo/avatar_3.svg', content: Buffer.from(svgAvatar('伟', '#C8552F')).toString('base64') },
    { id: 'img_avatar_4', mime: 'image/svg+xml', cloudPath: 'demo/avatar_4.svg', content: Buffer.from(svgAvatar('李', '#3A8A5A')).toString('base64') },
    { id: 'img_team_1', mime: 'image/svg+xml', cloudPath: 'demo/team_1.svg', content: Buffer.from(svgAvatar('夜', '#7A2E1B')).toString('base64') },
    { id: 'img_album_1', mime: 'image/svg+xml', cloudPath: 'demo/album_1.svg', content: Buffer.from(svgPhoto('攻防对抗 · 第 1 场', 0)).toString('base64') },
    { id: 'img_album_2', mime: 'image/svg+xml', cloudPath: 'demo/album_2.svg', content: Buffer.from(svgPhoto('夺旗瞬间', 1)).toString('base64') },
    { id: 'img_album_3', mime: 'image/svg+xml', cloudPath: 'demo/album_3.svg', content: Buffer.from(svgPhoto('赛后合影', 2)).toString('base64') },
    {
      id: 'file_agreement_adult', mime: 'text/plain; charset=utf-8', cloudPath: 'demo/waiver_adult.txt',
      content: Buffer.from(`真人CS活动参与免责声明（成人版） v1.0

一、本人自愿参加俱乐部组织的真人CS对抗活动，已充分了解该项活动具有体力消耗大、场地地形复杂、对抗存在轻微磕碰风险等特点。
二、本人承诺身体状况良好，无不宜参加剧烈运动的疾病。活动期间将服从工作人员指挥，正确佩戴护具，遵守安全规则。
三、因本人违反安全规则或隐瞒身体状况造成的伤害，责任由本人自行承担；俱乐部已为活动购买公共责任保险，保险范围外的损失由本人承担。
四、本人同意活动照片与视频可能用于俱乐部宣传（如不同意请现场告知工作人员）。
五、本声明自签署之日起对本年度内参加的活动持续有效。`).toString('base64'),
    },
    {
      id: 'file_agreement_minor', mime: 'text/plain; charset=utf-8', cloudPath: 'demo/waiver_minor.txt',
      content: Buffer.from(`真人CS活动参与免责声明（未成年人监护人版） v1.0

一、监护人确认被监护人自愿参加真人CS对抗活动，并已了解活动风险。
二、监护人承诺被监护人身体状况适宜参加活动，并授权工作人员在紧急情况下送医处置。
三、活动期间被监护人将服从指挥、佩戴护具；因违规造成的伤害责任由监护人承担。
四、本声明自签署之日起生效。`).toString('base64'),
    },
  ];
}

// ---------- 主构造 ----------

export function buildSeed() {
  const now = Date.now();

  // 活动时间锚点
  const a1Start = now + 2 * D;          // 报名中：后天开打
  const a1End = a1Start + 3 * H;
  const a1Deadline = now + D;           // 明天截止
  const a2Start = now - H;              // 进行中：1 小时前开始
  const a2End = now + 2 * H;
  const a3Start = now - 3 * D;          // 已结束：3 天前
  const a3End = a3Start + 3 * H;
  const a3Deadline = a3Start - D;

  // 手机号密文：复用云端 crypto（同进程同 PHONE_AES_KEY，运行时可解密）
  const crypto = require('../cloudfunctions/common/lib/crypto.js');
  const vipPhoneEnc = crypto.encryptField('13800000003');

  const actors = [
    { openid: 'demo-admin', nickname: '管理员老王', phone: '13800000001', role: 'admin', desc: '超级管理员（* 通配）：管理后台全部功能' },
    { openid: 'demo-staff', nickname: '现场小张', phone: '13800000002', role: 'staff', desc: '工作人员：签到核验 / 战绩录入 / 相册上传' },
    { openid: 'demo-vip', nickname: '氪金玩家阿伟', phone: '13800000003', role: 'member', desc: '会员：次卡持有人 · 夜袭小队队长 · 有订单与战绩' },
    { openid: 'demo-new', nickname: '新兵小李', phone: '13800000004', role: 'member', desc: '新会员：未绑手机号未签协议 · 待支付报名 · 有待审退款' },
  ];

  const user = [
    {
      _id: 'u_admin', openid: 'demo-admin', nickname: '管理员老王', avatar: 'cloud://demo/img_avatar_1',
      role: 'admin', status: 'normal', is_minor: false, total_games: 0, total_kills: 0, total_wins: 0, rank: 'recruit',
      active_team_id: null, last_login_at: now, created_at: now - 200 * D, updated_at: now,
    },
    {
      _id: 'u_staff', openid: 'demo-staff', nickname: '现场小张', avatar: 'cloud://demo/img_avatar_2',
      role: 'staff', status: 'normal', is_minor: false, total_games: 3, total_kills: 9, total_wins: 1, rank: 'recruit',
      active_team_id: null, last_login_at: now, created_at: now - 180 * D, updated_at: now,
    },
    {
      _id: 'u_vip', openid: 'demo-vip', nickname: '氪金玩家阿伟', avatar: 'cloud://demo/img_avatar_3',
      role: 'member', status: 'normal', is_minor: false, gender: 1, birthday: new Date('1998-05-20').getTime(),
      phone: vipPhoneEnc, phone_hash: crypto.hashField('13800000003'), phone_owner: 'self', phone_bound_at: now - 30 * D,
      emergency_contact: { name: '王秀兰', phone: '13900000003' },
      total_games: 12, total_kills: 85, total_wins: 7, rank: 'recruit', active_team_id: 'team_1',
      last_login_at: now, created_at: now - 120 * D, updated_at: now,
    },
    {
      _id: 'u_new', openid: 'demo-new', nickname: '新兵小李', avatar: 'cloud://demo/img_avatar_4',
      role: 'member', status: 'normal', is_minor: false, total_games: 1, total_kills: 4, total_wins: 0, rank: 'recruit',
      active_team_id: 'team_1', last_login_at: now, created_at: now - 2 * D, updated_at: now,
    },
  ];

  const agreement = [
    {
      _id: 'adult:v1.0', type: 'adult', agreement_type: 'adult', version: 'v1.0',
      title: '真人CS活动参与免责声明（成人版）', content_file_id: 'cloud://demo/file_agreement_adult',
      status: 'published', published_at: now - 90 * D, created_at: now - 90 * D, updated_at: now - 90 * D,
    },
    {
      _id: 'minor:v1.0', type: 'minor', agreement_type: 'minor', version: 'v1.0',
      title: '真人CS活动参��免责声明（未成年人监护人版）', content_file_id: 'cloud://demo/file_agreement_minor',
      status: 'published', published_at: now - 90 * D, created_at: now - 90 * D, updated_at: now - 90 * D,
    },
  ];

  const cardProductBase = [
    { _id: 'card_count_10', name: '次卡·10次', card_type: 'count', times: 10, valid_months: 12, price: 19900, discount_percent: null, sort: 1 },
    { _id: 'card_count_30', name: '次卡·30次', card_type: 'count', times: 30, valid_months: 12, price: 49900, discount_percent: null, sort: 2 },
    { _id: 'card_period_1', name: '月卡', card_type: 'period', period_months: 1, price: 29900, discount_percent: null, sort: 3 },
    { _id: 'card_period_3', name: '季卡', card_type: 'period', period_months: 3, price: 79900, discount_percent: 95, sort: 4 },
    { _id: 'card_period_12', name: '年卡', card_type: 'period', period_months: 12, price: 259900, discount_percent: 90, sort: 5 },
  ];
  const card_product = cardProductBase.map((p) => ({ ...p, status: 'on', created_at: now - 90 * D, updated_at: now }));

  const role_permission = [
    { _id: 'guest', role_key: 'guest', name: '游客', permissions: [], is_preset: true, description: '游客（未登录/未注册，不进入管理端）', user_count: 0, updated_at: now },
    { _id: 'member', role_key: 'member', name: '会员', permissions: [], is_preset: true, description: '普通会员', user_count: 2, updated_at: now },
    { _id: 'captain', role_key: 'captain', name: '战队队长', permissions: [], is_preset: true, description: '队长权限走战队自身归属校验，不走权限点（admin-module §1.4 说明）', user_count: 0, updated_at: now },
    { _id: 'staff', role_key: 'staff', name: '工作人员', permissions: ['checkin_activity', 'record_stats', 'upload_album'], is_preset: true, description: '现场工作人员（签到/录入/相册权限合并进单一 staff）', user_count: 1, updated_at: now },
    { _id: 'admin', role_key: 'admin', name: '管理员', permissions: ['*'], is_preset: true, description: '超级管理员（* 通配仅预置 admin 可配置）', user_count: 1, updated_at: now },
  ];

  const permissionPointBase = [
    ['publish_activity', '发布活动', 'activity'],
    ['cancel_activity', '取消活动', 'activity'],
    ['audit_team', '战队审核', 'team'],
    ['record_stats', '战绩录入', 'activity'],
    ['upload_album', '相册上传', 'activity'],
    ['checkin_activity', '现场签到核验', 'activity'],
    ['audit_refund', '退款审核', 'order'],
    ['view_operation_log', '操作日志查询', 'admin'],
    ['role_manage', '角色与权限配置', 'admin'],
    ['user_role_assign', '用户角色分配', 'admin'],
    ['user_manage', '用户管理', 'user'],
    ['user_ban', '封禁/解封', 'user'],
    ['user_card_adjust', '会员卡人工调整', 'user'],
  ];
  const permission_point = permissionPointBase.map(([key, name, module_group]) => ({ _id: key, key, name, module_group, created_at: now - 90 * D }));

  const activity = [
    {
      _id: 'act_1', title: '周末主题对抗赛', type: 'theme', cover: 'cloud://demo/img_cover_1',
      venue: '3号场地', address: '上海市浦东新区张江路88号 · 极战真人CS俱乐部', location: { lat: 31.2045, lng: 121.5903 },
      start_time: a1Start, end_time: a1End, signup_deadline: a1Deadline,
      price: 9900, max_num: 20, min_num: 4, remain_num: 18, signup_count: 1, waitlist_count: 0, checkin_count: 0,
      status: 'published', cancel_reason: '', pay_types: ['wxpay', 'times_card', 'period_card'],
      intro: '全天 4 场主题对抗（歼灭/夺旗/护送/生存），含装备与护具租赁，新兵友好。',
      published_at: now - D, created_by: 'u_admin', created_at: now - 2 * D, updated_at: now - D,
    },
    {
      _id: 'act_2', title: '周三夜场排位', type: 'regular', cover: 'cloud://demo/img_cover_2',
      venue: '夜光馆 A 区', address: '上海市浦东新区张江路88号 · 极战真人CS俱乐部', location: { lat: 31.2045, lng: 121.5903 },
      start_time: a2Start, end_time: a2End, signup_deadline: a2Start - 2 * H,
      price: 9900, max_num: 20, min_num: 4, remain_num: 19, signup_count: 1, waitlist_count: 0, checkin_count: 0,
      status: 'ongoing', cancel_reason: '', pay_types: ['wxpay', 'times_card', 'period_card'],
      intro: '每周三夜场排位赛，胜负计入战队战绩。进行中，可围观战绩直播。',
      published_at: now - 5 * D, created_by: 'u_admin', created_at: now - 6 * D, updated_at: now - H,
    },
    {
      _id: 'act_3', title: '上周末场 · 已结束', type: 'regular', cover: 'cloud://demo/img_cover_3',
      venue: '丛林场 B 区', address: '上海市浦东新区张江路88号 · 极战真人CS俱乐部', location: { lat: 31.2045, lng: 121.5903 },
      start_time: a3Start, end_time: a3End, signup_deadline: a3Deadline,
      price: 9900, max_num: 16, min_num: 4, remain_num: 14, signup_count: 2, waitlist_count: 0, checkin_count: 2,
      status: 'finished', cancel_reason: '', pay_types: ['wxpay', 'times_card', 'period_card'],
      intro: '已于 3 天前结束，战绩已录入，相册已上传，可查看回顾并评价。',
      published_at: now - 8 * D, created_by: 'u_admin', created_at: now - 9 * D, updated_at: a3End,
    },
  ];

  const enrollmentBase = {
    checkin_time: null, checkin_by: null, checkin_request: null, cancel_type: null,
  };
  const activity_enrollment = [
    {
      ...enrollmentBase, _id: 'enr_vip_a1', activity_id: 'act_1', user_id: 'u_vip',
      nickname: '氪金玩家阿伟', avatar: 'cloud://demo/img_avatar_3',
      activity_title: '周末主题对抗赛', activity_cover: 'cloud://demo/img_cover_1', activity_start_time: a1Start,
      team_id: null, status: 'pending', pay_type: 'wxpay', order_id: 'ord_vip_a1', price_snapshot: 9900,
      expire_at: now + 15 * 60 * 1000, enqueue_at: null, created_at: now - 30 * 60 * 1000, updated_at: now - 30 * 60 * 1000,
    },
    {
      ...enrollmentBase, _id: 'enr_new_a1', activity_id: 'act_1', user_id: 'u_new',
      nickname: '新兵小李', avatar: 'cloud://demo/img_avatar_4',
      activity_title: '周末主题对抗赛', activity_cover: 'cloud://demo/img_cover_1', activity_start_time: a1Start,
      team_id: null, status: 'enrolled', pay_type: 'wxpay', order_id: 'ord_new_a1', price_snapshot: 9900,
      expire_at: null, enqueue_at: null, created_at: now - 2 * H, updated_at: now - 2 * H,
    },
    {
      ...enrollmentBase, _id: 'enr_vip_a2', activity_id: 'act_2', user_id: 'u_vip',
      nickname: '氪金玩家阿伟', avatar: 'cloud://demo/img_avatar_3',
      activity_title: '周三夜场排位', activity_cover: 'cloud://demo/img_cover_2', activity_start_time: a2Start,
      team_id: null, status: 'enrolled', pay_type: 'times_card', order_id: 'ord_vip_a2', price_snapshot: 9900,
      expire_at: null, enqueue_at: null, created_at: now - D, updated_at: now - 30 * 60 * 1000,
    },
    {
      ...enrollmentBase, _id: 'enr_vip_a3', activity_id: 'act_3', user_id: 'u_vip',
      nickname: '氪金玩家阿伟', avatar: 'cloud://demo/img_avatar_3',
      activity_title: '上周末场 · 已结束', activity_cover: 'cloud://demo/img_cover_3', activity_start_time: a3Start,
      team_id: null, status: 'completed', pay_type: 'wxpay', order_id: 'ord_vip_a3', price_snapshot: 9900,
      expire_at: null, enqueue_at: null, checkin_time: a3Start + 20 * 60 * 1000, checkin_by: 'u_staff',
      created_at: now - 5 * D, updated_at: a3End,
    },
    {
      ...enrollmentBase, _id: 'enr_new_a3', activity_id: 'act_3', user_id: 'u_new',
      nickname: '新兵小李', avatar: 'cloud://demo/img_avatar_4',
      activity_title: '上周末场 · 已结束', activity_cover: 'cloud://demo/img_cover_3', activity_start_time: a3Start,
      team_id: null, status: 'completed', pay_type: 'wxpay', order_id: 'ord_new_a3', price_snapshot: 9900,
      expire_at: null, enqueue_at: null, checkin_time: a3Start + 22 * 60 * 1000, checkin_by: 'u_staff',
      created_at: now - 5 * D, updated_at: a3End,
    },
  ];

  const orderBase = { team_id: null, paid_at: null, closed_at: null, closed_reason: null, refunded_total: 0 };
  const order = [
    {
      ...orderBase, _id: 'ord_vip_a1', order_no: orderNo(now - 30 * 60 * 1000, 1),
      user_id: 'u_vip', nickname: '氪金玩家阿伟', biz_type: 'activity_enroll', biz_id: 'enr_vip_a1',
      items: [{ user_id: 'u_vip', nickname: '氪金玩家阿伟', enrollment_id: 'enr_vip_a1', unit_price: 9900, refund_status: 'none' }],
      snapshot: { title: '周末主题对抗赛', type: 'theme', cover: 'cloud://demo/img_cover_1', start_time: a1Start, venue: '3号场地', unit_price: 9900 },
      amount: 9900, pay_amount: 9900, pay_type: 'wxpay', status: 'pending',
      expire_at: now + 15 * 60 * 1000, created_at: now - 30 * 60 * 1000, updated_at: now - 30 * 60 * 1000,
    },
    {
      ...orderBase, _id: 'ord_new_a1', order_no: orderNo(now - 2 * H, 2),
      user_id: 'u_new', nickname: '新兵小李', biz_type: 'activity_enroll', biz_id: 'enr_new_a1',
      items: [{ user_id: 'u_new', nickname: '新兵小李', enrollment_id: 'enr_new_a1', unit_price: 9900, refund_status: 'none' }],
      snapshot: { title: '周末主题对抗赛', type: 'theme', cover: 'cloud://demo/img_cover_1', start_time: a1Start, venue: '3号场地', unit_price: 9900 },
      amount: 9900, pay_amount: 9900, pay_type: 'wxpay', status: 'paid',
      expire_at: null, paid_at: now - 2 * H, created_at: now - 2 * H - 3 * 60 * 1000, updated_at: now - 2 * H,
    },
    {
      ...orderBase, _id: 'ord_vip_a2', order_no: orderNo(now - D, 3),
      user_id: 'u_vip', nickname: '氪金玩家阿伟', biz_type: 'activity_enroll', biz_id: 'enr_vip_a2',
      items: [{ user_id: 'u_vip', nickname: '氪金玩家阿伟', enrollment_id: 'enr_vip_a2', unit_price: 9900, refund_status: 'none' }],
      snapshot: { title: '周三夜场排位', type: 'regular', cover: 'cloud://demo/img_cover_2', start_time: a2Start, venue: '夜光馆 A 区', unit_price: 9900 },
      amount: 9900, pay_amount: 0, pay_type: 'card_deduct', status: 'paid',
      expire_at: null, paid_at: now - 30 * 60 * 1000, created_at: now - D, updated_at: now - 30 * 60 * 1000,
    },
    {
      ...orderBase, _id: 'ord_vip_a3', order_no: orderNo(a3Start - D, 4),
      user_id: 'u_vip', nickname: '氪金玩家阿伟', biz_type: 'activity_enroll', biz_id: 'enr_vip_a3',
      items: [{ user_id: 'u_vip', nickname: '氪金玩家阿伟', enrollment_id: 'enr_vip_a3', unit_price: 9900, refund_status: 'none' }],
      snapshot: { title: '上周末场 · 已结束', type: 'regular', cover: 'cloud://demo/img_cover_3', start_time: a3Start, venue: '丛林场 B 区', unit_price: 9900 },
      amount: 9900, pay_amount: 9900, pay_type: 'wxpay', status: 'paid',
      expire_at: null, paid_at: a3Start - D, created_at: a3Start - D - 10 * 60 * 1000, updated_at: a3Start - D,
    },
    {
      ...orderBase, _id: 'ord_new_a3', order_no: orderNo(a3Start - D + 5 * 60 * 1000, 5),
      user_id: 'u_new', nickname: '新兵小李', biz_type: 'activity_enroll', biz_id: 'enr_new_a3',
      items: [{ user_id: 'u_new', nickname: '新兵小李', enrollment_id: 'enr_new_a3', unit_price: 9900, refund_status: 'none' }],
      snapshot: { title: '上周末场 · 已结束', type: 'regular', cover: 'cloud://demo/img_cover_3', start_time: a3Start, venue: '丛林场 B 区', unit_price: 9900 },
      amount: 9900, pay_amount: 9900, pay_type: 'wxpay', status: 'paid',
      expire_at: null, paid_at: a3Start - D + 5 * 60 * 1000, created_at: a3Start - D, updated_at: a3Start - D + 5 * 60 * 1000,
    },
    {
      ...orderBase, _id: 'ord_card_vip', order_no: orderNo(now - 60 * D, 6),
      user_id: 'u_vip', nickname: '氪金玩家阿伟', biz_type: 'member_card', biz_id: 'card_count_10',
      items: [{ user_id: 'u_vip', nickname: '氪金玩家阿伟', enrollment_id: null, unit_price: 19900, refund_status: 'none' }],
      snapshot: { title: '次卡·10次', card_type: 'count', total_times: 10, valid_months: 12, unit_price: 19900 },
      amount: 19900, pay_amount: 19900, pay_type: 'wxpay', status: 'paid',
      expire_at: null, paid_at: now - 60 * D, created_at: now - 60 * D, updated_at: now - 60 * D,
    },
  ];

  // 供 refund/member_card 回填的订单引用（order 是数组，不能直接 .order_no）
  const ordNewA1 = order.find((o) => o._id === 'ord_new_a1');
  const ordCardVip = order.find((o) => o._id === 'ord_card_vip');

  const payment = [];

  const refund = [
    {
      _id: 'rf_new_a1', refund_no: refundNo(now - H, 1), order_id: 'ord_new_a1', order_no: ordNewA1.order_no,
      type: 'manual', amount: 4950, reason: '临时有事无法参加，申请退款',
      status: 'pending', apply_user_id: 'u_new', refund_type: 'user', per_user: false,
      items: [{ user_id: 'u_new', enrollment_id: 'enr_new_a1', nickname: '新兵小李' }],
      auditor_id: null, audit_at: null, audit_remark: null, wx_refund_id: null, refunded_at: null,
      fail_reason: null, retry_count: 0, created_at: now - H, updated_at: now - H,
    },
  ];

  const member_card = [
    {
      _id: 'card_vip', user_id: 'u_vip', card_type: 'count', card_name: '次卡·10次', status: 'active',
      source: 'purchase', order_id: 'ord_card_vip', order_no: ordCardVip.order_no, price: 19900, remark: '',
      remain_times: 6, total_times: 10, used_times: 4, expire_at: endOfDay(now + 300 * D),
      activated_at: now - 60 * D, created_at: now - 60 * D,
    },
  ];

  const team = [
    {
      _id: 'team_1', name: '夜袭小队', logo: 'cloud://demo/img_team_1', slogan: '夜战到底，逢敌必亮剑',
      intro: '主打夜场排位的常驻小队，欢迎夜猫子加入。', captain_user_id: 'u_vip', captain_name: '氪金玩家阿伟',
      member_count: 2, status: 'normal', reject_reason: null, auditor_id: 'u_admin', auditor_name: '管理员老王',
      audit_at: now - 100 * D, created_at: now - 110 * D, updated_at: now - 10 * D,
    },
  ];

  const team_member = [
    {
      _id: 'tm_vip', team_id: 'team_1', team_name: '夜袭小队', user_id: 'u_vip', nickname: '氪金玩家阿伟',
      avatar: 'cloud://demo/img_avatar_3', role: 'captain', status: 'active', note: null,
      joined_at: now - 110 * D, created_at: now - 110 * D, updated_at: now - 110 * D,
    },
    {
      _id: 'tm_new', team_id: 'team_1', team_name: '夜袭小队', user_id: 'u_new', nickname: '新兵小李',
      avatar: 'cloud://demo/img_avatar_4', role: 'member', status: 'active', note: null,
      joined_at: now - 2 * D, created_at: now - 2 * D, updated_at: now - 2 * D,
    },
  ];

  const team_stats = [
    { _id: 'team_1', team_id: 'team_1', team_name: '夜袭小队', total_games: 8, wins: 5, win_rate: 0.625, participated_members: 6 }, // §6.2：0~1 小数，前端 ×100 显示
  ];

  const waiver_record = [
    { _id: 'w_vip', user_id: 'u_vip', agreement_type: 'adult', agreement_version: 'v1.0', signed_at: now - 30 * D, ip: '127.0.0.1', created_at: now - 30 * D },
  ];

  const user_address = [
    {
      _id: 'addr_vip', user_id: 'u_vip', receiver: '阿伟', phone: '13800000003',
      region: '上海市 上海市 浦东新区', detail: '张江路88号3号楼201室', is_default: true,
      created_at: now - 20 * D, updated_at: now - 20 * D,
    },
  ];

  const activity_stats = [
    {
      _id: 'st_vip_a3', activity_id: 'act_3', user_id: 'u_vip', nickname: '氪金玩家阿伟',
      kills: 12, deaths: 3, heals: 1, supplies: 2, captures: 0, is_win: true, honors: ['mvp'],
      source: 'manual', recorded_by: 'u_admin', created_at: a3End + H, updated_at: a3End + H,
    },
    {
      _id: 'st_new_a3', activity_id: 'act_3', user_id: 'u_new', nickname: '新兵小李',
      kills: 4, deaths: 7, heals: 0, supplies: 1, captures: 0, is_win: false, honors: [],
      source: 'manual', recorded_by: 'u_admin', created_at: a3End + H, updated_at: a3End + H,
    },
  ];

  const activity_review = [
    {
      _id: 'rv_vip_a3', activity_id: 'act_3', user_id: 'u_vip', nickname: '氪金玩家阿伟',
      avatar: 'cloud://demo/img_avatar_3', stars: 5, content: '场地专业，对抗很过瘾，裁判也很负责，下次还来！',
      status: 'published', created_at: a3End + 2 * H,
    },
  ];

  const activity_album = [
    { _id: 'alb_1', activity_id: 'act_3', activity_title: '上周末场 · 已结束', activity_cover: 'cloud://demo/img_cover_3', file_id: 'cloud://demo/img_album_1', media_type: 'image', size: 2048, uploader_id: 'u_staff', uploader_name: '现场小张', status: 'normal', created_at: a3End + 2 * H },
    { _id: 'alb_2', activity_id: 'act_3', activity_title: '上周末场 · 已结束', activity_cover: 'cloud://demo/img_cover_3', file_id: 'cloud://demo/img_album_2', media_type: 'image', size: 2048, uploader_id: 'u_staff', uploader_name: '现场小张', status: 'normal', created_at: a3End + 2 * H + 1000 },
    { _id: 'alb_3', activity_id: 'act_3', activity_title: '上周末场 · 已结束', activity_cover: 'cloud://demo/img_cover_3', file_id: 'cloud://demo/img_album_3', media_type: 'image', size: 2048, uploader_id: 'u_staff', uploader_name: '现场小张', status: 'normal', created_at: a3End + 2 * H + 2000 },
  ];

  // payment 流水补齐（依赖上面 order 的 order_no 生成后再回填）
  const txnSeq = ['DEMO_TXN_000000000001', 'DEMO_TXN_000000000002', 'DEMO_TXN_000000000003', 'DEMO_TXN_000000000004'];
  const paidOrders = [
    { o: 'ord_new_a1', openid: 'demo-new', at: now - 2 * H },
    { o: 'ord_vip_a2', openid: 'demo-vip', at: now - 30 * 60 * 1000 },
    { o: 'ord_vip_a3', openid: 'demo-vip', at: a3Start - D },
    { o: 'ord_new_a3', openid: 'demo-new', at: a3Start - D + 5 * 60 * 1000 },
    { o: 'ord_card_vip', openid: 'demo-vip', at: now - 60 * D },
  ];
  paidOrders.forEach((p, i) => {
    const od = order.find((x) => x._id === p.o);
    payment.push({
      _id: 'pay_' + p.o, order_id: od._id, order_no: od.order_no, transaction_id: txnSeq[i] || 'DEMO_TXN_' + i,
      channel: 'wxpay', amount: od.pay_amount, state: 'success', openid: p.openid,
      paid_at: p.at, callback_raw: {}, created_at: p.at,
    });
  });

  const collections = {
    user, agreement, card_product, role_permission, permission_point,
    activity, activity_enrollment, activity_stats, activity_review, activity_album,
    order, payment, refund, member_card,
    team, team_member, team_stats,
    waiver_record, user_address,
    operation_log: [], import_record: [], operation_log_archive: [],
  };

  return { actors, collections, files: buildDemoFiles() };
}
