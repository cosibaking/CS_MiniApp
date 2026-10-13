// pages/activity/checkin-verify.js — 现场签到核验（activity-module §2.1-5 / §5.1.5 / §3.7 / §4.3）
// 流程：扫现场二维码进入 → 自动调 selfCheckin 提交核验请求 → 展示本人凭证供线下比对
// → 轮询 myEnrollments 等工作人员 confirmCheckin，通过后本页自动翻转为签到成功。
const { callCloud } = require('../../utils/cloud');
const { requireLogin } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');

const PAY_TYPE_LABELS = {
  wxpay: '微信支付', times_card: '次卡', period_card: '期限卡', free: '免费',
};
const POLL_MS = 5000;
const TOKEN_EXPIRED = 3021;    // §5.0：二维码过期/无效
const NOT_ENROLLABLE = 3022;   // §5.0：无有效报名
const NOT_IN_WINDOW = 3005;    // §5.0：不在签到窗口

Page({
  data: {
    phase: 'submitting', // submitting | waiting | success | error
    credential: null,    // { nickname, avatar, payTypeText, cardRemainText }
    tip: '',
    checkinTimeText: '',
    errorMsg: '',
    rescan: false,       // error 态是否引导重新扫码（3021）
    activityId: '',
    token: '',
  },

  onLoad(options) {
    const activityId = options.activity_id || '';
    const token = options.token || '';
    this.setData({ activityId, token });
    requireLogin().then((user) => {
      if (!user) return;
      if (!activityId || !token) {
        this.setError('二维码内容无效，请对准工作人员出示的二维码重扫', true);
        return;
      }
      this.submit();
    });
  },

  onUnload() {
    this.stopPoll();
  },

  // 提交签到请求（token 可由重新扫码刷新；3021 后重扫即走这里）
  submit() {
    if (this._submitting) return;
    this._submitting = true;
    this.setData({ phase: 'submitting', errorMsg: '', rescan: false });
    callCloud('activity', 'selfCheckin', {
      activity_id: this.data.activityId,
      token: this.data.token,
    }).then((res) => {
      const d = res.data || {};
      if (d.checkin_status === 'checked_in') {
        this.showSuccess(d.checkin_time);
        return;
      }
      this.setData({
        phase: 'waiting',
        tip: d.tip || '请向工作人员出示此凭证完成核验',
        credential: this.buildCredential(d.enrollment || {}),
      });
      this.startPoll();
    }).catch((err) => {
      if (err.code === TOKEN_EXPIRED) {
        this.setError('签到二维码已过期，请向工作人员确认后重新扫码', true);
      } else {
        this.setError(err.msg || '签到失败，请重试', false);
      }
    }).then(() => {
      this._submitting = false;
    });
  },

  buildCredential(e) {
    const cred = {
      nickname: e.nickname || '未设置昵称',
      avatar: e.avatar || '',
      payTypeText: PAY_TYPE_LABELS[e.pay_type] || e.pay_type || '-',
      cardRemainText: '',
    };
    if (e.pay_type === 'times_card') {
      cred.cardRemainText = `次卡余次 ${e.card_remain_times != null ? e.card_remain_times : '-'}`;
    }
    return cred;
  },

  showSuccess(checkinTime) {
    this.stopPoll();
    this.setData({
      phase: 'success',
      checkinTimeText: checkinTime ? formatTime(checkinTime) : '',
    });
  },

  // ---------- 轮询核验结果（myEnrollments 最近记录匹配本活动，§4.3「轮询/页面状态」） ----------
  startPoll() {
    this.stopPoll();
    this._timer = setInterval(() => this.pollStatus(), POLL_MS);
  },
  stopPoll() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._polling = false;
  },
  pollStatus() {
    if (this._polling || this.data.phase !== 'waiting') return;
    this._polling = true;
    callCloud('activity', 'myEnrollments', { page: 1, page_size: 10 })
      .then((res) => {
        const list = (res.data && res.data.list) || [];
        const hit = list.find((it) => it.activity_id === this.data.activityId);
        if (hit && hit.status === 'checked_in') {
          this.showSuccess(hit.checkin_time);
        }
      })
      .catch(() => { /* 轮询失败静默，下个周期继续 */ })
      .then(() => {
        this._polling = false;
      });
  },

  // ---------- 事件 ----------
  setError(msg, rescan) {
    this.stopPoll();
    this.setData({ phase: 'error', errorMsg: msg, rescan: !!rescan });
  },

  // 重新扫码（3021）：解析二维码内容中的 activity_id / token 后重新提交
  onRescanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (r) => {
        const raw = String(r.result || '');
        const mId = raw.match(/[?&]activity_id=([^&\s]+)/);
        const mTk = raw.match(/[?&]token=([^&\s]+)/);
        if (!mId || !mTk) {
          wx.showToast({ title: '无效的签到二维码', icon: 'none' });
          return;
        }
        this.setData({
          activityId: decodeURIComponent(mId[1]),
          token: decodeURIComponent(mTk[1]),
        });
        this.submit();
      },
      fail: () => { /* 用户取消扫码，保持当前错误态 */ },
    });
  },

  // 重试（网络类失败；token 若已过期会转为 3021 引导重扫）
  onRetryTap() {
    this.submit();
  },
});
