// demo/runtime/wx.js — wx API 浏览器 shim（覆盖本项目实际使用的全部 wx.* 调用）
// 依赖：wxml.js（cloudUrl）、demo.css 中的浮层 DOM（index.html 提供）
// MP.router / MP.ui / MP.logCall / MP.createSelectorQuery 由 runtime.js 提供
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});
  const wx = (MP.wx = {});
  const $ = (s) => document.querySelector(s);

  // ============ 基础工具 ============
  function cbApi(opts, exec) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      exec(
        (res) => {
          if (opts.success) opts.success(res);
          if (opts.complete) opts.complete(res);
          resolve(res);
        },
        (err) => {
          if (opts.fail) opts.fail(err);
          if (opts.complete) opts.complete(err);
          reject(err);
        }
      );
    }).catch(() => {}); // 页面已用回调处理，吞掉未处理的 Promise 拒绝
  }

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-demo-openid': MP.getOpenid() },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());
  }

  MP.getOpenid = function () {
    return localStorage.getItem('mp_demo_openid') || 'demo-admin';
  };

  // ============ UI：浮层引用计数遮罩 ============
  let maskCount = 0;
  function showMask() {
    maskCount++;
    $('#mp-mask').style.display = 'block';
  }
  function hideMask() {
    maskCount = Math.max(0, maskCount - 1);
    if (!maskCount) $('#mp-mask').style.display = 'none';
  }

  // ============ toast / loading ============
  let toastTimer = 0;
  let loadingOn = false;
  function hideToastEl() {
    clearTimeout(toastTimer);
    $('#mp-toast').style.display = 'none';
    loadingOn = false;
  }
  wx.showToast = function (opts) {
    opts = opts || {};
    if (loadingOn) hideMask(); // loading 的遮罩随之关闭
    hideToastEl();
    const t = $('#mp-toast');
    const icon = opts.icon || 'success';
    const html =
      icon === 'none'
        ? ''
        : '<span class="mp-toast-icon">' + (icon === 'success' ? '✓' : '✕') + '</span>';
    t.innerHTML = html + escHtml(opts.title || '');
    t.style.display = 'block';
    toastTimer = setTimeout(() => {
      t.style.display = 'none';
    }, opts.duration || 1500);
  };
  wx.showLoading = function (opts) {
    opts = opts || {};
    hideToastEl();
    loadingOn = true;
    const t = $('#mp-toast');
    t.classList.add('mp-toast-loading');
    t.innerHTML =
      '<span class="mp-toast-icon">◌</span>' + escHtml(opts.title || '加载中');
    t.style.display = 'block';
    if (opts.mask !== false) showMask();
  };
  wx.hideLoading = function () {
    if (loadingOn) hideMask();
    hideToastEl();
    $('#mp-toast').classList.remove('mp-toast-loading');
  };

  // ============ modal ============
  let modalClose = null; // 关闭当前 modal（新 modal 打开时自动收掉旧的）
  wx.showModal = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok) => {
      if (modalClose) modalClose({ confirm: false, cancel: true, errMsg: 'showModal:ok' });
      const modal = $('#mp-modal');
      const title = modal.querySelector('.m-title');
      const content = modal.querySelector('.m-content');
      const btns = modal.querySelector('.m-btns');
      title.textContent = opts.title || '';
      title.style.display = opts.title ? '' : 'none';
      content.textContent = opts.content || '';
      content.style.display = opts.content ? '' : 'none';
      btns.innerHTML = '';
      const close = (res) => {
        modal.style.display = 'none';
        hideMask();
        if (modalClose === close) modalClose = null;
        ok(res);
      };
      modalClose = close;
      if (opts.showCancel !== false) {
        const c = document.createElement('button');
        c.textContent = opts.cancelText || '取消';
        c.onclick = () => close({ confirm: false, cancel: true, errMsg: 'showModal:ok' });
        btns.appendChild(c);
      }
      const m = document.createElement('button');
      m.textContent = opts.confirmText || '确定';
      m.style.color = opts.confirmColor || '#07c160';
      m.style.fontWeight = '600';
      m.onclick = () => close({ confirm: true, cancel: false, errMsg: 'showModal:ok' });
      btns.appendChild(m);
      showMask();
      modal.style.display = 'block';
    });
  };

  // ============ lightbox（previewImage / previewMedia） ============
  const lbState = { list: [], idx: 0 };
  function renderLightbox() {
    const box = $('#mp-lightbox');
    const item = lbState.list[lbState.idx] || {};
    const holder = box.querySelector('.lb-media');
    holder.innerHTML = '';
    if (item.type === 'video') {
      const v = document.createElement('video');
      v.src = item.url;
      v.controls = true;
      v.autoplay = true;
      holder.appendChild(v);
    } else {
      const im = document.createElement('img');
      im.src = item.url;
      holder.appendChild(im);
    }
    const nav = box.querySelector('.lb-nav');
    nav.style.display = lbState.list.length > 1 ? '' : 'none';
    nav.dataset.idx = lbState.idx;
  }
  wx.previewImage = function (opts) {
    opts = opts || {};
    const urls = (opts.urls || []).map((u) => MP.WXML.cloudUrl(u));
    const cur = MP.WXML.cloudUrl(opts.current || urls[0]);
    lbState.list = urls.map((u) => ({ url: u, type: 'image' }));
    lbState.idx = Math.max(0, urls.indexOf(cur));
    showMask();
    $('#mp-lightbox').style.display = 'flex';
    renderLightbox();
    return cbApi(opts, (ok) => ok({ errMsg: 'previewImage:ok' }));
  };
  wx.previewMedia = function (opts) {
    opts = opts || {};
    const sources = (opts.sources || []).map((s) => ({
      url: MP.WXML.cloudUrl(s.url),
      type: s.type || 'image',
    }));
    lbState.list = sources;
    lbState.idx = opts.current || 0;
    showMask();
    $('#mp-lightbox').style.display = 'flex';
    renderLightbox();
    return cbApi(opts, (ok) => ok({ errMsg: 'previewMedia:ok' }));
  };
  function initLightbox() {
    const box = $('#mp-lightbox');
    const media = document.createElement('div');
    media.className = 'lb-media';
    media.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;';
    const close = document.createElement('button');
    close.className = 'lb-close';
    close.textContent = '✕';
    const nav = document.createElement('button');
    nav.className = 'lb-nav';
    nav.textContent = '‹';
    nav.style.left = '0';
    box.appendChild(media);
    box.appendChild(close);
    box.appendChild(nav);
    close.onclick = () => {
      const v = media.querySelector('video');
      if (v) v.pause();
      box.style.display = 'none';
      media.innerHTML = '';
      hideMask();
    };
    nav.onclick = () => {
      lbState.idx = (lbState.idx + 1) % lbState.list.length;
      renderLightbox();
    };
  }

  // ============ picker 弹层（wx.pick 不存在；runtime 事件层用它） ============
  // 这里仅提供 scanCode 复用的面板工具
  function openPickerPanel(html) {
    const layer = $('#mp-picker-layer');
    const panel = layer.querySelector('.pk-panel');
    panel.innerHTML = html;
    layer.style.display = 'flex';
    return { layer, panel };
  }
  function closePickerPanel() {
    $('#mp-picker-layer').style.display = 'none';
  }
  MP._openPickerPanel = openPickerPanel;
  MP._closePickerPanel = closePickerPanel;

  // ============ scanCode ============
  wx.scanCode = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok, err) => {
      const { panel } = openPickerPanel(
        '<div style="font-weight:600;margin-bottom:8px;text-align:center">模拟扫码</div>' +
          '<input class="pk-scan" type="text" placeholder="输入二维码内容后回车" ' +
          'style="width:100%;padding:10px;font-size:15px;border:1px solid #ddd;border-radius:8px"/>' +
          '<button class="pk-cancel">取消</button>'
      );
      const input = panel.querySelector('.pk-scan');
      const cancel = panel.querySelector('.pk-cancel');
      const close = () => {
        input.removeEventListener('keydown', onKey);
        cancel.removeEventListener('click', onCancel);
        closePickerPanel();
      };
      const submit = () => {
        const v = input.value.trim();
        if (!v) return;
        close();
        ok({ result: v, errMsg: 'scanCode:ok' });
      };
      const onKey = (e) => {
        if (e.key === 'Enter') submit();
      };
      const onCancel = () => {
        close();
        err({ errMsg: 'scanCode:fail cancel' });
      };
      input.addEventListener('keydown', onKey);
      cancel.addEventListener('click', onCancel);
      setTimeout(() => input.focus(), 50);
    });
  };

  // ============ 导航 / 页面 UI（委托 runtime） ============
  ['navigateTo', 'redirectTo', 'navigateBack', 'switchTab', 'reLaunch'].forEach((fn) => {
    wx[fn] = function (opts) {
      opts = opts || {};
      return cbApi(opts, (ok, err) => {
        try {
          MP.router[fn](opts, ok, err);
        } catch (e) {
          err({ errMsg: fn + ':fail ' + e.message });
        }
      });
    };
  });
  wx.setNavigationBarTitle = function (opts) {
    return cbApi(opts, (ok) => {
      if (MP.ui) MP.ui.setTitle(opts.title || '');
      ok({ errMsg: 'setNavigationBarTitle:ok' });
    });
  };
  wx.stopPullDownRefresh = function () {
    if (MP.ui) MP.ui.stopPullDown();
  };
  wx.nextTick = function (fn) {
    setTimeout(fn, 0);
  };

  // ============ 存储 ============
  wx.setStorageSync = (k, v) => {
    try {
      localStorage.setItem('mp_' + k, JSON.stringify(v));
    } catch (e) {}
  };
  wx.getStorageSync = (k) => {
    const s = localStorage.getItem('mp_' + k);
    if (s == null) return '';
    try {
      return JSON.parse(s);
    } catch (e) {
      return '';
    }
  };
  wx.removeStorageSync = (k) => localStorage.removeItem('mp_' + k);
  wx.clearStorageSync = () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('mp_')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  };

  // ============ 设备信息 ============
  function systemInfo() {
    const pages = document.getElementById('mp-pages');
    return {
      windowWidth: 375,
      windowHeight: pages ? pages.clientHeight : 700,
      pixelRatio: 2,
      statusBarHeight: 24,
      screenwidth: 375,
      platform: 'devtools',
      model: 'demo-browser',
      language: 'zh_CN',
      SDKVersion: '3.4.10',
      version: '8.0.49',
      system: 'demo',
    };
  }
  wx.getWindowInfo = systemInfo;
  wx.getSystemInfoSync = systemInfo;

  // ============ 剪贴板 ============
  wx.setClipboardData = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok) => {
      const done = () => {
        wx.showToast({ title: '已复制', icon: 'none' });
        ok({ errMsg: 'setClipboardData:ok' });
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(opts.data || '').then(done, () => fallbackCopy(opts.data, done));
      } else fallbackCopy(opts.data, done);
    });
  };
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text || '';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {}
    document.body.removeChild(ta);
    done();
  }

  // ============ 文件选择（chooseMedia / chooseMessageFile） ============
  MP._files = new Map(); // objectURL → File
  MP.chooseFiles = function (opts) {
    return new Promise((resolve) => {
      const input = $('#mp-file-input');
      input.value = '';
      input.multiple = !!opts.multiple;
      input.accept = opts.accept || '';
      input.onchange = () => {
        const arr = Array.from(input.files || []).map((f) => {
          const p = URL.createObjectURL(f);
          MP._files.set(p, f);
          return { file: f, path: p };
        });
        resolve(arr);
      };
      input.click();
    });
  };
  function extOf(name) {
    const m = String(name || '').match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  }
  wx.chooseMedia = function (opts) {
    opts = opts || {};
    const count = opts.count || 1;
    const accept =
      opts.mediaType && opts.mediaType.indexOf('video') >= 0 ? 'video/*,image/*' : 'image/*';
    return cbApi(opts, (ok, err) => {
      MP.chooseFiles({ multiple: count > 1, accept }).then((pairs) => {
        if (!pairs.length) return err({ errMsg: 'chooseMedia:fail cancel' });
        const tempFiles = pairs.map((p) => ({
          tempFilePath: p.path,
          size: p.file.size,
          type: p.file.type.indexOf('video') === 0 ? 'video' : 'image',
        }));
        ok({
          tempFiles,
          tempFilePaths: tempFiles.map((t) => t.tempFilePath),
          type: tempFiles[0].type,
          errMsg: 'chooseMedia:ok',
        });
      });
    });
  };
  wx.chooseMessageFile = function (opts) {
    opts = opts || {};
    const count = opts.count || 1;
    const accept = opts.type === 'file' ? '.xlsx,.xls,.csv,.pdf,.doc,.docx,.txt' : '';
    return cbApi(opts, (ok, err) => {
      MP.chooseFiles({ multiple: count > 1, accept }).then((pairs) => {
        if (!pairs.length) return err({ errMsg: 'chooseMessageFile:fail cancel' });
        ok({
          tempFiles: pairs.map((p) => ({
            path: p.path,
            name: p.file.name,
            size: p.file.size,
            type: extOf(p.file.name),
            time: Math.floor(Date.now() / 1000),
          })),
          errMsg: 'chooseMessageFile:ok',
        });
      });
    });
  };

  // ============ 下载 / 文件系统 / 文档 ============
  wx.downloadFile = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok, err) => {
      fetch(opts.url)
        .then((r) => {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.blob();
        })
        .then((b) => {
          const p = URL.createObjectURL(b);
          MP._files.set(p, b);
          ok({ tempFilePath: p, statusCode: 200, errMsg: 'downloadFile:ok' });
        })
        .catch(() => err({ errMsg: 'downloadFile:fail' }));
    });
  };
  wx.getFileSystemManager = function () {
    return {
      readFile(o) {
        o = o || {};
        fetch(o.filePath)
          .then((r) => {
            if (!r.ok) throw new Error('http ' + r.status);
            return r.blob();
          })
          .then((b) => {
            const fr = new FileReader();
            fr.onload = () => {
              const data =
                o.encoding === 'base64'
                  ? String(fr.result).replace(/^data:[^;]*;base64,/, '')
                  : fr.result;
              o.success && o.success({ data });
            };
            if (o.encoding === 'base64') fr.readAsDataURL(b);
            else fr.readAsText(b);
          })
          .catch(() => o.fail && o.fail({ errMsg: 'readFile:fail' }));
      },
    };
  };
  wx.openDocument = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok, err) => {
      const w = window.open(opts.filePath, '_blank');
      if (!w) return err({ errMsg: 'openDocument:fail popup blocked' });
      wx.showToast({ title: '已在新窗口打开文档', icon: 'none' });
      ok({ errMsg: 'openDocument:ok' });
    });
  };

  // ============ 支付 ============
  wx.requestPayment = function (opts) {
    opts = opts || {};
    return cbApi(opts, (ok, err) => {
      const m = String(opts.package || '').match(/^prepay_id=demo_(.+)$/);
      if (!m) return err({ errMsg: 'requestPayment:fail invalid package' });
      apiPost('/api/demo/confirm-pay', { outTradeNo: m[1] })
        .then((res) => {
          if (res.ok) ok({ errMsg: 'requestPayment:ok' });
          else err({ errMsg: 'requestPayment:fail ' + (res.errmsg || 'pay error'), errcode: res.errcode });
        })
        .catch(() => err({ errMsg: 'requestPayment:fail network' }));
    });
  };

  // ============ 云能力 ============
  wx.cloud = {
    init(opts) {
      MP._cloudEnv = opts || {};
    },
    callFunction(o) {
      o = o || {};
      return cbApi(o, (ok, err) => {
        apiPost('/api/cloud', { name: o.name, data: o.data })
          .then((res) => {
            if (res.ok) {
              if (MP.logCall) MP.logCall('callFunction ' + o.name + ' ✓');
              ok({ result: res.result }); // 与真实 SDK 一致：resolve { result: 云函数返回值 }
            } else {
              if (MP.logCall) MP.logCall('callFunction ' + o.name + ' ✗ ' + (res.errMsg || ''), true);
              err({ errMsg: 'cloud.callFunction:fail ' + (res.errMsg || 'unknown') });
            }
          })
          .catch(() => {
            if (MP.logCall) MP.logCall('callFunction ' + o.name + ' ✗ network', true);
            err({ errMsg: 'cloud.callFunction:fail network' });
          });
      });
    },
    uploadFile(o) {
      o = o || {};
      return cbApi(o, (ok, err) => {
        const doUpload = (base64, mime) => {
          apiPost('/api/upload', { cloudPath: o.cloudPath, contentBase64: base64, mime })
            .then((res) => {
              if (res.ok) {
                if (MP.logCall) MP.logCall('uploadFile ' + o.cloudPath + ' ✓');
                ok({ fileID: res.fileID, statusCode: 200, errMsg: 'uploadFile:ok' });
              } else {
                if (MP.logCall) MP.logCall('uploadFile ' + o.cloudPath + ' ✗', true);
                err({ errMsg: 'cloud.uploadFile:fail ' + (res.errMsg || '') });
              }
            })
            .catch(() => err({ errMsg: 'cloud.uploadFile:fail network' }));
        };
        const blobToBase64 = (b) =>
          new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () =>
              resolve({ base64: String(fr.result).replace(/^data:[^;]*;base64,/, ''), mime: b.type });
            fr.readAsDataURL(b);
          });
        const f = MP._files.get(o.filePath);
        if (f) return blobToBase64(f).then((r) => doUpload(r.base64, r.mime));
        if (typeof o.filePath === 'string' && /^(blob:|https?:|\/)/.test(o.filePath)) {
          return fetch(o.filePath)
            .then((r) => r.blob())
            .then((b) => blobToBase64(b))
            .then((r) => doUpload(r.base64, r.mime))
            .catch(() => err({ errMsg: 'cloud.uploadFile:fail file not found' }));
        }
        err({ errMsg: 'cloud.uploadFile:fail file not found' });
      });
    },
    getTempFileURL(o) {
      o = o || {};
      return cbApi(o, (ok) => {
        const fileList = (o.fileList || []).map((id) => ({
          fileID: id,
          tempFileURL: MP.WXML.cloudUrl(id),
          status: 0,
          errMsg: 'getTempFileURL:ok',
        }));
        ok({ fileList, errMsg: 'getTempFileURL:ok' });
      });
    },
    downloadFile(o) {
      o = o || {};
      return cbApi(o, (ok, err) => {
        fetch(MP.WXML.cloudUrl(o.fileID))
          .then((r) => {
            if (!r.ok) throw new Error('http ' + r.status);
            return r.blob();
          })
          .then((b) => {
            const p = URL.createObjectURL(b);
            MP._files.set(p, b);
            ok({ tempFilePath: p, statusCode: 200, errMsg: 'downloadFile:ok' });
          })
          .catch(() => err({ errMsg: 'cloud.downloadFile:fail' }));
      });
    },
  };

  // ============ 节点查询（实现见 runtime.js） ============
  wx.createSelectorQuery = function () {
    return MP.createSelectorQuery(null);
  };

  // ============ 启动 ============
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.wx = wx;
  document.addEventListener('DOMContentLoaded', initLightbox);
})();
