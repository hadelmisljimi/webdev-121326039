import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { config } from './config.js';
import { listGroups, getGroupById, createGroup } from './services/groupService.js';
import { getStudyRecommendations } from './services/aiService.js';

const { Pool } = pg;
// Connection pool for Neon PostgreSQL / Пул от връзки към Neon PostgreSQL
const pool = new Pool({ connectionString: config.databaseUrl });

const SESSION_COOKIE_NAME = 'sgm_session';

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    ...extraHeaders,
  });
  res.end(html);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, {
    Location: location,
    ...extraHeaders,
  });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const map = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    map[key] = decodeURIComponent(val);
  }
  return map;
}

function signPayload(obj) {
  const encoded = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function buildSessionCookie(req, payload, maxAgeSeconds = 60 * 60 * 24 * 7) {
  const token = signPayload({
    ...payload,
    exp: Date.now() + maxAgeSeconds * 1000,
  });
  const isHttps =
    config.publicBaseUrl.startsWith('https://') ||
    req.headers['x-forwarded-proto'] === 'https';

  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const isHttps =
    config.publicBaseUrl.startsWith('https://') ||
    req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT,
      google_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function hasGoogleOAuth() {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

async function findOrLinkGoogleUser({ email, name, googleSub }) {
  await ensureUsersTable();
  const normalizedEmail = email.trim().toLowerCase();

  const existingRes = await pool.query(
    'SELECT id, email, name, google_id FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [normalizedEmail]
  );

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    if (existing.google_id !== googleSub) {
      await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [
        googleSub,
        existing.id,
      ]);
    }
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name || name || normalizedEmail,
      authProvider: 'google',
    };
  }

  const insertedRes = await pool.query(
    `INSERT INTO users (email, name, google_id)
     VALUES ($1, $2, $3)
     RETURNING id, email, name`,
    [normalizedEmail, name || normalizedEmail, googleSub]
  );
  const created = insertedRes.rows[0];
  return {
    id: created.id,
    email: created.email,
    name: created.name,
    authProvider: 'google',
  };
}

function renderHomePage(user) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>StudyGroupManager — Учебни групи</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 780px; margin: 36px auto; padding: 0 16px; line-height: 1.5; }
    .card { border: 1px solid #d1d5db; border-radius: 8px; padding: 18px; margin-bottom: 16px; }
    input, textarea, button { padding: 8px 12px; margin: 4px 0; }
    .muted { color: #4b5563; font-size: 0.9rem; }
    pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>StudyGroupManager</h1>
  <p class="muted">University Study Groups & Collaboration / Учебни групи и съвместна работа</p>

  <div class="card">
    ${
      user
        ? `<p>Signed in as <strong>${user.email}</strong> (${user.name || 'Student'})</p>
           <button onclick="logout()">Logout / Изход</button>`
        : `<p>Not signed in / Не сте влезли в профила си.</p>
           <a href="/auth/google"><button type="button">Sign in with Google / Вход с Google</button></a>`
    }
  </div>

  <div class="card">
    <h2>Study Groups / Учебни групи</h2>
    <button onclick="loadGroups()">Refresh Groups / Обнови групите</button>
    <pre id="groupsOutput">Loading... / Зареждане...</pre>
  </div>

  <div class="card">
    <h2>AI Study Recommendations / AI препоръки</h2>
    <input id="prefsInput" type="text" placeholder="Topic, schedule, level / Тема, график, ниво" style="width: 100%; box-sizing: border-box;" />
    <button onclick="getRecommendations()">Get Recommendations / Вземи препоръки</button>
    <pre id="aiOutput">Enter preferences above. / Въведете предпочитания по-горе.</pre>
  </div>

  <script>
    async function logout() {
      await fetch('/auth/logout', { method: 'POST' });
      location.reload();
    }
    async function loadGroups() {
      const res = await fetch('/api/groups');
      const data = await res.json();
      document.getElementById('groupsOutput').textContent = JSON.stringify(data, null, 2);
    }
    async function getRecommendations() {
      const preferences = document.getElementById('prefsInput').value || 'Web Programming';
      const res = await fetch('/api/recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences })
      });
      const data = await res.json();
      document.getElementById('aiOutput').textContent = JSON.stringify(data, null, 2);
    }
    loadGroups();
  </script>
</body>
</html>`;
}

// Main HTTP server / Основен HTTP сървър
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', config.publicBaseUrl);
  const cookies = parseCookies(req);
  const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);

  try {
    // Health check endpoint / Проверка на състоянието и базата данни
    if (req.method === 'GET' && url.pathname === '/health') {
      try {
        await pool.query('SELECT 1');
        return sendJson(res, 200, {
          status: 'ok',
          db: 'connected',
          message: 'Service healthy / Услугата работи нормално',
        });
      } catch (dbErr) {
        console.error('Health check DB error / Грешка при проверка на БД:', dbErr.message);
        return sendJson(res, 503, {
          status: 'error',
          db: 'disconnected',
          message: 'Database unavailable / Базата данни е недостъпна',
        });
      }
    }

    // List study groups / Списък с учебни групи
    if (req.method === 'GET' && url.pathname === '/api/groups') {
      const groups = await listGroups();
      return sendJson(res, 200, { groups });
    }

    // Get group by id / Детайли за учебна група по ID
    if (req.method === 'GET' && url.pathname.startsWith('/api/groups/')) {
      const idParam = url.pathname.replace('/api/groups/', '').trim();
      const id = Number(idParam);
      if (!Number.isInteger(id) || id <= 0) {
        return sendJson(res, 400, { error: 'Invalid group ID / Невалидно ID на група' });
      }
      const group = await getGroupById(id);
      if (!group) {
        return sendJson(res, 404, { error: 'Group not found / Групата не е намерена' });
      }
      return sendJson(res, 200, { group });
    }

    // Create study group (authenticated members only) / Създаване на група (само за влезли потребители)
    if (req.method === 'POST' && url.pathname === '/api/groups') {
      if (!session?.user) {
        return sendJson(res, 401, {
          error: 'Unauthorized / Неоторизиран достъп',
        });
      }
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const subject = String(body.subject || '').trim();
      const maxCapacity = Number(body.max_capacity);

      if (!title || !subject || !Number.isInteger(maxCapacity) || maxCapacity <= 0) {
        return sendJson(res, 400, {
          error:
            'title, subject, and positive integer max_capacity are required / Изискват се title, subject и положителен max_capacity',
        });
      }

      const created = await createGroup({
        title,
        subject,
        max_capacity: maxCapacity,
        creator: session.user.email || session.user.id,
      });
      return sendJson(res, 201, { group: created });
    }

    // AI study recommendations with fallback / AI препоръки с резервен вариант
    if (req.method === 'POST' && url.pathname === '/api/recommendations') {
      const body = await readJsonBody(req);
      const preferences = String(body.preferences || '').trim() || 'General study groups';
      const recommendation = await getStudyRecommendations(preferences);
      return sendJson(res, 200, { recommendation });
    }

    // Local registration / Локална регистрация с имейл и парола
    if (req.method === 'POST' && url.pathname === '/auth/register') {
      await ensureUsersTable();
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim() || email.split('@')[0];

      if (!email || !email.includes('@') || password.length < 6) {
        return sendJson(res, 400, {
          error:
            'Valid email and password (min 6 chars) required / Изискват се валиден имейл и парола (мин. 6 символа)',
        });
      }

      const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
      if (existing.rows.length > 0) {
        return sendJson(res, 409, {
          error: 'Email already registered / Имейлът вече е регистриран',
        });
      }

      const passwordHash = hashPassword(password);
      const inserted = await pool.query(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, name`,
        [email, name, passwordHash]
      );
      const user = { ...inserted.rows[0], authProvider: 'local' };
      return sendJson(
        res,
        201,
        { message: 'Registered successfully / Успешна регистрация', user },
        { 'Set-Cookie': buildSessionCookie(req, { user }) }
      );
    }

    // Local login / Локален вход с имейл и парола
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      await ensureUsersTable();
      const body = await readJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      const found = await pool.query(
        'SELECT id, email, name, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1',
        [email]
      );
      const row = found.rows[0];
      if (!row || !verifyPassword(password, row.password_hash)) {
        return sendJson(res, 401, {
          error: 'Invalid credentials / Невалидни данни за вход',
        });
      }

      const user = { id: row.id, email: row.email, name: row.name, authProvider: 'local' };
      return sendJson(
        res,
        200,
        { message: 'Logged in / Успешен вход', user },
        { 'Set-Cookie': buildSessionCookie(req, { user }) }
      );
    }

    // Current session user / Текущ потребител от сесията
    if (req.method === 'GET' && url.pathname === '/auth/me') {
      if (!session || !session.user) {
        return sendJson(res, 401, {
          authenticated: false,
          error: 'Unauthorized / Неоторизиран достъп',
        });
      }
      return sendJson(res, 200, {
        authenticated: true,
        user: session.user,
      });
    }

    // Logout route / Изход от сесията
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      return sendJson(
        res,
        200,
        { message: 'Logged out / Излязохте успешно' },
        { 'Set-Cookie': clearSessionCookie(req) }
      );
    }

    // Start Google OAuth flow / Начало на Google OAuth автентикация
    if (req.method === 'GET' && url.pathname === '/auth/google') {
      if (!hasGoogleOAuth()) {
        return sendJson(res, 501, {
          error:
            'Google OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET) / Google OAuth не е конфигуриран',
        });
      }

      const state = crypto.randomBytes(24).toString('hex');
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', config.googleClientId);
      authUrl.searchParams.set('redirect_uri', config.googleCallbackUrl);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', state);

      return redirect(res, authUrl.toString(), {
        'Set-Cookie': buildSessionCookie(req, { oauthState: state }, 600),
      });
    }

    // Google OAuth callback / Обработка на отговора от Google OAuth
    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      if (!hasGoogleOAuth()) {
        return sendJson(res, 501, {
          error: 'Google OAuth is not configured / Google OAuth не е конфигуриран',
        });
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state || !session?.oauthState || state !== session.oauthState) {
        return sendJson(res, 400, {
          error: 'Invalid or expired OAuth state / Невалидно или изтекло OAuth състояние',
        });
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.googleClientId,
          client_secret: config.googleClientSecret,
          redirect_uri: config.googleCallbackUrl,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenRes.ok) {
        console.error('Google token exchange failed / Грешка при размяна на токен с Google');
        return sendJson(res, 502, {
          error: 'Failed to authenticate with Google / Неуспешна автентикация през Google',
        });
      }

      const tokenData = await tokenRes.json();
      const userInfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (!userInfoRes.ok) {
        return sendJson(res, 502, {
          error: 'Failed to fetch Google user profile / Неуспешно извличане на профил от Google',
        });
      }

      const profile = await userInfoRes.json();
      if (!profile.email) {
        return sendJson(res, 400, {
          error: 'Google account email is missing / Липсва имейл адрес в Google профила',
        });
      }

      const user = await findOrLinkGoogleUser({
        email: profile.email,
        name: profile.name,
        googleSub: profile.sub,
      });

      return redirect(res, '/', {
        'Set-Cookie': buildSessionCookie(req, { user }),
      });
    }

    // Home UI page / Начална HTML страница
    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderHomePage(session?.user || null));
    }

    // 404 Not Found / 404 Не е намерено
    return sendJson(res, 404, {
      error: 'Not found / Не е намерено',
      path: url.pathname,
    });
  } catch (err) {
    if (err.message === 'Invalid JSON body' || err.message === 'Payload too large') {
      return sendJson(res, 400, {
        error: 'Invalid request body / Невалидно тяло на заявката',
      });
    }
    // 500 Internal Server Error without leaking internals
    // 500 Вътрешна грешка на сървъра без изтичане на вътрешни детайли
    console.error('Server error / Грешка на сървъра:', err.message);
    return sendJson(res, 500, {
      error: 'Internal server error / Вътрешна грешка на сървъра',
    });
  }
});

server.listen(config.port, () => {
  console.log(
    `Server listening on http://localhost:${config.port} | Сървърът слуша на порт ${config.port}`
  );
});