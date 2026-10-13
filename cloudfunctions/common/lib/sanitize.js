// lib/sanitize.js — 日志 detail 脱敏（admin-module §6.2 / §5.18 sanitizeDetail）
// 规则：手机号 138****0000；支付账号要素 ***（订单号/退款单号不脱敏）；身份证前6后4；openid 前6后4。
// detail 序列化后 ≤ 4KB，超限截断标记。

const PHONE_RE = /^1[3-9]\d{9}$/;

function maskPhone(v) {
  const s = String(v);
  if (PHONE_RE.test(s)) return s.slice(0, 3) + '****' + s.slice(-4);
  return s.length > 4 ? s.slice(0, 3) + '****' + s.slice(-2) : '***';
}

function maskIdCard(v) {
  const s = String(v);
  return s.length > 10 ? s.slice(0, 6) + '****' + s.slice(-4) : '***';
}

function maskOpenid(v) {
  const s = String(v);
  return s.length > 10 ? s.slice(0, 6) + '****' + s.slice(-4) : '***';
}

// 字段名 → 脱敏函数
const FIELD_RULES = [
  { test: (k) => /(^|_)(phone|mobile)$/i.test(k), mask: maskPhone },
  { test: (k) => /(id_?card|idcard|guardian_id)/i.test(k), mask: maskIdCard },
  { test: (k) => k === 'openid', mask: maskOpenid },
];

function maskValue(key, value) {
  if (typeof value !== 'string' || !value) return value;
  for (const rule of FIELD_RULES) {
    if (rule.test(key)) return rule.mask(value);
  }
  return value;
}

function deepMask(input, depth) {
  if (input === null || input === undefined) return input;
  if (depth > 6) return '[too-deep]';
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => deepMask(v, depth + 1));
  if (typeof input === 'object') {
    const out = {};
    for (const k of Object.keys(input)) {
      out[k] = maskValue(k, deepMask(input[k], depth + 1));
    }
    return out;
  }
  if (typeof input === 'string') return input.length > 512 ? input.slice(0, 512) + '…' : input;
  return input;
}

const DETAIL_LIMIT = 4096; // 4KB 上限（admin-module §6.2）

function sanitizeDetail(input) {
  if (input === null || input === undefined) return null;
  const masked = deepMask(input, 0);
  try {
    const json = JSON.stringify(masked);
    if (json.length <= DETAIL_LIMIT) return masked;
    return { _truncated: true, preview: json.slice(0, DETAIL_LIMIT) };
  } catch (e) {
    return { _stringify_error: String(input).slice(0, 512) };
  }
}

module.exports = { sanitizeDetail, maskPhone, maskIdCard, maskOpenid };
