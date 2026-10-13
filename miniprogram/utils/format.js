// utils/format.js — 展示格式化：金额（分→元）、时间（毫秒时间戳）
// 约定：全链路金额单位为分（整数）、时间为毫秒时间戳（architecture.md §6）

// 分 → 元字符串（如 8800 → "88"、990 → "9.9"）
function formatMoney(cents) {
  if (cents == null || isNaN(cents)) return '-';
  const yuan = (cents / 100).toFixed(2);
  return yuan.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

// 毫秒时间戳 → 'YYYY-MM-DD HH:mm'（默认）或自定义分隔
function formatTime(ts, withTime = true) {
  if (!ts) return '-';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(ts) {
  return formatTime(ts, false);
}

// 手机号脱敏展示（138****0000，user-module §5.18 脱敏规则）
function maskPhone(phone) {
  if (!phone || phone.length < 11) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

module.exports = { formatMoney, formatTime, formatDate, maskPhone };
