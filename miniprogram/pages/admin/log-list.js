// pages/admin/log-list.js — 操作日志查询（admin-module §2.2-5 / §2.4 / §5.12）
// 接口：admin/log/list（筛选：module/result/时间范围/keyword/action；默认近 7 天，20/页，倒序）
// 点击行进 log-detail；「导出 Excel」走 log/export（fileID 下载 + openDocument）
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');

const PAGE_SIZE = 20;

// 模块七枚举（LOG_MODULES）+ 全部
const MODULES = [
  { key: '', label: '全部模块' },
  { key: 'activity', label: '活动' },
  { key: 'team', label: '战队' },
  { key: 'user', label: '用户' },
  { key: 'stats', label: '战绩' },
  { key: 'album', label: '相册' },
  { key: 'order', label: '订单' },
  { key: 'admin', label: '管理' },
];

// 时间范围预设（E9：跨度上限 92 天，最大预设 90 天）
const RANGES = [
  { label: '近 1 天', days: 1 },
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近 90 天', days: 90 },
];

const RESULT_LABELS = ['全部', '成功', '失败'];
const RESULT_VALUES = ['', 'success', 'fail'];

Page({
  data: {
    checking: true,
    noPermission: false,
    moduleLabels: MODULES.map((m) => m.label),
    moduleIndex: 0,
    rangeLabels: RANGES.map((r) => r.label),
    rangeIndex: 1,            // 默认近 7 天
    resultLabels: RESULT_LABELS,
    resultIndex: 0,
    keyword: '',
    action: '',
    showFilter: false,
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
    listLoading: false,
    firstLoaded: false,
    exporting: false,
  },

  onLoad() {
    requirePermission('view_operation_log').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadLogs(true);
    });
  },

  buildPayload(page) {
    const d = this.data;
    const payload = { page, page_size: PAGE_SIZE };
    const moduleKey = MODULES[d.moduleIndex].key;
    if (moduleKey) payload.module = moduleKey;
    const result = RESULT_VALUES[d.resultIndex];
    if (result) payload.result = result;
    payload.start_time = Date.now() - RANGES[d.rangeIndex].days * 24 * 60 * 60 * 1000;
    const kw = (d.keyword || '').trim();
    if (kw) payload.keyword = kw;
    const act = (d.action || '').trim();
    if (act) payload.action = act;
    return payload;
  },

  loadLogs(reset) {
    if (this.data.listLoading) return;
    const p = reset ? 1 : this.data.page + 1;
    this.setData({ listLoading: true });
    callCloud('admin', 'log/list', this.buildPayload(p))
      .then((res) => {
        const items = (res.data.list || []).map((x) => ({
          log_id: x.log_id,
          operator_name: x.operator_name || '-',
          operator_role: x.operator_role || '',
          module_label: MODULES.find((m) => m.key === x.module) ? MODULES.find((m) => m.key === x.module).label : x.module,
          action: x.action,
          target_text: x.target_id ? `${x.target_type || ''} ${x.target_id}` : (x.target_type || '-'),
          result: x.result,
          error_msg: x.error_msg || '',
          created_text: formatTime(x.created_at),
        }));
        const list = reset ? items : this.data.list.concat(items);
        this.setData({
          list,
          total: res.data.total || 0,
          page: p,
          hasMore: list.length < (res.data.total || 0),
          listLoading: false,
          firstLoaded: true,
        });
      })
      .catch((e) => {
        this.setData({ listLoading: false, firstLoaded: true });
        showError(e, '日志加载失败');
      });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.listLoading) this.loadLogs(false);
  },

  // ---------- 筛选 ----------
  onToggleFilter() {
    this.setData({ showFilter: !this.data.showFilter });
  },

  onPickModule(e) {
    this.setData({ moduleIndex: Number(e.detail.value) });
    this.loadLogs(true);
  },

  onPickResult(e) {
    this.setData({ resultIndex: Number(e.detail.value) });
    this.loadLogs(true);
  },

  onPickRange(e) {
    this.setData({ rangeIndex: Number(e.detail.value) });
    this.loadLogs(true);
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onActionInput(e) {
    this.setData({ action: e.detail.value });
  },

  onSearch() {
    this.loadLogs(true);
  },

  // §5.12 导出 Excel：按当前筛选条件导出（时间范围必填，取所选预设）
  onExport() {
    if (this.data.exporting) return;
    const d = this.data;
    const payload = {};
    const moduleKey = MODULES[d.moduleIndex].key;
    if (moduleKey) payload.module = moduleKey;
    const result = RESULT_VALUES[d.resultIndex];
    if (result) payload.result = result;
    const end = Date.now();
    payload.start_time = end - RANGES[d.rangeIndex].days * 24 * 60 * 60 * 1000;
    payload.end_time = end;
    const kw = (d.keyword || '').trim();
    if (kw) payload.keyword = kw;
    const act = (d.action || '').trim();
    if (act) payload.action = act;

    this.setData({ exporting: true });
    callCloud('admin', 'log/export', payload)
      .then((res) => wx.cloud.downloadFile({ fileID: res.data.file_id }))
      .then((r) => wx.openDocument({ filePath: r.tempFilePath, fileType: 'xlsx', showMenu: true }))
      .then(() => this.setData({ exporting: false }))
      .catch((e) => {
        this.setData({ exporting: false });
        showError(e, '导出失败');
      });
  },

  // 点击行进详情
  onNav(e) {
    wx.navigateTo({ url: `/pages/admin/log-detail?log_id=${e.currentTarget.dataset.id}` });
  },
});
