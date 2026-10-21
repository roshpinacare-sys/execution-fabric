/* eslint-disable @typescript-eslint/no-require-imports -- .cjs = CommonJS לפי-הגדרה; require-כאן-הוא-החוק */
/**
 * steem-pub-derive.cjs — WIF→STM pubkey [T-111 · trace 1a15e3bf30e79311]
 * ═════════════════════════════════════════════════════════════════════════
 * חוק-סודיות: ה-WIF מגיע ב-stdin (לעולם-לא ב-argv — argv נראה ב-proc-cmdline),
 * הפלט = מפתח-פומבי בלבד (STM…). אפס-ערכי-סודות ביומנים.
 *
 * תומך-בשתי-הצורות (PROCEDURE.md סעיף 6):
 *   · 5-form קנוני (51-char, 37-byte פענוח): [0x80][32-byte secret][4 chk]
 *   · 52-char bitcoin-form (38-byte): [0x80][33-byte body][0x01][4 chk]
 *     → סקאלר = (גוף-33 mod n) — סמנטיקת-steemit "P"+WIF
 * אימות-checksum (b58check) — מפתח-פגום נופל-רם, לא-משתיק.
 */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  const fail = (msg) => { console.error('[steem-pub-derive] ' + msg); process.exit(2); };
  try {
    const wif = raw.trim();
    if (!wif || wif.length < 50) return fail('wif-too-short');
    const { secp256k1 } = require('@noble/curves/secp256k1.js');
    const { sha256 } = require('@noble/hashes/sha2.js');
    const { ripemd160 } = require('@noble/hashes/ripemd160.js');
    const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const b58d = (s) => { let n = 0n; for (const c of s) { const i = A58.indexOf(c); if (i < 0) throw new Error('bad-b58-char'); n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
    const b58e = (b) => { let n = BigInt('0x' + Buffer.from(b).toString('hex')); let o = ''; while (n > 0n) { o = A58[Number(n % 58n)] + o; n /= 58n; } for (const c of b) { if (c === 0) o = '1' + o; else break; } return o; };
    const dec = b58d(wif);
    if (dec.length < 5) return fail('decoded-too-short');
    const payload = dec.subarray(0, dec.length - 4);
    const chk = dec.subarray(dec.length - 4);
    const expect = Buffer.from(sha256(sha256(payload)).slice(0, 4));
    if (!chk.equals(expect)) return fail('b58check-mismatch (corrupt key)');
    let scalar;
    if (dec.length === 38 && dec[0] === 0x80 && dec[33] === 0x01) scalar = Buffer.from((BigInt('0x' + dec.subarray(1, 34).toString('hex')) % N).toString(16).padStart(64, '0'), 'hex');
    else if (dec.length === 37 && dec[0] === 0x80) scalar = dec.subarray(1, 33);
    else return fail('unexpected-wif-form len=' + dec.length);
    const c33 = secp256k1.getPublicKey(scalar, true);
    const cchk = ripemd160(sha256(c33)).slice(0, 4);
    console.log('STM' + b58e(Buffer.concat([c33, cchk])));
  } catch (e) {
    console.error('[steem-pub-derive] error: ' + String(e && e.message).slice(0, 60));
    process.exit(2);
  }
});
