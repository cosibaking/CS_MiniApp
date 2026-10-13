// pages/activity/detail.js — 活动详情（guest，activity-module §2.1-2 / §2.2 / §5.1.2）
// 接口：activity/detail（全量 + my_enrollment + finished 汇总）
// 按钮状态机（§2.2）：立即报名/加入候补/待支付·去支付/已报名·查看报名/报名已截止/活动进行中/已结束/已取消
// 已取消：展示取消原因 + 报名费原路全额退回提示；已结束：评价摘要 + 相册入口（M2 页面）
const { callCloud } = require('../../utils/cloud');
const { showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const TYPE_LABELS = {
  novice: '新手体验课', regular: '常规对抗赛', theme: '主题赛事',
  league: '俱乐部联赛', custom: '团建定制',
};
const STATUS_LABELS = {
  draft: '未开放', published: '报名中', signup_closed: '报名截止',
  ongoing: '进行中', finished: '已结束', cancelled: '已取消',
};
const STATUS_CLASS = {
  draft: 'st-grey', published: 'st-green', signup_closed: 'st-grey',
  ongoing: 'st-blue', finished: 'st-grey', cancelled: 'st-red',
};
const PAY_TYPE_LABELS = { wxpay: '微信支付', times_card: '次卡', period_card: '期限卡' };
const HONOR_LABELS = { mvp: 'MVP', svp: 'SVP', best_heal: '最佳治疗', best_supply: '最佳补给', best_capture: '最佳占领' };
const HONOR_ORDER = ['mvp', 'svp', 'best_heal', 'best_supply', 'best_capture'];

// stats_summary 预格式化（§5.1.2 ③：kills 前十 + 荣誉名单）
function buildStatsSummary(ss) {
  if (!ss) return null;
  const honorLines = [];
  for (const key of HONOR_ORDER) {
    const names = (ss.honors && ss.honors[key]) || [];
    if (names.length) honorLines.push({ key, label: HONOR_LABELS[key], names: names.join('、') });
  }
  return {
    total: ss.total || 0,
    hasBoard: !!(ss.top10 && ss.top10.length),
    hasHonors: honorLines.length > 0,
    honorLines,
    top10: (ss.top10 || []).map((s) => Object.assign({}, s, {
      honorText: (s.honors || []).map((h) => HONOR_LABELS[h] || h).join(' / '),
    })),
  };
}

function rangeText(start, end) {
  const s = formatTime(start);
  if (!end) return s;
  const e = formatTime(end);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s} ~ ${e.slice(11)}` : `${s} ~ ${e}`;
}

// 底栏主按钮状态（§2.2 状态展示矩阵）
function computeAction(act, mine) {
  if (act.type === 'custom') return { text: '团建定制 · 请联系俱乐部', disabled: true }; // 3004 不开放自助报名
  if (act.status === 'cancelled') return { text: '活动已取消', disabled: true };
  if (act.status === 'finished') return { text: '活动已结束', disabled: true };
  if (act.status === 'ongoing') return { text: '活动进行中', disabled: true };
  if (act.status === 'signup_closed' || act.status === 'draft') return { text: act.status === 'draft' ? '报名未开放' : '报名已截止', disabled: true };
  // published：随本人报名态变化
  if (mine) {
    if (mine.status === 'pending') return { text: '待支付 · 去支付', type: 'pay' };
    if (mine.status === 'waitlist') return { text: `候补中 · 第 ${mine.position || '-'} 位`, type: 'my' };
    if (mine.status === 'checked_in') return { text: '已签到 · 查看报名', type: 'my' };
    if (mine.status === 'completed') return { text: '已参加 · 查看报名', type: 'my' };
    return { text: '已报名 · 查看我的报名', type: 'my' };
  }
  const remain = act.remain_num == null ? 1 : act.remain_num;
  return remain > 0
    ? { text: '立即报名', type: 'signup' }
    : { text: '加入候补', type: 'signup', full: true };
}

Page({
  data: {
    loading: true,
    id: '',
    act: null,        // 格式化后的活动展示模型
    action: { text: '', disabled: true },
    reviewSummary: null,
    albumCount: 0,
    statsSummary: null,
    showTeamEnroll: false,
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    this.fetch();
  },

  fetch() {
    const id = this.data.id;
    if (!id) {
      wx.showToast({ title: '活动不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ loading: true });
    callCloud('activity', 'detail', { activity_id: id }).then((res) => {
      const d = res.data || {};
      const act = d.activity || {};
      const mine = d.my_enrollment || null;
      const payTypes = (Array.isArray(act.pay_types) && act.pay_types.length)
        ? act.pay_types : ['wxpay', 'times_card', 'period_card'];
      const maxNum = act.max_num || 0;
      const remain = act.remain_num == null ? maxNum : act.remain_num;
      this.setData({
        loading: false,
        act: {
          id: act._id,
          title: act.title,
          cover: act.cover,
          typeLabel: TYPE_LABELS[act.type] || act.type,
          status: act.status,
          statusLabel: STATUS_LABELS[act.status] || act.status,
          statusClass: STATUS_CLASS[act.status] || 'st-grey',
          timeText: rangeText(act.start_time, act.end_time),
          deadlineText: act.signup_deadline ? formatTime(act.signup_deadline) : '-',
          venue: act.venue,
          address: act.address,
          priceText: act.price > 0 ? '¥' + formatMoney(act.price) : '免费',
          isFree: !(act.price > 0),
          remain,
          maxNum,
          minNum: act.min_num || 0,
          signupPercent: maxNum > 0 ? Math.min(100, Math.round(((maxNum - remain) / maxNum) * 100)) : 0,
          waitlistCount: act.waitlist_count || 0,
          payTypeText: payTypes.map((t) => PAY_TYPE_LABELS[t] || t).join(' / '),
          intro: act.intro || '暂无介绍',
          cancelReason: act.cancel_reason || '',
          mine,
        },
        action: computeAction(act, mine),
        reviewSummary: d.review_summary || null,
        albumCount: d.album_count || 0,
        statsSummary: buildStatsSummary(d.stats_summary),
      });
      this.checkTeamEnroll(act);
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败');
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  // 主按钮：signup → 报名确认页（登录在目标页处理）；pay/my → 我的报名
  onMainTap() {
    const type = this.data.action.type;
    if (!type) return;
    if (type === 'signup') {
      wx.navigateTo({ url: '/pages/activity/signup-confirm?id=' + this.data.id });
      return;
    }
    this.goMyEnrollments();
  },

  goMyEnrollments() {
    wx.navigateTo({ url: '/pages/activity/my-enrollments' });
  },

  // 战队报名入口（team-module §4.3）：在职队长 + 报名中 + 有名额 + 未截止；其余情况静默隐藏
  checkTeamEnroll(act) {
    this.setData({ showTeamEnroll: false });
    if (act.status !== 'published' || act.type === 'custom' || !(act.remain_num > 0)) return;
    if (act.signup_deadline && act.signup_deadline <= Date.now()) return;
    callCloud('team', 'my', {}).then((res) => {
      const at = (res.data || {}).active_team;
      if (at && at.role === 'captain') this.setData({ showTeamEnroll: true });
    }).catch(() => { /* 未登录/无战队：不显示入口 */ });
  },

  goTeamEnroll() {
    wx.navigateTo({ url: '/pages/team/enroll-select?activity_id=' + this.data.id });
  },

  goAlbum() {
    wx.navigateTo({ url: '/pages/activity/album?id=' + this.data.id });
  },

  goWaiver() {
    wx.navigateTo({ url: '/pages/profile/waiver' });
  },

  onShareAppMessage() {
    const act = this.data.act;
    return {
      title: act ? act.title : '俱乐部活动',
      path: '/pages/activity/detail?id=' + this.data.id,
      imageUrl: act && act.cover ? act.cover : undefined,
    };
  },
});
