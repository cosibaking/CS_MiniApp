// demo/runtime/runtime.js — 浏览器端小程序运行时
// CJS 同步加载器 / App/Page 注册 / 路由与页面栈 / setData 渲染 / 事件委托 / picker / 工具条 / 启动
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});
  const $ = (s) => document.querySelector(s);

  // ================= 同步文件获取 =================
  function fetchSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send(null);
    if (xhr.status === 200) return xhr.responseText;
    throw new Error('fetch failed ' + xhr.status + ': ' + url);
  }
  function fetchOrNull(url) {
    try {
      return fetchSync(url);
    } catch (e) {
      return null;
    }
  }

  // ================= CJS 模块加载 =================
  const moduleCache = new Map();
  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : '';
  }
  function joinPath(dir, rel) {
    if (rel.charAt(0) === '/') return normalizeAbs(rel);
    const stack = dir ? dir.split('/') : [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  }
  function normalizeAbs(p) {
    const stack = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  }
  function loadModule(path) {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    const src = fetchSync(path);
    const module = { exports: {} };
    moduleCache.set(path, module);
    const fn = new Function(
      'module', 'exports', 'require', 'wx', 'getApp', 'getCurrentPages', 'App', 'Page',
      src
    );
    const requireFrom = (rel) => {
      const base = joinPath(dirname(path), rel);
      if (fetchOrNull(base + '.js') != null) return loadModule(base + '.js');
      if (fetchOrNull(base + '/index.js') != null) return loadModule(base + '/index.js');
      throw new Error('Cannot find module ' + rel + ' (from ' + path + ')');
    };
    fn(module, module.exports, requireFrom, MP.wx, getApp, getCurrentPages, App, Page);
    return module.exports;
  }

  // ================= App / Page 注册 =================
  MP._appOptions = null;
  MP._pendingPage = null;
  let MPapp = null;
  function App(options) {
    MP._appOptions = options || {};
  }
  function Page(options) {
    MP._pendingPage = options || {};
  }
  function getApp() {
    return MPapp || {};
  }
  function getCurrentPages() {
    return pageStack.map((e) => e.inst);
  }

  // ================= 页面定义缓存 =================
  const defCache = new Map();
  function loadPageDef(route) {
    if (defCache.has(route)) return defCache.get(route);
    const base = '/mp/' + route;
    const json = JSON.parse(fetchOrNull(base + '.json') || '{}');
    const wxmlSrc = fetchSync(base + '.wxml');
    const wxssSrc = fetchOrNull(base + '.wxss') || '';
    MP._pendingPage = null;
    loadModule(base + '.js');
    const def = {
      route,
      json,
      ast: MP.WXML.parse(wxmlSrc),
      wxss: wxssSrc,
      options: MP._pendingPage || {},
    };
    defCache.set(route, def);
    return def;
  }

  // ================= 页面栈与渲染 =================
  const pageStack = []; // {route, inst, el, body, def, styleEl}
  const tabEntries = {}; // route → entry（tab 页常驻）
  let pageSeq = 0;

  function createInst(def, query, entry) {
    const inst = Object.assign({}, def.options);
    inst.data = JSON.parse(JSON.stringify(def.options.data || {}));
    inst.route = def.route;
    inst.__entry = entry;
    inst.__el = entry.body;
    inst.__dirty = false;
    inst.setData = function (patch, cb) {
      patch = patch || {};
      for (const k of Object.keys(patch)) setPath(inst.data, k, patch[k]);
      scheduleRender(inst);
      if (typeof cb === 'function') setTimeout(cb, 0);
    };
    inst.createSelectorQuery = function () {
      return MP.createSelectorQuery(inst);
    };
    return inst;
  }

  function setPath(obj, path, value) {
    const segs = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (cur[k] == null || typeof cur[k] !== 'object') {
        cur[k] = /^\d+$/.test(segs[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[segs[segs.length - 1]] = value;
  }

  function scheduleRender(inst) {
    if (inst.__dirty) return;
    inst.__dirty = true;
    queueMicrotask(() => {
      if (!inst.__dirty) return;
      inst.__dirty = false;
      renderPage(inst);
    });
  }

  function captureFocus(root) {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const holder = a.closest('[data-wxid]');
    if (!holder) return null;
    return {
      wxid: holder.getAttribute('data-wxid'),
      value: holder.value,
      s: a.selectionStart,
      e: a.selectionEnd,
    };
  }
  function restoreFocus(root, f) {
    if (!f) return;
    const el = root.querySelector('[data-wxid="' + f.wxid + '"]');
    if (!el) return;
    if (el.value !== f.value) el.value = f.value;
    try {
      el.focus();
      el.setSelectionRange(f.s, f.e);
    } catch (e) {}
  }

  function snapshotCanvases(body) {
    // setData 重建 DOM 前保留 canvas 位图（真实微信 canvas 节点跨 setData 复用）
    const snap = {};
    const list = body.querySelectorAll('canvas');
    for (let i = 0; i < list.length; i++) {
      const cv = list[i];
      if (!cv.id) continue;
      try {
        if (cv.width > 0 && cv.height > 0) {
          snap[cv.id] = {
            w: cv.width,
            h: cv.height,
            img: cv.getContext('2d').getImageData(0, 0, cv.width, cv.height),
          };
        }
      } catch (e) {}
    }
    return snap;
  }

  function restoreCanvases(body, snap) {
    Object.keys(snap).forEach((id) => {
      const cv = body.querySelector('canvas[id="' + id + '"]');
      if (!cv || !cv.getContext) return;
      const s = snap[id];
      cv.width = s.w;
      cv.height = s.h;
      cv.getContext('2d').putImageData(s.img, 0, 0);
    });
  }

  function renderPage(inst) {
    const body = inst.__el;
    if (!body) return;
    const f = captureFocus(body);
    const cs = snapshotCanvases(body);
    body.innerHTML = MP.WXML.render(inst.__entry.def.ast, inst.data);
    restoreFocus(body, f);
    restoreCanvases(body, cs);
  }

  // ================= 路由 =================
  function parseUrl(url) {
    const s = String(url || '').replace(/^\/+/, '');
    const qi = s.indexOf('?');
    const route = qi < 0 ? s : s.slice(0, qi);
    const query = {};
    if (qi >= 0) {
      for (const kv of s.slice(qi + 1).split('&')) {
        if (!kv) continue;
        const p = kv.split('=');
        try {
          query[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
        } catch (e) {
          query[p[0]] = p[1] || '';
        }
      }
    }
    return { route, query };
  }

  function buildEntry(def, query) {
    const el = document.createElement('div');
    el.className = 'mp-page';
    el.hidden = true;
    const body = document.createElement('div');
    body.className = 'mp-page-body';
    body.id = 'mp-page-' + ++pageSeq;
    el.appendChild(body);
    const styleEl = document.createElement('style');
    styleEl.textContent = MP.WXSS.compileCss(def.wxss, '#' + body.id);
    document.head.appendChild(styleEl);
    $('#mp-pages').appendChild(el);
    const entry = { route: def.route, def, el, body, styleEl, inst: null };
    entry.inst = createInst(def, query, entry);
    bindPageEvents(el, entry.inst);
    return entry;
  }

  function destroyEntry(entry) {
    entry.inst.onUnload && entry.inst.onUnload.call(entry.inst);
    entry.el.remove();
    entry.styleEl.remove();
  }

  function openPage(route, query) {
    const def = loadPageDef(route);
    const entry = buildEntry(def, query);
    pageStack.push(entry);
    entry.inst.onLoad && entry.inst.onLoad.call(entry.inst, query);
    entry.el.hidden = false;
    renderPage(entry.inst);
    entry.inst.onShow && entry.inst.onShow.call(entry.inst); // redirectTo/reLaunch 也需要 onShow
    entry.inst.onReady && entry.inst.onReady.call(entry.inst);
    updateChrome();
  }

  const MProuter = {
    navigateTo(opts, ok, fail) {
      const { route, query } = parseUrl(opts.url);
      if (tabEntries[route]) return MProuter.switchTab(opts, ok, fail); // tab 页容错
      if (pageStack.length >= 10) return fail && fail({ errMsg: 'navigateTo:fail page stack limit' });
      hideTop();
      openPage(route, query); // openPage 内已含 onShow + updateChrome
      ok && ok({ errMsg: 'navigateTo:ok' });
    },
    redirectTo(opts, ok, fail) {
      const { route, query } = parseUrl(opts.url);
      if (pageStack.length) {
        const old = pageStack.pop();
        destroyEntry(old);
      }
      openPage(route, query);
      ok && ok({ errMsg: 'redirectTo:ok' });
    },
    navigateBack(opts, ok, fail) {
      const delta = (opts && opts.delta) || 1;
      if (pageStack.length <= 1) return fail && fail({ errMsg: 'navigateBack:fail no page to go back' });
      let last = null;
      for (let i = 0; i < delta && pageStack.length > 1; i++) {
        last = pageStack.pop();
        destroyEntry(last);
      }
      showTop();
      ok && ok({ errMsg: 'navigateBack:ok' });
    },
    switchTab(opts, ok, fail) {
      const { route } = parseUrl(opts.url);
      const entry = tabEntries[route];
      if (!entry) return fail && fail({ errMsg: 'switchTab:fail not a tabbar page: ' + route });
      while (pageStack.length > 1) destroyEntry(pageStack.pop());
      const cur = pageStack.pop();
      if (cur) {
        cur.inst.onHide && cur.inst.onHide.call(cur.inst);
        cur.el.hidden = true;
      }
      pageStack.push(entry);
      entry.el.hidden = false;
      entry.inst.onShow && entry.inst.onShow.call(entry.inst);
      updateChrome();
      ok && ok({ errMsg: 'switchTab:ok' });
    },
    reLaunch(opts, ok, fail) {
      const { route } = parseUrl(opts.url);
      while (pageStack.length) {
        const e = pageStack.pop();
        if (tabEntries[e.route]) e.el.hidden = true;
        else destroyEntry(e);
      }
      if (tabEntries[route]) {
        pageStack.push(tabEntries[route]);
        tabEntries[route].el.hidden = false;
        tabEntries[route].inst.onShow && tabEntries[route].inst.onShow.call(tabEntries[route].inst);
        updateChrome();
      } else {
        openPage(route, parseUrl(opts.url).query);
      }
      ok && ok({ errMsg: 'reLaunch:ok' });
    },
  };
  function hideTop() {
    const t = pageStack[pageStack.length - 1];
    if (t) {
      t.inst.onHide && t.inst.onHide.call(t.inst);
      t.el.hidden = true;
    }
  }
  function showTop() {
    const t = pageStack[pageStack.length - 1];
    if (t) {
      t.el.hidden = false;
      t.inst.onShow && t.inst.onShow.call(t.inst);
    }
    updateChrome();
  }
  MP.router = MProuter;

  // ================= 顶部栏 / tabBar =================
  MP.ui = {
    setTitle(t) {
      $('#mp-title').textContent = t || '';
    },
    stopPullDown() {
      $('#mp-refresh').classList.remove('spinning');
    },
  };

  function updateChrome() {
    const entry = pageStack[pageStack.length - 1];
    if (!entry) return;
    const win = (MP._appJson && MP._appJson.window) || {};
    $('#mp-title').textContent =
      entry.def.json.navigationBarTitleText || win.navigationBarTitleText || '';
    $('#mp-back').style.visibility = pageStack.length > 1 ? 'visible' : 'hidden';
    const refresh = $('#mp-refresh');
    refresh.style.visibility = entry.def.json.enablePullDownRefresh ? 'visible' : 'hidden';
    $('#mp-tabbar').hidden = pageStack.length > 1 || !tabEntries[entry.route];
    document.querySelectorAll('.mp-tab-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.route === entry.route);
    });
  }

  // ================= 事件委托 =================
  function cleanDataset(node) {
    const ds = Object.assign({}, node.dataset);
    delete ds.on;
    delete ds.pk;
    delete ds.pkDisabled;
    return ds;
  }

  function fireNamed(inst, node, type, detail) {
    const specs = String(node.dataset.on || '').split(';');
    for (const s of specs) {
      const parts = s.split(':');
      if (parts[0] !== type) continue;
      const fn = inst[parts[1]];
      if (typeof fn !== 'function') continue;
      const ds = cleanDataset(node);
      fn.call(inst, {
        type,
        timeStamp: Date.now(),
        detail: detail || {},
        target: { id: node.id || '', dataset: ds },
        currentTarget: { id: node.id || '', dataset: ds },
        touches: [],
        changedTouches: [],
        stopPropagation() {},
      });
      return parts[2] === 'catch';
    }
    return false;
  }

  function dispatchTap(el, inst, domEvent) {
    // 从目标向上收集绑定节点
    let node = domEvent.target;
    const chain = [];
    while (node && node !== el) {
      if (node.dataset && (node.dataset.on || node.dataset.pk)) chain.push(node);
      node = node.parentElement;
    }
    for (const node of chain) {
      // picker 弹层
      if (node.dataset.pk) {
        if (!node.dataset.pkDisabled) openPicker(inst, node);
        return;
      }
      // open-type 按钮
      const ot = node.getAttribute('open-type');
      if (ot === 'getPhoneNumber') {
        fireNamed(inst, node, 'getphonenumber', {
          code: 'demo-phone-code',
          errMsg: 'getPhoneNumber:ok',
        });
        return;
      }
      if (ot === 'chooseAvatar') {
        MP.chooseFiles({ accept: 'image/*' }).then((pairs) => {
          if (pairs.length) fireNamed(inst, node, 'chooseavatar', { avatarUrl: pairs[0].path });
        });
        return;
      }
      if (ot === 'share') {
        wx.showToast({ title: '演示环境不支持分享', icon: 'none' });
      }
      // form-type=submit
      if (node.getAttribute('form-type') === 'submit') {
        const form = node.closest('form');
        if (form) {
          const value = collectForm(form);
          if (fireNamed(inst, form, 'submit', { value })) return;
        }
      }
      if (fireNamed(inst, node, 'tap', {})) return;
    }
  }

  function collectForm(form) {
    const value = {};
    form.querySelectorAll('input, textarea').forEach((n) => {
      if (!n.name) return;
      value[n.name] = n.type === 'checkbox' ? n.checked : n.value;
    });
    return value;
  }

  function bindPageEvents(el, inst) {
    el.addEventListener('click', (e) => dispatchTap(el, inst, e));
    el.addEventListener('input', (e) => {
      const node = e.target.closest('[data-wxid]');
      if (node) fireNamed(inst, node, 'input', { value: node.value });
    });
    el.addEventListener('change', (e) => {
      const node = e.target;
      if (node.classList && node.classList.contains('mp-switch')) {
        fireNamed(inst, node, 'change', { value: node.checked });
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const node = e.target.closest('[data-wxid]');
      if (node) {
        fireNamed(inst, node, 'confirm', { value: node.value });
        if (node.tagName === 'INPUT') node.blur();
      }
    });
    el.addEventListener('focusout', (e) => {
      const node = e.target.closest('[data-wxid]');
      if (node) fireNamed(inst, node, 'blur', { value: node.value });
    });
    el.addEventListener(
      'scroll',
      (e) => {
        let node = e.target;
        if (node === el) return; // 页面级滚动暂不处理 onReachBottom
        while (node && node !== el) {
          if (node.dataset && String(node.dataset.on || '').indexOf('scrolltolower') >= 0) {
            const th = parseInt(node.getAttribute('data-lower-threshold') || '50', 10) || 50;
            if (node.scrollTop + node.clientHeight >= node.scrollHeight - th) {
              fireNamed(inst, node, 'scrolltolower', {});
            }
            return;
          }
          node = node.parentElement;
        }
      },
      true
    );
  }

  // ================= picker 弹层 =================
  function openPicker(inst, node) {
    let pk;
    try {
      pk = JSON.parse(node.dataset.pk);
    } catch (e) {
      return;
    }
    const { panel } = MP._openPickerPanel('');
    const close = () => MP._closePickerPanel();
    const done = (value) => {
      close();
      fireNamed(inst, node, 'change', { value });
    };
    const mode = pk.mode || 'selector';
    if (mode === 'selector') {
      const range = Array.isArray(pk.range) ? pk.range : [];
      const cur = typeof pk.value === 'number' ? pk.value : parseInt(pk.value, 10) || 0;
      const html = range
        .map((item, i) => {
          const label = pk.rangeKey && item && typeof item === 'object' ? item[pk.rangeKey] : item;
          return (
            '<div class="pk-opt' + (i === cur ? ' selected' : '') + '" data-i="' + i + '">' +
            String(label == null ? '' : label) + '</div>'
          );
        })
        .join('') + '<button class="pk-cancel">取消</button>';
      panel.innerHTML = html;
      panel.querySelectorAll('.pk-opt').forEach((opt) => {
        opt.onclick = () => done(parseInt(opt.dataset.i, 10));
      });
    } else if (mode === 'date' || mode === 'time') {
      const val = typeof pk.value === 'string' ? pk.value : '';
      panel.innerHTML =
        '<input class="pk-date" type="' + mode + '" value="' + String(val) + '"' +
        (pk.start ? ' min="' + pk.start + '"' : '') + (pk.end ? ' max="' + pk.end + '"' : '') +
        '/><button class="pk-cancel">取消</button>';
      const input = panel.querySelector('.pk-date');
      input.onchange = () => done(input.value);
    } else if (mode === 'region') {
      const v = Array.isArray(pk.value) ? pk.value : [];
      const pre = [
        v[0] || '广东省',
        v[1] || '深圳市',
        v[2] || '南山区',
      ];
      panel.innerHTML =
        pre.map((x) => '<input class="pk-region" type="text" value="' + String(x) + '"/>').join('') +
        '<button class="pk-ok" style="width:100%;border:none;background:#07c160;color:#fff;border-radius:10px;padding:11px;font-size:14px;cursor:pointer">确定</button>' +
        '<button class="pk-cancel">取消</button>';
      panel.querySelector('.pk-ok').onclick = () => {
        const inputs = Array.from(panel.querySelectorAll('.pk-region')).map((n) => n.value.trim());
        done(inputs);
      };
    } else {
      panel.innerHTML = '<button class="pk-cancel">关闭</button>';
    }
    panel.querySelector('.pk-cancel').onclick = close;
  }

  // ================= 节点查询 =================
  MP.createSelectorQuery = function (pageInst) {
    const inst =
      pageInst || (pageStack.length ? pageStack[pageStack.length - 1].inst : null);
    const q = {
      _sels: [],
      _cb: null,
      select(sel) {
        this._sels.push({ sel, all: false });
        return this;
      },
      in(scope) {
        // 组件/页面域限定：真实小程序支持 SelectorQuery.in(component)
        this._scope = scope;
        return this;
      },
      selectAll(sel) {
        this._sels.push({ sel, all: true });
        return this;
      },
      boundingClientRect(cb) {
        this._cb = cb;
        return this;
      },
      fields(f, cb) {
        this._fields = f || {};
        this._cb = cb;
        return this;
      },
      scrollOffset(cb) {
        this._scroll = true;
        this._cb = cb;
        return this;
      },
      exec(cb) {
        if (inst && inst.__dirty) {
          inst.__dirty = false;
          renderPage(inst);
        }
        const scope = this._scope || inst;
        const root = scope && scope.__el ? scope.__el : document;
        const res = this._sels.map(({ sel, all }) => {
          const els = all
            ? Array.from(root.querySelectorAll(sel))
            : [root.querySelector(sel)].filter(Boolean);
          const describe = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            const out = {
              id: el.id || '',
              dataset: Object.assign({}, el.dataset),
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            };
            if (el.tagName === 'CANVAS') out.node = el;
            if (this._scroll || 'scrollTop' in el) out.scrollTop = el.scrollTop;
            return out;
          };
          return all ? els.map(describe) : describe(els[0] || null);
        });
        cb && cb(res);
        this._cb && this._cb(res);
        return res;
      },
    };
    return q;
  };

  // ================= 浮层按钮 =================
  function initOverlays() {
    $('#mp-mask').addEventListener('click', () => {
      // 点击遮罩：仅关闭 lightbox（modal/loading 需按钮操作）
      const lb = $('#mp-lightbox');
      if (lb.style.display === 'flex') {
        lb.querySelector('.lb-close').click();
      }
    });
    $('#mp-back').addEventListener('click', () => {
      wx.navigateBack({
        fail: () => wx.switchTab({ url: '/' + (MP._appJson && MP._appJson.tabBar.list[0].pagePath) }),
      });
    });
    $('#mp-refresh').addEventListener('click', () => {
      const entry = pageStack[pageStack.length - 1];
      if (!entry || !entry.def.json.enablePullDownRefresh) return;
      $('#mp-refresh').classList.add('spinning');
      if (typeof entry.inst.onPullDownRefresh === 'function') entry.inst.onPullDownRefresh();
      else MP.ui.stopPullDown();
    });
  }

  // ================= 工具条 =================
  function logCall(text, isErr) {
    const box = document.querySelector('#demo-toolbar .cloud-log');
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'log-line' + (isErr ? ' err' : '');
    line.textContent = text;
    box.insertBefore(line, box.firstChild);
    while (box.children.length > 30) box.removeChild(box.lastChild);
  }
  MP.logCall = logCall;

  function showErr(text) {
    const box = $('#demo-error');
    box.style.display = 'block';
    box.textContent = (box.textContent ? box.textContent + '\n' : '') + String(text).slice(0, 500);
  }

  async function initToolbar() {
    $('#demo-title').textContent = '真人CS俱乐部 · 本地演示';
    try {
      const res = await fetch('/api/demo/actors').then((r) => r.json());
      const cur = MP.getOpenid();
      const list = document.querySelector('#demo-toolbar .actor-list');
      list.innerHTML = '';
      (res.actors || []).forEach((a) => {
        const item = document.createElement('div');
        item.className = 'actor-item' + (a.openid === cur ? ' active' : '');
        item.setAttribute('role', 'button'); // 无障碍：暴露为可交互元素
        item.tabIndex = 0;
        item.innerHTML =
          '<span class="role">' + a.role + '</span><div><div>' + a.nickname +
          '</div><div class="desc">' + a.desc + '</div></div>';
        item.onclick = async () => {
          if (a.openid === MP.getOpenid()) return;
          await fetch('/api/demo/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ openid: a.openid }),
          });
          localStorage.setItem('mp_demo_openid', a.openid);
          location.reload();
        };
        list.appendChild(item);
      });
    } catch (e) {
      showErr('工具条初始化失败: ' + e.message);
    }
    $('#demo-reset').onclick = async () => {
      await fetch('/api/demo/reset', { method: 'POST' });
      location.reload();
    };
    document.querySelectorAll('.quick-links button[data-url]').forEach((b) => {
      b.onclick = () => {
        const url = b.dataset.url;
        const { route } = parseUrl(url);
        if (tabEntries[route]) wx.switchTab({ url });
        else wx.navigateTo({ url });
      };
    });
  }

  // ================= 启动 =================
  async function boot() {
    const appJson = JSON.parse(fetchSync('/mp/app.json'));
    MP._appJson = appJson;
    const appWxss = fetchOrNull('/mp/app.wxss') || '';
    MP.WXSS.injectCss('mp-app-wxss', MP.WXSS.compileCss(appWxss, '.mp-page-body'));

    // tabBar DOM
    const tabbar = $('#mp-tabbar');
    tabbar.innerHTML = '';
    (appJson.tabBar && appJson.tabBar.list ? appJson.tabBar.list : []).forEach((t) => {
      const item = document.createElement('div');
      item.className = 'mp-tab-item';
      item.dataset.route = t.pagePath;
      item.textContent = t.text;
      item.onclick = () => wx.switchTab({ url: '/' + t.pagePath });
      tabbar.appendChild(item);
    });

    // app.js → App() → onLaunch
    loadModule('/mp/app.js');
    MPapp = Object.assign({}, MP._appOptions);
    if (typeof MPapp.onLaunch === 'function') MPapp.onLaunch.call(MPapp);

    // 预载 tab 页
    for (const t of appJson.tabBar.list) {
      const def = loadPageDef(t.pagePath);
      const entry = buildEntry(def, {});
      tabEntries[t.pagePath] = entry;
      entry.inst.onLoad && entry.inst.onLoad.call(entry.inst, {});
      renderPage(entry.inst);
      entry.inst.onReady && entry.inst.onReady.call(entry.inst);
    }

    // 打开第一个 tab
    const first = appJson.tabBar.list[0].pagePath;
    pageStack.push(tabEntries[first]);
    tabEntries[first].el.hidden = false;
    tabEntries[first].inst.onShow && tabEntries[first].inst.onShow.call(tabEntries[first].inst);
    updateChrome();

    initOverlays();
    initToolbar();

    console.log('%c[本地演示] 已就绪', 'color:#07c160;font-weight:bold');
  }

  window.addEventListener('error', (e) => {
    showErr((e.message || 'error') + '\n' + ((e.error && e.error.stack) || ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    showErr('Promise: ' + ((r && (r.stack || r.message || r.msg)) || String(r)));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
