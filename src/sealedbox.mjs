// GitHub Actions Secrets 등록용 libsodium 'sealed box' 암호화 (crypto_box_seal 호환)
//   봉인 = 임시공개키(32) || box(메시지, nonce = BLAKE2b-24(임시공개키 || 받는쪽공개키), 받는쪽공개키, 임시비밀키)
// tweetnacl(퍼블릭 도메인)을 src/vendor 에 포함. BLAKE2b 는 아래 구현(RFC 7693).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nacl = require('./vendor/nacl-fast.min.cjs');

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK;

export function blake2b(input, outlen = 64) {
  const data = Uint8Array.from(input);
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  let t = 0n;
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const last = b === blocks - 1;
    const block = new Uint8Array(128);
    block.set(data.subarray(b * 128, b * 128 + 128));
    t += BigInt(last ? data.length - b * 128 : 128);
    const m = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]);
      m.push(w);
    }
    const v = [...h, ...IV];
    v[12] ^= t & MASK;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= MASK;
    const G = (a, b2, c, d, x, y) => {
      v[a] = (v[a] + v[b2] + x) & MASK; v[d] = rotr(v[d] ^ v[a], 32);
      v[c] = (v[c] + v[d]) & MASK; v[b2] = rotr(v[b2] ^ v[c], 24);
      v[a] = (v[a] + v[b2] + y) & MASK; v[d] = rotr(v[d] ^ v[a], 16);
      v[c] = (v[c] + v[d]) & MASK; v[b2] = rotr(v[b2] ^ v[c], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

// 받는 쪽 공개키(base64, GitHub 가 주는 값)로 문자열을 봉인 → base64
export function sealBase64(message, recipientPublicKeyB64) {
  const pk = Uint8Array.from(Buffer.from(recipientPublicKeyB64, 'base64'));
  const eph = nacl.box.keyPair();
  const nonceIn = new Uint8Array(64);
  nonceIn.set(eph.publicKey, 0);
  nonceIn.set(pk, 32);
  const nonce = blake2b(nonceIn, 24);
  const boxed = nacl.box(Uint8Array.from(Buffer.from(message, 'utf8')), nonce, pk, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return Buffer.from(out).toString('base64');
}

// 검증용: 봉인 열기
export function openSealedBase64(sealedB64, recipientKeyPair) {
  const c = Uint8Array.from(Buffer.from(sealedB64, 'base64'));
  const epk = c.subarray(0, 32);
  const nonceIn = new Uint8Array(64);
  nonceIn.set(epk, 0);
  nonceIn.set(recipientKeyPair.publicKey, 32);
  const m = nacl.box.open(c.subarray(32), blake2b(nonceIn, 24), epk, recipientKeyPair.secretKey);
  return m ? Buffer.from(m).toString('utf8') : null;
}
export { nacl };
