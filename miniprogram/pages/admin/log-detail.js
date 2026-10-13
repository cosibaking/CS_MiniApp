// pages/admin/log-detail.js — 日志详情（admin-module §2.2-6）
// 接口：admin/log/detail（detail 写入时已脱敏 R11，查询侧原样展示）
// before/after 变更对比：双对象逐字段比对，差异高亮（架构 §1.5）
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');
const { ADMIN_BIZ, ROLE_NAMES } = require('../../utils/constants');

const MODULE_LABELS = {
  activity: '活动运营',
  team: '战队',
  user: '用户',
  stats: '战绩',
  album: '相册',
  order: '订单',
  admin: '管理',
};

// detail 附加字段常用中文标签（未命中时原样展示 key）
const DETAIL_LABELS = {
  remark: '备注',
  role: '角色',
  role_key: '角色标识',
  role_name: '角色名称',
  user_id: '用户 ID',
  biz_type: '导入类型',
  file_name: '文件名',
  total: '总行数',
  inserted: '新增',
  updated: '更新',
  skipped: '跳过',
  reason: '原因',
};

function stringify(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isPlainObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// before/after 对比：双对象 → key 并集逐字段（差异标记）；否则单行展示
function buildDiff(before, after) {
  const hasB = before !== null && before !== undefined;
  const hasA = after !== null && after !== undefined;
  if (!hasB && !hasA) return null;

  if (hasB && hasA && isPlainObj(before) && isPlainObj(after)) {
    const keys = Object.keys(before).concat(
      Object.keys(after).filter((k) => !(k in before))
    );
    return keys.map((k) => {
      const old = stringify(before[k]);
      const cur = stringify(after[k]);
      return { field: k, old, new: cur, changed: old !== cur };
    });
  }
  return [{ field: '', old: stringify(before), new: stringify(after), changed: true }];
}

Page({
  data: {
    checking: true,
    noPermission: false,
    notFound: false,
    log: null,
    diffRows: null,
    hasDiffChange: false,
    extraRows: [],
  },

  onLoad(options) {
    requirePermission('view_operation_log').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadData(options);
    });
  },

  loadData(options) {
    const logId = options && options.log_id;
    if (!logId) {
      this.setData({ notFound: true });
      return;
    }
    callCloud('admin', 'log/detail', { log_id: logId })
      .then((res) => {
        const d = res.data || {};
        const detail = d.detail || {};
        const diffRows = buildDiff(detail.before, detail.after);
        const extraRows = Object.keys(detail)
          .filter((k) => k !== 'before' && k !== 'after')
          .map((k) => ({ label: DETAIL_LABELS[k] || k, value: stringify(detail[k]) }));

        this.setData({
          notFound: false,
          log: {
            log_id: d.log_id,
            operator_name: d.operator_name || '—',
            operator_role_name: ROLE_NAMES[d.operator_role] || d.operator_role || '—',
            module_label: MODULE_LABELS[d.module] || d.module || '—',
            action: d.action || '—',
            target_text: d.target_id
              ? `${d.target_type || '—'} ${d.target_id}`
              : d.target_type || '—',
            result: d.result,
            error_msg: d.error_msg || '',
            created_text: formatTime(d.created_at),
          },
          diffRows,
          hasDiffChange: !!(diffRows && diffRows.some((r) => r.changed)),
          extraRows,
        });
      })
      .catch((e) => {
        if (e && e.code === ADMIN_BIZ.NOT_FOUND) {
          this.setData({ notFound: true });
          return;
        }
        showError(e, '加载日志详情失败');
      });
  },
});
