// importers/stats.js — 战绩 Excel 导入 def（activity-module §3.9 第 8 条，列定义/逐行校验/写入）
// 落位说明：文档 §5.20 示例在 activity 云函数内注册；因各云函数为独立部署进程，
//   common/lib/importer.js 的注册表是进程内内存 Map，跨进程不可见，
//   故 def 落位 admin 云函数包内、由 admin/index.js 注册（框架与业务边界不变，D9）。
// def 结构对 §5.20 的扩展：beforeImport（整表前置校验 + 预取）、afterImport（导入后置处理），
//   均由 admin 导入框架（actions/import.js runImport）调用，业务逻辑仍归本文件。
const common = require('@club/admin-common');
const { BizError, CODE, rankOf } = common;
const { ADMIN_BIZ } = require('../actions/shared');

const HONOR_KEYS = ['mvp', 'svp', 'best_heal', 'best_supply', 'best_capture'];
const NUM_COLS = [ // 列 → 字段映射（§3.9 数值校验：≥0 整数 ≤999）
  ['C', 'kills', '击杀'],
  ['D', 'deaths', '阵亡'],
  ['E', 'heals', '治疗量'],
  ['F', 'supplies', '补给量'],
  ['G', 'captures', '占领点数'],
];
const MAX_NUM = 999;

// §3.9 荣誉重评定：清空该活动全部 honors 后按全量 stats 重新评（幂等）
async function reevaluateHonors(ctx) {
  const { db } = ctx;
  // ① 清空（一次 where 批量 update）
  await db.collection('activity_stats')
    .where({ activity_id: ctx.biz_id })
    .update({ data: { honors: [], updated_at: Date.now() } });
  // ② 重拉全量战绩（报名上限内 ≤ 500，limit 1000 兜底）
  const res = await db.collection('activity_stats')
    .where({ activity_id: ctx.biz_id }).limit(1000).get();
  const stats = res.data;
  if (!stats.length) return;

  // ③ 评定：MVP=胜方组 kills 最大；SVP=负方组 kills 最大；治疗/补给/占领=全量最大（并列均获得）
  const winners = new Map(); // user_id -> honors[]
  const add = (uid, h) => {
    const arr = winners.get(uid) || [];
    if (!arr.includes(h)) arr.push(h);
    winners.set(uid, arr);
  };
  const winStats = stats.filter((s) => s.is_win === true);
  const loseStats = stats.filter((s) => s.is_win === false);
  if (!winStats.length) console.warn('[stats-import] 全场无人 is_win=true，MVP 不产生（边界 3）');
  const rules = [
    [winStats, 'kills', 'mvp', 'MVP'],
    [loseStats, 'kills', 'svp', 'SVP'],
    [stats, 'heals', 'best_heal', '最佳治疗'],
    [stats, 'supplies', 'best_supply', '最佳补给'],
    [stats, 'captures', 'best_capture', '最佳占领'],
  ];
  for (const [pool, field, honor, label] of rules) {
    if (!pool.length) continue;
    const maxV = Math.max(...pool.map((s) => s[field] || 0));
    if (maxV <= 0) continue; // 全为 0 视为无实际成绩，不产生该荣誉（裁量，文档未排除 0，可调）
    const top = pool.filter((s) => (s[field] || 0) === maxV);
    if (top.length > 5) console.warn(`[stats-import] ${label} 并列 ${top.length} 人（>5），建议运营复核（仍照常发放）`);
    top.forEach((s) => add(s.user_id, honor));
  }

  // ④ 写回各记录 honors
  for (const [userId, honors] of Array.from(winners)) {
    await db.collection('activity_stats')
      .where({ activity_id: ctx.biz_id, user_id: userId })
      .update({ data: { honors } });
  }
}

// §3.9 第 6 条：军衔冗余重算（全量聚合，fire-and-forget，失败自愈）
async function recomputeRanks(ctx) {
  const { db } = ctx;
  const userIds = Array.from(ctx.extra.touchedUserIds); // 涉改用户集 U
  for (const uid of userIds) {
    const res = await db.collection('activity_stats').where({ user_id: uid }).limit(1000).get();
    const stats = res.data;
    const totalKills = stats.reduce((sum, s) => sum + (s.kills || 0), 0);
    const totalWins = stats.filter((s) => s.is_win === true).length;
    const rank = rankOf(totalKills, totalWins); // 与门：kills 与 wins 双门槛最高档，如实升降
    await db.collection('user').doc(uid).update({
      data: { total_kills: totalKills, total_wins: totalWins, rank: rank.key, rank_updated_at: Date.now() },
    });
  }
}

module.exports = {
  bizType: 'stats',
  permission: 'record_stats', // R17：导入权限随业务权限点
  module: 'stats',            // 批量日志归属模块
  logAction: 'stats.import',  // 批量日志 action
  requireBizId: true,         // stats 必填 activity_id
  version: 'v1',
  columns: [ // 模板列定义（§3.9 表：A-I 顺序固定）
    { col: 'A', title: '用户ID', required: true, example: 'u_001', desc: 'user_id，从已签到名单导出后复制' },
    { col: 'B', title: '姓名', required: true, example: '张三', desc: '与用户昵称不一致时警告但不阻断' },
    { col: 'C', title: '击杀', required: true, example: '12', desc: '≥0 整数，上限 999' },
    { col: 'D', title: '阵亡', required: true, example: '5', desc: '≥0 整数，上限 999' },
    { col: 'E', title: '治疗量', required: true, example: '0', desc: '≥0 整数，上限 999' },
    { col: 'F', title: '补给量', required: true, example: '0', desc: '≥0 整数，上限 999' },
    { col: 'G', title: '占领点数', required: true, example: '3', desc: '≥0 整数，上限 999' },
    { col: 'H', title: '胜负', required: true, example: '胜', desc: '仅填「胜」或「负」' },
    { col: 'I', title: '备注', required: false, example: '', desc: '≤50 字，选填' },
  ],

  // 整表前置（§3.9 规则 1：活动状态）+ 预取（已签到名单 / 已有战绩，避免 500 行 × 逐行查询）
  async beforeImport(ctx) {
    const { db } = ctx;
    const _ = db.command;

    const actRes = await db.collection('activity').where({ _id: ctx.biz_id }).limit(1).get();
    const activity = actRes.data[0];
    if (!activity) throw new BizError(ADMIN_BIZ.NOT_FOUND, '活动不存在'); // 文档 1004 口径 → 5016
    if (activity.status !== 'ongoing' && activity.status !== 'finished') {
      throw new BizError(CODE.PARAM, '活动状态不允许录入'); // 规则 1（整表前置，秒失败）
    }

    const enrRes = await db.collection('activity_enrollment')
      .where({ activity_id: ctx.biz_id, status: _.in(['checked_in', 'completed']) })
      .limit(1000).get();
    const enrollMap = new Map(); // user_id -> enrollment（已签到名单）
    enrRes.data.forEach((e) => enrollMap.set(e.user_id, e));

    const statRes = await db.collection('activity_stats')
      .where({ activity_id: ctx.biz_id }).limit(1000).get();
    const statsMap = new Map(); // user_id -> 已有战绩记录（upsert 判定）
    statRes.data.forEach((s) => statsMap.set(s.user_id, s));

    ctx.extra = { activity, enrollMap, statsMap, seenUserIds: new Set(), touchedUserIds: new Set() };
  },

  // 逐行校验（§3.9 规则 2-6）：返回 null=通过（解析结果挂 row._parsed），string=失败原因
  async validateRow(row, ctx) {
    const userId = (row.A || '').trim();
    if (!userId) return '用户ID不能为空';

    // 规则 5：表内 user_id 去重（保留首行）
    if (ctx.extra.seenUserIds.has(userId)) return '用户ID重复（保留首行）';

    // 规则 2：已报名且已签到（checked_in / completed）
    const enr = ctx.extra.enrollMap.get(userId);
    if (!enr) return '用户未报名或未签到';

    // 规则 3：数值列 ≥0 整数 ≤999
    const nums = {};
    for (const [col, field, label] of NUM_COLS) {
      const raw = (row[col] || '').trim();
      if (!/^\d+$/.test(raw)) return `${label}需为非负整数`;
      const v = Number(raw);
      if (v > MAX_NUM) return `${label}不能超过 ${MAX_NUM}`;
      nums[field] = v;
    }

    // 规则 4：胜负枚举
    const winText = (row.H || '').trim();
    if (winText !== '胜' && winText !== '负') return '胜负只能填「胜」或「负」';

    // 规则 6：姓名核对（警告不阻断）——对照报名快照昵称
    const name = (row.B || '').trim();
    if (!name) return '姓名不能为空';
    if (name !== (enr.nickname || '')) {
      ctx.warnings.push(`第 ${row._row} 行：姓名与系统昵称不一致（${name} / ${enr.nickname || '无'}），已放行`);
    }

    // 备注 ≤50（不落库：activity_stats 无 remark 字段，仅导入时人工备注）
    const remark = (row.I || '').trim();
    if (remark.length > 50) return '备注不能超过 50 字';

    ctx.extra.seenUserIds.add(userId);
    row._parsed = {
      user_id: userId, nickname: enr.nickname || '',
      kills: nums.kills, deaths: nums.deaths, heals: nums.heals,
      supplies: nums.supplies, captures: nums.captures,
      is_win: winText === '胜', remark,
    };
    return null;
  },

  // 逐行写入（§3.9 第 3 条：activity_id+user_id upsert，覆盖式，source=excel）
  async writeRow(row, ctx) {
    const { db } = ctx;
    const st = row._parsed;
    const now = Date.now();
    const payload = {
      activity_id: ctx.biz_id, user_id: st.user_id, nickname: st.nickname,
      kills: st.kills, deaths: st.deaths, heals: st.heals,
      supplies: st.supplies, captures: st.captures,
      is_win: st.is_win, honors: [],              // 荣誉由 afterImport 重评定统一写
      source: 'excel', recorded_by: ctx.operator.id,
      updated_at: now,
    };
    const existing = ctx.extra.statsMap.get(st.user_id);
    if (existing) {
      await db.collection('activity_stats').doc(existing._id).update({ data: payload });
    } else {
      const addRes = await db.collection('activity_stats')
        .add({ data: { ...payload, created_at: now } });
      ctx.extra.statsMap.set(st.user_id, { _id: addRes._id, ...payload });
    }
    ctx.extra.touchedUserIds.add(st.user_id);
  },

  // 导入后置：荣誉重评定（同步完成）+ 军衔重算（fire-and-forget）
  async afterImport(ctx, summary) {
    if (!summary.success_count) return; // 无成功行则无业务变更
    await reevaluateHonors(ctx);
    recomputeRanks(ctx).catch((e) => {
      console.warn('[stats-import] 军衔重算失败（不阻断导入，下次写入全量聚合自愈）', e);
    });
  },
};
