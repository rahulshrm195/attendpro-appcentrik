// Web Push for Cloudflare Workers (no deps): VAPID (RFC 8292) and
// aes128gcm payload encryption (RFC 8291 / RFC 8188), using WebCrypto.
//
// The VAPID key pair is made once by the Worker and kept in Firestore at
// push_config/vapid: the public key in clear (the app needs it to subscribe),
// the private key encrypted with a key derived from the API_KEY secret.

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/** Raw uncompressed P-256 public key (65 bytes) → JWK x/y */
function rawToXY(raw) {
  return { x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

// ── VAPID keys ──

const VAPID_DOC = 'push_config/vapid';

async function wrapKey(apiKey) {
  const bits = await hkdf(enc.encode('attendpro-vapid'), enc.encode(apiKey), enc.encode('vapid-private-key'), 32);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Returns {publicKey (b64url raw), privateJwk}. Makes and stores a new pair
 * when none exists or the stored one can't be opened (API_KEY changed).
 */
export async function ensureVapid(db, apiKey) {
  const wk = await wrapKey(apiKey);
  const doc = await db.get(VAPID_DOC);
  if (doc && doc.data.enc && doc.data.iv) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(doc.data.iv) }, wk, b64urlDecode(doc.data.enc));
      return { publicKey: doc.data.publicKey, privateJwk: JSON.parse(new TextDecoder().decode(plain)) };
    } catch (e) {
      console.warn('Stored VAPID key could not be opened (API_KEY changed?) — making a new one');
    }
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, enc.encode(JSON.stringify(privateJwk)));
  await db.commit([{ set: VAPID_DOC, data: {
    publicKey, enc: b64urlEncode(sealed), iv: b64urlEncode(iv), createdAt: new Date(),
  } }]);
  return { publicKey, privateJwk };
}

/** Signed VAPID JWT for one push service origin */
export async function vapidJwt(vapid, audience, subject, now = Math.floor(Date.now() / 1000)) {
  const head = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...vapid.privateJwk, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return head + '.' + body + '.' + b64urlEncode(sig);
}

// ── Payload encryption (RFC 8291) ──

/**
 * @param {{p256dh:string, auth:string}} keys  from the browser subscription
 * @param {Uint8Array} plaintext
 * @param {object} [fixed]  test only: {asPrivate (b64url d), asPublic (b64url raw), salt (b64url)}
 */
export async function encryptPayload(keys, plaintext, fixed) {
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  let asPrivateKey, asPublic;
  if (fixed) {
    asPublic = b64urlDecode(fixed.asPublic);
    asPrivateKey = await crypto.subtle.importKey('jwk',
      { kty: 'EC', crv: 'P-256', d: fixed.asPrivate, ...rawToXY(asPublic), ext: true },
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivateKey = pair.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed ? b64urlDecode(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last (only) record
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic);
  return concat(header, cipher);
}

/**
 * Send one notification. Returns {ok, status, gone} — gone = the subscription
 * no longer exists (404/410) and should be deleted.
 * @param {{endpoint:string, p256dh:string, auth:string}} sub
 * @param {object} message  {title, body, tag, url}
 */
export async function sendPush(sub, message, vapid, { subject, ttl = 86400, urgency = 'high' } = {}) {
  const body = await encryptPayload({ p256dh: sub.p256dh, auth: sub.auth }, enc.encode(JSON.stringify(message)));
  const jwt = await vapidJwt(vapid, new URL(sub.endpoint).origin, subject);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
