// demo/runtime/wxml.js — WXML 解析器 + 渲染器（覆盖本项目用到的 12 种标签与 wx:if/for、事件绑定）
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});

  // ================= 表达式求值 =================
  const exprCache = new Map();
  function evalInScopes(exprRaw, scopes) {
    // wx:if / wx:for 调用点会传入原始属性值（可能带 {{}} 外壳），统一剥掉
    let expr = String(exprRaw == null ? '' : exprRaw).trim();
    const wrapped = expr.match(/^\{\{([\s\S]*)\}\}$/);
    if (wrapped) expr = wrapped[1].trim();
    let fn = exprCache.get(expr);
    if (!fn) {
      try {
        fn = new Function('__s', 'for (var i = 0; i < __s.length; i++) { try { with (__s[i]) { return (' + expr + '); } } catch (e) {} } return undefined;');
      } catch (e) {
        console.error('[wxml-expr] 编译失败:', JSON.stringify(expr), e.message);
        fn = null;
        exprCache.set(expr, fn);
        return undefined;
      }
      exprCache.set(expr, fn);
    }
    try {
      return fn(scopes);
    } catch (e) {
      return undefined;
    }
  }

  // 属性字符串求值（可含多个 {{}}）
  function evalAttr(raw, scopes) {
    if (raw == null) return '';
    const str = String(raw);
    // 单一完整插值 {{x}}（无前后缀）：保留原始类型（字符串化交给调用方）
    const only = str.trim().match(/^\{\{([\s\S]*)\}\}$/);
    if (only && only[0].length === str.length && str.indexOf('{{') === str.lastIndexOf('{{')) {
      const v = evalInScopes(only[1], scopes);
      return v === undefined || v === null ? '' : v;
    }
    let out = '';
    let rest = str;
    let m;
    const re = /\{\{([\s\S]*?)\}\}/;
    while ((m = rest.match(re))) {
      out += rest.slice(0, m.index);
      const v = evalInScopes(m[1], scopes);
      out += v === undefined || v === null ? '' : String(v);
      rest = rest.slice(m.index + m[0].length);
    }
    return out + rest;
  }

  function evalBool(raw, scopes) {
    if (raw == null || raw === '') return true; // 布尔属性（无值）
    const only = String(raw).trim().match(/^\{\{([\s\S]*)\}\}$/);
    if (only) {
      const v = evalInScopes(only[1], scopes);
      return !(v === undefined || v === null || v === false || v === 0 || v === '');
    }
    return true; // disabled="disabled" 之类字面量
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // cloud:// 文件地址 → 本地端点
  function cloudUrl(v) {
    if (v == null) return v;
    return String(v).replace(/^cloud:\/\/([^/]+)\/(.*)$/, '/api/file/$2');
  }

  // ================= WXML 解析 =================
  const VOID_TAGS = new Set(['input', 'image', 'br', 'hr', 'img']);

  function parse(src) {
    const root = { type: 'root', tag: '', attrs: {}, children: [] };
    const stack = [root];
    let i = 0;
    const n = src.length;
    const pushText = (t) => {
      if (t) stack[stack.length - 1].children.push({ type: 'text', text: t });
    };
    while (i < n) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { pushText(src.slice(i)); break; }
      if (lt > i) pushText(src.slice(i, lt));
      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (src[lt + 1] === '/') { // 闭合标签：向上找同名节点
        const gt = src.indexOf('>', lt);
        const name = src.slice(lt + 2, gt < 0 ? n : gt).trim();
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].tag === name) { stack.length = s; break; }
        }
        i = gt < 0 ? n : gt + 1;
        continue;
      }
      // 开始标签
      const node = { type: 'el', tag: '', attrs: {}, children: [] };
      let j = lt + 1;
      while (j < n && /[^\s/>]/.test(src[j])) j++;
      node.tag = src.slice(lt + 1, j).toLowerCase();
      while (j < n) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n || src[j] === '>') break;
        if (src[j] === '/' && src[j + 1] === '>') break;
        let k = j;
        while (k < n && /[^\s=/>]/.test(src[k])) k++;
        const name = src.slice(j, k);
        j = k;
        while (j < n && /\s/.test(src[j])) j++;
        let value = '';
        if (src[j] === '=') {
          j++;
          while (j < n && /\s/.test(src[j])) j++;
          const q = src[j];
          if (q === '"' || q === "'") {
            const end = src.indexOf(q, j + 1);
            value = src.slice(j + 1, end < 0 ? n : end);
            j = end < 0 ? n : end + 1;
          } else {
            let k2 = j;
            while (k2 < n && /[^\s>]/.test(src[k2])) k2++;
            value = src.slice(j, k2);
            j = k2;
          }
        }
        if (name) node.attrs[name] = value;
      }
      let selfClose = false;
      if (src[j] === '/') { selfClose = true; j++; }
      if (src[j] === '>') j++; else j = n;
      stack[stack.length - 1].children.push(node);
      if (!selfClose && !VOID_TAGS.has(node.tag)) stack.push(node);
      i = j;
    }
    return root;
  }

  // ================= 渲染 =================
  const SKIP_ATTRS = new Set(['wx:if', 'wx:elif', 'wx:else', 'wx:for', 'wx:for-item', 'wx:for-index', 'wx:key']);
  const BOOL_ATTRS = new Set(['disabled', 'checked', 'loading', 'show-scrollbar']);

  const TAG_MAP = {
    view: 'div', text: 'span', block: null, button: 'button', input: 'input',
    image: 'img', picker: 'div', 'scroll-view': 'div', textarea: 'textarea',
    canvas: 'canvas', switch: 'input', form: 'form',
  };

  function attrNameToDom(name) {
    if (name === 'placeholder-class') return null;
    if (name === 'confirm-type') return null;
    if (name === 'lower-threshold') return 'data-lower-threshold';
    if (name === 'placeholder-style') return null;
    return name;
  }

  function renderChildren(children, scopes, path) {
    let html = '';
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.type === 'el' && c.attrs['wx:if'] !== undefined) {
        // wx:if / elif / else 分支组（wx:if 与 elif/else 之间的空白文本节点不影响分组）
        let chosen = truthyCond(evalInScopes(c.attrs['wx:if'], scopes)) ? c : null;
        let j = i + 1;
        while (j < children.length) {
          const nx = children[j];
          if (nx.type === 'text' && !String(nx.text).trim()) { j++; continue; } // 跳过纯空白
          if (nx.type === 'el' &&
            (nx.attrs['wx:elif'] !== undefined || nx.attrs['wx:else'] !== undefined)) {
            if (!chosen) {
              if (nx.attrs['wx:elif'] !== undefined) {
                if (truthyCond(evalInScopes(nx.attrs['wx:elif'], scopes))) chosen = nx;
              } else chosen = nx;
            }
            j++;
            continue;
          }
          break;
        }
        if (chosen) html += renderNode(chosen, scopes, path + '.' + i);
        i = j - 1;
        continue;
      }
      if (c.type === 'el' && (c.attrs['wx:elif'] !== undefined || c.attrs['wx:else'] !== undefined)) continue;
      html += renderNode(c, scopes, path + '.' + i);
    }
    return html;
  }

  function truthyCond(v) {
    return !(v === undefined || v === null || v === false || v === 0 || v === '');
  }

  function renderNode(node, scopes, path) {
    if (node.type === 'text') {
      const t = node.text.replace(/\s+/g, ' ');
      if (!t.trim()) return '';
      return esc(evalAttr(t, scopes));
    }
    if (node.type !== 'el') return '';
    const forExpr = node.attrs['wx:for'];
    if (forExpr !== undefined) {
      const list = evalInScopes(forExpr, scopes);
      if (!list || typeof list !== 'object') return '';
      const arr = Array.isArray(list) ? list : Object.keys(list).map((k) => list[k]);
      const itemKey = node.attrs['wx:for-item'] || 'item';
      const idxKey = node.attrs['wx:for-index'] || 'index';
      let html = '';
      for (let k = 0; k < arr.length; k++) {
        const sub = {};
        sub[itemKey] = arr[k];
        sub[idxKey] = k;
        html += renderEl(node, scopes.concat([sub]), path + '[' + k + ']');
      }
      return html;
    }
    return renderEl(node, scopes, path);
  }

  function renderEl(node, scopes, path) {
    if (node.tag === 'block') return renderChildren(node.children, scopes, path);
    const domTag = TAG_MAP[node.tag];
    if (domTag == null) return renderChildren(node.children, scopes, path);
    const a = node.attrs;
    const attrs = [];
    const onEvents = [];
    const styles = [];
    let clsVal = ''; // class 统一收集，特化分支合并，避免输出重复 class 属性

    if (a.hidden !== undefined && evalBool(a.hidden, scopes)) styles.push('display:none');
    if (a['show-scrollbar'] !== undefined && !evalBool(a['show-scrollbar'], scopes)) {
      // scroll-view 隐藏滚动条（demo.css 已全局隐藏）
    }

    for (const name of Object.keys(a)) {
      if (SKIP_ATTRS.has(name) || name === 'hidden' || name === 'show-scrollbar') continue;
      const ev = name.match(/^(bind|catch)([a-zA-Z]+)$/);
      if (ev) {
        const type = ev[2].toLowerCase();
        onEvents.push(type + ':' + a[name] + (ev[1] === 'catch' ? ':catch' : ''));
        continue;
      }
      if (BOOL_ATTRS.has(name)) {
        if (evalBool(a[name], scopes)) attrs.push(name + '="' + name + '"');
        continue;
      }
      let val = evalAttr(a[name], scopes);
      if (name === 'class') { if (val) clsVal = String(val); continue; }
      if (name === 'style') { if (val) styles.push(String(val).replace(/;$/, '')); continue; }
      if (name === 'src' || name === 'poster') { val = cloudUrl(val); }
      if (name === 'value') { attrs.push('value="' + esc(val) + '"'); continue; }
      if (name === 'type' && node.tag === 'input') {
        if (val === 'number' || val === 'digit') { attrs.push('type="text" inputmode="numeric"'); continue; }
        if (val === 'idcard') { attrs.push('type="text"'); continue; }
        attrs.push('type="' + esc(val) + '"');
        continue;
      }
      if (name === 'maxlength' && String(val) === '-1') continue;
      const dom = attrNameToDom(name);
      if (dom) attrs.push(dom + '="' + esc(val) + '"');
    }

    // 标签特化
    if (node.tag === 'image') attrs.push('data-mode="' + esc(evalAttr(a.mode || 'scaleToFill', scopes)) + '"');
    if (node.tag === 'picker') {
      const pk = {
        mode: evalAttr(a.mode || 'selector', scopes),
        range: evalInScopes(wrapExpr(a.range), scopes),
        rangeKey: a['range-key'] || '',
        value: evalInScopes(wrapExpr(a.value), scopes),
        start: evalAttr(a.start || '', scopes),
        end: evalAttr(a.end || '', scopes),
      };
      clsVal = 'mp-picker' + (clsVal ? ' ' + clsVal : '');
      attrs.push('data-pk="' + esc(JSON.stringify(pk)) + '"');
      if (evalBool(a.disabled, scopes)) attrs.push('data-pk-disabled="1"');
    }
    if (node.tag === 'switch') {
      attrs.push('type="checkbox"');
      clsVal = 'mp-switch' + (clsVal ? ' ' + clsVal : '');
    }
    if (node.tag === 'scroll-view') {
      clsVal = 'mp-scroll-view' + (clsVal ? ' ' + clsVal : '');
    }
    if (clsVal) attrs.push('class="' + esc(clsVal) + '"');
    if (onEvents.length) attrs.push('data-on="' + esc(onEvents.join(';')) + '"');
    if (node.tag === 'input' || node.tag === 'textarea') attrs.push('data-wxid="' + esc(path) + '"');

    const styleAttr = styles.join(';');
    let html = '<' + domTag;
    for (const at of attrs) html += ' ' + at;
    if (styleAttr) html += ' style="' + esc(styleAttr) + '"';
    html += '>';
    if (VOID_TAGS.has(domTag)) return html;
    html += renderChildren(node.children, scopes, path);
    html += '</' + domTag + '>';
    return html;
  }

  function wrapExpr(v) {
    if (v == null || v === '') return 'undefined';
    const s = String(v).trim();
    if (/^\{\{[\s\S]*\}\}$/.test(s)) return s.slice(2, -2);
    return JSON.stringify(s);
  }

  MP.WXML = {
    parse,
    render(ast, data) {
      return renderChildren(ast.children, [data || {}], 'r');
    },
    cloudUrl,
    evalInScopes,
    evalAttr,
  };
})();
