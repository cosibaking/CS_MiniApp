// pages/order/refund-apply.js — 申请退款（payment-module §2 页面5）
// 接口：order/detail（订单摘要 + 规则预估）、order/refundApply（提交申请）。
// 规则提示为 §3.4 前端镜像（仅展示预估；服务端以活动最新开始时间与签到态
// 为准，最终以 refundApply 校验结果为准）：≥24h 全额自动退；<24h 未开始退
// 实付 50% 需人工审核；已开始/无可退余额 → 42002 前置拦截。
// 批量单（items ≥ 2）支持按人勾选退款（§3.9）：默认全选，全选时省略
// refund_user_ids 走服务端整单路径；部分勾选按单人分摊预估，金额以服务端为准。
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const HOUR_24 = 24 * 60 * 60 * 1000;

Page({
  data: {
    loading: true,
    orderNo: '',
    order: null,       // 订单摘要（标题/开始时间/实付/已退）
    reason: '',        // 退款原因（必填，≤200 字，服务端同长截断）
    canApply: false,   // 状态与时间规则是否允许提交
    ruleTip: '',       // 退款规则提示（动态）
    estimateText: '',  // 预计可退金额（数字文本，展示层加 ¥）
    isBatch: false,    // 批量单（items ≥ 2）→ 显示按人勾选（§3.9）
    members: [],       // 成员勾选项 { userId, nickname, amountText, checked, disabled, refunded }
    selectedCount: 0,  // 已勾选成员数
    submitting: false,
  },

  onLoad(options) {
    this.orderNo = options.order_no || '';
    this.setData({ orderNo: this.orderNo });
    requireLogin().then((user) => {
      this.user = user;
      if (!this.orderNo) {
        wx.showModal({ title: '提示', content: '缺少订单号', showCancel: false, success: () => wx.navigateBack() });
        return;
      }
      this.fetch();
    }).catch(() => {
      wx.showToast({ title: '请先登录', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  fetch() {
    // 首次进入显示加载态；提交失败重拉保持内容不闪烁
    this.setData({ loading: !this.data.order });
    callCloud('order', 'detail', { order_no: this.orderNo }).then((res) => {
      const o = (res.data && res.data.order) || null;
      if (!o) throw new Error('订单不存在');
      const snap = o.snapshot || {};
      const payAmount = o.pay_amount || 0;
      const refundedTotal = o.refunded_total || 0;
      const refundable = payAmount - refundedTotal;
      const startTime = snap.start_time || null;

      // 规则预估（§3.4 镜像；签到态由服务端校验拦截）
      const refundableStatus = o.status === 'paid' || o.status === 'partial_refunded';
      const started = !!(startTime && Date.now() >= startTime);
      const manual = refundableStatus && refundable > 0 && !started
        && !!(startTime && startTime - Date.now() < HOUR_24);
      this.batchManual = manual;
      this.orderPayAmount = payAmount;
      this.orderRefundable = refundable;

      let canApply = false;
      let ruleTip = '';
      let estimateText = '';
      if (!refundableStatus) {
        ruleTip = '当前订单状态不可申请退款';
      } else if (refundable <= 0) {
        ruleTip = '该订单已无可退余额';
      } else if (started) {
        ruleTip = '活动已开始，不可申请退款';
      } else {
        canApply = true;
        if (!manual) {
          estimateText = formatMoney(refundable);
          ruleTip = '距活动开始超过24小时，提交后按可退余额全额原路退回微信支付，无需审核。';
        } else {
          estimateText = formatMoney(Math.min(Math.round(payAmount * 0.5), refundable));
          ruleTip = '距活动开始不足24小时，可退实付金额的50%，提交后需管理员审核。';
        }
      }

      // §3.9 批量单按人勾选（items ≥ 2）：默认全选未退款成员。分摊镜像服务端
      // floor(pay_amount/n)、余数锚定明细末位；<24h 时单人按 round(share×50%) 预估
      const items = o.items || [];
      const isBatch = items.length >= 2;
      let members = [];
      if (isBatch && canApply) {
        const unit = Math.floor(payAmount / items.length);
        const remainder = payAmount - unit * items.length;
        this.memberShares = items.map((it, idx) => (
          idx === items.length - 1 ? unit + Math.max(remainder, 0) : unit
        ));
        members = items.map((it, idx) => {
          const refunded = it.refund_status === 'refunded';
          return {
            userId: it.user_id,
            nickname: it.nickname || ('成员' + (idx + 1)),
            amountText: formatMoney(this.memberShares[idx]),
            checked: !refunded,
            disabled: refunded,
            refunded,
          };
        });
        this.batchAllChecked = true;
        // 勾选态覆盖整单预估（全选时两者口径一致，见 computeBatch）
        let total = 0;
        this.memberShares.forEach((share, i) => {
          if (members[i].checked) total += manual ? Math.round(share * 0.5) : share;
        });
        estimateText = formatMoney(total);
      } else {
        this.memberShares = null;
        this.batchAllChecked = true;
      }

      this.setData({
        loading: false,
        canApply,
        ruleTip,
        estimateText,
        isBatch,
        members,
        selectedCount: members.filter((m) => m.checked).length,
        order: {
          title: snap.title || '俱乐部活动',
          timeText: snap.start_time ? formatTime(snap.start_time) : '-',
          orderNo: o.order_no,
          payAmountText: formatMoney(payAmount),
          refundedText: refundedTotal > 0 ? formatMoney(refundedTotal) : '',
        },
      });
    }).catch((e) => {
      this.setData({ loading: false });
      wx.showModal({
        title: '提示', content: (e && e.msg) || '订单加载失败', showCancel: false,
        success: () => wx.navigateBack(),
      });
    });
  },

  onReasonInput(e) {
    this.setData({ reason: e.detail.value });
  },

  // §3.9 勾选/取消成员：重算预估与「是否全选」（全选 → 提交省略 refund_user_ids）
  onToggleMember(e) {
    const userId = e.currentTarget.dataset.userId;
    if (this.data.members.some((m) => m.userId === userId && m.disabled)) return;
    const members = this.data.members.map((m) => (
      m.userId === userId ? Object.assign({}, m, { checked: !m.checked }) : m
    ));
    this.setData({ members });
    this.computeBatch();
  },

  // 重算勾选预估：全选（未退款成员全部勾选）→ 与服务端整单路径同口径；
  // 部分勾选 → 按人分摊合计（<24h 时单人 round(share×50%)，§3.9）
  computeBatch() {
    if (!this.memberShares) return;
    const members = this.data.members;
    const selectedCount = members.filter((m) => m.checked).length;
    const anyUnchecked = members.some((m) => !m.checked && !m.disabled);
    if (!anyUnchecked) {
      this.batchAllChecked = true;
      const total = this.batchManual
        ? Math.min(Math.round(this.orderPayAmount * 0.5), this.orderRefundable)
        : this.orderRefundable;
      this.setData({ estimateText: formatMoney(total), selectedCount });
      return;
    }
    this.batchAllChecked = false;
    let total = 0;
    this.memberShares.forEach((share, i) => {
      if (members[i] && members[i].checked) {
        total += this.batchManual ? Math.round(share * 0.5) : share;
      }
    });
    this.setData({ estimateText: formatMoney(total), selectedCount });
  },

  // 提交申请（敏感操作：确认弹窗；成功后进入退款进度 §2 页面6）
  onTapSubmit() {
    if (!this.data.canApply || this.data.submitting) return;
    const reason = (this.data.reason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请填写退款原因', icon: 'none' });
      return;
    }
    // §3.9 批量单：至少勾选一名成员
    if (this.data.isBatch && this.data.selectedCount === 0) {
      wx.showToast({ title: '请至少勾选一名退款成员', icon: 'none' });
      return;
    }
    const partial = this.data.isBatch && !this.batchAllChecked;
    const detail = partial ? '已勾选 ' + this.data.selectedCount + ' 名成员，' : '';
    wx.showModal({
      title: '申请退款',
      content: detail + '预计退款 ¥' + this.data.estimateText + '，将原路退回微信支付，确定提交？',
      success: (r) => {
        if (!r.confirm) return;
        this.submit(reason);
      },
    });
  },

  submit(reason) {
    // §3.9：批量单部分勾选 → 按人退款 refund_user_ids；全选/单人单省略走整单路径
    const payload = { order_no: this.orderNo, reason };
    if (this.data.isBatch && !this.batchAllChecked) {
      payload.refund_user_ids = this.data.members
        .filter((m) => m.checked).map((m) => m.userId);
    }
    this.setData({ submitting: true });
    callCloud('order', 'refundApply', payload).then((res) => {
      this.setData({ submitting: false });
      const needAudit = res.data && res.data.need_audit !== false;
      wx.showToast({ title: needAudit ? '申请已提交' : '退款已发起', icon: 'success' });
      setTimeout(() => this.goProgress(), 800);
    }).catch((e) => {
      this.setData({ submitting: false });
      const code = e && e.code;
      if (code === 42004) {
        // 已存在未终态退款单 → 直接查看进度
        wx.showModal({
          title: '提示', content: e.msg || '已有退款申请处理中', showCancel: false,
          success: () => this.goProgress(),
        });
        return;
      }
      if (code === 42001) {
        wx.showModal({
          title: '提示', content: e.msg || '当前订单状态不可退款', showCancel: false,
          success: () => wx.navigateBack(),
        });
        return;
      }
      if (code === 42002 || code === 42003 || code === 42006) {
        // 已开始/已签到/无可退余额/金额为零/超出可退余额（服务端签到态在此拦截）
        wx.showModal({ title: '无法退款', content: e.msg || '不满足退款条件', showCancel: false });
        return;
      }
      if (code === 50001) {
        // 自动退款微信侧发起失败：退款单已建（failed 待对账重试 §8.4），进度页可见
        wx.showToast({ title: e.msg || '退款发起失败，将自动重试', icon: 'none', duration: 2000 });
        setTimeout(() => this.goProgress(), 2000);
        return;
      }
      showError(e, '提交失败');
    });
  },

  // 替换当前页进入退款进度（返回时直接回订单详情，不回申请页）
  goProgress() {
    wx.redirectTo({ url: '/pages/order/refund-progress?order_no=' + this.orderNo });
  },
});
