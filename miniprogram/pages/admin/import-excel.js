// pages/admin/import-excel.js — Excel 导入（admin-module §2.2-7，R14/R15/R17）
// 接口：admin/import/template（列说明+下载链接）、import/submit（同步导入）、import/result（失败明细）
// biz_type 当前仅 stats（战绩导入，requireBizId=活动 ID）；URL 参数 biz_id 可由入口页带入。
// 后端为同步导入（E4 简化）：submit 直接返回结果，无需前端轮询 import/status。
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { CODE, ADMIN_BIZ } = require('../../utils/constants');

const BIZ_TYPE = 'stats';        // 当前注册的唯一导入类型（importers/stats.js）
const FILE_MAX_SIZE = 2 * 1024 * 1024; // R14：≤ 2MB（前端预检，后端兜底）

const STATUS_LABELS = {
  succeeded: { text: '导入成功', cls: 'st-ok' },
  partial: { text: '部分成功', cls: 'st-partial' },
  failed: { text: '导入失败', cls: 'st-fail' },
};

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

Page({
  data: {
    checking: true,
    noPermission: false,
    mode: 'form', // form | result
    bizId: '',
    columns: [],
    templateUrl: '',
    file: null,        // { name, size, sizeText, path }
    submitting: false,
    result: null,      // { status_label, status_cls, total, success_count, fail_count, import_id }
    failedRows: [],
    loadingFailRows: false,
  },

  onLoad(options) {
    if (options && options.biz_id) {
      this.setData({ bizId: options.biz_id });
    }
    requirePermission('record_stats').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadTemplate();
    });
  },

  // 模板列说明 + 下载链接（失败不阻断页面，点「下载模板」时重试）
  loadTemplate() {
    return callCloud('admin', 'import/template', { biz_type: BIZ_TYPE })
      .then((res) => {
        const d = res.data || {};
        this.setData({ columns: d.columns || [], templateUrl: d.download_url || '' });
      })
      .catch((e) => {
        console.warn('[import-excel] 模板加载失败', e);
      });
  },

  onBizIdInput(e) {
    this.setData({ bizId: e.detail.value });
  },

  // §2.2-7：wx.chooseMessageFile 选 xlsx（从聊天记录选择）
  onPickFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size > FILE_MAX_SIZE) {
          wx.showToast({ title: '文件不能超过 2MB', icon: 'none' });
          return;
        }
        this.setData({
          file: { name: f.name || '未命名.xlsx', size: f.size, sizeText: formatSize(f.size), path: f.path },
        });
      },
    });
  },

  onClearFile() {
    this.setData({ file: null });
  },

  onSubmit() {
    const bizId = (this.data.bizId || '').trim();
    if (!bizId) {
      wx.showToast({ title: '请填写活动 ID', icon: 'none' });
      return;
    }
    if (!this.data.file) {
      wx.showToast({ title: '请先选择 xlsx 文件', icon: 'none' });
      return;
    }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    wx.showLoading({ title: '上传文件中…', mask: true });

    // ① 上传云存储（cloudPath 带时间戳避免覆盖他人文件）
    const cloudPath = `imports/${BIZ_TYPE}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: this.data.file.path,
      success: (up) => {
        this.doSubmit(bizId, up.fileID);
      },
      fail: () => {
        wx.hideLoading();
        this.setData({ submitting: false });
        wx.showToast({ title: '文件上传失败，请重试', icon: 'none' });
      },
    });
  },

  // ② 提交导入（同步执行，可能较慢 → 全程 loading 遮罩）
  doSubmit(bizId, fileID) {
    wx.showLoading({ title: '正在导入…', mask: true });
    callCloud('admin', 'import/submit', {
      biz_type: BIZ_TYPE,
      biz_id: bizId,
      file_id: fileID,
      file_name: this.data.file.name,
    })
      .then((res) => {
        wx.hideLoading();
        const d = res.data || {};
        const st = STATUS_LABELS[d.status] || STATUS_LABELS.failed;
        this.setData({
          submitting: false,
          mode: 'result',
          result: {
            import_id: d.import_id,
            status_label: st.text,
            status_cls: st.cls,
            total: d.total || 0,
            success_count: d.success_count || 0,
            fail_count: d.fail_count || 0,
          },
          failedRows: [],
        });
        if ((d.fail_count || 0) > 0) this.loadFailRows(d.import_id);
      })
      .catch((e) => {
        wx.hideLoading();
        this.setData({ submitting: false });
        this.handleImportError(e);
      });
  },

  // 失败明细（行号 + 原因，最多 50 条）
  loadFailRows(importId) {
    this.setData({ loadingFailRows: true });
    callCloud('admin', 'import/result', { import_id: importId })
      .then((res) => {
        this.setData({ loadingFailRows: false, failedRows: (res.data || {}).failed_rows || [] });
      })
      .catch((e) => {
        console.warn('[import-excel] 失败明细加载失败', e);
        this.setData({ loadingFailRows: false });
        wx.showToast({ title: '失败明细加载失败', icon: 'none' });
      });
  },

  handleImportError(e) {
    // 文件/业务类错误用 modal 完整展示（如表头列提示需完整阅读）
    if (
      e && (
        e.code === ADMIN_BIZ.FILE_OVER_LIMIT ||
        e.code === ADMIN_BIZ.FILE_INVALID ||
        e.code === ADMIN_BIZ.BIZ_TYPE_UNREGISTERED ||
        e.code === ADMIN_BIZ.IMPORT_NOT_FOUND ||
        e.code === ADMIN_BIZ.NOT_FOUND ||
        e.code === CODE.PARAM
      )
    ) {
      wx.showModal({ title: '导入失败', content: e.msg || '文件或参数无效', showCancel: false });
      return;
    }
    showError(e, '导入失败');
  },

  // 下载模板：优先 wx.downloadFile + openDocument 直接预览，失败回退复制链接
  onDownloadTemplate() {
    const doDownload = () => {
      if (!this.data.templateUrl) {
        wx.showToast({ title: '模板链接未就绪，请稍后重试', icon: 'none' });
        return;
      }
      wx.showLoading({ title: '下载模板中…', mask: true });
      wx.downloadFile({
        url: this.data.templateUrl,
        success: (res) => {
          wx.hideLoading();
          if (res.statusCode === 200) {
            wx.openDocument({
              filePath: res.tempFilePath,
              fileType: 'xlsx',
              fail: () => this.copyTemplateUrl(),
            });
          } else {
            this.copyTemplateUrl();
          }
        },
        fail: () => {
          wx.hideLoading();
          this.copyTemplateUrl();
        },
      });
    };

    if (!this.data.templateUrl) {
      this.loadTemplate().then(doDownload);
    } else {
      doDownload();
    }
  },

  copyTemplateUrl() {
    wx.setClipboardData({
      data: this.data.templateUrl,
      success: () => {
        wx.showToast({ title: '链接已复制，可在浏览器打开下载', icon: 'none' });
      },
    });
  },

  // 失败明细复制（修正后重导，§2.2-7）
  onCopyFailRows() {
    const rows = this.data.failedRows;
    if (!rows.length) return;
    const text = rows
      .filter((r) => r.row)
      .map((r) => `第${r.row}行：${r.reason}`)
      .join('\n');
    wx.setClipboardData({
      data: text || '（无可复制的失败明细）',
      success: () => {
        wx.showToast({ title: '失败明细已复制', icon: 'none' });
      },
    });
  },

  // 回表单修正重导（保留活动 ID 与列说明）
  onReset() {
    this.setData({ mode: 'form', file: null, result: null, failedRows: [] });
  },
});
