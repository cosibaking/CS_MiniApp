/**
 * 二维码生成器（QR Code Model 2）——签到二维码渲染用
 *
 * 移植自 qrcode-generator@1.4.4（MIT License, Copyright (c) 2009 Kazuhiko Arase），
 * 按本项目需要裁剪：仅 Byte 模式 + ECC 级别 M + 版本 v1-v10 自动选型。
 * 关键表（RS 块结构 / 对齐坐标 / 容量）均已与 ISO/IEC 18004 标准表核对。
 *
 * 用法：
 *   const qrcode = require('../../utils/qrcode.js');
 *   const qr = qrcode.create('https://example.com/checkin?token=xxx');
 *   // qr.size       模块数（21/25/.../57）
 *   // qr.isDark(row, col)  判断暗模块（供 canvas 逐格绘制）
 *   // qr.typeNumber / qr.maskPattern  调试用
 */

'use strict';

// ---------- GF(256) 运算（本原多项式 0x11D） ----------
var EXP_TABLE = new Array(256);
var LOG_TABLE = new Array(256);
(function initGaloisField() {
  for (var i = 0; i < 8; i += 1) {
    EXP_TABLE[i] = 1 << i;
  }
  for (var i = 8; i < 256; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (var i = 0; i < 255; i += 1) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
})();

function glog(n) {
  if (n < 1) {
    throw new Error('qrcode: glog(' + n + ')');
  }
  return LOG_TABLE[n];
}

function gexp(n) {
  while (n < 0) {
    n += 255;
  }
  while (n >= 256) {
    n -= 255;
  }
  return EXP_TABLE[n];
}

// ---------- GF(256) 多项式（系数从高次到低次） ----------
function Polynomial(num, shift) {
  var offset = 0;
  while (offset < num.length && num[offset] === 0) {
    offset += 1;
  }
  var coef = [];
  for (var i = 0; i < num.length - offset; i += 1) {
    coef.push(num[i + offset]);
  }
  for (var i = 0; i < shift; i += 1) {
    coef.push(0);
  }
  this.num = coef;
}

Polynomial.prototype.getAt = function (index) {
  return this.num[index];
};

Polynomial.prototype.getLength = function () {
  return this.num.length;
};

Polynomial.prototype.multiply = function (e) {
  var num = [];
  for (var i = 0; i < this.getLength() + e.getLength() - 1; i += 1) {
    num.push(0);
  }
  for (var i = 0; i < this.getLength(); i += 1) {
    for (var j = 0; j < e.getLength(); j += 1) {
      num[i + j] ^= gexp(glog(this.getAt(i)) + glog(e.getAt(j)));
    }
  }
  return new Polynomial(num, 0);
};

Polynomial.prototype.mod = function (e) {
  if (this.getLength() - e.getLength() < 0) {
    return this;
  }
  var ratio = glog(this.getAt(0)) - glog(e.getAt(0));
  var num = [];
  for (var i = 0; i < this.getLength(); i += 1) {
    num.push(this.getAt(i));
  }
  for (var i = 0; i < e.getLength(); i += 1) {
    num[i] ^= gexp(glog(e.getAt(i)) + ratio);
  }
  return new Polynomial(num, 0).mod(e);
};

// RS 生成多项式：∏ (x - α^i)
function getErrorCorrectPolynomial(errorCorrectLength) {
  var a = new Polynomial([1], 0);
  for (var i = 0; i < errorCorrectLength; i += 1) {
    a = a.multiply(new Polynomial([1, gexp(i)], 0));
  }
  return a;
}

// ---------- QR 常量与关键表 ----------
var PAD0 = 0xEC;
var PAD1 = 0x11;

// 版本 1-10 的对齐图案中心坐标（ISO/IEC 18004）
var PATTERN_POSITION_TABLE = [
  [], // v1
  [6, 18], // v2
  [6, 22], // v3
  [6, 26], // v4
  [6, 30], // v5
  [6, 34], // v6
  [6, 22, 38], // v7
  [6, 24, 42], // v8
  [6, 26, 46], // v9
  [6, 28, 50] // v10
];

// RS 块结构（仅 M 级，v1-10）：[块数, 每块总码字, 每块数据码字, ...]，短块在前
var RS_BLOCK_TABLE_M = [
  [1, 26, 16], // v1
  [1, 44, 28], // v2
  [1, 70, 44], // v3
  [2, 50, 32], // v4
  [2, 67, 43], // v5
  [4, 43, 27], // v6
  [4, 49, 31], // v7
  [2, 60, 38, 2, 61, 39], // v8
  [3, 58, 36, 2, 59, 37], // v9
  [4, 69, 43, 1, 70, 44] // v10
];

// format 信息 BCH 生成子 / 掩码（标准值）
var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

function getBCHDigit(data) {
  var digit = 0;
  while (data !== 0) {
    digit += 1;
    data >>>= 1;
  }
  return digit;
}

var G15_DIGIT = getBCHDigit(G15); // 10
var G18_DIGIT = getBCHDigit(G18); // 12

// format 信息：15 位 = 5 位数据（2 位 ECC + 3 位掩码）经 BCH(15,5) 编码后异或 G15_MASK
function getBCHTypeInfo(data) {
  var d = data << 10;
  while (getBCHDigit(d) - G15_DIGIT >= 0) {
    d ^= (G15 << (getBCHDigit(d) - G15_DIGIT));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

// 版本信息（v7+）：18 位 = 6 位版本号经 BCH(18,6) 编码
function getBCHTypeNumber(data) {
  var d = data << 12;
  while (getBCHDigit(d) - G18_DIGIT >= 0) {
    d ^= (G18 << (getBCHDigit(d) - G18_DIGIT));
  }
  return (data << 12) | d;
}

// Byte 模式字符计数位数：v1-9 为 8 位，v10+ 为 16 位
function getLengthInBits(typeNumber) {
  if (typeNumber >= 1 && typeNumber < 10) {
    return 8;
  }
  if (typeNumber >= 10 && typeNumber < 27) {
    return 16;
  }
  throw new Error('qrcode: typeNumber 超出支持范围（1-10）');
}

function getRSBlocks(typeNumber) {
  var rsBlock = RS_BLOCK_TABLE_M[typeNumber - 1];
  var list = [];
  for (var i = 0; i < rsBlock.length; i += 3) {
    var count = rsBlock[i];
    var totalCount = rsBlock[i + 1];
    var dataCount = rsBlock[i + 2];
    for (var j = 0; j < count; j += 1) {
      list.push({ totalCount: totalCount, dataCount: dataCount });
    }
  }
  return list;
}

// 8 种掩码函数（i=行, j=列）
var MASK_FUNCTIONS = [
  function (i, j) { return (i + j) % 2 === 0; },
  function (i) { return i % 2 === 0; },
  function (i, j) { return j % 3 === 0; },
  function (i, j) { return (i + j) % 3 === 0; },
  function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
  function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; },
  function (i, j) { return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0; },
  function (i, j) { return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0; }
];

// 掩码惩罚评分（移植自 qrcode-generator，用于挑选失真最小的掩码；
// 评分细节不影响 QR 合法性——format 信息与掩码始终一致）
function getLostPoint(qrcode) {
  var moduleCount = qrcode.getModuleCount();
  var lostPoint = 0;

  // 同色纵向三连
  var row = 0, col = 0;
  for (row = 0; row < moduleCount; row += 1) {
    for (col = 0; col < moduleCount; col += 1) {
      var sameCount = 0;
      var dark = qrcode.isDark(row, col);
      for (var r = -1; r <= 1; r += 1) {
        if (row + r < 0 || moduleCount <= row + r) {
          continue;
        }
        if (qrcode.isDark(row + r, col) !== dark) {
          continue;
        }
        sameCount += 1;
      }
      if (sameCount === 3) {
        lostPoint += 3;
      }
    }
  }

  // 2x2 同色块
  for (row = 0; row < moduleCount - 1; row += 1) {
    for (col = 0; col < moduleCount - 1; col += 1) {
      var count = 0;
      if (qrcode.isDark(row, col)) count += 1;
      if (qrcode.isDark(row + 1, col)) count += 1;
      if (qrcode.isDark(row, col + 1)) count += 1;
      if (qrcode.isDark(row + 1, col + 1)) count += 1;
      if (count === 0 || count === 4) {
        lostPoint += 3;
      }
    }
  }

  // 1:1:3:1:1 图案（1011101 带 0000 前后缀）
  for (row = 0; row < moduleCount; row += 1) {
    for (col = 0; col < moduleCount - 6; col += 1) {
      if (qrcode.isDark(row, col) &&
          !qrcode.isDark(row, col + 1) &&
          qrcode.isDark(row, col + 2) &&
          qrcode.isDark(row, col + 3) &&
          qrcode.isDark(row, col + 4) &&
          !qrcode.isDark(row, col + 5) &&
          qrcode.isDark(row, col + 6)) {
        lostPoint += 40;
      }
    }
  }
  for (col = 0; col < moduleCount; col += 1) {
    for (row = 0; row < moduleCount - 6; row += 1) {
      if (qrcode.isDark(row, col) &&
          !qrcode.isDark(row + 1, col) &&
          qrcode.isDark(row + 2, col) &&
          qrcode.isDark(row + 3, col) &&
          qrcode.isDark(row + 4, col) &&
          !qrcode.isDark(row + 5, col) &&
          qrcode.isDark(row + 6, col)) {
        lostPoint += 40;
      }
    }
  }

  // 暗模块占比
  var darkCount = 0;
  for (col = 0; col < moduleCount; col += 1) {
    for (row = 0; row < moduleCount; row += 1) {
      if (qrcode.isDark(row, col)) {
        darkCount += 1;
      }
    }
  }
  var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
  lostPoint += ratio * 10;

  return lostPoint;
}

// ---------- 位缓冲 ----------
function BitBuffer() {
  this.buffer = [];
  this.length = 0;
}

BitBuffer.prototype.get = function (index) {
  return ((this.buffer[Math.floor(index / 8)] >>> (7 - (index % 8))) & 1) === 1;
};

BitBuffer.prototype.put = function (num, length) {
  for (var i = 0; i < length; i += 1) {
    this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }
};

BitBuffer.prototype.getLengthInBits = function () {
  return this.length;
};

BitBuffer.prototype.putBit = function (bit) {
  var bufIndex = Math.floor(this.length / 8);
  if (this.buffer.length <= bufIndex) {
    this.buffer.push(0);
  }
  if (bit) {
    this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
  }
  this.length += 1;
};

// ---------- UTF-8 编码（含代理对） ----------
function utf8Bytes(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i += 1) {
    var code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
      var lo = str.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        code = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
      bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    } else {
      bytes.push(
        0xF0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3F),
        0x80 | ((code >> 6) & 0x3F),
        0x80 | (code & 0x3F)
      );
    }
  }
  return bytes;
}

// ---------- 编码主流程 ----------
var MODE_BYTE = 4; // 0100

function pickVersion(byteLength) {
  for (var v = 1; v <= 10; v += 1) {
    var lenBits = getLengthInBits(v);
    var needBits = 4 + lenBits + byteLength * 8;
    var blocks = getRSBlocks(v);
    var totalDataCount = 0;
    for (var i = 0; i < blocks.length; i += 1) {
      totalDataCount += blocks[i].dataCount;
    }
    if (needBits <= totalDataCount * 8) {
      return v;
    }
  }
  throw new Error('qrcode: 内容超出容量上限（v10-M，约 213 字节）');
}

function createData(typeNumber, bytes) {
  var rsBlocks = getRSBlocks(typeNumber);
  var buffer = new BitBuffer();

  buffer.put(MODE_BYTE, 4);
  buffer.put(bytes.length, getLengthInBits(typeNumber));
  for (var i = 0; i < bytes.length; i += 1) {
    buffer.put(bytes[i], 8);
  }

  var totalDataCount = 0;
  for (var i = 0; i < rsBlocks.length; i += 1) {
    totalDataCount += rsBlocks[i].dataCount;
  }
  if (buffer.getLengthInBits() > totalDataCount * 8) {
    throw new Error('qrcode: 数据长度溢出（version ' + typeNumber + '）');
  }

  // 终止符：能整体放下才补 4 位 0
  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
    buffer.put(0, 4);
  }
  // 补齐到字节边界
  while (buffer.getLengthInBits() % 8 !== 0) {
    buffer.putBit(false);
  }
  // 0xEC / 0x11 交替填充
  while (true) {
    if (buffer.getLengthInBits() >= totalDataCount * 8) {
      break;
    }
    buffer.put(PAD0, 8);
    if (buffer.getLengthInBits() >= totalDataCount * 8) {
      break;
    }
    buffer.put(PAD1, 8);
  }

  // 分块计算 RS 纠错码并交织
  var offset = 0;
  var maxDcCount = 0;
  var maxEcCount = 0;
  var dcdata = [];
  var ecdata = [];
  for (var r = 0; r < rsBlocks.length; r += 1) {
    var dcCount = rsBlocks[r].dataCount;
    var ecCount = rsBlocks[r].totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);

    dcdata[r] = [];
    for (var i = 0; i < dcCount; i += 1) {
      dcdata[r][i] = 0xff & buffer.buffer[i + offset];
    }
    offset += dcCount;

    var rsPoly = getErrorCorrectPolynomial(ecCount);
    var rawPoly = new Polynomial(dcdata[r], rsPoly.getLength() - 1);
    var modPoly = rawPoly.mod(rsPoly);
    ecdata[r] = [];
    for (var i = 0; i < rsPoly.getLength() - 1; i += 1) {
      var modIndex = i + modPoly.getLength() - (rsPoly.getLength() - 1);
      ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
    }
  }

  var inter = new BitBuffer();
  for (var i = 0; i < maxDcCount; i += 1) {
    for (var r = 0; r < rsBlocks.length; r += 1) {
      if (i < dcdata[r].length) {
        inter.put(dcdata[r][i], 8);
      }
    }
  }
  for (var i = 0; i < maxEcCount; i += 1) {
    for (var r = 0; r < rsBlocks.length; r += 1) {
      if (i < ecdata[r].length) {
        inter.put(ecdata[r][i], 8);
      }
    }
  }
  return inter.buffer;
}

function create(text) {
  var bytes = utf8Bytes(String(text == null ? '' : text));
  var typeNumber = pickVersion(bytes.length);
  var moduleCount = typeNumber * 4 + 17;

  // 试选最优掩码
  var bestMask = 0;
  var bestLost = 0;
  for (var m = 0; m < 8; m += 1) {
    var modules = buildModules(typeNumber, moduleCount, bytes, m, true);
    var lost = getLostPoint({
      getModuleCount: function () { return moduleCount; },
      isDark: function (row, col) { return modules[row][col]; }
    });
    if (m === 0 || lost < bestLost) {
      bestLost = lost;
      bestMask = m;
    }
  }

  var finalModules = buildModules(typeNumber, moduleCount, bytes, bestMask, false);
  return {
    typeNumber: typeNumber,
    maskPattern: bestMask,
    size: moduleCount,
    modules: finalModules,
    isDark: function (row, col) {
      return finalModules[row][col];
    }
  };
}

// 构建完整模块矩阵
function buildModules(typeNumber, moduleCount, bytes, maskPattern, test) {
  var modules = [];
  for (var row = 0; row < moduleCount; row += 1) {
    modules.push([]);
    for (var col = 0; col < moduleCount; col += 1) {
      modules[row].push(null);
    }
  }

  setupPositionProbePattern(modules, moduleCount, 0, 0);
  setupPositionProbePattern(modules, moduleCount, moduleCount - 7, 0);
  setupPositionProbePattern(modules, moduleCount, 0, moduleCount - 7);
  setupPositionAdjustPattern(modules, moduleCount, typeNumber);
  setupTimingPattern(modules, moduleCount);
  setupTypeInfo(modules, moduleCount, test, maskPattern);
  if (typeNumber >= 7) {
    setupTypeNumber(modules, moduleCount, test, typeNumber);
  }

  // 之字形填入数据（跳过功能图案，已被占用）
  var data = createData(typeNumber, bytes);
  var maskFunc = MASK_FUNCTIONS[maskPattern];
  var inc = -1;
  var row = moduleCount - 1;
  var bitIndex = 7;
  var byteIndex = 0;
  for (var col = moduleCount - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    while (true) {
      for (var c = 0; c < 2; c += 1) {
        if (modules[row][col - c] == null) {
          var dark = false;
          if (byteIndex < data.length) {
            dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
          }
          if (maskFunc(row, col - c)) {
            dark = !dark;
          }
          modules[row][col - c] = dark;
          bitIndex -= 1;
          if (bitIndex === -1) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || moduleCount <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return modules;
}

// 三个 7x7 定位图案 + 分隔留白
function setupPositionProbePattern(modules, moduleCount, row, col) {
  for (var r = -1; r <= 7; r += 1) {
    if (row + r <= -1 || moduleCount <= row + r) {
      continue;
    }
    for (var c = -1; c <= 7; c += 1) {
      if (col + c <= -1 || moduleCount <= col + c) {
        continue;
      }
      if ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
          (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
        modules[row + r][col + c] = true;
      } else {
        modules[row + r][col + c] = false;
      }
    }
  }
}

// 对齐图案（5x5，避让已占用位置）
function setupPositionAdjustPattern(modules, moduleCount, typeNumber) {
  var pos = PATTERN_POSITION_TABLE[typeNumber - 1];
  for (var i = 0; i < pos.length; i += 1) {
    for (var j = 0; j < pos.length; j += 1) {
      var row = pos[i];
      var col = pos[j];
      if (modules[row][col] != null) {
        continue;
      }
      for (var r = -2; r <= 2; r += 1) {
        for (var c = -2; c <= 2; c += 1) {
          if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
            modules[row + r][col + c] = true;
          } else {
            modules[row + r][col + c] = false;
          }
        }
      }
    }
  }
}

// 时序图案：第 6 行/列，黑白交替
function setupTimingPattern(modules, moduleCount) {
  for (var r = 8; r < moduleCount - 8; r += 1) {
    if (modules[r][6] != null) {
      continue;
    }
    modules[r][6] = (r % 2 === 0);
  }
  for (var c = 8; c < moduleCount - 8; c += 1) {
    if (modules[6][c] != null) {
      continue;
    }
    modules[6][c] = (c % 2 === 0);
  }
}

// format 信息（ECC=M 的格式位为 00，data = 0<<3 | mask）
function setupTypeInfo(modules, moduleCount, test, maskPattern) {
  var data = (0 << 3) | maskPattern;
  var bits = getBCHTypeInfo(data);

  // 纵向副本（左上角，绕开时序行）
  for (var i = 0; i < 15; i += 1) {
    var mod = (!test && ((bits >> i) & 1) === 1);
    if (i < 6) {
      modules[i][8] = mod;
    } else if (i < 8) {
      modules[i + 1][8] = mod;
    } else {
      modules[moduleCount - 15 + i][8] = mod;
    }
  }

  // 横向副本（左上 + 右上）
  for (var i = 0; i < 15; i += 1) {
    var mod = (!test && ((bits >> i) & 1) === 1);
    if (i < 8) {
      modules[8][moduleCount - i - 1] = mod;
    } else if (i < 9) {
      modules[8][15 - i - 1 + 1] = mod;
    } else {
      modules[8][15 - i - 1] = mod;
    }
  }

  // 固定暗模块
  modules[moduleCount - 8][8] = !test;
}

// 版本信息（v7+）
function setupTypeNumber(modules, moduleCount, test, typeNumber) {
  var bits = getBCHTypeNumber(typeNumber);
  for (var i = 0; i < 18; i += 1) {
    var mod = (!test && ((bits >> i) & 1) === 1);
    modules[Math.floor(i / 3)][(i % 3) + moduleCount - 8 - 3] = mod;
  }
  for (var i = 0; i < 18; i += 1) {
    var mod = (!test && ((bits >> i) & 1) === 1);
    modules[(i % 3) + moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
  }
}

module.exports = {
  create: create
};
