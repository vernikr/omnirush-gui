const sharedTextEncoder = new TextEncoder();

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, idx) => idx.toString(16).padStart(2, "0"));

/**
 * Compute exact UTF-8 byte length of a JS string in a single zero-allocation pass.
 * Matches `new TextEncoder().encode(value).byteLength` identically (including
 * surrogate pairs and lone-surrogate U+FFFD 3-byte replacements).
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  const len = value.length;
  for (let i = 0; i < len; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < len ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Pure synchronous SHA-256 hex digest (64 lowercase hex chars) so `useMemo`
 * live size previews and deterministic IR construction run synchronously in
 * browsers, Electron renderers, and Bun/Node tests without async SubtleCrypto.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === "string" ? sharedTextEncoder.encode(input) : input;
  const bitLenHi = Math.floor(data.length / 0x20000000);
  const bitLenLo = (data.length << 3) >>> 0;

  const paddedLength = (((data.length + 9 + 63) >> 6) << 6);
  const buffer = new Uint8Array(paddedLength);
  buffer.set(data);
  buffer[data.length] = 0x80;

  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLenHi, false);
  view.setUint32(paddedLength - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
      const s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);

  let hex = "";
  for (let i = 0; i < 32; i += 1) {
    hex += HEX_TABLE[out[i]!]!;
  }
  return hex;
}

/** Short 12-hex SHA-256 prefix (48 bits) matching `sqz` reference granularity. */
export function shortSha256(fullHex: string): string {
  return fullHex.slice(0, 12);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isCyrillic(code: number): boolean {
  return code >= 0x0400 && code <= 0x052f;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isExtendedAlpha(code: number): boolean {
  return (
    (code >= 0x00c0 && code <= 0x02af) ||
    (code >= 0x0370 && code <= 0x03ff) ||
    (code >= 0x0530 && code <= 0x07ff) ||
    (code >= 0x1e00 && code <= 0x1eff)
  );
}

function scoreAsciiSubword(length: number): number {
  if (length <= 7) return 1;
  return Math.ceil(length / 4.5);
}

function isTwoCharOperator(c1: number, c2: number): boolean {
  if (c2 === 61) {
    return c1 === 61 || c1 === 33 || c1 === 60 || c1 === 62 || c1 === 43 || c1 === 45;
  }
  if (c1 === 45 && c2 === 62) return true; // ->
  if (c1 === 61 && c2 === 62) return true; // =>
  if (c1 === 38 && c2 === 38) return true; // &&
  if (c1 === 124 && c2 === 124) return true; // ||
  if (c1 === 58 && c2 === 58) return true; // ::
  if (c1 === 47 && (c2 === 47 || c2 === 42 || c2 === 62)) return true; // // /* />
  if (c1 === 42 && c2 === 47) return true; // */
  if (c1 === 60 && c2 === 47) return true; // </
  if (c1 === 34 && (c2 === 58 || c2 === 44)) return true; // ": ",
  if (c1 === 40 && (c2 === 41 || c2 === 123)) return true; // () ({
  if (c1 === 125 && c2 === 41) return true; // })
  if (c1 === 91 && c2 === 93) return true; // []
  if (c1 === 123 && c2 === 125) return true; // {}
  return false;
}

/**
 * Fast, zero-allocation, BPE-calibrated lexical tokenizer (`O(N)` single pass).
 *
 * Mirrors modern LLM pre-tokenization (`o200k_base` / `cl100k_base` / Claude):
 * - Single leading spaces attach to the following word or punctuation token.
 * - Leading indentation runs merge up to 8 columns per token; newlines merge in pairs.
 * - ASCII identifiers split on camelCase / PascalCase boundaries and letter/digit transitions
 *   (so hex hashes, paths, and snake_case tokenize realistically).
 * - Digits group into 1–3 digit chunks (`\p{N}{1,3}`).
 * - Cyrillic, extended Latin/Greek, CJK, and astral emoji use script-specific subword densities
 *   rather than inflating multi-byte UTF-8 prose.
 */
export function estimateTokenCount(text: string): number {
  const len = text.length;
  if (len === 0) return 0;

  let tokens = 0;
  let i = 0;
  let atLineStart = true;

  while (i < len) {
    const c = text.charCodeAt(i);

    if (c === 10 || c === 13) {
      let nlCount = 0;
      while (i < len) {
        const ch = text.charCodeAt(i);
        if (ch === 10) {
          nlCount += 1;
          i += 1;
        } else if (ch === 13) {
          nlCount += 1;
          i += 1;
          if (i < len && text.charCodeAt(i) === 10) {
            i += 1;
          }
        } else {
          break;
        }
      }
      tokens += Math.ceil(nlCount / 2);
      atLineStart = true;
      continue;
    }

    if (c === 32 || c === 9) {
      let cols = 0;
      while (i < len) {
        const ch = text.charCodeAt(i);
        if (ch === 32) {
          cols += 1;
          i += 1;
        } else if (ch === 9) {
          cols += 2;
          i += 1;
        } else {
          break;
        }
      }
      const atEol = i >= len || text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13;
      if (atLineStart && cols >= 2) {
        tokens += Math.ceil(cols / 8);
      } else if (atEol) {
        tokens += Math.ceil(cols / 4);
      } else if (cols > 1) {
        tokens += Math.ceil((cols - 1) / 4);
      }
      atLineStart = false;
      continue;
    }

    atLineStart = false;

    if (isAsciiAlpha(c)) {
      let subStart = i;
      i += 1;
      while (i < len && isAsciiAlpha(text.charCodeAt(i))) {
        const prev = text.charCodeAt(i - 1);
        const curr = text.charCodeAt(i);
        if (isAsciiLower(prev) && isAsciiUpper(curr)) {
          tokens += scoreAsciiSubword(i - subStart);
          subStart = i;
        } else if (
          i - subStart >= 2 &&
          isAsciiUpper(prev) &&
          isAsciiUpper(curr) &&
          i + 1 < len &&
          isAsciiLower(text.charCodeAt(i + 1))
        ) {
          tokens += scoreAsciiSubword(i - subStart);
          subStart = i;
        }
        i += 1;
      }
      tokens += scoreAsciiSubword(i - subStart);
      continue;
    }

    if (isAsciiDigit(c)) {
      const start = i;
      i += 1;
      while (i < len && isAsciiDigit(text.charCodeAt(i))) {
        i += 1;
      }
      tokens += Math.ceil((i - start) / 3);
      continue;
    }

    if (isCyrillic(c)) {
      const start = i;
      i += 1;
      while (i < len && isCyrillic(text.charCodeAt(i))) {
        i += 1;
      }
      const wordLen = i - start;
      tokens += wordLen <= 3 ? 1 : Math.ceil(wordLen / 3.4);
      continue;
    }

    if (isCjk(c)) {
      const start = i;
      i += 1;
      while (i < len && isCjk(text.charCodeAt(i))) {
        i += 1;
      }
      tokens += Math.ceil((i - start) * 1.15);
      continue;
    }

    if (isExtendedAlpha(c)) {
      const start = i;
      i += 1;
      while (i < len && isExtendedAlpha(text.charCodeAt(i))) {
        i += 1;
      }
      const wordLen = i - start;
      tokens += wordLen <= 4 ? 1 : Math.ceil(wordLen / 3.8);
      continue;
    }

    if (c >= 0xd800 && c <= 0xdbff && i + 1 < len) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        tokens += 2;
        i += 2;
        continue;
      }
    }

    if (c === 39 && i + 1 < len && isAsciiLower(text.charCodeAt(i + 1))) {
      const n1 = text.charCodeAt(i + 1);
      const n2 = i + 2 < len ? text.charCodeAt(i + 2) : 0;
      if ((n1 === 114 && n2 === 101) || (n1 === 118 && n2 === 101) || (n1 === 108 && n2 === 108)) {
        if (i + 3 >= len || !isAsciiAlpha(text.charCodeAt(i + 3))) {
          tokens += 1;
          i += 3;
          continue;
        }
      } else if (n1 === 115 || n1 === 116 || n1 === 100 || n1 === 109) {
        if (i + 2 >= len || !isAsciiAlpha(text.charCodeAt(i + 2))) {
          tokens += 1;
          i += 2;
          continue;
        }
      }
    }

    if (i + 1 < len && text.charCodeAt(i + 1) === c) {
      const start = i;
      i += 2;
      while (i < len && text.charCodeAt(i) === c) {
        i += 1;
      }
      tokens += Math.ceil((i - start) / 4);
      continue;
    }

    if (i + 1 < len && isTwoCharOperator(c, text.charCodeAt(i + 1))) {
      tokens += 1;
      i += 2;
      continue;
    }

    tokens += 1;
    i += 1;
  }

  return tokens;
}
