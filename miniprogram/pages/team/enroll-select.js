// pages/team/enroll-select.js — 战队报名选人（login（队长），team-module §4.3 / §5.18-5.19）
// 接口：team/enrollable-members（在职成员 + 资格状态 + 活动剩余名额）、team/enroll-submit
// 流程：勾选可报名成员（不可选标灰 + 原因）→ 预检（人数 ≤ 剩余名额）→ 提交 →
//       有批量订单（order_no）进收银台（支付人=队长，15 分钟窗口）；0 元免单直接完成
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { TEAM_BIZ } = require('../../utils/constants');

Page({
  data: {
    loading: true,
    submitting: false,
    activityId: '',
    leftQuota: 0,   // 活动剩余名额（§5.18 前端预检展示）
    members: [],    // { user_id, nickname, avatar, isCaptain, enrollable, block_reason, selected }
    selectedCount: 0,
  },

  onLoad(options) {
    this.setData({ activityId: options.activity_id || '' });
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.fetch();
    });
  },

  fetch() {
    if (!this.data.activityId) {
      wx.showToast({ title: '活动不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ loading: true });
    callCloud('team', 'enrollable-members', { activity_id: this.data.activityId }).then((res) => {
      const d = res.data || {};
      const members = (d.list || []).map((m) => ({
        user_id: m.user_id,
        nickname: m.nickname || '会员',
        avatar: m.avatar || '',
        isCaptain: m.role === 'captain',
        enrollable: !!m.enrollable,
        block_reason: m.block_reason || '',
        selected: false,
      }));
      this.setData({
        loading: false,
        leftQuota: d.activity_left_quota || 0,
        members,
        selectedCount: 0,
      });
    }).catch((e) => {
      this.setData({ loading: false });
      if (e && e.code === TEAM_BIZ.CAPTAIN_ONLY) {
        wx.showModal({
          title: '提示',
          content: '仅本队队长可发起战队报名',
          showCancel: false,
          success: () => wx.navigateBack(),
        });
        return;
      }
      showError(e, '加载失败');
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  // 勾选/取消（不可报名成员禁选；名额预检 §4.3 C2）
  onToggle(e) {
    const m = this.data.members[e.currentTarget.dataset.index];
    if (!m || !m.enrollable) return;
    const selected = !m.selected;
    if (selected && this.data.selectedCount >= this.data.leftQuota) {
      wx.showToast({ title: `活动剩余名额仅 ${this.data.leftQuota} 人`, icon: 'none' });
      return;
    }
    this.setData({
      [`members[${e.currentTarget.dataset.index}].selected`]: selected,
      selectedCount: this.data.selectedCount + (selected ? 1 : -1),
    });
  },

  onSubmit() {
    const { submitting, selectedCount, members } = this.data;
    if (submitting || selectedCount < 1) return;
    const ids = members.filter((m) => m.selected).map((m) => m.user_id);
    this.setData({ submitting: true });
    callCloud('team', 'enroll-submit', {
      activity_id: this.data.activityId,
      member_user_ids: ids,
    }).then((res) => {
      const d = res.data || {};
      if (d.order_no) {
        // 批量待支付订单已建（§5.19 第 4 步）：收银台拉起微信支付
        wx.redirectTo({ url: '/pages/order/cashier?order_no=' + d.order_no });
      } else {
        // 0 元免单路径：无订单直接 enrolled，回我的报名查看
        wx.showModal({
          title: '报名成功',
          content: `已为本队 ${ids.length} 名成员完成报名`,
          showCancel: false,
          success: () => wx.redirectTo({ url: '/pages/activity/my-enrollments' }),
        });
      }
    }).catch((e) => {
      this.setData({ submitting: false });
      if (e && (e.code === TEAM_BIZ.DUP_PENDING || e.code === TEAM_BIZ.QUOTA_SHORT)) {
        // 重复报名 / 名额不足：提示后刷新成员资格与剩余名额（后端为最终校验）
        wx.showModal({
          title: '提示',
          content: (e && e.msg) || '提交失败',
          showCancel: false,
          success: () => this.fetch(),
        });
        return;
      }
      showError(e, '提交失败，请重试');
    });
  },
});
