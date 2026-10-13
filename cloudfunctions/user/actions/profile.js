// actions/profile.js — 登录与资料（user-module §5.2-§5.7）
// phone / guardian_phone AES 加密存储（架构 §8.1），出参一律脱敏。
// 业务错误一律直接 return fail(...)（user/index.js 路由层 catch 不识别 BizError）。
const common = require('@club/admin-common');
const { ok, fail, CODE, levelOf, rankOf, RANKS, maskPhone, encryptField, decryptField, hashField } = common;

// user 模块业务码（user-module §5.5-§5.7）
const BIZ = {
  PHONE_FETCH_FAILED: 2001, // 微信手机号获取失败（code 无效或云调用失败，可重试）
  NO_ACTIVE_AGREEMENT: 1005, // 无生效协议版本
  AGREEMENT_VERSION_INVALID: 2002,
  GUARDIAN_INVALID: 2003,
  IDENTITY_CONFLICT: 2004,
};

// ---------- 内部工具 ----------

// 周岁计算（东八区口径；birthday 为毫秒时间戳）
function calcAge(birthdayMs, now) {
  const b = new Date((birthdayMs || 0) + 8 * 3600 * 1000);
  const n = new Date((now || Date.now()) + 8 * 3600 * 1000);
  let age = n.getUTCFullYear() - b.getUTCFullYear();
  const m = n.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && n.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

// R4：按生日判定是否未成年；无生日返回 null（未知，走声明流程）
function isMinorByBirthday(birthdayMs, now) {
  if (!birthdayMs) return null;
  return calcAge(birthdayMs, now) < 18;
}

// 查询当前生效协议（§6.7 status='published'，published_at 倒序，每 type 取最新一条）
async function getActiveAgreements(db) {
  const res = await db
    .collection('agreement')
    .where({ status: 'published' })
    .orderBy('published_at', 'desc')
    .limit(20)
    .get();
  const byType = {};
  (res.data || []).forEach((a) => {
    if (a && a.type && !byType[a.type]) byType[a.type] = a;
  });
  return byType;
}

// 查询本人最新签署记录（signed_at 倒序取 1 条）
async function getLatestSigned(db, userId) {
  const res = await db
    .collection('waiver_record')
    .where({ user_id: userId })
    .orderBy('signed_at', 'desc')
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

// R4/R5/R6：协议状态综合判定（login / getProfile / getWaiver 共用）
// suggest_type 优先级：birthday 实时计算 > 用户声明 is_minor > 已签版本类型 > adult
// need_resign：无签署记录 / 无生效版本 / 身份类型不符 / 版本落后，任一即需（重）签
async function computeWaiverStatus(db, user) {
  let activeByType = {};
  let latestSigned = null;
  try {
    activeByType = await getActiveAgreements(db);
  } catch (e) {
    console.warn('[waiver] 生效协议查询失败（非阻断）', e);
  }
  try {
    latestSigned = await getLatestSigned(db, user._id);
  } catch (e) {
    console.warn('[waiver] 签署记录查询失败（非阻断）', e);
  }

  const minorByBirthday = isMinorByBirthday(user.birthday);
  let suggestType;
  if (minorByBirthday !== null) {
    suggestType = minorByBirthday ? 'minor' : 'adult';
  } else if (user.is_minor) {
    suggestType = 'minor';
  } else if (latestSigned && latestSigned.agreement_type) {
    suggestType = latestSigned.agreement_type;
  } else {
    suggestType = 'adult';
  }

  const activeDoc = activeByType[suggestType] || null;
  const activeVersion = activeDoc ? activeDoc.version : null;
  const needResign =
    !latestSigned ||
    !activeVersion ||
    latestSigned.agreement_type !== suggestType ||
    latestSigned.agreement_version !== activeVersion;

  return { activeByType, latestSigned, suggestType, activeDoc, activeVersion, needResign };
}

// §6.9 冗余字段同步：昵称/头像 → 未结束报名记录、队伍成员
// fire-and-forget：不 await、失败仅告警不阻断；历史记录留痕当时昵称，不同步。
function syncNicknameAvatar(db, userId, data) {
  setImmediate(() => {
    const _ = db.command;
    const notFinished = ['pending', 'enrolled', 'waitlist', 'checked_in']; // activity-module §6.2 状态枚举
    Promise.all([
      db
        .collection('activity_enrollment')
        .where({ user_id: userId, status: _.in(notFinished) })
        .update({ data }),
      db
        .collection('team_member')
        .where({ user_id: userId, status: 'active' })
        .update({ data }),
    ])
      .then(() => console.info('[updateProfile] 冗余字段同步完成', userId))
      .catch((e) => console.warn('[updateProfile] 冗余字段同步失败（不阻断）', e));
  });
}

// ---------- Actions ----------

// §5.2 login — 静默登录
// openid upsert：不存在则插入默认文档（openid 唯一索引冲突时重查）；存在则刷新 last_login_at。
// 输出：{ is_new, user: { user_id, nickname, avatar, role, status, is_minor,
//        phone_bound, phone_masked, waiver_signed, level, created_at } }
async function login(event) {
  const { cloud, db } = common.getContext();
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();

  try {
    const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
    let user = found.data && found.data[0];
    let isNew = false;

    if (!user) {
      try {
        const add = await db.collection('user').add({
          data: {
            openid: OPENID,
            nickname: '微信用户',
            avatar: '',
            role: 'member',
            status: 'normal',
            is_minor: false,
            total_games: 0,
            total_kills: 0,
            total_wins: 0,
            rank: 'recruit',
            last_login_at: now,
            created_at: now,
            updated_at: now,
          },
        });
        user = {
          _id: add._id,
          openid: OPENID,
          nickname: '微信用户',
          avatar: '',
          role: 'member',
          status: 'normal',
          is_minor: false,
          total_games: 0,
          created_at: now,
        };
        isNew = true;
      } catch (e) {
        // openid 唯一索引冲突（并发首登）：重查一次
        const again = await db.collection('user').where({ openid: OPENID }).limit(1).get();
        user = again.data && again.data[0];
        if (!user) throw e;
      }
    } else {
      await db.collection('user').doc(user._id).update({
        data: { last_login_at: now, updated_at: now },
      });
    }

    // 封禁账号：code=1003 + data.banned=true（§5.2）
    if (user.status === 'banned') {
      return fail(CODE.BANNED, '账号已被封禁，如有疑问请联系俱乐部工作人员', { banned: true });
    }

    // 免责协议签署态（R6 口径）：有签署记录且无需重签
    let waiverSigned = false;
    try {
      const waiverInfo = await computeWaiverStatus(db, user);
      waiverSigned = !waiverInfo.needResign;
    } catch (e) {
      console.warn('[login] 协议签署态查询失败（非阻断）', e);
    }

    // 手机号：AES 解密后脱敏（密钥变更/密文损坏按未绑定处理）
    let phoneMasked = null;
    if (user.phone) {
      const plainPhone = decryptField(user.phone);
      phoneMasked = plainPhone ? maskPhone(plainPhone) : null;
    }

    return ok({
      is_new: isNew,
      user: {
        user_id: user._id,
        nickname: user.nickname,
        avatar: user.avatar,
        role: user.role,
        status: user.status,
        is_minor: !!user.is_minor,
        phone_bound: phoneMasked !== null,
        phone_masked: phoneMasked,
        waiver_signed: waiverSigned,
        level: isNew ? null : levelOf(user.total_games),
        created_at: user.created_at,
      },
    });
  } catch (e) {
    console.error('[login] 登录失败', e);
    return fail(CODE.INTERNAL, '服务器开小差了');
  }
}

// §5.3 getProfile — 个人资料聚合（资料 + 等级 + 军衔 + 协议 + 卡概要）
async function getProfile(event) {
  const { cloud, db } = common.getContext();
  const { OPENID } = cloud.getWXContext();

  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  const user = found.data && found.data[0];
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, '账号已被封禁，如有疑问请联系俱乐部工作人员', { banned: true });
  }

  // 协议签署态（查询失败不阻断，降级为待签署）
  let waiver = {
    signed: false,
    agreement_version: null,
    agreement_type: null,
    signed_at: null,
    need_resign: true,
  };
  try {
    const info = await computeWaiverStatus(db, user);
    const latestSigned = info.latestSigned;
    waiver = {
      signed: !info.needResign,
      agreement_version: latestSigned ? latestSigned.agreement_version : null,
      agreement_type: latestSigned ? latestSigned.agreement_type : null,
      signed_at: latestSigned ? latestSigned.signed_at : null,
      need_resign: info.needResign,
    };
  } catch (e) {
    console.warn('[getProfile] 协议状态计算失败（非阻断）', e);
  }

  // 等级（R14 实时换算，不落库）
  const lv = levelOf(user.total_games || 0);
  const NEXT_LEVEL_THRESHOLD = [1, 10, 30, 60, null]; // LV0→1场 / LV1→10 / LV2→30 / LV3→60 / LV4 封顶
  const level = {
    key: 'LV' + lv.level,
    name: lv.name,
    discount_percent: lv.discount_percent,
    next_threshold: NEXT_LEVEL_THRESHOLD[lv.level] !== undefined ? NEXT_LEVEL_THRESHOLD[lv.level] : null,
  };

  // 军衔（R15：读冗余字段 + 下一档双门槛）
  const totalKills = user.total_kills || 0;
  const totalWins = user.total_wins || 0;
  const currentRank = rankOf(totalKills, totalWins);
  const rankIdx = RANKS.findIndex((r) => r.key === currentRank.key);
  const nextRank = rankIdx >= 0 && rankIdx < RANKS.length - 1 ? RANKS[rankIdx + 1] : null;
  const rank = {
    key: currentRank.key,
    name: currentRank.name,
    total_kills: totalKills,
    total_wins: totalWins,
    next_thresholds: nextRank ? { total_kills: nextRank.kills, total_wins: nextRank.wins } : null,
  };

  // 会员卡概要：全部 active（次卡 R9「先到期先用」、期限卡最近到期）
  let cards = [];
  try {
    const cardRes = await db
      .collection('member_card')
      .where({ user_id: user._id, status: 'active' })
      .limit(50)
      .get();
    const all = (cardRes.data || []).slice();
    const countCards = all
      .filter((c) => c.card_type === 'count')
      .sort((a, b) => (a.expire_at || 0) - (b.expire_at || 0));
    const periodCards = all
      .filter((c) => c.card_type === 'period')
      .sort((a, b) => (a.expire_at || 0) - (b.expire_at || 0));
    cards = countCards.concat(periodCards).map((c) => ({
      card_id: c._id,
      card_type: c.card_type,
      card_name: c.card_name,
      remain_times: c.card_type === 'count' ? c.remain_times || 0 : null,
      expire_at: c.expire_at || null,
      status: c.status,
    }));
  } catch (e) {
    console.warn('[getProfile] 会员卡查询失败（非阻断）', e);
  }

  // 手机号：AES 解密后脱敏
  let phoneMasked = null;
  if (user.phone) {
    const plainPhone = decryptField(user.phone);
    phoneMasked = plainPhone ? maskPhone(plainPhone) : null;
  }

  return ok({
    user: {
      user_id: user._id,
      nickname: user.nickname,
      avatar: user.avatar || '',
      gender: user.gender === undefined ? 0 : user.gender,
      birthday: user.birthday || null,
      phone_masked: phoneMasked,
      phone_owner: user.phone_owner || 'self',
      phone_bound: phoneMasked !== null,
      is_minor: !!user.is_minor,
      emergency_contact: user.emergency_contact
        ? {
            name: user.emergency_contact.name || '',
            phone_masked: user.emergency_contact.phone ? maskPhone(user.emergency_contact.phone) : null,
          }
        : null,
      total_games: user.total_games || 0,
    },
    level,
    rank,
    waiver,
    cards,
  });
}

// §5.4 updateProfile — 资料更新（白名单校验；服务端管控字段出现即忽略不报错）
async function updateProfile(event) {
  const { cloud, db } = common.getContext();
  const { OPENID } = cloud.getWXContext();
  const payload = (event && event.payload) || {};

  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  const user = found.data && found.data[0];
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, '账号已被封禁，如有疑问请联系俱乐部工作人员');
  }

  const updated = {};
  const updatedFields = [];

  if (payload.nickname !== undefined) {
    const nickname = typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
    if (!nickname.length || nickname.length > 20) {
      return fail(CODE.PARAM, '昵称需为 1-20 个字符');
    }
    updated.nickname = nickname;
    updatedFields.push('nickname');
  }

  if (payload.avatar !== undefined) {
    if (typeof payload.avatar !== 'string' || !payload.avatar.length || payload.avatar.length > 500) {
      return fail(CODE.PARAM, '头像地址不合法');
    }
    updated.avatar = payload.avatar;
    updatedFields.push('avatar');
  }

  if (payload.gender !== undefined) {
    if ([0, 1, 2].indexOf(payload.gender) < 0) {
      return fail(CODE.PARAM, '性别取值需为 0（保密）/1（男）/2（女）');
    }
    updated.gender = payload.gender;
    updatedFields.push('gender');
  }

  if (payload.birthday !== undefined) {
    const birthday = payload.birthday;
    if (
      typeof birthday !== 'number' ||
      !isFinite(birthday) ||
      birthday < -2208960000000 ||
      birthday > Date.now()
    ) {
      return fail(CODE.PARAM, '出生日期不合法');
    }
    updated.birthday = birthday;
    updated.is_minor = isMinorByBirthday(birthday) === true; // R4：以生日实时判定为准
    updatedFields.push('birthday');
  }

  if (payload.emergency_contact !== undefined) {
    if (payload.emergency_contact === null) {
      updated.emergency_contact = null; // 允许清除
    } else {
      const c = payload.emergency_contact || {};
      const cname = c.name === undefined || c.name === null ? '' : String(c.name).trim();
      const cphone = c.phone === undefined || c.phone === null ? '' : String(c.phone).trim();
      if (!cname.length || cname.length > 20) {
        return fail(CODE.PARAM, '紧急联系人姓名需为 1-20 个字符');
      }
      if (!/^1\d{10}$/.test(cphone)) {
        return fail(CODE.PARAM, '紧急联系人手机号格式不正确');
      }
      updated.emergency_contact = { name: cname, phone: cphone };
    }
    updatedFields.push('emergency_contact');
  }

  if (!updatedFields.length) {
    return fail(CODE.PARAM, '未提供可更新字段');
  }

  updated.updated_at = Date.now();
  await db.collection('user').doc(user._id).update({ data: updated });

  // §6.9 冗余同步：昵称/头像 → 未结束报名记录、在队成员（fire-and-forget）
  const syncData = {};
  if (updated.nickname !== undefined) syncData.nickname = updated.nickname;
  if (updated.avatar !== undefined) syncData.avatar = updated.avatar;
  if (syncData.nickname !== undefined || syncData.avatar !== undefined) {
    syncNicknameAvatar(db, user._id, syncData);
  }

  return ok({ updated_fields: updatedFields });
}

// §5.5 bindPhone — 绑定/换绑手机号（self=微信手机号快捷验证 / guardian=监护人表单）
// phone AES 加密落库（架构 §8.1）；幂等：同号同 owner 直接成功；
// guardian 模式与已签监护人版协议留痕不一致仅 warning 提示，不阻断（§8.2）。
async function bindPhone(event) {
  const { cloud, db } = common.getContext();
  const { OPENID } = cloud.getWXContext();
  const payload = (event && event.payload) || {};

  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  const user = found.data && found.data[0];
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');
  if (user.status === 'banned') {
    return fail(CODE.BANNED, '账号已被封禁，如有疑问请联系俱乐部工作人员');
  }

  const owner = payload.phone_owner;
  if (owner !== 'self' && owner !== 'guardian') {
    return fail(CODE.PARAM, 'phone_owner 需为 self 或 guardian');
  }

  const now = Date.now();
  let plainPhone = '';

  if (owner === 'self') {
    // 8.11：code 为一次性，入参拒绝空 code
    const code = typeof payload.phone_code === 'string' ? payload.phone_code.trim() : '';
    if (!code) return fail(CODE.PARAM, 'phone_code 不能为空');
    try {
      const res = await cloud.openapi.phonenumber.getPhoneNumber({ code });
      const phoneInfo = res && res.phoneInfo;
      plainPhone = (phoneInfo && (phoneInfo.purePhoneNumber || phoneInfo.phoneNumber)) || '';
      if (!plainPhone) throw new Error('phoneInfo 为空');
    } catch (e) {
      // 2001：微信侧解密/接口失败（可重试）
      console.warn('[bindPhone] 微信手机号获取失败', e);
      return fail(BIZ.PHONE_FETCH_FAILED, '手机号获取失败，请重试');
    }
  } else {
    plainPhone = typeof payload.phone === 'string' ? payload.phone.trim() : '';
    if (!/^1\d{10}$/.test(plainPhone)) {
      return fail(CODE.PARAM, '监护人手机号格式不正确');
    }
  }

  // 幂等：同号同 owner → 直接成功返回（不重复写库）
  const currentPhone = user.phone ? decryptField(user.phone) : null;
  if (currentPhone === plainPhone && (user.phone_owner || 'self') === owner) {
    return ok({
      phone_masked: maskPhone(plainPhone),
      phone_owner: owner,
      phone_bound_at: user.phone_bound_at || null,
      warning: null,
    });
  }

  // 换绑直接覆盖（§8.2：不提供解绑；密文损坏时 decryptField 返回 null 走正常覆盖）
  await db.collection('user').doc(user._id).update({
    data: {
      phone: encryptField(plainPhone),
      phone_hash: hashField(plainPhone),   // §6.1 等值查询索引（手机号搜索复用，架构 §8.1）
      phone_owner: owner,
      phone_bound_at: now,
      updated_at: now,
    },
  });

  // guardian 模式：与最新监护人版签署记录的 guardian_phone 比对（不一致仅提示，不阻断）
  let warning = null;
  if (owner === 'guardian') {
    try {
      const signed = await getLatestSigned(db, user._id);
      if (signed && signed.agreement_type === 'minor' && signed.guardian_phone) {
        const gPhone = decryptField(signed.guardian_phone);
        if (gPhone && gPhone !== plainPhone) {
          warning = '监护人手机号与已签署监护人版协议中的号码不一致，请确认是否为同一监护人';
        }
      }
    } catch (e) {
      console.warn('[bindPhone] 协议监护人号码比对失败（非阻断）', e);
    }
  }

  return ok({
    phone_masked: maskPhone(plainPhone),
    phone_owner: owner,
    phone_bound_at: now,
    warning,
  });
}

// §5.6 getWaiver — 协议签署页数据（生效版本 + 本人最新签署 + 是否需重签）
// 可选 payload.type（adult/minor）：指定查看/签署的版本类型（前端身份切换入口、2004 引导重签用）；
// 缺省返回 R4 建议类型；指定类型无生效协议时同样返回 1005
async function getWaiver(event) {
  const { cloud, db } = common.getContext();
  const { OPENID } = cloud.getWXContext();
  const payload = (event && event.payload) || {};

  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  const user = found.data && found.data[0];
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  const info = await computeWaiverStatus(db, user);
  let active = info.activeDoc;
  let needResign = info.needResign;
  if ((payload.type === 'adult' || payload.type === 'minor') && payload.type !== info.suggestType) {
    active = (info.activeByType || {})[payload.type] || null;
    const signed0 = info.latestSigned;
    needResign =
      !signed0 ||
      signed0.agreement_type !== payload.type ||
      !active ||
      signed0.agreement_version !== active.version;
  }
  if (!active) {
    // §5.6 1005：建议签署的版本类型无生效协议（如未成年但监护人版未上架）
    return fail(BIZ.NO_ACTIVE_AGREEMENT, '当前无生效的协议版本，请联系俱乐部工作人员');
  }

  const signed = info.latestSigned;
  return ok({
    latest: {
      agreement_version: active.version,
      agreement_type: active.type,
      title: active.title,
      content_file_id: active.content_file_id || '',
      published_at: active.published_at || null,
    },
    signed: signed
      ? {
          agreement_version: signed.agreement_version,
          agreement_type: signed.agreement_type,
          signed_at: signed.signed_at,
        }
      : null,
    need_resign: needResign,
    is_minor: active.type === 'minor', // 生效身份口径（R4）
    suggest_type: active.type,
  });
}

// §5.7 signWaiver — 协议签署（2002 版本校验 → 2003 监护人信息 → 2004 身份一致性 → 幂等 → 留痕落库）
async function signWaiver(event) {
  const { cloud, db } = common.getContext();
  const wxContext = cloud.getWXContext();
  const { OPENID } = wxContext;
  const payload = (event && event.payload) || {};

  // 入参校验
  const agreementType = payload.agreement_type;
  if (agreementType !== 'adult' && agreementType !== 'minor') {
    return fail(CODE.PARAM, 'agreement_type 需为 adult 或 minor');
  }
  const agreementVersion = payload.agreement_version;
  if (typeof agreementVersion !== 'string' || !agreementVersion.trim().length || agreementVersion.length > 20) {
    return fail(CODE.PARAM, 'agreement_version 不能为空');
  }

  const found = await db.collection('user').where({ openid: OPENID }).limit(1).get();
  const user = found.data && found.data[0];
  if (!user) return fail(CODE.UNAUTHORIZED, '请先登录');

  const now = Date.now();

  // 生日（选填）：优先本次提交，其次档案已有
  let birthday = null;
  if (payload.birthday !== undefined && payload.birthday !== null) {
    if (
      typeof payload.birthday !== 'number' ||
      !isFinite(payload.birthday) ||
      payload.birthday < -2208960000000 ||
      payload.birthday > now
    ) {
      return fail(CODE.PARAM, '出生日期不合法');
    }
    birthday = payload.birthday;
  } else if (user.birthday) {
    birthday = user.birthday;
  }

  // 2002：签署版本必须为当前生效版本
  let activeByType = {};
  try {
    activeByType = await getActiveAgreements(db);
  } catch (e) {
    console.warn('[signWaiver] 生效协议查询失败', e);
  }
  const activeDoc = activeByType[agreementType];
  if (!activeDoc || activeDoc.version !== agreementVersion) {
    return fail(BIZ.AGREEMENT_VERSION_INVALID, '协议版本不存在或已更新，请刷新后重试');
  }

  // 2003：监护人版必填监护人姓名与手机号
  let guardianName = '';
  let guardianPhone = '';
  if (agreementType === 'minor') {
    guardianName =
      payload.guardian_name === undefined || payload.guardian_name === null
        ? ''
        : String(payload.guardian_name).trim();
    guardianPhone =
      payload.guardian_phone === undefined || payload.guardian_phone === null
        ? ''
        : String(payload.guardian_phone).trim();
    if (!guardianName.length || guardianName.length > 20) {
      return fail(BIZ.GUARDIAN_INVALID, '请填写监护人姓名（1-20 个字符）');
    }
    if (!/^1\d{10}$/.test(guardianPhone)) {
      return fail(BIZ.GUARDIAN_INVALID, '请填写正确的监护人手机号');
    }
  }

  // 2004：版本-身份一致性（有生日依据才校验；缺生日走声明流程）
  if (birthday) {
    const minor = isMinorByBirthday(birthday, now) === true;
    if (agreementType === 'adult' && minor) {
      return fail(BIZ.IDENTITY_CONFLICT, '按出生日期您未满 18 周岁，需由监护人签署监护人版协议');
    }
    if (agreementType === 'minor' && !minor) {
      return fail(BIZ.IDENTITY_CONFLICT, '按出生日期您已成年，请签署成人版协议');
    }
  }

  // 幂等：同 user 同版本同类型已签 → 返回原记录
  const dupRes = await db
    .collection('waiver_record')
    .where({ user_id: user._id, agreement_version: agreementVersion, agreement_type: agreementType })
    .limit(1)
    .get();
  const dup = dupRes.data && dupRes.data[0];
  if (dup) {
    return ok({
      agreement_version: dup.agreement_version,
      agreement_type: dup.agreement_type,
      signed_at: dup.signed_at,
      ip: dup.ip || null,
    });
  }

  // 落签署记录（§6.3：guardian_phone AES 加密；ip 留痕）
  const ip = wxContext.CLIENTIP || null;
  const record = {
    user_id: user._id,
    agreement_type: agreementType,
    agreement_version: agreementVersion,
    signed_at: now,
    ip,
    created_at: now,
  };
  if (agreementType === 'minor') {
    record.guardian_name = guardianName;
    record.guardian_phone = encryptField(guardianPhone);
  }

  try {
    await db.collection('waiver_record').add({ data: record });
  } catch (e) {
    // (user_id, agreement_version) 唯一索引并发冲突 → 重查幂等返回
    const again = await db
      .collection('waiver_record')
      .where({ user_id: user._id, agreement_version: agreementVersion, agreement_type: agreementType })
      .limit(1)
      .get();
    const rec = again.data && again.data[0];
    if (rec) {
      return ok({
        agreement_version: rec.agreement_version,
        agreement_type: rec.agreement_type,
        signed_at: rec.signed_at,
        ip: rec.ip || null,
      });
    }
    throw e;
  }

  // R4 身份联动：首次提交生日落档；签署监护人版=声明未成年，成人版=声明成年
  const userUpdate = {};
  if (birthday && !user.birthday) userUpdate.birthday = birthday;
  if (agreementType === 'minor' && !user.is_minor) userUpdate.is_minor = true;
  if (agreementType === 'adult' && user.is_minor) userUpdate.is_minor = false;
  if (Object.keys(userUpdate).length) {
    userUpdate.updated_at = now;
    try {
      await db.collection('user').doc(user._id).update({ data: userUpdate });
    } catch (e) {
      console.warn('[signWaiver] 用户身份声明更新失败（不影响签署记录）', e);
    }
  }

  // 监护人手机号与绑定手机号一致性提示（同 §5.5 warning 口径，不阻断）
  let warning = null;
  if (agreementType === 'minor' && user.phone) {
    const boundPhone = decryptField(user.phone);
    if (boundPhone && boundPhone !== guardianPhone) {
      warning = '监护人手机号与当前绑定的手机号不一致，请确认是否为同一监护人';
    }
  }

  return ok({
    agreement_version: agreementVersion,
    agreement_type: agreementType,
    signed_at: now,
    ip,
    warning,
  });
}

module.exports = {
  login,
  getProfile,
  updateProfile,
  bindPhone,
  getWaiver,
  signWaiver,
};
