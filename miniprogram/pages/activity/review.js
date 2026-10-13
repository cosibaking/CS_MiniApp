// pages/activity/review.js — 评价活动（login，activity-module §2.1 页面6 / §5.1.6，§3.10）
// 接口：activity/submitReview；仅已参加者可评价（活动 finished + 本人 checked_in/completed）
// 入口：我的报名 → 历史记录「评价」按钮（携带 activity_id + title）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

const MAX_CONTENT = 200;                       // §3.10-3：content ≤200 字
const STAR_TEXTS = { 1: '很差', 2: '较差', 3: '一般', 4: '满意', 5: '超赞' };
const ALREADY_REVIEWED = 3032;                 // §5.0：重复评价

Page({
  data: {
    activityId: '',
    activityTitle: '',
    starList: [1, 2, 3, 4, 5],
    stars: 0,
    starText: '',
    content: '',
    maxContent: MAX_CONTENT,
    submitting: false,
  },

  onLoad(options) {
    const activityId = options.activity_id || '';
    if (!activityId) {
      wx.showToast({ title: '缺少活动参数', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({
      activityId,
      activityTitle: decodeURIComponent(options.title || ''),
    });
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
      }
    });
  },

  // 星级选择（1~5，必选）
  onStarTap(e) {
    const stars = Number(e.currentTarget.dataset.star);
    if (!stars || stars === this.data.stars) return;
    this.setData({ stars, starText: STAR_TEXTS[stars] || '' });
  },

  onContentInput(e) {
    this.setData({ content: e.detail.value });
  },

  // 提交（§5.1.6：资格 3031/重复 3032 由后端拦截）
  onSubmit() {
    if (this.data.submitting) return;
    if (!this.data.stars) {
      wx.showToast({ title: '请先选择星级', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    callCloud('activity', 'submitReview', {
      activity_id: this.data.activityId,
      stars: this.data.stars,
      content: this.data.content.trim(),
    }).then(() => {
      this.setData({ submitting: false });
      wx.showModal({
        title: '感谢您的评价',
        content: '评价已提交，您的反馈对我们很重要',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    }).catch((err) => {
      this.setData({ submitting: false });
      if (err && err.code === ALREADY_REVIEWED) {
        wx.showToast({ title: '您已评价过该活动', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      showError(err, '提交失败，请重试');
    });
  },
});
