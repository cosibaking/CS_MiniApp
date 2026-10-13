// lib/validate.js — 参数校验（user-module §5.0：校验失败返回 1001，msg 注明字段）
const { BizError } = require('./response');
const { CODE } = require('./constants');

function assertParam(cond, field) {
  if (!cond) throw new BizError(CODE.PARAM, `参数错误：${field}`);
}

function assertEnum(value, list, field) {
  if (!list.includes(value)) {
    throw new BizError(CODE.PARAM, `参数错误：${field} 取值「${value}」不合法`);
  }
}

function assertPositiveInt(v, field) {
  if (!Number.isInteger(v) || v <= 0) {
    throw new BizError(CODE.PARAM, `参数错误：${field} 需为正整数`);
  }
}

function assertString(v, field, opts) {
  const o = opts || {};
  if (typeof v !== 'string') throw new BizError(CODE.PARAM, `参数错误：${field} 需为字符串`);
  if (o.min && v.length < o.min) throw new BizError(CODE.PARAM, `参数错误：${field} 长度不能小于 ${o.min}`);
  if (o.max && v.length > o.max) throw new BizError(CODE.PARAM, `参数错误：${field} 长度不能超过 ${o.max}`);
}

module.exports = { assertParam, assertEnum, assertPositiveInt, assertString };
