// pages/admin/refund-audit.js — 退款审核（payment-module §5.9 / admin-module §2.3）
// 接口：order/refundList（管理端列表，audit_refund）、order/refundAudit（审核动作）
// 边界（§6.5 敏感操作二次确认；驳回理由必填 ≤200 字，前端不发空请求）：
//   42004 已被处理 → 刷新列表；其余失败 → 行内标记原因不打断列表；
//   同意前弹窗展示退款金额（执行时后端会重算可退金额，取较小值 §3.4）
const { callCloud } = require('../../utils/cloud');
const { requirePermission, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const PAGE_SIZE = 20;
const BIZ_REFUND_DUP = 42004; // order/shared.js BIZ.REFUND_DUP（退款单已被处理）

const STATUS_TEXT = {
  pending: '待审核',
  processing: '退款中',
  success: '已退款',
  failed: '退款失败',
  rejected: '已驳回',
};

Page({
  data: {
    checking: true,        // 权限预检中
    noPermission: false,   // audit_refund 门控（入口体验层；云函数侧硬校验）
    activeTab: 'pending',  // pending 待审核 / processed 已处理
    pending: [],
    processed: [],
    listLoading: false,
    tabFailed: false,
    acting: false,
  },

  onLoad() {
    this._tabLoading = false;
    this._tabState = {};
    ['pending', 'processed'].forEach((t) => {
      this._tabState[t] = { page: 1, finished: false, loaded: false };
    });
    requirePermission('audit_refund').then((pass) => {
      this.setData({ checking: false, noPermission: !pass });
      if (pass) this.loadTab('pending', true);
    });
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
  },

  onReachBottom() {
    this.loadTab(this.data.activeTab, false);
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (!this._tabState[tab] || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab, tabFailed: false });
    if (!this._tabState[tab].loaded) this.loadTab(tab, true);
  },

  retryTab() {
    this.loadTab(this.data.activeTab, true);
  },

  // reset=true 重置当前 Tab 第一页（refundList：status 分 Tab 查询）
  loadTab(tab, reset) {
    const st = this._tabState[tab];
    if (!st || this._tabLoading) return;
    if (!reset && st.finished) return;
    const page = reset ? 1 : st.page + 1;
    this._tabLoading = true;
    this.setData({ listLoading: true });
    callCloud('order', 'refundList', {
      status: tab,
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((r) => this.mapItem(r));
      st.page = page;
      st.finished = items.length < PAGE_SIZE;
      st.loaded = true;
      const patch = { listLoading: false, tabFailed: false };
      patch[tab] = reset ? items : this.data[tab].concat(items);
      this.setData(patch);
    }).catch((e) => {
      this.setData({ listLoading: false, tabFailed: !st.loaded });
      showError(e, '列表加载失败，请重试');
    }).then(() => {
      this._tabLoading = false;
    });
  },

  mapItem(r) {
    return {
      refund_no: r.refund_no,
      order_no: r.order_no,
      amount_text: '¥' + formatMoney(r.amount),
      status: r.status,
      status_text: STATUS_TEXT[r.status] || r.status,
      reason: r.reason || '',
      audit_remark: r.audit_remark || '',
      fail_reason: r.fail_reason || '',
      created_text: r.created_at ? formatTime(r.created_at) + ' 申请' : '',
      audit_text: r.audit_at ? formatTime(r.audit_at) + ' 审核' : '',
      refunded_text: r.refunded_at ? formatTime(r.refunded_at) + ' 到账' : '',
      order_title: r.order_title || '未命名活动',
      start_text: r.start_time ? '开始 ' + formatTime(r.start_time) : '',
      pay_text: r.pay_amount ? '实付 ¥' + formatMoney(r.pay_amount) : '',
      refunded_total_text: r.refunded_total ? '已退 ¥' + formatMoney(r.refunded_total) : '',
      payer_name: r.payer_name || '会员',
      per_user: !!r.per_user,
      refund_members: r.refund_members || '',
      failMsg: '',
    };
  },

  // 同意（§6.5：敏感操作二次确认，展示退款金额；后端执行时会重算可退金额取较小值）
  onApprove(e) {
    if (this.data.acting) return;
    const idx = Number(e.currentTarget.dataset.index);
    const r = this.data.pending[idx];
    if (!r) return;
    wx.showModal({
      title: '同意退款',
      content: '将向「' + r.order_title + '」付款方 ' + r.payer_name + ' 发起退款 ' + r.amount_text + '，确认执行？',
      confirmText: '同意',
      success: (res) => {
        if (res.confirm) this.handleAudit(idx, 'approve', null);
      },
    });
  },

  // 驳回（§5.9：理由必填 ≤200 字，随审核结果通知申请人）
  onReject(e) {
    if (this.data.acting) return;
    const idx = Number(e.currentTarget.dataset.index);
    const r = this.data.pending[idx];
    if (!r) return;
    wx.showModal({
      title: '驳回退款',
      content: '驳回后退款单终止，申请人可查看驳回理由。',
      editable: true,
      placeholderText: '驳回理由（必填，≤200 字）',
      confirmText: '驳回',
      confirmColor: '#B03030',
      success: (res) => {
        if (!res.confirm) return;
        const remark = String(res.content || '').trim();
        if (!remark) {
          wx.showToast({ title: '请填写驳回理由', icon: 'none' });
          return;
        }
        if (remark.length > 200) {
          wx.showToast({ title: '驳回理由不可超过 200 字', icon: 'none' });
          return;
        }
        this.handleAudit(idx, 'reject', remark);
      },
    });
  },

  // 执行审核（42004 已被处理 → 刷新；其余失败行内标记不打断列表）
  handleAudit(idx, auditAction, remark) {
    const r = this.data.pending[idx];
    if (!r) return;
    this.setData({ acting: true });
    callCloud('order', 'refundAudit', {
      refund_no: r.refund_no,
      audit_action: auditAction,
      audit_remark: remark || null,
    }).then(() => {
      wx.showToast({ title: auditAction === 'approve' ? '已同意' : '已驳回', icon: 'success' });
      this.refreshAfterAudit();
    }).catch((err) => {
      if (err && err.code === BIZ_REFUND_DUP) {
        wx.showToast({ title: '该退款单已被处理', icon: 'none' });
        this.refreshAfterAudit();
      } else {
        // 42002/42005 等：行内标记失败原因（§5.9 驳回必填理由已由前端预校验）
        showError(err, '操作失败，请稍后重试');
        const patch = {};
        patch['pending[' + idx + '].failMsg'] = (err && err.msg) || '操作失败，请稍后重试';
        this.setData(patch);
      }
    }).then(() => this.setData({ acting: false }));
  },

  // 审核落定后：重取待审核列表；已处理 Tab 标记待重取（条目会迁移过来）
  refreshAfterAudit() {
    const st = this._tabState.processed;
    if (st) st.loaded = false;
    if (this.data.activeTab === 'pending') {
      this.loadTab('pending', true);
    } else if (st) {
      this.loadTab('processed', true);
    }
  },
});
