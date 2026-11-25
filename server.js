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
  const css = "\n" +
    "    :root { --bg: #f4f7fb; --surface: #ffffff; --surface-alt: #f8fafc; --text: #0f172a; --muted: #475569; --subtle: #64748b; --border: #e2e8f0; --border-strong: #cbd5e1; --primary: #2563eb; --primary-hover: #1d4ed8; --primary-soft: #eff6ff; --accent-indigo: #4f46e5; --accent-teal: #0d9488; --success-bg: #ecfdf5; --success-text: #065f46; --success-border: #a7f3d0; --error-bg: #fef2f2; --error-text: #991b1b; --error-border: #fecaca; --warn-bg: #fffbeb; --warn-text: #92400e; --radius: 16px; --radius-sm: 10px; --shadow: 0 14px 34px -16px rgba(15, 23, 42, 0.14), 0 4px 12px -4px rgba(15, 23, 42, 0.05); }\n" +
    "    * { box-sizing: border-box; }\n" +
    "    body { margin: 0; font-family: \"Inter\", system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; background: radial-gradient(circle at top left, #e0e7ff 0%, var(--bg) 42%, var(--bg) 100%); color: var(--text); line-height: 1.5; min-height: 100vh; }\n" +
    "    :focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }\n" +
    "    .topbar { position: sticky; top: 0; z-index: 30; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }\n" +
    "    .topbar-inner { max-width: 1080px; margin: 0 auto; padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }\n" +
    "    .brand { display: flex; align-items: center; gap: 11px; text-decoration: none; color: var(--text); }\n" +
    "    .brand-mark { width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(135deg, #2563eb, #4f46e5); color: #ffffff; font-weight: 700; font-size: 0.9rem; display: grid; place-items: center; box-shadow: 0 6px 14px rgba(37, 99, 235, 0.24); }\n" +
    "    .brand-title { font-weight: 700; font-size: 1rem; letter-spacing: -0.015em; display: block; }\n" +
    "    .brand-sub { font-size: 0.75rem; color: var(--subtle); display: block; }\n" +
    "    .nav-group { display: flex; align-items: center; gap: 12px; position: relative; }\n" +
    "    .session-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 0.8rem; font-weight: 500; border: 1px solid var(--border); background: var(--surface); color: var(--text); white-space: nowrap; }\n" +
    "    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; flex-shrink: 0; }\n" +
    "    .status-dot.active { background: #10b981; }\n" +
    "    .account-trigger { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; background: transparent; border: none; padding: 2px 6px; cursor: pointer; }\n" +
    "    .account-badge { width: 34px; height: 34px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.88rem; transition: transform 0.14s ease, box-shadow 0.14s ease; }\n" +
    "    .account-badge.guest { background: #2563eb; color: #ffffff; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); }\n" +
    "    .account-badge.auth { background: linear-gradient(135deg, #0d9488, #4f46e5); color: #ffffff; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.28); }\n" +
    "    .account-trigger:hover .account-badge { transform: translateY(-1px); }\n" +
    "    .account-caption { font-size: 0.68rem; font-weight: 600; color: var(--muted); line-height: 1.15; white-space: nowrap; }\n" +
    "    .account-popover { display: none; position: absolute; right: 0; top: 54px; width: 325px; max-width: calc(100vw - 32px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; z-index: 50; }\n" +
    "    .account-popover.open { display: block; }\n" +
    "    .popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }\n" +
    "    .popover-title { font-weight: 700; font-size: 0.96rem; color: var(--text); }\n" +
    "    .popover-close { background: transparent; border: none; color: var(--subtle); font-size: 1.15rem; padding: 2px 6px; cursor: pointer; line-height: 1; }\n" +
    "    .popover-close:hover { color: var(--text); }\n" +
    "    .container { max-width: 1080px; margin: 0 auto; padding: 40px 24px 64px; }\n" +
    "    .hero { margin-bottom: 28px; }\n" +
    "    .hero h1 { margin: 0 0 6px; font-size: clamp(1.65rem, 3vw, 2.15rem); font-weight: 700; letter-spacing: -0.025em; }\n" +
    "    .hero p { margin: 0; color: var(--muted); font-size: 0.95rem; }\n" +
    "    .hub-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }\n" +
    "    .hub-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 26px; box-shadow: var(--shadow); display: flex; flex-direction: column; justify-content: space-between; gap: 20px; cursor: pointer; transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease; text-align: left; }\n" +
    "    .hub-card:hover { transform: translateY(-2px); border-color: #93c5fd; }\n" +
    "    .hub-icon { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; margin-bottom: 14px; }\n" +
    "    .hub-icon.groups { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }\n" +
    "    .hub-icon.ai { background: #eef2ff; color: #4f46e5; border: 1px solid #c7d2fe; }\n" +
    "    .hub-title { margin: 0 0 6px; font-size: 1.24rem; font-weight: 700; letter-spacing: -0.015em; color: var(--text); }\n" +
    "    .hub-desc { margin: 0; font-size: 0.9rem; color: var(--muted); }\n" +
    "    .hub-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 14px; border-top: 1px solid var(--border); }\n" +
    "    .hub-stat { font-size: 0.82rem; font-weight: 600; color: var(--muted); }\n" +
    "    .field-block { display: grid; gap: 4px; }\n" +
    "    .field-hint { font-size: 0.72rem; color: var(--subtle); line-height: 1.3; }\n" +
    "    .form-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }\n" +
    "    .form-grid-stack { display: grid; grid-template-columns: 1fr; gap: 10px; }\n" +
    "    .section-label { display: block; font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }\n" +
    "    .btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }\n" +
    "    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }\n" +
    "    .chip-btn { padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 500; background: var(--surface-alt); color: var(--muted); border: 1px solid var(--border); cursor: pointer; }\n" +
    "    .chip-btn:hover { background: var(--primary-soft); color: var(--primary); border-color: #bfdbfe; }\n" +
    "    input { width: 100%; padding: 9px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-family: inherit; font-size: 0.88rem; }\n" +
    "    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); outline: none; }\n" +
    "    button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; font-family: inherit; font-size: 0.86rem; font-weight: 600; white-space: nowrap; cursor: pointer; text-decoration: none; }\n" +
    "    button:disabled { opacity: 0.5; cursor: not-allowed; }\n" +
    "    .btn-primary { background: var(--primary); color: #ffffff; }\n" +
    "    .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }\n" +
    "    .btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); }\n" +
    "    .btn-secondary:hover:not(:disabled) { background: var(--surface-alt); }\n" +
    "    .btn-soft { background: var(--primary-soft); color: var(--primary); }\n" +
    "    .btn-soft:hover:not(:disabled) { background: #dbeafe; }\n" +
    "    .btn-sm { padding: 6px 11px; font-size: 0.8rem; border-radius: 8px; }\n" +
    "    .divider { margin: 16px 0; border: none; border-top: 1px solid var(--border); }\n" +
    "    .banner { margin-top: 10px; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 0.83rem; font-weight: 500; display: none; }\n" +
    "    .banner.show { display: block; }\n" +
    "    .banner.info { background: var(--primary-soft); color: #1e40af; border: 1px solid #bfdbfe; }\n" +
    "    .banner.success { background: var(--success-bg); color: var(--success-text); border: 1px solid var(--success-border); }\n" +
    "    .banner.error { background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error-border); }\n" +
    "    .group-list { display: grid; gap: 9px; margin-top: 10px; }\n" +
    "    .group-card { border: 1px solid var(--border); background: var(--surface-alt); border-radius: var(--radius-sm); padding: 11px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }\n" +
    "    .group-name { font-weight: 600; font-size: 0.92rem; color: var(--text); }\n" +
    "    .group-tags { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 4px; align-items: center; }\n" +
    "    .tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 0.74rem; font-weight: 600; background: #e2e8f0; color: #334155; }\n" +
    "    .tag.open { background: var(--success-bg); color: var(--success-text); }\n" +
    "    .tag.full { background: var(--warn-bg); color: var(--warn-text); }\n" +
    "    .state-box { text-align: center; padding: 20px 14px; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-alt); color: var(--muted); font-size: 0.86rem; }\n" +
    "    .profile-box { padding: 12px; border-radius: var(--radius-sm); background: var(--surface-alt); border: 1px solid var(--border); }\n" +
    "    .profile-email { font-weight: 600; font-size: 0.9rem; color: var(--text); word-break: break-word; }\n" +
    "    .profile-meta { font-size: 0.8rem; color: var(--muted); margin-top: 2px; }\n" +
    "    .ai-result { margin-top: 12px; padding: 13px 14px; border-radius: var(--radius-sm); background: var(--surface-alt); border: 1px solid var(--border); font-size: 0.88rem; color: var(--text); white-space: pre-wrap; }\n" +
    "    .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(3px); z-index: 60; align-items: center; justify-content: center; padding: 18px; }\n" +
    "    .modal-backdrop.open { display: flex; }\n" +
    "    .modal-panel { width: 100%; max-width: 680px; max-height: 88vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); }\n" +
    "    @media (max-width: 820px) { .hub-grid { grid-template-columns: 1fr; } .form-grid-3 { grid-template-columns: 1fr; } }\n" +
    "    @media (max-width: 600px) { .container { padding: 28px 16px 48px; } .hub-card, .modal-panel { padding: 18px; } }\n" +
    "";

  const safeEmail = escapeHtml(user?.email || "");
  const safeName = escapeHtml(user?.name || "Student");
  const isAuth = Boolean(user);
  const initialChar = escapeHtml(((user?.name || user?.email || "U").trim().charAt(0) || "U").toUpperCase());

  const sessionPillText = isAuth ? "Signed in: " + safeEmail : "Guest session";
  const dotClass = isAuth ? "status-dot active" : "status-dot";
  const accountCaption = isAuth ? "Account" : "Sign in / Create account";

  const accountBadgeHtml = isAuth
    ? "<span class=\"account-badge auth\">" + initialChar + "</span>"
    : "<span class=\"account-badge guest\">" +
        "<svg width=\"17\" height=\"17\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">" +
          "<path d=\"M20 21a8 8 0 0 0-16 0\"></path>" +
          "<circle cx=\"12\" cy=\"7\" r=\"4\"></circle>" +
        "</svg>" +
      "</span>";

  const accountPopoverBody = user
    ? "<div class=\"profile-box\">" +
        "<div class=\"profile-email\">" + safeEmail + "</div>" +
        "<div class=\"profile-meta\">" + safeName + " &middot; Active session</div>" +
      "</div>" +
      "<div class=\"btn-row\">" +
        "<button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"logout()\">Sign out</button>" +
      "</div>"
    : "<div class=\"btn-row\" style=\"margin-top:0;\">" +
        "<a class=\"btn btn-soft btn-sm\" href=\"/auth/google\">Continue with Google</a>" +
      "</div>" +
      "<hr class=\"divider\" />" +
      "<div class=\"form-grid-stack\">" +
        "<div class=\"field-block\"><input id=\"authName\" type=\"text\" placeholder=\"Full name\" aria-label=\"Full name\" /><span class=\"field-hint\">Required when creating a new account.</span></div>" +
        "<div class=\"field-block\"><input id=\"authEmail\" type=\"email\" placeholder=\"Email address\" aria-label=\"Email address\" /><span class=\"field-hint\">Use your student or personal email.</span></div>" +
        "<div class=\"field-block\"><input id=\"authPassword\" type=\"password\" placeholder=\"Password\" aria-label=\"Password\" /><span class=\"field-hint\">At least 6 characters.</span></div>" +
      "</div>" +
      "<div class=\"btn-row\">" +
        "<button class=\"btn-primary btn-sm\" type=\"button\" onclick=\"loginUser()\">Sign in</button>" +
        "<button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"registerUser()\">Create account</button>" +
      "</div>";

  return "<!doctype html>\n" +
    "<html lang=\"en\">\n" +
    "<head>\n" +
    "  <meta charset=\"utf-8\" />\n" +
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n" +
    "  <title>StudyGroupManager</title>\n" +
    "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />\n" +
    "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin />\n" +
    "  <link href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\" />\n" +
    "  <style>" + css + "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <header class=\"topbar\">\n" +
    "    <div class=\"topbar-inner\">\n" +
    "      <a class=\"brand\" href=\"/\">\n" +
    "        <span class=\"brand-mark\">SG</span>\n" +
    "        <span>\n" +
    "          <span class=\"brand-title\">StudyGroupManager</span>\n" +
    "          <span class=\"brand-sub\">Course Study Cohorts</span>\n" +
    "        </span>\n" +
    "      </a>\n" +
    "      <div class=\"nav-group\">\n" +
    "        <span class=\"session-pill\" id=\"sessionStatus\">\n" +
    "          <span class=\"" + dotClass + "\"></span>\n" +
    "          <span>" + sessionPillText + "</span>\n" +
    "        </span>\n" +
    "        <button id=\"accountIconBtn\" class=\"account-trigger\" type=\"button\" aria-label=\"Account menu\" aria-expanded=\"false\" onclick=\"toggleAccountPopover(event)\">\n" +
    "          " + accountBadgeHtml + "\n" +
    "          <span class=\"account-caption\">" + accountCaption + "</span>\n" +
    "        </button>\n" +
    "        <div id=\"accountPopover\" class=\"account-popover\" role=\"dialog\" aria-label=\"Account options\">\n" +
    "          <div class=\"popover-head\">\n" +
    "            <span class=\"popover-title\">" + (isAuth ? "Account details" : "Sign in or create account") + "</span>\n" +
    "            <button class=\"popover-close\" type=\"button\" aria-label=\"Close account menu\" onclick=\"closeAccountPopover()\">&times;</button>\n" +
    "          </div>\n" +
    "          " + accountPopoverBody + "\n" +
    "          <p id=\"authMsg\" class=\"banner\" role=\"status\" aria-live=\"polite\"></p>\n" +
    "        </div>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </header>\n" +
    "  <main class=\"container\">\n" +
    "    <div class=\"hero\">\n" +
    "      <h1>Study Workspace</h1>\n" +
    "      <p>Select a module below to open its full workspace window.</p>\n" +
    "    </div>\n" +
    "    <div class=\"hub-grid\">\n" +
    "      <div class=\"hub-card\" role=\"button\" tabindex=\"0\" onclick=\"openModal('groupsModal')\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();openModal('groupsModal');}\">\n" +
    "        <div>\n" +
    "          <span class=\"hub-icon groups\" aria-hidden=\"true\">SG</span>\n" +
    "          <h2 class=\"hub-title\">Study Groups</h2>\n" +
    "          <p class=\"hub-desc\">Create a new study group, join or leave by ID or name prefix, and browse active cohorts.</p>\n" +
    "        </div>\n" +
    "        <div class=\"hub-meta\">\n" +
    "          <span class=\"hub-stat\" id=\"hubGroupsStat\">Loading cohorts...</span>\n" +
    "          <span class=\"btn btn-primary btn-sm\">Open Study Groups</span>\n" +
    "        </div>\n" +
    "      </div>\n" +
    "      <div class=\"hub-card\" role=\"button\" tabindex=\"0\" onclick=\"openModal('aiModal')\" onkeydown=\"if(event.key==='Enter'||event.key===' '){event.preventDefault();openModal('aiModal');}\">\n" +
    "        <div>\n" +
    "          <span class=\"hub-icon ai\" aria-hidden=\"true\">AI</span>\n" +
    "          <h2 class=\"hub-title\">AI Advisor</h2>\n" +
    "          <p class=\"hub-desc\">Get focused study plans, topic breakdowns, and schedule recommendations tailored to your course.</p>\n" +
    "        </div>\n" +
    "        <div class=\"hub-meta\">\n" +
    "          <span class=\"hub-stat\">Personalized study tips</span>\n" +
    "          <span class=\"btn btn-soft btn-sm\">Open AI Advisor</span>\n" +
    "        </div>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </main>\n" +
    "  <div id=\"groupsModal\" class=\"modal-backdrop\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Study Groups Workspace\">\n" +
    "    <div class=\"modal-panel\">\n" +
    "      <div class=\"popover-head\">\n" +
    "        <span class=\"popover-title\">Study Groups</span>\n" +
    "        <button class=\"popover-close\" type=\"button\" aria-label=\"Close window\" onclick=\"closeModal('groupsModal')\">&times;</button>\n" +
    "      </div>\n" +
    "      <span class=\"section-label\">Create New Group</span>\n" +
    "      <div class=\"form-grid-3\">\n" +
    "        <div class=\"field-block\"><input id=\"groupTitle\" type=\"text\" placeholder=\"Group title\" aria-label=\"Group title\" /><span class=\"field-hint\">Short descriptive cohort name.</span></div>\n" +
    "        <div class=\"field-block\"><input id=\"groupSubject\" type=\"text\" placeholder=\"Subject\" aria-label=\"Subject\" /><span class=\"field-hint\">Course or topic area.</span></div>\n" +
    "        <div class=\"field-block\"><input id=\"groupCapacity\" type=\"number\" min=\"1\" placeholder=\"Max capacity\" aria-label=\"Max capacity\" /><span class=\"field-hint\">Maximum seats (1 or more).</span></div>\n" +
    "      </div>\n" +
    "      <div class=\"btn-row\">\n" +
    "        <button class=\"btn-primary btn-sm\" type=\"button\" onclick=\"createNewGroup()\">Create Group</button>\n" +
    "        <button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"loadGroups()\">Refresh</button>\n" +
    "      </div>\n" +
    "      <hr class=\"divider\" />\n" +
    "      <span class=\"section-label\">Join or Leave by ID or Name Prefix</span>\n" +
    "      <div class=\"form-grid-3\">\n" +
    "        <div class=\"field-block\"><input id=\"membershipGroupId\" type=\"number\" min=\"1\" placeholder=\"Group ID\" aria-label=\"Group ID\" /><span class=\"field-hint\">Exact numeric ID or auto-filled below.</span></div>\n" +
    "        <div class=\"field-block\" style=\"grid-column: span 2;\"><input id=\"groupPrefixQuery\" type=\"text\" placeholder=\"Type starting letters of group name...\" aria-label=\"Search group by name prefix\" oninput=\"filterGroupsByPrefix()\" /><span class=\"field-hint\">Matches from the start: 1 letter, then 2 letters, and so on.</span></div>\n" +
    "      </div>\n" +
    "      <div class=\"btn-row\">\n" +
    "        <button class=\"btn-primary btn-sm\" type=\"button\" onclick=\"joinSelectedGroup()\">Join Group</button>\n" +
    "        <button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"leaveSelectedGroup()\">Leave Group</button>\n" +
    "      </div>\n" +
    "      <p id=\"groupMsg\" class=\"banner\" role=\"status\" aria-live=\"polite\"></p>\n" +
    "      <hr class=\"divider\" />\n" +
    "      <span class=\"section-label\">Matching &amp; Active Groups</span>\n" +
    "      <div id=\"groupsCards\" class=\"group-list\" aria-live=\"polite\">\n" +
    "        <div class=\"state-box\">Loading groups...</div>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </div>\n" +
    "  <div id=\"aiModal\" class=\"modal-backdrop\" role=\"dialog\" aria-modal=\"true\" aria-label=\"AI Advisor Window\">\n" +
    "    <div class=\"modal-panel\">\n" +
    "      <div class=\"popover-head\">\n" +
    "        <span class=\"popover-title\">AI Advisor</span>\n" +
    "        <button class=\"popover-close\" type=\"button\" aria-label=\"Close window\" onclick=\"closeModal('aiModal')\">&times;</button>\n" +
    "      </div>\n" +
    "      <div class=\"field-block\">\n" +
    "        <input id=\"prefsInput\" type=\"text\" placeholder=\"Topic, schedule, or study level\" aria-label=\"Study preferences\" />\n" +
    "        <span class=\"field-hint\">Example: Web Programming, evenings, intermediate.</span>\n" +
    "      </div>\n" +
    "      <div class=\"chip-row\">\n" +
    "        <button class=\"chip-btn\" type=\"button\" onclick=\"applyPreset('Web Programming, evenings, intermediate')\">Web Programming</button>\n" +
    "        <button class=\"chip-btn\" type=\"button\" onclick=\"applyPreset('Databases & SQL, weekend lab, beginner')\">Databases &amp; SQL</button>\n" +
    "        <button class=\"chip-btn\" type=\"button\" onclick=\"applyPreset('Cloud & Distributed Systems, exam prep')\">Cloud Systems</button>\n" +
    "      </div>\n" +
    "      <div class=\"btn-row\">\n" +
    "        <button class=\"btn-primary btn-sm\" type=\"button\" onclick=\"getRecommendations()\">Get Recommendations</button>\n" +
    "      </div>\n" +
    "      <div id=\"aiFormatted\" class=\"ai-result\" aria-live=\"polite\">Enter your topic and preferences above, then click Get Recommendations.</div>\n" +
    "    </div>\n" +
    "  </div>\n" +
    "  <script>\n" +
    "    let allGroupsCache = [];\n" +
    "    function toggleAccountPopover(e) {\n" +
    "      if (e) e.stopPropagation();\n" +
    "      const pop = document.getElementById(\"accountPopover\");\n" +
    "      const btn = document.getElementById(\"accountIconBtn\");\n" +
    "      if (!pop) return;\n" +
    "      const next = !pop.classList.contains(\"open\");\n" +
    "      pop.classList.toggle(\"open\", next);\n" +
    "      if (btn) btn.setAttribute(\"aria-expanded\", String(next));\n" +
    "    }\n" +
    "    function closeAccountPopover() {\n" +
    "      const pop = document.getElementById(\"accountPopover\");\n" +
    "      const btn = document.getElementById(\"accountIconBtn\");\n" +
    "      if (pop) pop.classList.remove(\"open\");\n" +
    "      if (btn) btn.setAttribute(\"aria-expanded\", \"false\");\n" +
    "    }\n" +
    "    function openModal(id) {\n" +
    "      closeAccountPopover();\n" +
    "      const el = document.getElementById(id);\n" +
    "      if (el) el.classList.add(\"open\");\n" +
    "    }\n" +
    "    function closeModal(id) {\n" +
    "      const el = document.getElementById(id);\n" +
    "      if (el) el.classList.remove(\"open\");\n" +
    "    }\n" +
    "    function applyPreset(text) {\n" +
    "      const p = document.getElementById(\"prefsInput\");\n" +
    "      if (p) p.value = text;\n" +
    "      getRecommendations();\n" +
    "    }\n" +
    "    document.addEventListener(\"click\", (e) => {\n" +
    "      const pop = document.getElementById(\"accountPopover\");\n" +
    "      const btn = document.getElementById(\"accountIconBtn\");\n" +
    "      if (pop && pop.classList.contains(\"open\") && !pop.contains(e.target) && (!btn || !btn.contains(e.target))) {\n" +
    "        closeAccountPopover();\n" +
    "      }\n" +
    "      if (e.target.classList && e.target.classList.contains(\"modal-backdrop\")) {\n" +
    "        e.target.classList.remove(\"open\");\n" +
    "      }\n" +
    "    });\n" +
    "    document.addEventListener(\"keydown\", (e) => {\n" +
    "      if (e.key === \"Escape\") {\n" +
    "        closeAccountPopover();\n" +
    "        document.querySelectorAll(\"(.modal-backdrop.open)\").forEach((m) => m.classList.remove(\"open\"));\n" +
    "      }\n" +
    "    });\n" +
    "    function setBanner(elId, message, type) {\n" +
    "      const el = document.getElementById(elId);\n" +
    "      if (!el) return;\n" +
    "      if (!message) { el.textContent = \"\"; el.className = \"banner\"; return; }\n" +
    "      el.textContent = message;\n" +
    "      el.className = \"banner show \" + (type || \"info\");\n" +
    "    }\n" +
    "    async function loginUser() {\n" +
    "      setBanner(\"authMsg\", \"Signing in...\", \"info\");\n" +
    "      const email = document.getElementById(\"authEmail\").value;\n" +
    "      const password = document.getElementById(\"authPassword\").value;\n" +
    "      try {\n" +
    "        const res = await fetch(\"/auth/login\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ email, password }) });\n" +
    "        const data = await res.json();\n" +
    "        if (res.ok) { setBanner(\"authMsg\", \"Signed in.\", \"success\"); location.reload(); }\n" +
    "        else { setBanner(\"authMsg\", data.error || \"Sign in failed.\", \"error\"); }\n" +
    "      } catch { setBanner(\"authMsg\", \"Network error while signing in.\", \"error\"); }\n" +
    "    }\n" +
    "    async function registerUser() {\n" +
    "      setBanner(\"authMsg\", \"Creating account...\", \"info\");\n" +
    "      const name = document.getElementById(\"authName\").value;\n" +
    "      const email = document.getElementById(\"authEmail\").value;\n" +
    "      const password = document.getElementById(\"authPassword\").value;\n" +
    "      try {\n" +
    "        const res = await fetch(\"/auth/register\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ name, email, password }) });\n" +
    "        const data = await res.json();\n" +
    "        if (res.ok) { setBanner(\"authMsg\", \"Account created.\", \"success\"); location.reload(); }\n" +
    "        else { setBanner(\"authMsg\", data.error || \"Registration failed.\", \"error\"); }\n" +
    "      } catch { setBanner(\"authMsg\", \"Network error while creating account.\", \"error\"); }\n" +
    "    }\n" +
    "    async function logout() { await fetch(\"/auth/logout\", { method: \"POST\" }); location.reload(); }\n" +
    "    function selectGroupForAction(group) {\n" +
    "      const idInput = document.getElementById(\"membershipGroupId\");\n" +
    "      const prefixInput = document.getElementById(\"groupPrefixQuery\");\n" +
    "      if (idInput) idInput.value = String(group.id);\n" +
    "      if (prefixInput && group.title) prefixInput.value = String(group.title);\n" +
    "      setBanner(\"groupMsg\", \"Selected group #\" + group.id + \" (\" + (group.title || \"\") + \").\", \"info\");\n" +
    "    }\n" +
    "    function renderGroupCards(groups) {\n" +
    "      const container = document.getElementById(\"groupsCards\");\n" +
    "      if (!container) return;\n" +
    "      container.textContent = \"\";\n" +
    "      if (!groups.length) {\n" +
    "        const empty = document.createElement(\"div\");\n" +
    "        empty.className = \"state-box\";\n" +
    "        empty.textContent = \"No matching study groups.\";\n" +
    "        container.appendChild(empty);\n" +
    "        return;\n" +
    "      }\n" +
    "      for (const g of groups) {\n" +
    "        const item = document.createElement(\"div\");\n" +
    "        item.className = \"group-card\";\n" +
    "        const info = document.createElement(\"div\");\n" +
    "        const title = document.createElement(\"div\");\n" +
    "        title.className = \"group-name\";\n" +
    "        title.textContent = \"#\" + g.id + \" \u00b7 \" + (g.title || \"Untitled Group\");\n" +
    "        const tags = document.createElement(\"div\");\n" +
    "        tags.className = \"group-tags\";\n" +
    "        const subjTag = document.createElement(\"span\");\n" +
    "        subjTag.className = \"tag\";\n" +
    "        subjTag.textContent = g.subject || \"General\";\n" +
    "        const membersCount = Number(g.member_count ?? g.current_members ?? 0);\n" +
    "        const capCount = Number(g.max_capacity ?? 0);\n" +
    "        const isFull = capCount > 0 && membersCount >= capCount;\n" +
    "        const capTag = document.createElement(\"span\");\n" +
    "        capTag.className = \"tag \" + (isFull ? \"full\" : \"open\");\n" +
    "        capTag.textContent = capCount > 0 ? (membersCount + \"/\" + capCount + \" seats\") : (membersCount + \" members\");\n" +
    "        tags.appendChild(subjTag);\n" +
    "        tags.appendChild(capTag);\n" +
    "        info.appendChild(title);\n" +
    "        info.appendChild(tags);\n" +
    "        const actions = document.createElement(\"div\");\n" +
    "        actions.className = \"btn-row\";\n" +
    "        actions.style.marginTop = \"0\";\n" +
    "        const selectBtn = document.createElement(\"button\");\n" +
    "        selectBtn.type = \"button\";\n" +
    "        selectBtn.className = \"btn-secondary btn-sm\";\n" +
    "        selectBtn.textContent = \"Pick\";\n" +
    "        selectBtn.onclick = () => selectGroupForAction(g);\n" +
    "        const joinBtn = document.createElement(\"button\");\n" +
    "        joinBtn.type = \"button\";\n" +
    "        joinBtn.className = \"btn-primary btn-sm\";\n" +
    "        joinBtn.textContent = \"Join\";\n" +
    "        joinBtn.disabled = isFull;\n" +
    "        joinBtn.onclick = async () => { selectGroupForAction(g); await joinSelectedGroup(); };\n" +
    "        actions.appendChild(selectBtn);\n" +
    "        actions.appendChild(joinBtn);\n" +
    "        item.appendChild(info);\n" +
    "        item.appendChild(actions);\n" +
    "        container.appendChild(item);\n" +
    "      }\n" +
    "    }\n" +
    "    function filterGroupsByPrefix() {\n" +
    "      const q = (document.getElementById(\"groupPrefixQuery\")?.value || \"\").trim().toLowerCase();\n" +
    "      const idInput = document.getElementById(\"membershipGroupId\");\n" +
    "      if (!q) {\n" +
    "        renderGroupCards(allGroupsCache);\n" +
    "        return;\n" +
    "      }\n" +
    "      const startsWithMatches = allGroupsCache.filter((g) => String(g.title || \"\").trim().toLowerCase().startsWith(q));\n" +
    "      const filtered = startsWithMatches.length ? startsWithMatches : allGroupsCache.filter((g) => String(g.title || \"\").toLowerCase().includes(q));\n" +
    "      renderGroupCards(filtered);\n" +
    "      if (filtered.length === 1 && idInput) {\n" +
    "        idInput.value = String(filtered[0].id);\n" +
    "      }\n" +
    "    }\n" +
    "    function resolveTargetGroupId() {\n" +
    "      const directId = Number(document.getElementById(\"membershipGroupId\")?.value);\n" +
    "      if (directId > 0) return directId;\n" +
    "      const q = (document.getElementById(\"groupPrefixQuery\")?.value || \"\").trim().toLowerCase();\n" +
    "      if (!q) return 0;\n" +
    "      const exact = allGroupsCache.find((g) => String(g.title || \"\").trim().toLowerCase() === q);\n" +
    "      if (exact) return Number(exact.id);\n" +
    "      const prefixMatch = allGroupsCache.find((g) => String(g.title || \"\").trim().toLowerCase().startsWith(q));\n" +
    "      if (prefixMatch) return Number(prefixMatch.id);\n" +
    "      const partial = allGroupsCache.find((g) => String(g.title || \"\").toLowerCase().includes(q));\n" +
    "      return partial ? Number(partial.id) : 0;\n" +
    "    }\n" +
    "    async function loadGroups() {\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups\");\n" +
    "        const data = await res.json();\n" +
    "        const list = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : []);\n" +
    "        allGroupsCache = list;\n" +
    "        const hubStat = document.getElementById(\"hubGroupsStat\");\n" +
    "        if (hubStat) hubStat.textContent = list.length + (list.length === 1 ? \" active group\" : \" active groups\");\n" +
    "        filterGroupsByPrefix();\n" +
    "      } catch { setBanner(\"groupMsg\", \"Could not load study groups.\", \"error\"); }\n" +
    "    }\n" +
    "    async function createNewGroup() {\n" +
    "      setBanner(\"groupMsg\", \"Creating group...\", \"info\");\n" +
    "      const title = document.getElementById(\"groupTitle\").value;\n" +
    "      const subject = document.getElementById(\"groupSubject\").value;\n" +
    "      const max_capacity = Number(document.getElementById(\"groupCapacity\").value);\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ title, subject, max_capacity }) });\n" +
    "        const data = await res.json();\n" +
    "        if (res.ok) { setBanner(\"groupMsg\", \"Created group #\" + data.group.id + \".\", \"success\"); }\n" +
    "        else { setBanner(\"groupMsg\", data.error || \"Could not create group.\", \"error\"); }\n" +
    "        await loadGroups();\n" +
    "      } catch { setBanner(\"groupMsg\", \"Network error while creating group.\", \"error\"); }\n" +
    "    }\n" +
    "    async function joinSelectedGroup() {\n" +
    "      const groupId = resolveTargetGroupId();\n" +
    "      if (!groupId) { setBanner(\"groupMsg\", \"Enter a Group ID or matching group name first.\", \"error\"); return; }\n" +
    "      setBanner(\"groupMsg\", \"Joining group #\" + groupId + \"...\", \"info\");\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups/\" + groupId + \"/join\", { method: \"POST\" });\n" +
    "        const data = await res.json();\n" +
    "        setBanner(\"groupMsg\", res.ok ? (data.message || \"Joined group.\") : (data.error || \"Could not join group.\"), res.ok ? \"success\" : \"error\");\n" +
    "        await loadGroups();\n" +
    "      } catch { setBanner(\"groupMsg\", \"Network error while joining group.\", \"error\"); }\n" +
    "    }\n" +
    "    async function leaveSelectedGroup() {\n" +
    "      const groupId = resolveTargetGroupId();\n" +
    "      if (!groupId) { setBanner(\"groupMsg\", \"Enter a Group ID or matching group name first.\", \"error\"); return; }\n" +
    "      setBanner(\"groupMsg\", \"Leaving group #\" + groupId + \"...\", \"info\");\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups/\" + groupId + \"/leave\", { method: \"POST\" });\n" +
    "        const data = await res.json();\n" +
    "        setBanner(\"groupMsg\", res.ok ? (data.message || \"Left group.\") : (data.error || \"Could not leave group.\"), res.ok ? \"success\" : \"error\");\n" +
    "        await loadGroups();\n" +
    "      } catch { setBanner(\"groupMsg\", \"Network error while leaving group.\", \"error\"); }\n" +
    "    }\n" +
    "    async function getRecommendations() {\n" +
    "      const formattedEl = document.getElementById(\"aiFormatted\");\n" +
    "      if (formattedEl) formattedEl.textContent = \"Generating recommendations...\";\n" +
    "      const preferences = document.getElementById(\"prefsInput\").value || \"Web Programming\";\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/recommendations\", { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ preferences }) });\n" +
    "        const data = await res.json();\n" +
    "        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.recommendation || data?.message || \"Recommendations received.\";\n" +
    "        if (formattedEl) formattedEl.textContent = String(text);\n" +
    "      } catch { if (formattedEl) formattedEl.textContent = \"Could not load recommendations right now.\"; }\n" +
    "    }\n" +
    "    loadGroups();\n" +
    "  </script>\n" +
    "</body>\n" +
    "</html>";
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