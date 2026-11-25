import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { config } from './config.js';
import {
  listGroups,
  getGroupById,
  createGroup,
  joinGroup,
  leaveGroup,
} from './services/groupService.js';
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

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHomePage(user) {
  const safeEmail = escapeHtml(user?.email || "");
  const safeName = escapeHtml(user?.name || "Student");
  const isAuth = Boolean(user);
  const sessionLabel = isAuth ? "Signed in: " + safeEmail : "Guest / Гост";
  const dotClass = isAuth ? "dot online" : "dot";
  const statSessionText = isAuth ? safeName : "Not signed in";
  const accountSub = isAuth
    ? "Manage your active study session."
    : "Sign in with Google or email/password to create or join groups.";
  const accountBody = user
    ? "<p class=\"muted\">Signed in as <strong>" + safeEmail + "</strong> (" + safeName + ")</p><div class=\"row\"><button class=\"btn-secondary\" type=\"button\" onclick=\"logout()\">Logout / Изход</button></div>"
    : "<div class=\"row\"><a class=\"btn btn-ghost\" href=\"/auth/google\">Sign in with Google / Вход с Google</a></div><hr class=\"divider\" /><div class=\"field-grid\"><input id=\"authName\" type=\"text\" placeholder=\"Name (register) / Име\" aria-label=\"Name\" /><input id=\"authEmail\" type=\"email\" placeholder=\"Email / Имейл\" aria-label=\"Email\" /><input id=\"authPassword\" type=\"password\" placeholder=\"Password (min 6) / Парола\" aria-label=\"Password\" /></div><div class=\"row\"><button class=\"btn-primary\" type=\"button\" onclick=\"loginUser()\">Login / Вход</button><button class=\"btn-secondary\" type=\"button\" onclick=\"registerUser()\">Register / Регистрация</button></div><p id=\"authMsg\" class=\"status-banner\" role=\"status\" aria-live=\"polite\"></p>";
  return ("<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>StudyGroupManager — Учебни групи</title>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />\n  <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\" />\n  <style>\n    :root {\n      --bg: #f4f6fb;\n      --surface: #ffffff;\n      --surface-subtle: #f8fafc;\n      --text: #0f172a;\n      --muted: #475569;\n      --border: #e2e8f0;\n      --primary: #2563eb;\n      --primary-hover: #1d4ed8;\n      --primary-soft: #eff6ff;\n      --success-bg: #ecfdf5;\n      --success-text: #065f46;\n      --success-border: #a7f3d0;\n      --error-bg: #fef2f2;\n      --error-text: #991b1b;\n      --error-border: #fecaca;\n      --warn-bg: #fffbeb;\n      --warn-text: #92400e;\n      --radius: 14px;\n      --radius-sm: 10px;\n      --shadow: 0 10px 25px -12px rgba(15, 23, 42, 0.12), 0 2px 6px -1px rgba(15, 23, 42, 0.06);\n      --shadow-sm: 0 1px 3px rgba(15, 23, 42, 0.06);\n    }\n    * { box-sizing: border-box; }\n    body {\n      margin: 0;\n      font-family: \"Inter\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n      background: radial-gradient(circle at top right, #eef2ff 0%, var(--bg) 48%, #f8fafc 100%);\n      color: var(--text);\n      line-height: 1.55;\n      min-height: 100vh;\n    }\n    :focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }\n    .topbar {\n      position: sticky; top: 0; z-index: 20;\n      background: rgba(255, 255, 255, 0.9);\n      backdrop-filter: blur(12px);\n      border-bottom: 1px solid var(--border);\n    }\n    .topbar-inner {\n      max-width: 1120px; margin: 0 auto; padding: 14px 20px;\n      display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;\n    }\n    .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text); }\n    .brand-mark {\n      width: 38px; height: 38px; border-radius: 10px;\n      background: linear-gradient(135deg, #2563eb, #4f46e5);\n      color: #fff; font-weight: 700; font-size: 0.95rem;\n      display: grid; place-items: center;\n      box-shadow: 0 6px 14px rgba(37, 99, 235, 0.25);\n    }\n    .brand-title { font-weight: 700; font-size: 1.05rem; letter-spacing: -0.015em; }\n    .brand-sub { font-size: 0.78rem; color: var(--muted); }\n    .nav-pills { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }\n    .nav-link {\n      text-decoration: none; color: var(--muted); font-size: 0.88rem; font-weight: 500;\n      padding: 7px 12px; border-radius: 8px; transition: background 0.15s ease, color 0.15s ease;\n    }\n    .nav-link:hover { background: var(--surface-subtle); color: var(--text); }\n    .session-chip {\n      display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px;\n      border-radius: 999px; font-size: 0.82rem; font-weight: 500;\n      border: 1px solid var(--border); background: var(--surface);\n    }\n    .dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }\n    .dot.online { background: #10b981; }\n    .container { max-width: 1120px; margin: 0 auto; padding: 28px 20px 56px; }\n    .hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; flex-wrap: wrap; margin-bottom: 24px; }\n    .hero h1 { margin: 0 0 6px; font-size: clamp(1.55rem, 3vw, 2.15rem); letter-spacing: -0.025em; }\n    .hero p { margin: 0; color: var(--muted); font-size: 0.96rem; }\n    .stats-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px; }\n    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow-sm); }\n    .stat-label { font-size: 0.78rem; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }\n    .stat-value { font-size: 1.45rem; font-weight: 700; margin-top: 4px; letter-spacing: -0.02em; }\n    .layout-grid { display: grid; grid-template-columns: 1.45fr 1fr; gap: 22px; align-items: start; }\n    .stack { display: flex; flex-direction: column; gap: 20px; }\n    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 22px; box-shadow: var(--shadow); }\n    .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }\n    .card h2 { margin: 0; font-size: 1.15rem; letter-spacing: -0.015em; }\n    .card-sub { margin: 2px 0 0; font-size: 0.85rem; color: var(--muted); }\n    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }\n    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 10px; margin-top: 12px; }\n    input, textarea {\n      width: 100%; padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid #cbd5e1;\n      background: var(--surface); color: var(--text); font-family: inherit; font-size: 0.92rem;\n      transition: border-color 0.15s ease, box-shadow 0.15s ease;\n    }\n    input:hover, textarea:hover { border-color: #94a3b8; }\n    input:focus, textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); outline: none; }\n    button, .btn {\n      display: inline-flex; align-items: center; justify-content: center; gap: 6px;\n      padding: 10px 15px; border-radius: var(--radius-sm); border: 1px solid transparent;\n      font-family: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer;\n      text-decoration: none; transition: all 0.15s ease;\n    }\n    button:active, .btn:active { transform: translateY(1px); }\n    .btn-primary { background: var(--primary); color: #ffffff; box-shadow: 0 4px 10px rgba(37, 99, 235, 0.22); }\n    .btn-primary:hover { background: var(--primary-hover); }\n    .btn-secondary { background: var(--surface); color: var(--text); border-color: #cbd5e1; }\n    .btn-secondary:hover { background: var(--surface-subtle); border-color: #94a3b8; }\n    .btn-ghost { background: var(--primary-soft); color: var(--primary); }\n    .btn-ghost:hover { background: #dbeafe; }\n    .btn-sm { padding: 7px 11px; font-size: 0.82rem; border-radius: 8px; }\n    .status-banner { margin-top: 12px; padding: 10px 13px; border-radius: var(--radius-sm); font-size: 0.88rem; font-weight: 500; display: none; }\n    .status-banner.visible { display: block; }\n    .status-banner.info { background: var(--primary-soft); color: #1e40af; border: 1px solid #bfdbfe; }\n    .status-banner.success { background: var(--success-bg); color: var(--success-text); border: 1px solid var(--success-border); }\n    .status-banner.error { background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error-border); }\n    .muted { color: var(--muted); font-size: 0.88rem; }\n    .groups-list { display: grid; gap: 12px; margin-top: 16px; }\n    .group-item {\n      border: 1px solid var(--border); background: var(--surface-subtle); border-radius: var(--radius-sm);\n      padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap;\n    }\n    .group-title { font-weight: 600; font-size: 0.98rem; color: var(--text); }\n    .group-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; align-items: center; }\n    .badge { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; font-size: 0.76rem; font-weight: 600; background: #e2e8f0; color: #334155; }\n    .badge.open { background: var(--success-bg); color: var(--success-text); }\n    .badge.full { background: var(--warn-bg); color: var(--warn-text); }\n    .empty-state { text-align: center; padding: 28px 16px; border: 1px dashed #cbd5e1; border-radius: var(--radius-sm); background: var(--surface-subtle); margin-top: 14px; }\n    .ai-box { margin-top: 14px; padding: 14px; border-radius: var(--radius-sm); background: var(--surface-subtle); border: 1px solid var(--border); font-size: 0.9rem; white-space: pre-wrap; }\n    pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: var(--radius-sm); overflow-x: auto; font-size: 0.8rem; margin-top: 10px; }\n    details summary { cursor: pointer; font-size: 0.82rem; color: var(--muted); margin-top: 10px; user-select: none; }\n    .divider { margin: 16px 0; border: none; border-top: 1px solid var(--border); }\n    @media (max-width: 900px) { .layout-grid { grid-template-columns: 1fr; } .stats-row { grid-template-columns: 1fr; } }\n  </style>\n</head>\n<body>\n  <header class=\"topbar\">\n    <div class=\"topbar-inner\">\n      <a class=\"brand\" href=\"/\">\n        <span class=\"brand-mark\">SG</span>\n        <span>\n          <span class=\"brand-title\">StudyGroupManager</span><br />\n          <span class=\"brand-sub\">Учебни групи и съвместна работа</span>\n        </span>\n      </a>\n      <nav class=\"nav-pills\" aria-label=\"Primary navigation\">\n        <a class=\"nav-link\" href=\"#groups-section\">Groups / Групи</a>\n        <a class=\"nav-link\" href=\"#ai-section\">AI Advisor / Препоръки</a>\n        <span class=\"session-chip\" id=\"sessionStatus\">\n          <span class=\"dot \" + (isAuth ? \"online\" : \"\") + \"></span>\n          <span>__SESSION_LABEL__</span>\n        </span>\n      </nav>\n    </div>\n  </header>\n  <main class=\"container\">\n    <section class=\"hero\">\n      <div>\n        <h1>Collaborative Study Groups</h1>\n        <p>Create study cohorts, track seat capacity, and get AI-assisted study group recommendations.</p>\n      </div>\n    </section>\n    <section class=\"stats-row\" aria-label=\"Workspace summary\">\n      <div class=\"stat-card\">\n        <div class=\"stat-label\">Active Groups / Групи</div>\n        <div class=\"stat-value\" id=\"statGroupsCount\">—</div>\n      </div>\n      <div class=\"stat-card\">\n        <div class=\"stat-label\">Total Seats / Места</div>\n        <div class=\"stat-value\" id=\"statSeatsCount\">—</div>\n      </div>\n      <div class=\"stat-card\">\n        <div class=\"stat-label\">Session / Сесия</div>\n        <div class=\"stat-value\" style=\"font-size: 1.05rem; margin-top: 8px;\">__STAT_SESSION__</div>\n      </div>\n    </section>\n    <div class=\"layout-grid\">\n      <div class=\"stack\">\n        <section class=\"card\" id=\"groups-section\">\n          <div class=\"card-header\">\n            <div>\n              <h2>Study Groups / Учебни групи</h2>\n              <p class=\"card-sub\">Browse open study groups, create a new cohort, or manage membership.</p>\n            </div>\n            <button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"loadGroups()\">Refresh / Обнови</button>\n          </div>\n          <div class=\"field-grid\">\n            <input id=\"groupTitle\" type=\"text\" placeholder=\"Group title / Заглавие\" aria-label=\"Group title\" />\n            <input id=\"groupSubject\" type=\"text\" placeholder=\"Subject / Предмет\" aria-label=\"Subject\" />\n            <input id=\"groupCapacity\" type=\"number\" min=\"1\" placeholder=\"Max capacity / Капацитет\" aria-label=\"Max capacity\" />\n          </div>\n          <div class=\"row\">\n            <button class=\"btn-primary\" type=\"button\" onclick=\"createNewGroup()\">Create Group / Създай група</button>\n          </div>\n          <hr class=\"divider\" />\n          <div class=\"row\">\n            <input id=\"membershipGroupId\" type=\"number\" min=\"1\" placeholder=\"Group ID / ID на група\" aria-label=\"Group ID\" style=\"max-width: 190px;\" />\n            <button class=\"btn-secondary\" type=\"button\" onclick=\"joinSelectedGroup()\">Join Group / Включи се</button>\n            <button class=\"btn-secondary\" type=\"button\" onclick=\"leaveSelectedGroup()\">Leave Group / Напусни</button>\n          </div>\n          <p id=\"groupMsg\" class=\"status-banner\" role=\"status\" aria-live=\"polite\"></p>\n          <div id=\"groupsCards\" class=\"groups-list\" aria-live=\"polite\">\n            <div class=\"empty-state\">Loading groups... / Зареждане на групите...</div>\n          </div>\n          <details>\n            <summary>Raw JSON / Технически отговор</summary>\n            <pre id=\"groupsOutput\">Loading... / Зареждане...</pre>\n          </details>\n        </section>\n      </div>\n      <div class=\"stack\">\n        <section class=\"card\" id=\"account-section\">\n          <div class=\"card-header\">\n            <div>\n              <h2>Account &amp; Session / Профил</h2>\n              <p class=\"card-sub\">__ACCOUNT_SUB__</p>\n            </div>\n          </div>\n          \" + (user\n            ? \"<p class=\\\"muted\\\">Signed in as <strong>\" + safeEmail + \"</strong> (\" + safeName + \")</p><div class=\\\"row\\\"><button class=\\\"btn-secondary\\\" type=\\\"button\\\" onclick=\\\"logout()\\\">Logout / Изход</button></div>\"\n            : \"<div class=\\\"row\\\"><a class=\\\"btn btn-ghost\\\" href=\\\"/auth/google\\\">Sign in with Google / Вход с Google</a></div><hr class=\\\"divider\\\" /><div class=\\\"field-grid\\\"><input id=\\\"authName\\\" type=\\\"text\\\" placeholder=\\\"Name (register) / Име\\\" aria-label=\\\"Name\\\" /><input id=\\\"authEmail\\\" type=\\\"email\\\" placeholder=\\\"Email / Имейл\\\" aria-label=\\\"Email\\\" /><input id=\\\"authPassword\\\" type=\\\"password\\\" placeholder=\\\"Password (min 6) / Парола\\\" aria-label=\\\"Password\\\" /></div><div class=\\\"row\\\"><button class=\\\"btn-primary\\\" type=\\\"button\\\" onclick=\\\"loginUser()\\\">Login / Вход</button><button class=\\\"btn-secondary\\\" type=\\\"button\\\" onclick=\\\"registerUser()\\\">Register / Регистрация</button></div><p id=\\\"authMsg\\\" class=\\\"status-banner\\\" role=\\\"status\\\" aria-live=\\\"polite\\\"></p>\")\n        </section>\n        <section class=\"card\" id=\"ai-section\">\n          <div class=\"card-header\">\n            <div>\n              <h2>AI Study Recommendations / AI препоръки</h2>\n              <p class=\"card-sub\">Get tailored study suggestions based on your topic, schedule, or level.</p>\n            </div>\n          </div>\n          <input id=\"prefsInput\" type=\"text\" placeholder=\"Topic, schedule, level / Тема, график, ниво\" aria-label=\"Study preferences\" />\n          <div class=\"row\">\n            <button class=\"btn-primary\" type=\"button\" onclick=\"getRecommendations()\">Get Recommendations / Вземи препоръки</button>\n          </div>\n          <div id=\"aiFormatted\" class=\"ai-box\" aria-live=\"polite\">Enter preferences above. / Въведете предпочитания по-горе.</div>\n          <details>\n            <summary>Raw AI response / Суров отговор</summary>\n            <pre id=\"aiOutput\">Enter preferences above. / Въведете предпочитания по-горе.</pre>\n          </details>\n        </section>\n      </div>\n    </div>\n  </main>\n  <script>\n    function setBanner(elId, message, type = \"info\") {\n      const el = document.getElementById(elId);\n      if (!el) return;\n      if (!message) { el.textContent = \"\"; el.className = \"status-banner\"; return; }\n      el.textContent = message;\n      el.className = \"status-banner visible \" + type;\n    }\n    async function loginUser() {\n      setBanner(\"authMsg\", \"Signing in...\", \"info\");\n      const email = document.getElementById(\"authEmail\").value;\n      const password = document.getElementById(\"authPassword\").value;\n      try {\n        const res = await fetch(\"/auth/login\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ email, password }) });\n        const data = await res.json();\n        if (res.ok) { setBanner(\"authMsg\", \"Signed in successfully.\", \"success\"); location.reload(); }\n        else { setBanner(\"authMsg\", data.error || \"Login failed\", \"error\"); }\n      } catch { setBanner(\"authMsg\", \"Network error while signing in.\", \"error\"); }\n    }\n    async function registerUser() {\n      setBanner(\"authMsg\", \"Creating account...\", \"info\");\n      const name = document.getElementById(\"authName\").value;\n      const email = document.getElementById(\"authEmail\").value;\n      const password = document.getElementById(\"authPassword\").value;\n      try {\n        const res = await fetch(\"/auth/register\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ name, email, password }) });\n        const data = await res.json();\n        if (res.ok) { setBanner(\"authMsg\", \"Registered successfully.\", \"success\"); location.reload(); }\n        else { setBanner(\"authMsg\", data.error || \"Registration failed\", \"error\"); }\n      } catch { setBanner(\"authMsg\", \"Network error while registering.\", \"error\"); }\n    }\n    async function logout() { await fetch(\"/auth/logout\", { method: \"POST\" }); location.reload(); }\n    function renderGroupCards(groups) {\n      const container = document.getElementById(\"groupsCards\");\n      container.textContent = \"\";\n      const countEl = document.getElementById(\"statGroupsCount\");\n      const seatsEl = document.getElementById(\"statSeatsCount\");\n      if (countEl) countEl.textContent = String(groups.length);\n      if (seatsEl) {\n        const totalCap = groups.reduce((acc, g) => acc + (Number(g.max_capacity) || 0), 0);\n        seatsEl.textContent = String(totalCap);\n      }\n      if (!groups.length) {\n        const empty = document.createElement(\"div\");\n        empty.className = \"empty-state\";\n        empty.textContent = \"No study groups yet. Create the first one above.\";\n        container.appendChild(empty);\n        return;\n      }\n      for (const g of groups) {\n        const item = document.createElement(\"div\");\n        item.className = \"group-item\";\n        const info = document.createElement(\"div\");\n        const title = document.createElement(\"div\");\n        title.className = \"group-title\";\n        title.textContent = \"#\" + g.id + \" · \" + (g.title || \"Untitled Group\");\n        const meta = document.createElement(\"div\");\n        meta.className = \"group-meta\";\n        const subjBadge = document.createElement(\"span\");\n        subjBadge.className = \"badge\";\n        subjBadge.textContent = g.subject || \"General\";\n        const membersCount = Number(g.member_count ?? g.current_members ?? 0);\n        const capCount = Number(g.max_capacity ?? 0);\n        const isFull = capCount > 0 && membersCount >= capCount;\n        const capBadge = document.createElement(\"span\");\n        capBadge.className = \"badge \" + (isFull ? \"full\" : \"open\");\n        capBadge.textContent = capCount > 0 ? (membersCount + \"/\" + capCount + \" members\") : (membersCount + \" members\");\n        meta.appendChild(subjBadge);\n        meta.appendChild(capBadge);\n        info.appendChild(title);\n        info.appendChild(meta);\n        const actions = document.createElement(\"div\");\n        actions.className = \"row\";\n        actions.style.marginTop = \"0\";\n        const selectBtn = document.createElement(\"button\");\n        selectBtn.type = \"button\";\n        selectBtn.className = \"btn-secondary btn-sm\";\n        selectBtn.textContent = \"Select ID\";\n        selectBtn.onclick = () => { const idInput = document.getElementById(\"membershipGroupId\"); if (idInput) idInput.value = String(g.id); };\n        const joinBtn = document.createElement(\"button\");\n        joinBtn.type = \"button\";\n        joinBtn.className = \"btn-primary btn-sm\";\n        joinBtn.textContent = \"Join\";\n        joinBtn.disabled = isFull;\n        joinBtn.onclick = async () => { const idInput = document.getElementById(\"membershipGroupId\"); if (idInput) idInput.value = String(g.id); await joinSelectedGroup(); };\n        actions.appendChild(selectBtn);\n        actions.appendChild(joinBtn);\n        item.appendChild(info);\n        item.appendChild(actions);\n        container.appendChild(item);\n      }\n    }\n    async function loadGroups() {\n      const container = document.getElementById(\"groupsCards\");\n      if (container) {\n        container.textContent = \"\";\n        const loading = document.createElement(\"div\");\n        loading.className = \"empty-state\";\n        loading.textContent = \"Loading groups... / Зареждане на групите...\";\n        container.appendChild(loading);\n      }\n      try {\n        const res = await fetch(\"/api/groups\");\n        const data = await res.json();\n        document.getElementById(\"groupsOutput\").textContent = JSON.stringify(data, null, 2);\n        const list = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : []);\n        renderGroupCards(list);\n      } catch { setBanner(\"groupMsg\", \"Failed to load study groups.\", \"error\"); }\n    }\n    async function createNewGroup() {\n      setBanner(\"groupMsg\", \"Saving group...\", \"info\");\n      const title = document.getElementById(\"groupTitle\").value;\n      const subject = document.getElementById(\"groupSubject\").value;\n      const max_capacity = Number(document.getElementById(\"groupCapacity\").value);\n      try {\n        const res = await fetch(\"/api/groups\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ title, subject, max_capacity }) });\n        const data = await res.json();\n        if (res.ok) { setBanner(\"groupMsg\", \"Created / Създадена: #\" + data.group.id, \"success\"); } else { setBanner(\"groupMsg\", data.error || \"Error\", \"error\"); }\n        await loadGroups();\n      } catch { setBanner(\"groupMsg\", \"Network error while creating group.\", \"error\"); }\n    }\n    async function joinSelectedGroup() {\n      const groupId = Number(document.getElementById(\"membershipGroupId\").value);\n      if (!groupId) { setBanner(\"groupMsg\", \"Please enter or select a valid Group ID.\", \"error\"); return; }\n      setBanner(\"groupMsg\", \"Joining group #\" + groupId + \"...\", \"info\");\n      try {\n        const res = await fetch(\"/api/groups/\" + groupId + \"/join\", { method: \"POST\" });\n        const data = await res.json();\n        setBanner(\"groupMsg\", res.ok ? (data.message || \"Joined group.\") : (data.error || \"Error\"), res.ok ? \"success\" : \"error\");\n        await loadGroups();\n      } catch { setBanner(\"groupMsg\", \"Network error while joining group.\", \"error\"); }\n    }\n    async function leaveSelectedGroup() {\n      const groupId = Number(document.getElementById(\"membershipGroupId\").value);\n      if (!groupId) { setBanner(\"groupMsg\", \"Please enter or select a valid Group ID.\", \"error\"); return; }\n      setBanner(\"groupMsg\", \"Leaving group #\" + groupId + \"...\", \"info\");\n      try {\n        const res = await fetch(\"/api/groups/\" + groupId + \"/leave\", { method: \"POST\" });\n        const data = await res.json();\n        setBanner(\"groupMsg\", res.ok ? (data.message || \"Left group.\") : (data.error || \"Error\"), res.ok ? \"success\" : \"error\");\n        await loadGroups();\n      } catch { setBanner(\"groupMsg\", \"Network error while leaving group.\", \"error\"); }\n    }\n    async function getRecommendations() {\n      const formattedEl = document.getElementById(\"aiFormatted\");\n      if (formattedEl) formattedEl.textContent = \"Generating recommendations... / Генериране на препоръки...\";\n      const preferences = document.getElementById(\"prefsInput\").value || \"Web Programming\";\n      try {\n        const res = await fetch(\"/api/recommendations\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ preferences }) });\n        const data = await res.json();\n        document.getElementById(\"aiOutput\").textContent = JSON.stringify(data, null, 2);\n        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.recommendation || data?.message || \"Recommendations received.\";\n        if (formattedEl) formattedEl.textContent = String(text);\n      } catch { if (formattedEl) formattedEl.textContent = \"Could not load recommendations right now.\"; }\n    }\n    loadGroups();\n  </script>\n</body>\n</html>")
    .replace("__DOT_CLASS__", dotClass)
    .replace("__SESSION_LABEL__", sessionLabel)
    .replace("__STAT_SESSION__", statSessionText)
    .replace("__ACCOUNT_SUB__", accountSub)
    .replace("__ACCOUNT_BODY__", accountBody);
}// Main HTTP server / Основен HTTP сървър
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

    // Join study group (authenticated members only, 409 if full)
    // Включване в група (само за влезли потребители, 409 при пълен капацитет)
    if (req.method === 'POST' && /^\/api\/groups\/\d+\/join$/.test(url.pathname)) {
      if (!session?.user) {
        return sendJson(res, 401, {
          error: 'Unauthorized / Неоторизиран достъп',
        });
      }
      const groupId = Number(url.pathname.split('/')[3]);
      const userId = Number(session.user.id) || 1;
      try {
        const updatedGroup = await joinGroup(groupId, userId);
        return sendJson(res, 200, {
          message: 'Joined study group / Успешно се включихте в групата',
          group: updatedGroup,
        });
      } catch (err) {
        if (err.code === 'GROUP_FULL') {
          return sendJson(res, 409, { error: 'This group is full' });
        }
        if (err.code === 'GROUP_NOT_FOUND') {
          return sendJson(res, 404, { error: 'Group not found / Групата не е намерена' });
        }
        throw err;
      }
    }

    // Leave study group (authenticated members only)
    // Напускане на група (само за влезли потребители)
    if (req.method === 'POST' && /^\/api\/groups\/\d+\/leave$/.test(url.pathname)) {
      if (!session?.user) {
        return sendJson(res, 401, {
          error: 'Unauthorized / Неоторизиран достъп',
        });
      }
      const groupId = Number(url.pathname.split('/')[3]);
      const userId = Number(session.user.id) || 1;
      const group = await getGroupById(groupId);
      if (!group) {
        return sendJson(res, 404, { error: 'Group not found / Групата не е намерена' });
      }
      const updatedGroup = await leaveGroup(groupId, userId);
      return sendJson(res, 200, {
        message: 'Left study group / Напуснахте групата',
        group: updatedGroup,
      });
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