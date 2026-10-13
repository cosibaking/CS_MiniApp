// demo/runtime/wxss.js — WXSS 编译：rpx→px、选择器作用域前缀、cloud:// 重写、@media/@keyframes 处理
(function () {
  'use strict';
  const MP = (window.MP = window.MP || {});

  // 750rpx = 375px → 1rpx = 0.5px
  function rpxToPx(css) {
    return css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (m0, num) => {
      return Math.round(parseFloat(num) * 0.5 * 100) / 100 + 'px';
    });
  }

  // cloud://fileID → /api/file/路径
  function rewriteCloud(css) {
    return css.replace(/cloud:\/\/([^/"'\s)]+)\/([^/"'\s)]+)/g, '/api/file/$2');
  }

  const COMPILE_CACHE = new Map(); // key: srcHashCode → compiled string（与 scope 无关，前缀在运行时拼）

  // 把选择器列表逐个加前缀；page → scope 本体
  function prefixSelectorList(list, scope) {
    return list
      .split(',')
      .map((sel) => {
        let s = sel.trim();
        if (!s) return '';
        if (/^page\b/i.test(s)) s = s.replace(/^page\b/i, scope);
        else s = scope + ' ' + s;
        return s;
      })
      .filter(Boolean)
      .join(', ');
  }

  // 遍历大括号结构编译
  function compileBlock(src, scope) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
      // 跳过空白
      while (i < n && /\s/.test(src[i])) i++;
      if (i >= n) break;
      // @规则
      if (src[i] === '@') {
        // 读取 @名称 直到 { 或 ;
        let j = i;
        while (j < n && src[j] !== '{' && src[j] !== ';') j++;
        const atName = src.slice(i, j).trim(); // 如 @media (max-width: 600px)
        if (src[j] === ';') {
          out += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        // 找匹配的 }
        let depth = 0;
        let k = j;
        for (; k < n; k++) {
          if (src[k] === '{') depth++;
          else if (src[k] === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        const inner = src.slice(j + 1, k);
        if (/^@keyframes/i.test(atName) || /^@font-face/i.test(atName) || /^@supports/i.test(atName)) {
          // 原样保留（keyframes 的百分比选择器不能加前缀）
          out += atName + '{' + compileBlock(inner, scope) + '}';
        } else if (/^@media/i.test(atName)) {
          out += atName + '{' + compileBlock(inner, scope) + '}';
        } else {
          // 其他 @ 规则原样
          out += atName + '{' + inner + '}';
        }
        i = k + 1;
        continue;
      }
      // 普通规则：选择器 { 声明 }
      let j = i;
      while (j < n && src[j] !== '{' && src[j] !== '}') j++;
      if (j >= n) {
        out += src.slice(i);
        break;
      }
      if (src[j] === '}') {
        // 容错：多余的 }
        i = j + 1;
        continue;
      }
      const selector = src.slice(i, j);
      let depth = 0;
      let k = j;
      for (; k < n; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = src.slice(j + 1, k);
      out += prefixSelectorList(selector, scope) + '{' + body + '}';
      i = k + 1;
    }
    return out;
  }

  // 编译 WXSS：src 原文，scope 为选择器前缀（如 '.mp-page-body' 或 '#mp-page-1'）
  function compileCss(src, scope) {
    if (!src) return '';
    const key = scope + '::' + src.length + '::' + hash(src);
    let cached = COMPILE_CACHE.get(key);
    if (cached) return cached;
    let css = String(src);
    css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释
    css = rpxToPx(css);
    css = rewriteCloud(css);
    css = compileBlock(css, scope);
    COMPILE_CACHE.set(key, css);
    return css;
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  // 注入样式表
  function injectCss(id, css) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = css;
  }

  MP.WXSS = { compileCss, injectCss, rpxToPx };
})();
