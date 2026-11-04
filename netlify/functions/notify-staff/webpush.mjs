// Web Push for MIC — no dependencies, Node's built-in crypto only.
//
//   VAPID signing ............ RFC 8292  (ES256 JWT, "vapid t=..., k=...")
//   Payload encryption ....... RFC 8291 + RFC 8188 (aes128gcm)
//
// encryptPayload() is checked against the worked example in RFC 8291 §5 in
// webpush.test.mjs, so the bytes it produces are the bytes the standard expects.

import crypto from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(String(str), 'base64url'),
};

const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/**
 * Encrypt one push message for one subscription (RFC 8291, aes128gcm).
 * @param {Buffer|string} plaintext
 * @param {string} uaPublicB64  subscription.keys.p256dh (65-byte uncompressed point)
 * @param {string} authB64      subscription.keys.auth   (16 bytes)
 * @param {object} [fixed]      { asPrivate: Buffer, salt: Buffer } — tests only
 * @returns {Buffer} the request body to POST to the push service
 */
export function encryptPayload(plaintext, uaPublicB64, authB64, fixed = {}) {
  const uaPublic = b64u.dec(uaPublicB64);
  const authSecret = b64u.dec(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');

  const ecdh = crypto.createECDH('prime256v1');
  if (fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();                       // 65 bytes, uncompressed
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188 §2.2 / §2.3: content encryption key and nonce from a fresh salt
  const salt = fixed.salt || crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  // a single record: data, then the 0x02 "last record" delimiter
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // header: salt(16) | record size(4, BE) | key id length(1) | key id = as_public(65)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/** The inverse, used only to prove our own messages decrypt. */
export function decryptPayload(body, uaPrivate, uaPublicB64, authB64) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = b64u.dec(uaPublicB64);
  const ikm = hkdf(ecdh.computeSecret(asPublic), b64u.dec(authB64),
                   Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;                  // strip any zero padding
  if (padded[end] !== 0x02) throw new Error('missing last-record delimiter');
  return padded.subarray(0, end);
}

/**
 * VAPID Authorization header for one push service (RFC 8292).
 * @param {string} endpoint      the subscription endpoint URL
 * @param {string} publicB64     65-byte uncompressed P-256 public key, base64url
 * @param {string} privateB64    32-byte P-256 private scalar, base64url
 * @param {string} subject       "mailto:..." or "https://..."
 */
export function vapidHeader(endpoint, publicB64, privateB64, subject, nowSeconds = Math.floor(Date.now() / 1000)) {
  const pub = b64u.dec(publicB64);
  if (pub.length !== 65) throw new Error('VAPID public key must be 65 bytes');
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privateB64, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const head = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,          // must be under 24 hours
    sub: subject,
  }));
  const unsigned = `${head}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u.enc(sig)}, k=${publicB64}`;
}

/** Push services we are willing to POST to. Anything else is refused. */
const PUSH_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com',          // Chrome, Edge on Android
  'updates.push.services.mozilla.com',                     // Firefox
  'web.push.apple.com',                                    // Safari, iPad home-screen apps
  '.notify.windows.com',                                   // Edge on Windows
];
export function isPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    return PUSH_HOSTS.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  } catch { return false; }
}

/**
 * Send one message to one subscription.
 * @returns {Promise<{status:number, gone:boolean}>}
 */
export async function sendPush(sub, payloadObj, vapid, { urgency = 'normal', ttl = 86400, fetchImpl = fetch } = {}) {
  if (!isPushEndpoint(sub.endpoint)) return { status: 0, gone: true };
  const body = encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  // 404 and 410 mean the subscription no longer exists and should be forgotten
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
