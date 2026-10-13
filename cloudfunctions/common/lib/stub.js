// lib/stub.js — 骨架占位 action（框架阶段统一返回 NOT_IMPL，并标注文档出处）
const { fail } = require('./response');
const { CODE } = require('./constants');

function stub(action, docRef) {
  return async () => fail(CODE.NOT_IMPL, `接口 ${action} 待实现（${docRef}）`);
}

module.exports = { stub };
