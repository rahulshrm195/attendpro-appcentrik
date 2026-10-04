// Minimal Firestore REST client for Cloudflare Workers (no SDK, no deps).
// Authenticates as a Google service account, so it bypasses security rules:
// every caller of the Worker must already be authorised by the API key.

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class FirestoreError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createFirestore(env) {
  const emulator = env.FIRESTORE_EMULATOR_HOST;
  let sa = null;
  if (!emulator) {
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is not set');
    sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  }
  const projectId = env.FIREBASE_PROJECT_ID || (sa && sa.project_id);
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set');
  const root = `projects/${projectId}/databases/(default)/documents`;
  const base = (emulator ? `http://${emulator}` : 'https://firestore.googleapis.com') + '/v1/';

  async function authHeader() {
    if (emulator) return 'Bearer owner';
    return 'Bearer ' + await getAccessToken(sa);
  }

  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      throw new FirestoreError(res.status, err?.message || res.statusText, err?.status);
    }
    return json;
  }

  const name = (path) => `${root}/${path}`;

  return {
    /** Returns {id, data, updateTime} or null. */
    async get(path) {
      const d = await call('GET', name(path));
      return d ? fromDoc(d) : null;
    },

    /**
     * Query a collection. filters: [[field, op, value], ...] with op one of
     * == != < <= > >= (combined with AND).
     */
    async list(colPath, filters = []) {
      const i = colPath.lastIndexOf('/');
      const parent = i < 0 ? root : name(colPath.slice(0, i));
      const collectionId = colPath.slice(i + 1);
      const structuredQuery = { from: [{ collectionId }] };
      const where = filters.map(([field, op, value]) => ({
        fieldFilter: { field: { fieldPath: field }, op: OPS[op], value: toValue(value) },
      }));
      if (where.length === 1) structuredQuery.where = where[0];
      if (where.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: where } };
      const rows = await call('POST', `${parent}:runQuery`, { structuredQuery });
      return rows.filter((r) => r.document).map((r) => fromDoc(r.document));
    },

    /**
     * Atomic batch. Each write is one of:
     *   {set: path, data, merge?, ifUpdateTime?, ifMissing?}
     *   {delete: path}
     * Fails as a whole (FAILED_PRECONDITION) if a precondition does not hold.
     */
    async commit(writes) {
      const body = {
        writes: writes.map((w) => {
          if (w.delete) return { delete: name(w.delete) };
          const out = { update: { name: name(w.set), fields: toFields(w.data) } };
          if (w.merge) out.updateMask = { fieldPaths: Object.keys(w.data).map(quoteField) };
          if (w.ifUpdateTime) out.currentDocument = { updateTime: w.ifUpdateTime };
          else if (w.ifMissing) out.currentDocument = { exists: false };
          return out;
        }),
      };
      return call('POST', `${root}:commit`, body);
    },

    newId,
  };
}

const OPS = {
  '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL',
};

// Same shape as Firestore's auto IDs
export function newId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let id = '';
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

function quoteField(f) {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(f) ? f : '`' + f.replace(/[`\\]/g, (c) => '\\' + c) + '`';
}

// ── Value conversion ──
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  throw new Error('Unsupported value type: ' + typeof v);
}

function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = toValue(v);
  return fields;
}

export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}

function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v);
  return out;
}

function fromDoc(d) {
  return { id: d.name.split('/').pop(), data: fromFields(d.fields || {}), updateTime: d.updateTime };
}

// ── Service account → OAuth access token (cached per isolate) ──
let tokenCache = null;

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp - 60 > now) return tokenCache.token;
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' +
    enc({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' +
      unsigned + '.' + b64url(new Uint8Array(sig)),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + (json.error_description || json.error || res.status));
  tokenCache = { email: sa.client_email, token: json.access_token, exp: now + (json.expires_in || 3600) };
  return tokenCache.token;
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
