// lib/crypto.js — 敏感字段加解密与哈希（架构 §8.1 个人信息保护）
// 用途：user.phone / waiver_record.guardian_phone AES-256-CBC 加密存储；
//       phone_hash 等值查询索引（密钥派生 HMAC-SHA256，不可由哈希反推手机号）。
// 密钥：云函数环境变量 PHONE_AES_KEY（口令任意长度，经 SHA-256 派生为 32 字节 AES 密钥）；
//       未配置时使用开发占位密钥（仅限联调，生产必须配置——换密钥后历史密文不可解）。
const nodeCrypto = require('crypto');

const DEV_KEY = 'cs-club-dev-aes-key';
let devKeyWarned = false;

// 派生 32 字节 AES 密钥
function deriveKey() {
  const secret = process.env.PHONE_AES_KEY;
  if (secret) {
    return nodeCrypto.createHash('sha256').update(String(secret)).digest();
  }
  if (!devKeyWarned) {
    devKeyWarned = true;
    console.warn('[crypto] 未配置环境变量 PHONE_AES_KEY，使用开发占位密钥（生产环境必须配置）');
  }
  return nodeCrypto.createHash('sha256').update(DEV_KEY).digest();
}

// 加密：返回 "base64(iv):base64(ciphertext)"；入参为空返回 null
function encryptField(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  try {
    const key = deriveKey();
    const iv = nodeCrypto.randomBytes(16);
    const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return iv.toString('base64') + ':' + enc.toString('base64');
  } catch (e) {
    console.error('[crypto] 加密失败', e);
    return null;
  }
}

// 解密：格式不符 / 密钥变更 / 密文损坏 → 返回 null（调用方按未绑定处理，不抛错）
function decryptField(stored) {
  if (!stored || typeof stored !== 'string' || stored.indexOf(':') < 0) return null;
  try {
    const idx = stored.indexOf(':');
    const iv = Buffer.from(stored.slice(0, idx), 'base64');
    const data = Buffer.from(stored.slice(idx + 1), 'base64');
    const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', deriveKey(), iv);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    return null;
  }
}

// 等值查询哈希：同密钥派生，确定性 hex 输出（用于 phone_hash 索引）
function hashField(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  return nodeCrypto.createHmac('sha256', deriveKey()).update(String(plain)).digest('hex');
}

module.exports = { encryptField, decryptField, hashField };
