// actions/address.js — 收货地址（user-module §5.11-§5.13，P2 阶段）
// 业务错误一律直接 return fail(...)（user/index.js 路由层 catch 不识别 BizError）。
const common = require('@club/admin-common');
const { ok, fail, CODE, maskPhone } = common;

// user 模块业务码（user-module §5.12-§5.13）
const BIZ = {
  ADDRESS_NOT_FOUND: 1005, // 地址不存在或不属于当前用户
  ADDRESS_LIMIT: 2008,     // 地址数量超上限（20 条，建议，可调）
};

const BANNED_MSG = '账号已被封禁，如有疑问请联系俱乐部工作人员';
const ADDRESS_LIMIT = 20;

// ---------- 内部工具 ----------

// 由 openid 解析当前用户（profile.js 同款内联实现，user 模块无 shared.js）
async function getCurrentUser(db, cloud) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  return (found.data && found.data[0]) || null;
}

// 参数校验（§5.12 第 1 步）：receiver 1–20 字；phone 11 位（编辑时可空=保留原值，
// 因列表出参脱敏无法回显原号）；region 非空 ≤ 60 字；detail 1–100 字
// 返回规范化的字段对象，校验失败返回错误信息字符串
function validateAddress(payload) {
  const receiver = typeof payload.receiver === 'string' ? payload.receiver.trim() : '';
  const phone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
  const region = typeof payload.region === 'string' ? payload.region.trim() : '';
  const detail = typeof payload.detail === 'string' ? payload.detail.trim() : '';

  if (!receiver || receiver.length > 20) return { err: '请输入 1-20 字的收件人姓名' };
  if (phone && !/^1\d{10}$/.test(phone)) return { err: '请输入 11 位手机号' };
  if (!region || region.length > 60) return { err: '请选择所在地区' };
  if (!detail || detail.length > 100) return { err: '请输入 1-100 字的详细地址' };

  return { fields: { receiver, phone, region, detail, is_default: !!payload.is_default } };
}

// 归属校验（1005）：不存在或不属于当前用户均返回 null
async function getOwnedAddress(db, userId, addressId) {
  const res = await db.collection('user_address').doc(addressId).get().catch(() => null);
  const addr = res && res.data;
  if (!addr || addr.user_id !== userId) return null;
  return addr;
}

// ---------- Actions ----------

// §5.11 listAddress — 收货地址列表（登录态）
// 默认地址置顶、其余按 updated_at 倒序；电话出参脱敏。
async function listAddress() {
  const { cloud, db } = common.getContext();
  const user = await getCurrentUser(db, cloud);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, BANNED_MSG, { banned: true });
  }

  const res = await db
    .collection('user_address')
    .where({ user_id: user._id })
    .orderBy('is_default', 'desc')
    .orderBy('updated_at', 'desc')
    .limit(ADDRESS_LIMIT)
    .get();

  return ok({
    list: (res.data || []).map((a) => ({
      address_id: a._id,
      receiver: a.receiver,
      phone_masked: maskPhone(a.phone),
      region: a.region,
      detail: a.detail,
      is_default: !!a.is_default,
    })),
  });
}

// §5.12 saveAddress — 新增/编辑收货地址（含设默认）
async function saveAddress(event) {
  const { cloud, db } = common.getContext();
  const payload = (event && event.payload) || {};
  const user = await getCurrentUser(db, cloud);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, BANNED_MSG, { banned: true });
  }

  const v = validateAddress(payload);
  if (v.err) return fail(CODE.PARAM, v.err); // 1001
  const fields = v.fields;
  const now = Date.now();
  const addressId = payload.address_id;

  // 编辑：校验归属（1005）后更新
  if (addressId) {
    const addr = await getOwnedAddress(db, user._id, addressId);
    if (!addr) return fail(BIZ.ADDRESS_NOT_FOUND, '地址不存在或不属于当前用户');

    const update = Object.assign({}, fields, { updated_at: now });
    if (!update.phone) delete update.phone; // 编辑未重新输入手机号：保留原值（§5.11 出参脱敏）

    // 设为默认：先清除本人其他默认（§5.12 第 3 步两步更新），再保存本条
    if (fields.is_default && !addr.is_default) {
      await db.collection('user_address')
        .where({ user_id: user._id, is_default: true })
        .update({ data: { is_default: false } });
    }
    await db.collection('user_address').doc(addressId).update({ data: update });
    return ok({ address_id: addressId });
  }

  // 新增：数量上限校验（2008）；手机号必填
  if (!fields.phone) return fail(CODE.PARAM, '请输入 11 位手机号');
  const countRes = await db.collection('user_address').where({ user_id: user._id }).count();
  const count = countRes.total || 0;
  if (count >= ADDRESS_LIMIT) return fail(BIZ.ADDRESS_LIMIT, '收货地址已达上限（20 条）');

  // 首条地址默认设为默认地址；is_default=true 时先清除其他默认
  if (count === 0) fields.is_default = true;
  if (fields.is_default) {
    await db.collection('user_address')
      .where({ user_id: user._id, is_default: true })
      .update({ data: { is_default: false } });
  }
  const add = await db.collection('user_address').add({
    data: Object.assign({ user_id: user._id }, fields, { created_at: now, updated_at: now }),
  });
  return ok({ address_id: add._id });
}

// §5.13 deleteAddress — 删除收货地址
// 删除的是默认地址时不自动指定新默认（§5.13，下次保存时设置）。
async function deleteAddress(event) {
  const { cloud, db } = common.getContext();
  const payload = (event && event.payload) || {};
  const addressId = payload.address_id;
  if (!addressId || typeof addressId !== 'string') {
    return fail(CODE.PARAM, '参数错误：address_id 缺失'); // 1001
  }
  const user = await getCurrentUser(db, cloud);
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, BANNED_MSG, { banned: true });
  }

  const addr = await getOwnedAddress(db, user._id, addressId);
  if (!addr) return fail(BIZ.ADDRESS_NOT_FOUND, '地址不存在或不属于当前用户');

  await db.collection('user_address').doc(addressId).remove();
  return ok({});
}

module.exports = {
  listAddress,
  saveAddress,
  deleteAddress,
};
