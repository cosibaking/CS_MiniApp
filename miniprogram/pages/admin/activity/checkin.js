// pages/admin/activity/checkin.js — 签到管理（checkin_activity，activity-module §3.7 / §5.2.7-§5.2.9）
// 接口：activity/getCheckinCode（动态 token 60s 轮换）、activity/checkinWaiting（待核验轮询，M2 新增只读口）、
//       activity/confirmCheckin（现场核验，联动次卡核销）
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatTime } = require('../../../utils/format');
const QR = require('../../../utils/qrcode');

const CODE_REFRESH_SECONDS = 60; // 与后端 token 窗口一致（服务端容忍上一窗口，60s 必刷新）
const WAIT_POLL_SECONDS = 15;    // 待核验列表轮询间隔

const PAY_TYPE_LABELS = {
  wxpay: '微信支付', times_card: '次卡', period_card: '期限卡', free: '免费',
};

Page({
  data: {
    activityId: '',
    noPermission: false,
    // 签到二维码
    qrReady: false,
    qrError: '',
    countdown: 0,
    // 待核验 + 到场汇总
    waiting: [],
    checkinCount: 0,
    totalEnrolled: 0,
    confirmBusy: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({ activityId: options.id || '' });
    requirePermission('checkin_activity').then((pass) => {
      this.setData({ noPermission: !pass });
      if (!pass) return;
      this.startTimers();
    });
  },

  onShow() {
    if (this._started) this.startTimers(); // 从后台切回立即续跑
  },
  onHide() { this.stopTimers(); },
  onUnload() { this.stopTimers(); },

  startTimers() {
    if (!this.data.activityId || this.data.noPermission) return;
    this._started = true;
    if (!this._codeTimer) {
      this.refreshCode();
      this._codeTimer = setInterval(() => {
        const left = this.data.countdown - 1;
        if (left <= 0) this.refreshCode(); // 归零自动轮换；报错时置 10s 重试
        else this.setData({ countdown: left });
      }, 1000);
    }
    if (!this._waitTimer) {
      this.refreshWaiting();
      this._waitTimer = setInterval(() => this.refreshWaiting(), WAIT_POLL_SECONDS * 1000);
    }
  },

  stopTimers() {
    if (this._codeTimer) { clearInterval(this._codeTimer); this._codeTimer = null; }
    if (this._waitTimer) { clearInterval(this._waitTimer); this._waitTimer = null; }
  },

  // ---------- 签到二维码 ----------
  refreshCode() {
    if (this._codeFetching) return Promise.resolve();
    this._codeFetching = true;
    return callCloud('activity', 'getCheckinCode', { activity_id: this.data.activityId })
      .then((res) => {
        const d = res.data || {};
        this.setData({ qrError: '', countdown: d.expire_in || CODE_REFRESH_SECONDS });
        return this.drawQrcode(d.qrcode_payload).then(() => this.setData({ qrReady: true }));
      })
      .catch((err) => {
        // 活动未到签到时段等场景：不中断轮询，10s 后自动重试
        this.setData({
          qrReady: false,
          countdown: 10,
          qrError: (err && err.msg) || '暂不能生成签到码，将自动重试',
        });
      })
      .then(() => { this._codeFetching = false; });
  },

  onRefreshTap() {
    this.refreshCode();
  },

  // canvas 2d 初始化（首查可能早于首次渲染，带重试）
  initCanvas() {
    if (this._canvasPromise) return this._canvasPromise;
    this._canvasPromise = new Promise((resolve, reject) => {
      const attempt = (left) => {
        wx.createSelectorQuery().in(this)
          .select('#qr-canvas')
          .fields({ node: true, size: true })
          .exec((res) => {
            const r = res && res[0];
            if (r && r.node) {
              this._canvas = r.node;
              this._canvasSize = r.width || 270;
              resolve();
            } else if (left > 0) {
              setTimeout(() => attempt(left - 1), 100);
            } else {
              this._canvasPromise = null;
              reject(new Error('画布初始化失败'));
            }
          });
      };
      attempt(10);
    });
    return this._canvasPromise;
  },

  drawQrcode(payload) {
    const qr = QR.create(payload);
    this._qr = qr;
    return this.initCanvas().then(() => this.renderQr());
  },

  renderQr() {
    const canvas = this._canvas;
    const qr = this._qr;
    const cssSize = this._canvasSize;
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const dpr = win.pixelRatio || 2;
    canvas.width = Math.floor(cssSize * dpr);
    canvas.height = Math.floor(cssSize * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    // 白底 + 2 模块静区
    const quiet = 2;
    const cell = cssSize / (qr.size + quiet * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cssSize, cssSize);
    ctx.fillStyle = '#1F2A38';
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
  },

  // ---------- 待核验（checkinWaiting 轮询；失败静默，下轮自动恢复） ----------
  refreshWaiting() {
    if (this._waitFetching) return Promise.resolve();
    this._waitFetching = true;
    return callCloud('activity', 'checkinWaiting', { activity_id: this.data.activityId })
      .then((res) => {
        const d = res.data || {};
        const waiting = (d.waiting || []).map((it) => ({
          id: it._id,
          nickname: it.nickname || '未设置昵称',
          avatar: it.avatar || '',
          payTypeLabel: PAY_TYPE_LABELS[it.pay_type] || it.pay_type || '-',
          requestedText: it.requested_at ? formatTime(it.requested_at) + ' 申请核验' : '',
        }));
        this.setData({
          waiting,
          checkinCount: (d.summary && d.summary.checkin_count) || 0,
          totalEnrolled: (d.summary && d.summary.total_enrolled) || 0,
        });
      })
      .catch(() => { /* 轮询静默容错 */ })
      .then(() => { this._waitFetching = false; });
  },

  // ---------- 现场核验（confirmCheckin；幂等） ----------
  onConfirmTap(e) {
    if (this.data.confirmBusy) return;
    const id = e.currentTarget.dataset.id;
    const nickname = e.currentTarget.dataset.nickname || '该会员';
    wx.showModal({
      title: '确认签到',
      content: `为「${nickname}」核验到场签到？`,
      confirmColor: '#C8552F',
      success: (res) => {
        if (!res.confirm) return;
        this.doConfirm(id);
      },
    });
  },

  doConfirm(enrollmentId) {
    this.setData({ confirmBusy: true });
    callCloud('activity', 'confirmCheckin', { enrollment_id: enrollmentId })
      .then((res) => {
        const d = res.data || {};
        let extra = '';
        if (d.card_write_off === 'success') extra = '，次卡已核销 1 次';
        else if (d.card_write_off === 'failed') extra = '，次卡核销失败请人工处理';
        wx.showToast({ title: '签到成功' + extra, icon: 'none', duration: 2500 });
        this.refreshWaiting();
      })
      .catch((err) => showError(err, '核验失败，请重试'))
      .then(() => this.setData({ confirmBusy: false }));
  },
});
