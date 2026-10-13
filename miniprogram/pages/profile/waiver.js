// pages/profile/waiver.js — 免责协议签署页（user-module §2.2、§5.6/§5.7）
// 流程：阅读门控（滚动到底或内容不足一屏自动判读）→ 勾选 → 填写监护人信息（监护人版）→ 签署
// 错误分流：2002 版本失效自动刷新；2004 身份冲突引导切换版本类型
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');
const { formatTime } = require('../../utils/format');

const BIZ = {
  NO_ACTIVE: 1005, // 无生效协议版本
  VERSION_INVALID: 2002, // 签署版本已更新
  GUARDIAN_INVALID: 2003, // 监护人信息缺失/不合法
  IDENTITY_CONFLICT: 2004, // 身份与版本类型不符
};

// 协议正文占位文本（agreement.content_file_id 为空时兜底；上线前在云存储上传正式文本并回填 fileID）
const FALLBACK_TEXT = [
  '一、活动性质与风险告知',
  '真人CS是一项具有一定对抗强度的户外体育运动，活动中可能存在跌倒、碰撞、扭伤、擦伤等运动损伤风险。本俱乐部所有器材均经过安全检查，场地设有安全区域，并配备现场裁判与工作人员，但上述措施无法完全排除意外发生的可能。',
  '二、健康状况承诺',
  '签署人承诺本人（或被监护人）身体健康，无心脏病、高血压、哮喘、癫痫等不适宜参加剧烈运动的疾病，无隐瞒重大病史情形。活动中如出现身体不适，将立即停止参与并告知现场工作人员。',
  '三、防护装备与安全规则',
  '签署人承诺遵守活动规则，正确穿戴俱乐部提供的护目镜等防护装备，听从裁判与工作人员指挥，不越界、不擅自摘除护具、不蓄意攻击要害部位。',
  '四、未成年人特别条款',
  '未成年参与人须由其监护人代为签署本声明。监护人确认已如实告知活动风险，并同意被监护人参加活动；活动期间监护人应保持通讯畅通，配合俱乐部的安全管理要求。',
  '五、责任限制',
  '在法律允许的范围内，因签署人故意违反安全规则或未如实告知健康状况导致的损害，由签署人自行承担相应责任。俱乐部已尽合理的安全保障义务。',
  '六、肖像与影像使用',
  '活动过程中俱乐部可能拍摄照片与视频用于活动记录及合法宣传。若签署人不同意使用其肖像，应在活动前向工作人员书面提出。',
  '七、个人信息的收集与保护',
  '俱乐部依照法律法规收集、使用签署人提供的必要信息（姓名、联系方式、健康状况声明等），仅用于活动组织、安全保障与身份核验，并对手机号等敏感信息采取加密存储等保护措施。',
  '八、协议的生效与变更',
  '本声明自签署人在线确认时生效。俱乐部可能依法更新协议版本，更新后需重新签署方可继续参与活动。',
].join('\n');

Page({
  data: {
    loading: true,
    noActive: false, // 1005：无生效协议版本
    latest: null, // { agreement_version, agreement_type, title, content_file_id, published_at }
    signed: null, // { agreement_version, agreement_type, signed_at }
    signedText: '',
    publishedText: '',
    needResign: true,
    suggestType: 'adult', // 当前展示/签署的版本类型（adult/minor）
    isMinor: false,
    contentLines: [],
    contentLoading: true,
    readDone: false, // 阅读门控：已读至底部
    agreeChecked: false,
    guardianName: '',
    guardianPhone: '',
    birthdayStr: '', // picker 展示值 YYYY-MM-DD
    birthdayTs: null, // 提交用时间戳（本地零点）
    todayStr: '',
    submitting: false,
  },

  onLoad() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    this.setData({
      todayStr: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    });
    requireLogin().then((user) => {
      if (!user) {
        this.setData({ loading: false });
        wx.showToast({ title: '请先登录', icon: 'none' });
        return;
      }
      this.loadData();
    });
  },

  // type 可选：切换查看/签署的版本类型（adult ↔ minor；后端按 R4 校验身份口径）
  async loadData(type) {
    this.setData({ loading: true, noActive: false });
    const payload = {};
    if (type) payload.type = type;
    try {
      const res = await callCloud('user', 'getWaiver', payload);
      const d = res.data || {};
      this.setData({
        loading: false,
        latest: d.latest,
        signed: d.signed,
        signedText: d.signed && d.signed.signed_at ? formatTime(d.signed.signed_at) : '',
        publishedText: d.latest && d.latest.published_at ? formatTime(d.latest.published_at, false) : '',
        needResign: !!d.need_resign,
        isMinor: !!d.is_minor,
        suggestType: d.suggest_type || 'adult',
        contentLoading: true,
        readDone: false, // 换版本后重新计读
        agreeChecked: false,
      });
      await this.loadContent(d.latest);
    } catch (e) {
      this.setData({ loading: false });
      if (e && e.code === BIZ.NO_ACTIVE) {
        this.setData({ noActive: true });
      } else {
        showError(e, '加载失败，请稍后重试');
      }
    }
  },

  // 正文加载：content_file_id 为空用内置占位文本；非空从云存储下载 utf-8 文本
  async loadContent(latest) {
    let text = FALLBACK_TEXT;
    const fileId = latest && latest.content_file_id;
    if (fileId) {
      try {
        text = await this.downloadContent(fileId);
      } catch (e) {
        console.warn('[waiver] 协议正文下载失败，使用占位文本', e);
        wx.showToast({ title: '协议正文加载失败，暂展示内置文本', icon: 'none' });
        text = FALLBACK_TEXT;
      }
    }
    this.setData({ contentLines: this.buildLines(text), contentLoading: false });
    this.checkScrollable();
  },

  // 云存储下载协议正文（utf-8 文本）
  downloadContent(fileId) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID: fileId,
        success: (res) => {
          wx.getFileSystemManager().readFile({
            filePath: res.tempFilePath,
            encoding: 'utf-8',
            success: (r) => resolve(String(r.data || '')),
            fail: reject,
          });
        },
        fail: reject,
      });
    });
  },

  // 正文按行拆分（空行跳过；「一、」「第X条」「【」开头识别为条款标题）
  buildLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    lines.forEach((line) => {
      const t = line.trim();
      if (!t) return;
      out.push({
        heading: /^[一二三四五六七八九十]+、|^第[一二三四五六七八九十百]+条|^【/.test(t),
        text: t,
      });
    });
    return out.length ? out : [{ heading: true, text: '（暂无协议正文）' }];
  },

  // 内容不足一屏时自动视为已读完（scroll-view 不会触发 scrolltolower）
  checkScrollable() {
    wx.nextTick(() => {
      const q = this.createSelectorQuery();
      q.select('#waiver-content').boundingClientRect();
      q.select('#waiver-scroll').boundingClientRect();
      q.exec((rects) => {
        if (rects && rects[0] && rects[1] && rects[0].height <= rects[1].height) {
          this.setData({ readDone: true });
        }
      });
    });
  },

  onScrollToLower() {
    if (!this.data.readDone) this.setData({ readDone: true });
  },

  toggleAgree() {
    if (!this.data.readDone) {
      wx.showToast({ title: '请先阅读协议全文到底部', icon: 'none' });
      return;
    }
    this.setData({ agreeChecked: !this.data.agreeChecked });
  },

  onGuardianName(e) {
    this.setData({ guardianName: e.detail.value });
  },

  onGuardianPhone(e) {
    this.setData({ guardianPhone: e.detail.value });
  },

  // 生日（选填）：手动解析 YYYY-MM-DD，规避 iOS new Date(str) 兼容问题
  onBirthdayChange(e) {
    const str = e.detail.value || '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    const ts = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
    this.setData({ birthdayStr: str, birthdayTs: ts });
  },

  // 手动切换版本类型（后端 2004 身份硬校验兜底）
  switchType() {
    const next = this.data.suggestType === 'adult' ? 'minor' : 'adult';
    this.loadData(next);
  },

  async onSign() {
    const d = this.data;
    if (d.submitting) return;
    if (!d.readDone) {
      wx.showToast({ title: '请先阅读协议全文到底部', icon: 'none' });
      return;
    }
    if (!d.agreeChecked) {
      wx.showToast({ title: '请先勾选同意声明', icon: 'none' });
      return;
    }
    if (d.isMinor) {
      const name = (d.guardianName || '').trim();
      const phone = (d.guardianPhone || '').trim();
      if (!name.length || name.length > 20) {
        wx.showToast({ title: '请填写监护人姓名（1-20 字）', icon: 'none' });
        return;
      }
      if (!/^1\d{10}$/.test(phone)) {
        wx.showToast({ title: '请填写正确的监护人手机号', icon: 'none' });
        return;
      }
    }

    const payload = {
      agreement_type: d.suggestType,
      agreement_version: d.latest.agreement_version,
    };
    if (d.isMinor) {
      payload.guardian_name = (d.guardianName || '').trim();
      payload.guardian_phone = (d.guardianPhone || '').trim();
    }
    if (d.birthdayTs) payload.birthday = d.birthdayTs;

    this.setData({ submitting: true });
    try {
      const res = await callCloud('user', 'signWaiver', payload);
      const r = res.data || {};
      this.setData({
        submitting: false,
        needResign: false,
        signed: {
          agreement_version: r.agreement_version,
          agreement_type: r.agreement_type,
          signed_at: r.signed_at,
        },
        signedText: r.signed_at ? formatTime(r.signed_at) : '',
        agreeChecked: false,
      });
      const content = r.warning
        ? '协议签署成功。\n提示：监护人手机号与账号绑定手机号不一致，请确认信息无误。'
        : '协议签署成功！';
      wx.showModal({
        title: '签署成功',
        content,
        showCancel: false,
        success: () => this.goBack(),
      });
    } catch (e) {
      this.setData({ submitting: false });
      if (e && e.code === BIZ.VERSION_INVALID) {
        // 2002：版本已更新 → 自动刷新最新版本
        wx.showToast({ title: '协议版本已更新，正在刷新', icon: 'none' });
        this.loadData();
      } else if (e && e.code === BIZ.IDENTITY_CONFLICT) {
        // 2004：身份与版本不符 → 引导切换至对应版本
        const next = this.data.suggestType === 'adult' ? 'minor' : 'adult';
        wx.showModal({
          title: '身份与版本不符',
          content: (e.msg || '按出生日期判定的身份与所选协议版本不符') + '\n是否切换至对应版本重新签署？',
          confirmText: '切换版本',
          cancelText: '暂不',
          success: (r) => {
            if (r.confirm) this.loadData(next);
          },
        });
      } else {
        showError(e, '签署失败，请稍后重试');
      }
    }
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/profile/profile' });
  },
});
