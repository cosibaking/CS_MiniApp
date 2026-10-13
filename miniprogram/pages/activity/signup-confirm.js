// pages/activity/signup-confirm.js — 报名确认（login，activity-module §2.1 页面3 / §5.1.3）
// 接口：activity/detail（活动快照 + 本人报名态）、activity/signup（提交报名）
// result='pay' 时以 pay_params 直接拉起 wx.requestPayment；前置项（免责协议/手机号）缺失给引导
// BIZ 错误码（shared.js）：3010 WAIVER_REQUIRED / 3011 PHONE_REQUIRED / 3009 DUPLICATE / 3004 custom 未开放自助报名
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatMoney, formatTime } = require('../../utils/format');

const PAY_OPTIONS = [
  { key: 'wxpay', label: '微信支付', desc: '在线支付' },
  { key: 'times_card', label: '次卡', desc: '扣减 1 次' },
  { key: 'period_card', label: '期限卡', desc: '卡期内免费' },
];

function rangeText(start, end) {
  const s = formatTime(start);
  if (!end) return s;
  const e = formatTime(end);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s} ~ ${e.slice(11)}` : `${s} ~ ${e}`;
}

Page({
  data: {
    loading: true,
    id: '',
    act: null,               // 活动快照（title/cover/timeText/venue/price/remain/waitlistCount/isFull/isFree）
    user: { waiverSigned: false, phoneBound: false },
    payOptions: [],
    payType: 'wxpay',
    agreed: false,
    submitting: false,
    // 费用明细（展示预估，金额以服务端计算为准）
    originalText: '',
    discountLabel: '',
    discountText: '',
    cardDeductText: '',
    payableText: '',
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.applyUser(user);
      this.fetch();
    });
  },

  // 从 waiver / bind-phone 返回：刷新用户态（silentLogin 每次真实重登，无缓存跳过）
  onShow() {
    if (!this.wentAway || !this.data.id) return;
    this.wentAway = false;
    getApp().silentLogin().then((info) => {
      if (info && info.user) {
        this.applyUser(info.user);
        this.updateFee();
      }
    });
  },

  applyUser(user) {
    this.user = user; // 原始引用（含 level）
    this.setData({
      user: {
        waiverSigned: !!user.waiver_signed,
        phoneBound: !!user.phone_bound,
      },
    });
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
      const a = d.activity || {};
      // 前置状态校验（服务端 signup 同样硬校验，双防线）
      if (a.type === 'custom') {
        this.backWith('该活动为团建定制，不开放自助报名，请联系俱乐部');
        return;
      }
      if (a.status !== 'published') {
        this.backWith('当前活动状态不可报名');
        return;
      }
      if (d.my_enrollment) {
        wx.showModal({
          title: '已报名',
          content: '您已有该活动的报名记录，可在「我的报名」中查看',
          showCancel: false,
          success: () => wx.redirectTo({ url: '/pages/activity/detail?id=' + id }),
        });
        return;
      }
      const payTypes = (Array.isArray(a.pay_types) && a.pay_types.length)
        ? a.pay_types : ['wxpay', 'times_card', 'period_card'];
      const payOptions = PAY_OPTIONS.filter((o) => payTypes.indexOf(o.key) !== -1);
      const remain = a.remain_num == null ? (a.max_num || 0) : a.remain_num;
      const defaultPay = payOptions.some((o) => o.key === 'wxpay') ? 'wxpay' : payOptions[0].key;
      this.setData({
        loading: false,
        act: {
          title: a.title,
          cover: a.cover,
          timeText: rangeText(a.start_time, a.end_time),
          venue: a.venue,
          price: a.price || 0,
          remain,
          maxNum: a.max_num || 0,
          waitlistCount: a.waitlist_count || 0,
          isFull: remain <= 0,
          isFree: !(a.price > 0),
        },
        payOptions,
        payType: defaultPay,
      }, () => this.updateFee());
    }).catch((e) => {
      this.setData({ loading: false });
      showError(e, '加载失败');
      setTimeout(() => wx.navigateBack(), 1200);
    });
  },

  backWith(msg) {
    this.setData({ loading: false });
    wx.showModal({ title: '提示', content: msg, showCancel: false, success: () => wx.navigateBack() });
  },

  // 费用预估（与服务端 shared.calcPrice 同式：Math.round(base * pct / 100)）
  updateFee() {
    const act = this.data.act;
    if (!act) return;
    const level = (this.user && this.user.level) || {};
    const pct = level.discount_percent || 100; // null（未定级/新兵/老兵）不打折
    const original = act.price || 0;
    let payable = 0;
    let discountAmount = 0;
    if (this.data.payType === 'wxpay') {
      payable = Math.round((original * pct) / 100);
      discountAmount = original - payable;
    }
    this.setData({
      originalText: original > 0 ? '¥' + formatMoney(original) : '免费',
      discountLabel: this.data.payType === 'wxpay' && discountAmount > 0 ? `${level.name || '会员'} · ${pct / 10} 折` : '',
      discountText: discountAmount > 0 ? '-¥' + formatMoney(discountAmount) : '',
      cardDeductText: this.data.payType !== 'wxpay' && original > 0 ? '-¥' + formatMoney(original) : '',
      payableText: payable > 0 ? '¥' + formatMoney(payable) : '¥0',
    });
  },

  onPayTypeTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.payType) return;
    this.setData({ payType: key }, () => this.updateFee());
  },

  toggleAgreed() {
    this.setData({ agreed: !this.data.agreed });
  },

  goWaiver() {
    this.wentAway = true;
    wx.navigateTo({ url: '/pages/profile/waiver' });
  },

  goBindPhone() {
    this.wentAway = true;
    wx.navigateTo({ url: '/pages/profile/bind-phone' });
  },

  onSubmit() {
    if (this.data.submitting || !this.data.act) return;
    const user = this.data.user;
    // 前置项本地引导（服务端 3010/3011 双防线）
    if (!user.waiverSigned) {
      wx.showModal({
        title: '需要签署协议',
        content: '首次报名需先签署《参赛免责协议》，去签署？',
        confirmText: '去签署',
        success: (r) => { if (r.confirm) this.goWaiver(); },
      });
      return;
    }
    if (!user.phoneBound) {
      wx.showModal({
        title: '需要绑定手机',
        content: '报名与签到通知需要手机号，去绑定？',
        confirmText: '去绑定',
        success: (r) => { if (r.confirm) this.goBindPhone(); },
      });
      return;
    }
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选《参赛免责协议》', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    callCloud('activity', 'signup', {
      activity_id: this.data.id,
      pay_type: this.data.payType,
    }).then((res) => {
      const d = res.data || {};
      if (d.result === 'pay') {
        this.setData({ submitting: false });
        this.requestPay(d);
        return;
      }
      if (d.result === 'waitlist') {
        wx.showModal({
          title: '已加入候补',
          content: `名额已满，已为您加入候补（第 ${d.position || '-'} 位），有人退出时将自动递补并通知您`,
          showCancel: false,
          success: () => wx.redirectTo({ url: '/pages/activity/detail?id=' + this.data.id }),
        });
        return;
      }
      // enrolled（免费 / 会员卡）
      wx.showModal({
        title: '报名成功',
        content: '名额已确认，可在「我的报名」中查看',
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/activity/detail?id=' + this.data.id }),
      });
    }).catch((e) => this.handleSignupError(e));
  },

  handleSignupError(e) {
    this.setData({ submitting: false });
    const code = e && e.code;
    if (code === 3010) { // WAIVER_REQUIRED
      wx.showModal({
        title: '需要签署协议', content: '请先签署《参赛免责协议》后再报名', confirmText: '去签署',
        success: (r) => { if (r.confirm) this.goWaiver(); },
      });
      return;
    }
    if (code === 3011) { // PHONE_REQUIRED
      wx.showModal({
        title: '需要绑定手机', content: '报名前请先绑定手机号', confirmText: '去绑定',
        success: (r) => { if (r.confirm) this.goBindPhone(); },
      });
      return;
    }
    if (code === 3009) { // DUPLICATE
      wx.showModal({
        title: '已报名', content: '您已有该活动的报名记录', showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/activity/detail?id=' + this.data.id }),
      });
      return;
    }
    showError(e, '报名失败');
  },

  // result='pay'：直接以服务端 pay_params 拉起支付（payment-module §3.2 字段一致）
  requestPay(d) {
    wx.requestPayment({
      ...d.pay_params,
      success: () => {
        wx.showModal({
          title: '报名成功', content: '支付完成，名额已确认', showCancel: false,
          success: () => wx.redirectTo({ url: '/pages/activity/detail?id=' + this.data.id }),
        });
      },
      fail: () => {
        // 含用户取消：报名保留 15 分钟，超时自动释放（cron）
        wx.showModal({
          title: '支付未完成',
          content: '报名已保留 15 分钟，请及时在「我的报名」中完成支付，超时将自动释放名额',
          showCancel: false,
          success: () => wx.redirectTo({ url: '/pages/activity/my-enrollments' }),
        });
      },
    });
  },
});
