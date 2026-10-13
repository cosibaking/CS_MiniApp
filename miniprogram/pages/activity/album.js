// pages/activity/album.js — 活动相册（会员，activity-module §2.1 页面7 / §3.12 / §5.1.9）
// 接口：activity/albumList（status=normal，archived 已隐藏；登录可见——相册涉及会员肖像）
// 俱乐部统一上传，本页无任何上传入口；图片走云存储 CDN（getTempFileURL 换临时链接）
// 本地缓存第一页（架构 §11.4 降低调用量，stale-while-revalidate）
const { callCloud } = require('../../utils/cloud');
const { requireLogin, showError } = require('../../utils/auth');

const PAGE_SIZE = 18;
const CACHE_PREFIX = 'album_cache_'; // 本地缓存 key：activity_id

Page({
  data: {
    loading: true,
    loadingMore: false,
    loadError: false,
    id: '',
    title: '',
    imageTotal: 0,
    videoTotal: 0,
    items: [],
    page: 1,
    finished: false, // 分页到底
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    // 本地缓存第一页先行渲染（降低云函数调用量，§3.12-6 / 架构 §11.4）
    const cache = wx.getStorageSync(CACHE_PREFIX + this.data.id);
    if (cache && cache.items && cache.items.length && Date.now() - cache.time < 10 * 60 * 1000) {
      this.setData({
        loading: false,
        title: cache.title || '',
        items: cache.items,
        imageTotal: cache.imageTotal || 0,
        videoTotal: cache.videoTotal || 0,
      });
    }
    requireLogin().then((user) => {
      if (!user) {
        wx.showToast({ title: '请先登录', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.fetch(true);
    });
  },

  // fresh=true 首屏/下拉刷新（重置分页），否则为加载下一页
  fetch(fresh) {
    const page = fresh ? 1 : this.data.page + 1;
    if (!fresh && (this.data.finished || this.data.loadingMore)) return;
    this.setData(fresh ? { loading: !this.data.items.length, loadError: false } : { loadingMore: true });

    callCloud('activity', 'albumList', { activity_id: this.data.id, page, page_size: PAGE_SIZE })
      .then(async (res) => {
        const d = res.data || {};
        const raw = d.list || [];
        // fileID → 临时链接（CDN；getTempFileURL 单次 ≤50，PAGE_SIZE=18 安全）
        const urlMap = await this.getTempUrls(raw.map((i) => i.file_id));
        const items = raw.map((it) => ({
          id: it._id,
          fileId: it.file_id,
          mediaType: it.media_type || 'image',
          url: urlMap[it.file_id] || it.file_id,
        }));
        const merged = fresh ? items : this.data.items.concat(items);
        const patch = {
          loading: false,
          loadingMore: false,
          loadError: false,
          title: d.activity_title || this.data.title,
          imageTotal: d.image_total || 0,
          videoTotal: d.video_total || 0,
          items: merged,
          page,
          finished: merged.length >= (d.total || 0) || items.length < PAGE_SIZE,
        };
        this.setData(patch);
        // 第一页成功后更新本地缓存
        if (fresh && items.length) {
          wx.setStorageSync(CACHE_PREFIX + this.data.id, {
            time: Date.now(),
            title: patch.title,
            imageTotal: patch.imageTotal,
            videoTotal: patch.videoTotal,
            items,
          });
        }
      })
      .catch((e) => {
        this.setData({ loading: false, loadingMore: false, loadError: fresh });
        showError(e, '相册加载失败');
      });
  },

  // 批量换临时链接（失败降级：直接用 fileID，组件支持 cloud:// 渲染）
  getTempUrls(fileIds) {
    return new Promise((resolve) => {
      if (!fileIds.length) return resolve({});
      wx.cloud.getTempFileURL({
        fileList: fileIds,
        success: (r) => {
          const map = {};
          (r.fileList || []).forEach((f) => {
            if (f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
          });
          resolve(map);
        },
        fail: () => resolve({}),
      });
    });
  },

  onReachBottom() {
    this.fetch(false);
  },

  onPullDownRefresh() {
    this.fetch(true);
    wx.stopPullDownRefresh();
  },

  onRetry() {
    this.fetch(true);
  },

  // 点击大图浏览：图片 previewImage；视频 previewMedia 播放
  onItemTap(e) {
    const idx = e.currentTarget.dataset.index;
    const items = this.data.items;
    if (!items[idx]) return;
    if (items[idx].mediaType === 'video') {
      const videoSources = items
        .filter((i) => i.mediaType === 'video')
        .map((i) => ({ url: i.url }));
      const vIdx = items.slice(0, idx + 1).filter((i) => i.mediaType === 'video').length - 1;
      wx.previewMedia({
        sources: videoSources,
        current: Math.max(0, vIdx),
        fail: () => wx.showToast({ title: '视频加载失败', icon: 'none' }),
      });
      return;
    }
    const imageUrls = items.filter((i) => i.mediaType === 'image').map((i) => i.url);
    const iIdx = items.slice(0, idx + 1).filter((i) => i.mediaType === 'image').length - 1;
    wx.previewImage({
      urls: imageUrls,
      current: imageUrls[Math.max(0, iIdx)],
    });
  },
});
