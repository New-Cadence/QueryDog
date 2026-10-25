// Login for Convoy. Users come from the `auth:` section of
// querydog.yml with scrypt password hashes:
//
//   auth:
//     users:
//       - username: admin
//         password_hash: "scrypt$16384$<salt>$<hash>"   # npm run hash-password -- <password>
//
// With no users configured the app stays open, as before. A signed session
// cookie (HMAC-SHA256) keeps people logged in; the signing secret lives in the
// SQLite database so sessions survive restarts. In-process callers (the backend
// scheduler) send INTERNAL_TOKEN instead of a cookie.
import crypto from 'crypto';
import { getDb } from './db.js';

const COOKIE = 'qd_session';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// Lets the backend call its own API (the scheduler runs checks over HTTP)
export const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
export const INTERNAL_HEADER = 'X-QueryDog-Internal';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, n, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(actual, expected);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function sessionSecret() {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS auth_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM auth_secrets WHERE name = 'session'").get();
  if (row) return row.value;
  const value = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO auth_secrets (name, value) VALUES ('session', ?)").run(value);
  return value;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param {{ readAuthConfig: () => { users?: { username: string, password_hash: string }[] } | null }} opts
 *   Re-read on each request, so editing querydog.yml takes effect without a restart.
 */
export function createAuth({ readAuthConfig }) {
  const secret = sessionSecret();
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  const users = () => {
    const list = readAuthConfig()?.users;
    return Array.isArray(list) ? list.filter(u => u && u.username && u.password_hash) : [];
  };
  const enabled = () => users().length > 0;

  // The logged-in username, or null
  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sign(payload), sig)) return null;
    try {
      const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (typeof exp !== 'number' || exp < Date.now()) return null;
      // A user removed from querydog.yml loses access straight away
      return users().some(x => x.username === u) ? u : null;
    } catch {
      return null;
    }
  }

  const setCookie = (req, res, value, maxAgeSeconds) => {
    const secure = req.secure || req.get('X-Forwarded-Proto') === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
  };

  // Every /api route except /api/auth/* needs a session once users are configured
  function middleware(req, res, next) {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth/') || !enabled()) return next();
    if (safeEqual(req.get(INTERNAL_HEADER) || '', INTERNAL_TOKEN)) return next();
    if (sessionUser(req)) return next();
    res.status(401).json({ error: 'Not logged in', type: 'unauthorized' });
  }

  function register(app) {
    app.get('/api/auth/me', (req, res) => {
      res.json({ authEnabled: enabled(), user: enabled() ? sessionUser(req) : null });
    });

    app.post('/api/auth/login', (req, res) => {
      const { username, password } = req.body || {};
      const user = users().find(u => u.username === username);
      // Hash even for unknown users so response time doesn't reveal which names exist
      const ok = verifyPassword(password, user?.password_hash || hashPassword('x')) && !!user;
      if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
      const payload = Buffer.from(JSON.stringify({ u: user.username, exp: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
      setCookie(req, res, `${payload}.${sign(payload)}`, SESSION_DAYS * 86400);
      res.json({ user: user.username });
    });

    app.post('/api/auth/logout', (req, res) => {
      setCookie(req, res, '', 0);
      res.json({ success: true });
    });
  }

  return { middleware, register };
}
