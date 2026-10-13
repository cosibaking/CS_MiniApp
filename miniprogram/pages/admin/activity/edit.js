// pages/admin/activity/edit.js — 活动创建/编辑（publish_activity，activity-module §2.1-9 / §3.1 / §5.2）
// 接口：activity/detail（加载，返回全量文档）、activity/create、activity/update、activity/publish
// 双模式：无 id = 新建（create）；有 id = 编辑（update 差量 patch，避免已发布时间字段锁定误报）
// 发布受限编辑（§3.1 边界2，服务端强制）：价格锁定 / 人数只能调大 / 时间字段锁定 / 截止只能延长
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatMoney } = require('../../../utils/format');

const TYPE_OPTIONS = [
  { value: 'novice', label: '新手体验课' },
  { value: 'regular', label: '常规对抗赛' },
  { value: 'theme', label: '主题赛事' },
  { value: 'league', label: '俱乐部联赛' },
  { value: 'custom', label: '团建定制' },
];
const TYPE_VALUES = TYPE_OPTIONS.map((o) => o.value);
const TYPE_LABELS = TYPE_OPTIONS.map((o) => o.label);

const PAY_TYPE_OPTIONS = [
  { value: 'wxpay', label: '微信支付' },
  { value: 'times_card', label: '次卡' },
  { value: 'period_card', label: '期限卡' },
];

const MAX_DURATION_MS = 12 * 3600 * 1000; // §3.1：活动时长上限
const PUBLISH_LEAD_MS = 30 * 60 * 1000;   // §3.1：发布需晚于当前至少 30 分钟

const pad = (n) => (n < 10 ? '0' + n : '' + n);

// 时间戳 → { date: 'YYYY-MM-DD', time: 'HH:mm' }
function fromTs(ts) {
  if (!ts) return { date: '', time: '' };
  const d = new Date(ts);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// 'YYYY-MM-DD' + 'HH:mm' → 本地时间戳（手动解析，规避 iOS new Date(str) 兼容问题）
function toTs(dateStr, timeStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  const t = /^(\d{2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!m || !t) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]), Number(t[2])).getTime();
  return isFinite(ts) ? ts : null;
}

// 元（字符串输入）→ 分（整数）；空串视为 0（免费）；非法返回 NaN
function parsePrice(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return 0;
  const v = Number(s);
  if (!isFinite(v) || v < 0) return NaN;
  return Math.round(v * 100);
}

// 数字输入 → 整数；空返回 null
function parseNum(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return null;
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
}

// 差量 patch：只提交变化字段（update 对 patch[k]!==undefined 即校验，避免时间锁定误报）
function diffPatch(next, orig) {
  const patch = {};
  Object.keys(next).forEach((k) => {
    const a = next[k];
    const b = orig ? orig[k] : undefined;
    if (k === 'pay_types') {
      const ja = JSON.stringify((a || []).slice().sort());
      const jb = JSON.stringify((b || []).slice().sort());
      if (ja !== jb) patch[k] = a;
    } else if (a !== b) {
      patch[k] = a;
    }
  });
  return patch;
}

// create 草稿宽松口径：剔除空值（空串/空数组/null），title 必填由校验保证
function stripForCreate(p) {
  const out = {};
  Object.keys(p).forEach((k) => {
    const v = p[k];
    if (v == null) return;
    if (typeof v === 'string' && !v.trim() && k !== 'intro') return;
    if (Array.isArray(v) && !v.length) return;
    out[k] = v;
  });
  return out;
}

Page({
  data: {
    id: '',           // 空 = 新建
    mode: 'create',
    loading: false,
    noPermission: false,
    submitting: false,
    uploading: false,
    editable: true,   // 仅 draft/published 可编辑
    isPublished: false,
    priceLocked: false, // 已发布 + 存在有效报名
    timeLocked: false,  // 已发布 + 报名截止或已开始
    typeOptions: TYPE_LABELS,
    typeIndex: -1,
    payTypeOptions: PAY_TYPE_OPTIONS,
    // 表单
    title: '',
    cover: '',
    venue: '',
    address: '',
    startDate: '', startTime: '',
    endDate: '', endTime: '',
    deadlineDate: '', deadlineTime: '',
    priceYuan: '0',
    maxNum: '',
    minNum: '',
    intro: '',
    payTypes: { wxpay: true, times_card: true, period_card: true },
  },

  onLoad(options) {
    const id = options.id || '';
    requirePermission('publish_activity').then((pass) => {
      this.setData({ noPermission: !pass });
      if (!pass) return;
      if (id) {
        this.setData({ id, mode: 'edit', loading: true });
        this.loadActivity(id);
      } else {
        this.setData({ mode: 'create' });
      }
    });
  },

  loadActivity(id) {
    callCloud('activity', 'detail', { activity_id: id }).then((res) => {
      const a = (res.data && res.data.activity) || {};
      const s = fromTs(a.start_time);
      const e = fromTs(a.end_time);
      const d = fromTs(a.signup_deadline);
      const now = Date.now();
      const isPublished = a.status === 'published';
      const payTypes = {};
      PAY_TYPE_OPTIONS.forEach((o) => {
        payTypes[o.value] = !Array.isArray(a.pay_types) || a.pay_types.indexOf(o.value) >= 0;
      });
      this.setData({
        loading: false,
        editable: a.status === 'draft' || isPublished,
        isPublished,
        priceLocked: isPublished && ((a.signup_count || 0) + (a.waitlist_count || 0)) > 0,
        timeLocked: isPublished && (!!a.signup_deadline && now >= a.signup_deadline
          || !!a.start_time && now >= a.start_time),
        title: a.title || '',
        cover: a.cover || '',
        venue: a.venue || '',
        address: a.address || '',
        startDate: s.date, startTime: s.time,
        endDate: e.date, endTime: e.time,
        deadlineDate: d.date, deadlineTime: d.time,
        priceYuan: a.price > 0 ? String(formatMoney(a.price)) : '0',
        maxNum: a.max_num != null ? String(a.max_num) : '',
        minNum: a.min_num != null ? String(a.min_num) : '',
        intro: a.intro || '',
        typeIndex: TYPE_VALUES.indexOf(a.type),
        payTypes,
      });
      // 基线（差量 patch 比对用）
      this.original = {
        title: a.title || '',
        type: a.type || null,
        cover: a.cover || '',
        venue: a.venue || '',
        address: a.address || '',
        start_time: a.start_time || null,
        end_time: a.end_time || null,
        signup_deadline: a.signup_deadline || null,
        price: Number.isInteger(a.price) ? a.price : 0,
        max_num: a.max_num != null ? a.max_num : null,
        min_num: a.min_num != null ? a.min_num : null,
        intro: a.intro || '',
        pay_types: Array.isArray(a.pay_types) && a.pay_types.length ? a.pay_types.slice() : null,
      };
    }).catch((err) => {
      this.setData({ loading: false, editable: false });
      showError(err, '加载失败');
    });
  },

  // ---------- 表单交互 ----------
  onField(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onTypePick(e) {
    this.setData({ typeIndex: Number(e.detail.value) });
  },

  onDatePick(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onTimePick(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  onPayToggle(e) {
    const k = e.currentTarget.dataset.value;
    this.setData({ [`payTypes.${k}`]: !this.data.payTypes[k] });
  },

  // ---------- 封面上传（≤2MB，cloud:// fileID）----------
  onChooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
          wx.showToast({ title: '封面图不能超过 2MB', icon: 'none' });
          return;
        }
        this.uploadCover(f.tempFilePath);
      },
    });
  },

  uploadCover(filePath) {
    if (this.data.uploading) return;
    const ext = (/\.(\w+)$/.exec(filePath) || [])[1] || 'jpg';
    const cloudPath = `activity/covers/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    this.setData({ uploading: true });
    wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => {
      this.setData({ cover: res.fileID, uploading: false });
    }).catch(() => {
      this.setData({ uploading: false });
      wx.showToast({ title: '封面上传失败', icon: 'none' });
    });
  },

  onPreviewCover() {
    if (this.data.cover) wx.previewImage({ urls: [this.data.cover] });
  },

  // ---------- 提交 ----------
  // 表单 → 服务端 payload（全量形状；空为 null/0）
  buildPayload() {
    const d = this.data;
    const payTypes = PAY_TYPE_OPTIONS.filter((o) => d.payTypes[o.value]).map((o) => o.value);
    return {
      title: (d.title || '').trim(),
      type: d.typeIndex >= 0 ? TYPE_VALUES[d.typeIndex] : null,
      cover: d.cover || '',
      venue: (d.venue || '').trim(),
      address: (d.address || '').trim(),
      start_time: toTs(d.startDate, d.startTime),
      end_time: toTs(d.endDate, d.endTime),
      signup_deadline: toTs(d.deadlineDate, d.deadlineTime),
      price: parsePrice(d.priceYuan),
      max_num: parseNum(d.maxNum),
      min_num: parseNum(d.minNum),
      intro: d.intro || '',
      pay_types: payTypes,
    };
  },

  // 日期与时间需成对设置
  timesComplete() {
    const d = this.data;
    return [!!d.startDate, !!d.startTime, !!d.endDate, !!d.endTime, !!d.deadlineDate, !!d.deadlineTime]
      .every((v, i, arr) => (i % 2 === 0 ? v === arr[i + 1] : true));
  },

  // 草稿宽松校验（present 才校验，§3.1）
  validateDraft(p) {
    if (!p.title) return '请填写活动标题';
    if (p.title.length > 30) return '标题不超过 30 字';
    if (!this.timesComplete()) return '请补全时间（日期与时间需成对设置）';
    if (p.start_time != null && p.end_time != null) {
      if (p.end_time <= p.start_time) return '结束时间需晚于开始时间';
      if (p.end_time - p.start_time > MAX_DURATION_MS) return '活动时长不能超过 12 小时';
    }
    if (p.signup_deadline != null && p.start_time != null && p.signup_deadline > p.start_time) {
      return '报名截止不能晚于开始时间';
    }
    if (isNaN(p.price)) return '价格格式不正确';
    if (p.max_num != null && (isNaN(p.max_num) || p.max_num < 1 || p.max_num > 500)) {
      return '人数上限需为 1~500 的整数';
    }
    if (p.min_num != null && (isNaN(p.min_num) || p.min_num < 1)) return '成团人数需 ≥1';
    if (p.min_num != null && p.max_num != null && p.min_num > p.max_num) {
      return '成团人数不能大于人数上限';
    }
    if ((p.intro || '').length > 5000) return '简介不超过 5000 字';
    if (!p.pay_types.length) return '请至少保留一种支付方式';
    return null;
  },

  // 发布态全量校验（§3.1）
  validatePublish(p) {
    const now = Date.now();
    const err = this.validateDraft(p);
    if (err) return err;
    if (!p.type) return '请选择活动类型';
    if (!p.cover || p.cover.indexOf('cloud://') !== 0) return '请上传封面图';
    if (!p.venue) return '请填写场馆名称';
    if (!p.address) return '请填写详细地址';
    if (p.start_time == null || p.end_time == null || p.signup_deadline == null) {
      return '请完整设置开始/结束时间与报名截止时间';
    }
    if (p.max_num == null) return '请填写人数上限';
    if (p.min_num == null) return '请填写成团人数';
    if (p.signup_deadline <= now) return '报名截止需晚于当前时间';
    if (p.start_time <= now + PUBLISH_LEAD_MS) return '开始时间需晚于当前至少 30 分钟';
    return null;
  },

  // 保存草稿（create / update 差量）
  onSaveDraft() {
    if (this.data.submitting || !this.data.editable) return;
    const p = this.buildPayload();
    const err = this.validateDraft(p);
    if (err) return wx.showToast({ title: err, icon: 'none' });

    if (this.data.mode === 'create') {
      this.setData({ submitting: true });
      callCloud('activity', 'create', stripForCreate(p)).then(() => {
        wx.showToast({ title: '已保存草稿', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      }).catch((e) => {
        this.setData({ submitting: false });
        showError(e, '保存失败');
      });
      return;
    }

    const patch = diffPatch(p, this.original);
    if (!Object.keys(patch).length) {
      return wx.showToast({ title: '没有修改', icon: 'none' });
    }
    // 已发布受限编辑前置提示（服务端为最终裁决）
    if (this.data.isPublished) {
      if (this.data.priceLocked && patch.price != null) {
        return wx.showToast({ title: '已有有效报名，价格不可修改', icon: 'none' });
      }
      if (patch.max_num != null && this.original.max_num != null && patch.max_num < this.original.max_num) {
        return wx.showToast({ title: '人数上限只能调大', icon: 'none' });
      }
      if (patch.signup_deadline != null && this.original.signup_deadline
        && patch.signup_deadline < this.original.signup_deadline) {
        return wx.showToast({ title: '报名截止只能延长', icon: 'none' });
      }
    }
    this.setData({ submitting: true });
    callCloud('activity', 'update', Object.assign({ activity_id: this.data.id }, patch)).then(() => {
      this.original = p;
      this.setData({ submitting: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    }).catch((e) => {
      this.setData({ submitting: false });
      showError(e, '保存失败');
    });
  },

  // 发布（create：先建草稿再发布；edit：先应用差量再发布，仅草稿可发布）
  onPublish() {
    if (this.data.submitting || !this.data.editable) return;
    if (this.data.mode === 'edit' && this.data.isPublished) return; // 已发布不可再发布

    const p = this.buildPayload();
    const err = this.validatePublish(p);
    if (err) return wx.showToast({ title: err, icon: 'none' });

    wx.showModal({
      title: '发布活动',
      content: '发布后会员即可在活动列表看到该活动并报名，确认发布？',
      confirmText: '发布',
      confirmColor: '#C8552F',
      success: (r) => {
        if (!r.confirm) return;
        this.doPublish(p);
      },
    });
  },

  doPublish(p) {
    this.setData({ submitting: true });
    const fail = (e) => {
      this.setData({ submitting: false });
      showError(e, '发布失败');
    };
    if (this.data.mode === 'create') {
      callCloud('activity', 'create', stripForCreate(p)).then((res) => {
        const id = res.data && res.data.activity_id;
        return callCloud('activity', 'publish', { activity_id: id });
      }).then(() => {
        wx.showToast({ title: '已发布', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      }).catch(fail);
      return;
    }
    // 编辑（草稿）：先应用差量（若有）再发布
    const patch = diffPatch(p, this.original);
    const apply = Object.keys(patch).length
      ? callCloud('activity', 'update', Object.assign({ activity_id: this.data.id }, patch))
      : Promise.resolve();
    apply.then(() => callCloud('activity', 'publish', { activity_id: this.data.id }))
      .then(() => {
        wx.showToast({ title: '已发布', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      }).catch(fail);
  },
});
