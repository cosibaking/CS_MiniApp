// pages/admin/activity/album-manage.js — 相册管理（upload_album，activity-module §5.26/§5.27、§3.12）
// 接口：activity/albumList（分页 + image_total/video_total）、activity/uploadAlbum、activity/deleteAlbum
// 上传：chooseMedia → 大小/容量预检 → wx.cloud.uploadFile（album/{activity_id}/）→ uploadAlbum 批量入库
// 预览：image 组件直接渲染 cloud:// fileID；全屏预览需 getTempFileURL 换 https 地址
const { callCloud } = require('../../../utils/cloud');
const { requirePermission, showError } = require('../../../utils/auth');
const { formatTime } = require('../../../utils/format');

const PAGE_SIZE = 18;
const IMG_MAX = 1 * 1024 * 1024;     // 单图 ≤ 1MB（§3.12）
const VIDEO_MAX = 50 * 1024 * 1024;  // 单视频 ≤ 50MB
const IMG_LIMIT = 200;               // 相册容量：200 张图
const VIDEO_LIMIT = 10;              // 10 个视频

function formatSize(size) {
  const n = Number(size) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

Page({
  data: {
    activityId: '',
    noPermission: false,
    loading: false,
    finished: false,
    empty: false,
    list: [],
    total: 0,
    page: 1,
    imageTotal: 0,
    videoTotal: 0,
    imgLimit: IMG_LIMIT,
    videoLimit: VIDEO_LIMIT,
    // 多选删除
    pickMode: false,
    picked: {},
    pickedCount: 0,
    uploading: false,
    deleting: false,
  },

  onLoad(options) {
    const title = decodeURIComponent(options.title || '');
    if (title) wx.setNavigationBarTitle({ title: title.slice(0, 12) });
    this.setData({ activityId: options.id || '' });
    requirePermission('upload_album').then((pass) => {
      this.setData({ noPermission: !pass });
      if (pass) this.fetch(true);
    });
  },

  onPullDownRefresh() {
    this.fetch(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.finished || this.data.loading) return;
    this.fetch(false);
  },

  fetch(reset) {
    if (this.data.loading) return Promise.resolve();
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    return callCloud('activity', 'albumList', {
      activity_id: this.data.activityId,
      page,
      page_size: PAGE_SIZE,
    }).then((res) => {
      const d = res.data || {};
      const items = (d.list || []).map((it) => ({
        id: it._id,
        fileId: it.file_id,
        mediaType: it.media_type === 'video' ? 'video' : 'image',
        sizeText: formatSize(it.size),
        createdAtText: formatTime(it.created_at),
      }));
      this.setData({
        list: reset ? items : this.data.list.concat(items),
        total: d.total || 0,
        page,
        imageTotal: d.image_total || 0,
        videoTotal: d.video_total || 0,
        finished: (d.list || []).length < PAGE_SIZE,
        empty: reset && items.length === 0,
        loading: false,
        pickMode: false,
        picked: {},
        pickedCount: 0,
      });
    }).catch((err) => {
      this.setData({ loading: false, empty: this.data.list.length === 0 });
      showError(err, '加载失败，下拉重试');
    });
  },

  // ---------- 上传（§5.26） ----------
  onUploadTap() {
    if (this.data.uploading) return;
    const remain = (IMG_LIMIT - this.data.imageTotal) + (VIDEO_LIMIT - this.data.videoTotal);
    if (remain <= 0) {
      wx.showToast({ title: '相册容量已满，请先删除部分内容', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: Math.min(9, remain),
      mediaType: ['image', 'video'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
      success: (res) => this.uploadItems(res.tempFiles || []),
    });
  },

  uploadItems(files) {
    if (!files.length) return;
    let remainImg = IMG_LIMIT - this.data.imageTotal;
    let remainVid = VIDEO_LIMIT - this.data.videoTotal;
    const items = [];
    // 先整体预检（单文件大小 + 剩余容量），任一违规直接中止
    for (const f of files) {
      const isVideo = f.fileType === 'video'
        || /\.(mp4|mov|m4v|avi|3gp)$/i.test(f.tempFilePath || '');
      const size = f.size || 0;
      if (isVideo) {
        if (size > VIDEO_MAX) {
          wx.showToast({ title: '单个视频不能超过 50MB', icon: 'none' });
          return;
        }
        if (remainVid <= 0) {
          wx.showToast({ title: '视频数量已达上限（10 个）', icon: 'none' });
          return;
        }
        remainVid -= 1;
      } else {
        if (size > IMG_MAX) {
          wx.showToast({ title: '单张图片不能超过 1MB', icon: 'none' });
          return;
        }
        if (remainImg <= 0) {
          wx.showToast({ title: '图片数量已达上限（200 张）', icon: 'none' });
          return;
        }
        remainImg -= 1;
      }
      items.push({ path: f.tempFilePath, size, media_type: isVideo ? 'video' : 'image' });
    }

    this.setData({ uploading: true });
    wx.showLoading({ title: `上传中 0/${items.length}`, mask: true });
    const uploaded = [];
    const uploadOne = (i) => {
      if (i >= items.length) return Promise.resolve();
      const it = items[i];
      const ext = ((it.path.match(/\.(\w+)$/) || [])[1]
        || (it.media_type === 'video' ? 'mp4' : 'jpg')).toLowerCase();
      const cloudPath = `album/${this.data.activityId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      return wx.cloud.uploadFile({ cloudPath, filePath: it.path }).then((up) => {
        uploaded.push({ file_id: up.fileID, media_type: it.media_type, size: it.size });
        wx.showLoading({ title: `上传中 ${i + 1}/${items.length}`, mask: true });
        return uploadOne(i + 1);
      });
    };
    uploadOne(0)
      .then(() => callCloud('activity', 'uploadAlbum', {
        activity_id: this.data.activityId,
        items: uploaded,
      }))
      .then((res) => {
        wx.hideLoading();
        this.setData({ uploading: false });
        wx.showToast({ title: `已上传 ${(res.data || {}).created || uploaded.length} 项`, icon: 'success' });
        this.fetch(true);
      })
      .catch((err) => {
        wx.hideLoading();
        this.setData({ uploading: false });
        showError(err, '上传失败，请重试');
        if (uploaded.length) this.fetch(true); // 部分成功时刷新，避免与云端不一致
      });
  },

  // ---------- 点击：多选 / 预览 ----------
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.pickMode) {
      const picked = Object.assign({}, this.data.picked);
      if (picked[id]) delete picked[id]; else picked[id] = 1;
      this.setData({ picked, pickedCount: Object.keys(picked).length });
      return;
    }
    const it = this.data.list.find((x) => x.id === id);
    if (!it) return;
    wx.cloud.getTempFileURL({ fileList: [it.fileId] }).then((r) => {
      const f = (r.fileList || [])[0];
      const url = f && f.tempFileURL;
      if (!url) throw new Error('no url');
      if (it.mediaType === 'image') wx.previewImage({ urls: [url] });
      else wx.previewMedia({ sources: [{ url, type: 'video' }] });
    }).catch(() => wx.showToast({ title: '获取预览地址失败', icon: 'none' }));
  },

  // ---------- 批量删除（§5.27） ----------
  onManageTap() {
    this.setData({ pickMode: !this.data.pickMode, picked: {}, pickedCount: 0 });
  },

  onDeleteTap() {
    const ids = Object.keys(this.data.picked);
    if (!ids.length || this.data.deleting) return;
    wx.showModal({
      title: '删除确认',
      content: `将删除选中的 ${ids.length} 项，删除后不可恢复`,
      confirmColor: '#B03030',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ deleting: true });
        callCloud('activity', 'deleteAlbum', { ids })
          .then((res) => {
            wx.showToast({ title: `已删除 ${(res.data || {}).deleted || ids.length} 项`, icon: 'success' });
            this.setData({ deleting: false });
            this.fetch(true);
          })
          .catch((err) => {
            this.setData({ deleting: false });
            showError(err, '删除失败，请重试');
          });
      },
    });
  },
});
