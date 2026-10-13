/**
 * db-init —— 一次性数据库初始化云函数
 *
 * 用途：创建 collections.json 声明的全部 22 个集合，并导入 seed.json 的 4 类种子数据
 *       （预置角色 / 权限点 / 协议 v1.0 / 会员卡种）
 * 运行：开发者工具中右键本函数 →「云端测试」直接运行，无需小程序端接入
 * 幂等：可重复执行——
 *   1) 集合已存在则跳过（createCollection 失败后用 count() 验证是否真实存在）；
 *   2) 种子按 _id 判存，已存在则跳过，不覆盖、不删除（防重跑冲掉管理端已修改的数据）。
 * 注意：
 *   - wx-server-sdk 不支持建索引，索引需在云开发控制台手动创建（最关键：user.openid 唯一索引）；
 *   - agreement.content_file_id 为空，上传协议正文后需更新；
 *   - card_product 价格为占位，上线前在管理端改价。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// database/collections.json 声明的全部集合（22 个）
const COLLECTIONS = [
  'user', 'member_card', 'waiver_record', 'user_address', 'agreement', 'card_product',
  'team', 'team_member', 'team_stats',
  'activity', 'activity_enrollment', 'activity_stats', 'activity_review', 'activity_album',
  'order', 'payment', 'refund',
  'role_permission', 'permission_point',
  'operation_log', 'import_record', 'operation_log_archive'
];

// database/seed.json 的种子数据（_id 均为业务唯一键；以 _at 结尾且值为 0 的时间戳写入时替换为当前毫秒）
const SEEDS = {
  role_permission: [
    { _id: 'guest', role_key: 'guest', name: '游客', permissions: [], is_preset: true, description: '游客（未登录/未注册，不进入管理端）', user_count: 0, updated_at: 0 },
    { _id: 'member', role_key: 'member', name: '会员', permissions: [], is_preset: true, description: '普通会员', user_count: 0, updated_at: 0 },
    { _id: 'captain', role_key: 'captain', name: '战队队长', permissions: [], is_preset: true, description: '队长权限走战队自身归属校验，不走权限点（admin-module §1.4 说明）', user_count: 0, updated_at: 0 },
    { _id: 'staff', role_key: 'staff', name: '工作人员', permissions: ['checkin_activity', 'record_stats', 'upload_album'], is_preset: true, description: '现场工作人员（Q2：教练/裁判与签到/录入/相册权限合并进单一 staff）', user_count: 0, updated_at: 0 },
    { _id: 'admin', role_key: 'admin', name: '管理员', permissions: ['*'], is_preset: true, description: '超级管理员（* 通配仅预置 admin 可配置）', user_count: 0, updated_at: 0 }
  ],
  permission_point: [
    { _id: 'publish_activity', key: 'publish_activity', name: '发布活动', module_group: 'activity', created_at: 0 },
    { _id: 'cancel_activity', key: 'cancel_activity', name: '取消活动', module_group: 'activity', created_at: 0 },
    { _id: 'audit_team', key: 'audit_team', name: '战队审核', module_group: 'team', created_at: 0 },
    { _id: 'record_stats', key: 'record_stats', name: '战绩录入', module_group: 'activity', created_at: 0 },
    { _id: 'upload_album', key: 'upload_album', name: '相册上传', module_group: 'activity', created_at: 0 },
    { _id: 'checkin_activity', key: 'checkin_activity', name: '现场签到核验', module_group: 'activity', created_at: 0 },
    { _id: 'audit_refund', key: 'audit_refund', name: '退款审核', module_group: 'order', created_at: 0 },
    { _id: 'view_operation_log', key: 'view_operation_log', name: '操作日志查询', module_group: 'admin', created_at: 0 },
    { _id: 'role_manage', key: 'role_manage', name: '角色与权限配置', module_group: 'admin', created_at: 0 },
    { _id: 'user_role_assign', key: 'user_role_assign', name: '用户角色分配', module_group: 'admin', created_at: 0 },
    { _id: 'user_manage', key: 'user_manage', name: '用户管理', module_group: 'user', created_at: 0 },
    { _id: 'user_ban', key: 'user_ban', name: '封禁/解封', module_group: 'user', created_at: 0 },
    { _id: 'user_card_adjust', key: 'user_card_adjust', name: '会员卡人工调整', module_group: 'user', created_at: 0 }
  ],
  agreement: [
    { _id: 'adult:v1.0', type: 'adult', version: 'v1.0', title: '真人CS活动参与免责声明（成人版）', content_file_id: '', status: 'published', published_at: 0, created_at: 0, updated_at: 0 },
    { _id: 'minor:v1.0', type: 'minor', version: 'v1.0', title: '真人CS活动参与免责声明（未成年人监护人版）', content_file_id: '', status: 'published', published_at: 0, created_at: 0, updated_at: 0 }
  ],
  card_product: [
    { _id: 'card_count_10', name: '次卡·10次', card_type: 'count', times: 10, valid_months: 12, price: 19900, discount_percent: null, status: 'on', sort: 1, created_at: 0, updated_at: 0 },
    { _id: 'card_count_30', name: '次卡·30次', card_type: 'count', times: 30, valid_months: 12, price: 49900, discount_percent: null, status: 'on', sort: 2, created_at: 0, updated_at: 0 },
    { _id: 'card_period_1', name: '月卡', card_type: 'period', period_months: 1, price: 29900, discount_percent: null, status: 'on', sort: 3, created_at: 0, updated_at: 0 },
    { _id: 'card_period_3', name: '季卡', card_type: 'period', period_months: 3, price: 79900, discount_percent: 95, status: 'on', sort: 4, created_at: 0, updated_at: 0 },
    { _id: 'card_period_12', name: '年卡', card_type: 'period', period_months: 12, price: 259900, discount_percent: 90, status: 'on', sort: 5, created_at: 0, updated_at: 0 }
  ]
};

/** 以 _at 结尾且值为 0 的时间戳替换为 now（seed.json 约定：时间戳占位为 0） */
function fixTimestamps(doc, now) {
  const out = {};
  for (const k of Object.keys(doc)) {
    out[k] = (/_at$/.test(k) && doc[k] === 0) ? now : doc[k];
  }
  return out;
}

/** 建集合：已存在时 createCollection 会报错，改用 count() 验证集合真实存在即视为「已存在」 */
async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return 'created';
  } catch (e) {
    try {
      await db.collection(name).count();
      return 'existed';
    } catch (e2) {
      return 'failed: ' + (e2.errMsg || e.errMsg || e2.message || e.message || '未知错误');
    }
  }
}

exports.main = async () => {
  const now = Date.now();
  const report = {
    collections: { created: [], existed: [], failed: [] },
    seeds: {},
    errors: []
  };

  // 1. 建集合（并行）
  await Promise.all(COLLECTIONS.map(async (name) => {
    const status = await ensureCollection(name);
    if (status === 'created' || status === 'existed') {
      report.collections[status].push(name);
    } else {
      report.collections.failed.push(name);
      report.errors.push('集合 ' + name + ' ' + status);
    }
  }));

  // 2. 导种子（按 _id 判存：已存在跳过，绝不覆盖）
  await Promise.all(Object.keys(SEEDS).map(async (name) => {
    let inserted = 0, skipped = 0;
    for (const doc of SEEDS[name]) {
      const found = await db.collection(name).where({ _id: doc._id }).limit(1).get().catch(() => null);
      if (found && found.data && found.data.length > 0) { skipped++; continue; }
      try {
        await db.collection(name).add({ data: fixTimestamps(doc, now) });
        inserted++;
      } catch (e) {
        report.errors.push('种子 ' + name + '/' + doc._id + ' 写入失败: ' + (e.errMsg || e.message || '未知错误'));
      }
    }
    report.seeds[name] = { total: SEEDS[name].length, inserted, skipped };
  }));

  const c = report.collections;
  const seedSummary = Object.keys(report.seeds)
    .map((k) => k + ' 插入 ' + report.seeds[k].inserted + '/跳过 ' + report.seeds[k].skipped)
    .join('，');
  const summary = '集合：新建 ' + c.created.length + ' / 已存在 ' + c.existed.length + ' / 失败 ' + c.failed.length
    + '；种子：' + seedSummary;

  console.log('[db-init]', summary, JSON.stringify(report.errors));
  return {
    code: report.errors.length === 0 ? 0 : 1,
    msg: report.errors.length === 0 ? '初始化完成' : '初始化完成，但部分操作失败（可修复后重跑，幂等安全）',
    summary,
    report,
    todo: [
      '在云开发控制台为 user 集合手动创建 openid 唯一索引（防并发首登重复建档），其余索引按 database/collections.json 补齐',
      '上传协议正文文件后更新 agreement 两条记录的 content_file_id（当前为空）',
      'card_product 价格为占位示例，上线前在管理端改价'
    ]
  };
};
