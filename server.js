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
  const css = [
    ":root { --bg: #f4f7fb; --surface: #ffffff; --surface-alt: #f8fafc; --text: #0f172a; --muted: #475569; --subtle: #64748b; --border: #e2e8f0; --border-strong: #cbd5e1; --primary: #2563eb; --primary-hover: #1d4ed8; --primary-soft: #eff6ff; --success-bg: #ecfdf5; --success-text: #065f46; --success-border: #a7f3d0; --error-bg: #fef2f2; --error-text: #991b1b; --error-border: #fecaca; --warn-bg: #fffbeb; --warn-text: #92400e; --radius: 16px; --radius-sm: 10px; --shadow: 0 14px 34px -16px rgba(15, 23, 42, 0.14), 0 4px 12px -4px rgba(15, 23, 42, 0.05); }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: radial-gradient(circle at top left, #e0e7ff 0%, var(--bg) 42%, var(--bg) 100%); color: var(--text); line-height: 1.5; min-height: 100vh; }",
    ":focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }",
    ".topbar { position: sticky; top: 0; z-index: 30; background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); }",
    ".topbar-inner { max-width: 1120px; margin: 0 auto; padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }",
    ".brand { display: flex; align-items: center; gap: 11px; text-decoration: none; color: var(--text); }",
    ".brand-mark { width: 38px; height: 38px; border-radius: 11px; background: linear-gradient(135deg, #2563eb, #4f46e5); color: #ffffff; font-weight: 700; font-size: 0.9rem; display: grid; place-items: center; box-shadow: 0 6px 14px rgba(37, 99, 235, 0.24); }",
    ".brand-title { font-weight: 700; font-size: 1rem; letter-spacing: -0.015em; display: block; }",
    ".brand-sub { font-size: 0.75rem; color: var(--subtle); display: block; }",
    ".nav-group { display: flex; align-items: center; gap: 12px; position: relative; }",
    ".session-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; font-size: 0.8rem; font-weight: 500; border: 1px solid var(--border); background: var(--surface); color: var(--text); white-space: nowrap; }",
    ".status-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; flex-shrink: 0; }",
    ".status-dot.active { background: #10b981; }",
    ".account-trigger { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; background: transparent; border: none; padding: 2px 6px; cursor: pointer; }",
    ".account-badge { width: 34px; height: 34px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.88rem; transition: transform 0.14s ease, box-shadow 0.14s ease; }",
    ".account-badge.guest { background: #2563eb; color: #ffffff; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); }",
    ".account-badge.auth { background: linear-gradient(135deg, #0d9488, #4f46e5); color: #ffffff; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.28); }",
    ".account-trigger:hover .account-badge { transform: translateY(-1px); }",
    ".account-caption { font-size: 0.68rem; font-weight: 600; color: var(--muted); line-height: 1.15; white-space: nowrap; }",
    ".account-popover { display: none; position: absolute; right: 0; top: 54px; width: 325px; max-width: calc(100vw - 32px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; z-index: 50; }",
    ".account-popover.open { display: block; }",
    ".popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }",
    ".popover-title { font-weight: 700; font-size: 0.98rem; color: var(--text); }",
    ".popover-close { background: transparent; border: none; color: var(--subtle); font-size: 1.2rem; padding: 2px 6px; cursor: pointer; line-height: 1; }",
    ".popover-close:hover { color: var(--text); }",
    ".container { max-width: 1120px; margin: 0 auto; padding: 36px 24px 64px; }",
    ".hero { margin-bottom: 24px; }",
    ".hero h1 { margin: 0 0 4px; font-size: clamp(1.65rem, 3vw, 2.1rem); font-weight: 700; letter-spacing: -0.025em; }",
    ".hero p { margin: 0; color: var(--muted); font-size: 0.94rem; }",
    ".hub-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }",
    ".hub-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); display: flex; flex-direction: column; justify-content: space-between; gap: 18px; cursor: pointer; transition: transform 0.16s ease, border-color 0.16s ease; }",
    ".hub-card:hover { transform: translateY(-2px); border-color: #93c5fd; }",
    ".hub-icon { width: 42px; height: 42px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; margin-bottom: 12px; }",
    ".hub-icon.groups { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }",
    ".hub-icon.ai { background: #eef2ff; color: #4f46e5; border: 1px solid #c7d2fe; }",
    ".hub-title { margin: 0 0 4px; font-size: 1.2rem; font-weight: 700; letter-spacing: -0.015em; }",
    ".hub-desc { margin: 0; font-size: 0.88rem; color: var(--muted); }",
    ".hub-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); }",
    ".hub-stat { font-size: 0.82rem; font-weight: 600; color: var(--muted); }",
    ".section-block { margin-top: 32px; }",
    ".section-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }",
    ".section-title { margin: 0; font-size: 1.15rem; font-weight: 700; letter-spacing: -0.015em; }",
    ".all-groups-stack { display: flex; flex-direction: column; gap: 12px; }",
    ".cohort-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; box-shadow: var(--shadow); display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; cursor: pointer; transition: border-color 0.15s ease, transform 0.15s ease; }",
    ".cohort-card:hover { border-color: #93c5fd; transform: translateY(-1px); }",
    ".cohort-main { flex: 1 1 320px; min-width: 240px; }",
    ".cohort-title { font-weight: 700; font-size: 1rem; color: var(--text); }",
    ".cohort-meta-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }",
    ".tag { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: #e2e8f0; color: #334155; }",
    ".tag.time { background: #eef2ff; color: #3730a3; }",
    ".tag.open { background: var(--success-bg); color: var(--success-text); }",
    ".tag.full { background: var(--warn-bg); color: var(--warn-text); }",
    ".tag.joined { background: #dbeafe; color: #1d4ed8; }",
    ".cohort-side { flex: 0 0 250px; min-width: 210px; display: flex; flex-direction: column; gap: 6px; }",
    ".capacity-text { display: flex; justify-content: space-between; font-size: 0.78rem; font-weight: 600; color: var(--muted); }",
    ".meter-track { width: 100%; height: 8px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }",
    ".meter-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #0d9488, #2563eb); transition: width 0.55s cubic-bezier(0.22, 1, 0.36, 1); }",
    ".meter-fill.full { background: linear-gradient(90deg, #f59e0b, #ea580c); }",
    ".cohort-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
    ".sub-card { background: var(--surface-alt); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 16px; }",
    ".field-block { display: grid; gap: 4px; }",
    ".field-hint { font-size: 0.72rem; color: var(--subtle); line-height: 1.3; }",
    ".form-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }",
    ".form-grid-2 { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 10px; }",
    ".form-grid-stack { display: grid; grid-template-columns: 1fr; gap: 10px; }",
    ".section-label { display: block; font-size: 0.75rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }",
    ".btn-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }",
    ".chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }",
    ".chip-btn { padding: 4px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 500; background: var(--surface-alt); color: var(--muted); border: 1px solid var(--border); cursor: pointer; }",
    ".chip-btn:hover { background: var(--primary-soft); color: var(--primary); border-color: #bfdbfe; }",
    "input { width: 100%; padding: 9px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font-family: inherit; font-size: 0.88rem; }",
    "input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); outline: none; }",
    "button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 14px; border-radius: var(--radius-sm); border: 1px solid transparent; font-family: inherit; font-size: 0.86rem; font-weight: 600; white-space: nowrap; cursor: pointer; text-decoration: none; }",
    "button:disabled { opacity: 0.5; cursor: not-allowed; }",
    ".btn-primary { background: var(--primary); color: #ffffff; }",
    ".btn-primary:hover:not(:disabled) { background: var(--primary-hover); }",
    ".btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border-strong); }",
    ".btn-secondary:hover:not(:disabled) { background: var(--surface-alt); }",
    ".btn-soft { background: var(--primary-soft); color: var(--primary); }",
    ".btn-soft:hover:not(:disabled) { background: #dbeafe; }",
    ".btn-danger-soft { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }",
    ".btn-danger-soft:hover:not(:disabled) { background: #fee2e2; }",
    ".btn-sm { padding: 6px 11px; font-size: 0.8rem; border-radius: 8px; }",
    ".divider { margin: 16px 0; border: none; border-top: 1px solid var(--border); }",
    ".banner { margin-top: 10px; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 0.83rem; font-weight: 500; display: none; }",
    ".banner.show { display: block; }",
    ".banner.info { background: var(--primary-soft); color: #1e40af; border: 1px solid #bfdbfe; }",
    ".banner.success { background: var(--success-bg); color: var(--success-text); border: 1px solid var(--success-border); }",
    ".banner.error { background: var(--error-bg); color: #991b1b; border: 1px solid var(--error-border); }",
    ".group-list { display: grid; gap: 9px; margin-top: 10px; }",
    ".group-card { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-sm); padding: 11px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }",
    ".group-name { font-weight: 600; font-size: 0.92rem; color: var(--text); }",
    ".detail-card { background: var(--surface); border: 1px solid #bfdbfe; border-radius: var(--radius-sm); padding: 14px 16px; margin-top: 12px; }",
    ".detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; font-size: 0.85rem; margin-top: 8px; }",
    ".confirm-box { margin-top: 12px; padding: 12px 14px; border-radius: var(--radius-sm); background: var(--surface-alt); border: 1px solid var(--border-strong); }",
    ".state-box { text-align: center; padding: 20px 14px; border: 1px dashed var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-alt); color: var(--muted); font-size: 0.86rem; }",
    ".profile-box { padding: 12px; border-radius: var(--radius-sm); background: var(--surface-alt); border: 1px solid var(--border); }",
    ".profile-email { font-weight: 600; font-size: 0.9rem; color: var(--text); word-break: break-word; }",
    ".profile-meta { font-size: 0.8rem; color: var(--muted); margin-top: 2px; }",
    ".ai-result { margin-top: 12px; padding: 13px 14px; border-radius: var(--radius-sm); background: var(--surface-alt); border: 1px solid var(--border); font-size: 0.88rem; color: var(--text); white-space: pre-wrap; }",
    ".modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(3px); z-index: 60; align-items: center; justify-content: center; padding: 18px; }",
    ".modal-backdrop.open { display: flex; }",
    ".modal-panel { width: 100%; max-width: 720px; max-height: 88vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); }",
    "@media (max-width: 820px) { .hub-grid, .form-grid-3, .form-grid-2, .detail-grid { grid-template-columns: 1fr; } }",
    "@media (max-width: 600px) { .container { padding: 28px 16px 48px; } .hub-card, .modal-panel, .cohort-card { padding: 16px; } }"
  ].join("\n");

  const safeEmail = escapeHtml(user?.email || "");
  const safeName = escapeHtml(user?.name || "Student");
  const isAuth = Boolean(user);
  const initialChar = escapeHtml(((user?.name || user?.email || "U").trim().charAt(0) || "U").toUpperCase());

  const sessionPillText = isAuth ? "Signed in: " + safeEmail : "Guest session";
  const dotClass = isAuth ? "status-dot active" : "status-dot";
  const accountCaption = isAuth ? "Account" : "Sign in / Create account";

  const accountBadgeHtml = isAuth
    ? '<span class="account-badge auth">' + initialChar + '</span>'
    : '<span class="account-badge guest"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg></span>';

  const accountPopoverBody = user
    ? '<div class="profile-box"><div class="profile-email">' + safeEmail + '</div><div class="profile-meta">' + safeName + ' &middot; Active session</div></div>' +
      '<div class="btn-row"><button class="btn-secondary btn-sm" type="button" onclick="logout()">Sign out</button></div>'
    : '<div class="btn-row" style="margin-top:0;"><a class="btn btn-soft btn-sm" href="/auth/google">Continue with Google</a></div>' +
      '<hr class="divider" />' +
      '<div class="form-grid-stack">' +
      '<div class="field-block"><input id="authName" type="text" placeholder="Full name" aria-label="Full name" /><span class="field-hint">Required when creating a new account.</span></div>' +
      '<div class="field-block"><input id="authEmail" type="email" placeholder="Email address" aria-label="Email address" /><span class="field-hint">Use your student or personal email.</span></div>' +
      '<div class="field-block"><input id="authPassword" type="password" placeholder="Password" aria-label="Password" /><span class="field-hint">At least 6 characters.</span></div>' +
      '</div>' +
      '<div class="btn-row"><button class="btn-primary btn-sm" type="button" onclick="loginUser()">Sign in</button><button class="btn-secondary btn-sm" type="button" onclick="registerUser()">Create account</button></div>';

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>StudyGroupManager</title>",
    '  <link rel="preconnect" href="https://fonts.googleapis.com" />',
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />',
    "  <style>" + css + "</style>",
    "</head>",
    "<body>",
    '  <header class="topbar">',
    '    <div class="topbar-inner">',
    '      <a class="brand" href="/">',
    '        <span class="brand-mark">SG</span>',
    "        <span>",
    '          <span class="brand-title">StudyGroupManager</span>',
    '          <span class="brand-sub">Course Study Cohorts</span>',
    "        </span>",
    "      </a>",
    '      <div class="nav-group">',
    '        <span class="session-pill" id="sessionStatus"><span class="' + dotClass + '"></span><span>' + sessionPillText + "</span></span>",
    '        <button id="accountIconBtn" class="account-trigger" type="button" aria-label="Account menu" aria-expanded="false" onclick="toggleAccountPopover(event)">' + accountBadgeHtml + '<span class="account-caption">' + accountCaption + "</span></button>",
    '        <div id="accountPopover" class="account-popover" role="dialog" aria-label="Account options">',
    '          <div class="popover-head"><span class="popover-title">' + (isAuth ? "Account details" : "Sign in or create account") + '</span><button class="popover-close" type="button" aria-label="Close account menu" onclick="closeAccountPopover()">&times;</button></div>',
    "          " + accountPopoverBody,
    '          <p id="authMsg" class="banner" role="status" aria-live="polite"></p>',
    "        </div>",
    "      </div>",
    "    </div>",
    "  </header>",
    '  <main class="container">',
    '    <div class="hero"><h1>Study Workspace</h1><p>Open Study Groups or AI Advisor, or inspect every study group below.</p></div>',
    '    <div class="hub-grid">',
    '      <div class="hub-card" role="button" tabindex="0" onclick="openModal(\'groupsModal\')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openModal(\'groupsModal\');}">',
    '        <div><span class="hub-icon groups" aria-hidden="true">SG</span><h2 class="hub-title">Study Groups</h2><p class="hub-desc">Create a new study group, search by ID or name prefix, and manage membership.</p></div>',
    '        <div class="hub-meta"><span class="hub-stat" id="hubGroupsStat">Loading cohorts...</span><span class="btn btn-primary btn-sm">Open Study Groups</span></div>',
    "      </div>",
    '      <div class="hub-card" role="button" tabindex="0" onclick="openModal(\'aiModal\')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openModal(\'aiModal\');}">',
    '        <div><span class="hub-icon ai" aria-hidden="true">AI</span><h2 class="hub-title">AI Advisor</h2><p class="hub-desc">Get focused study plans, topic breakdowns, and schedule recommendations.</p></div>',
    '        <div class="hub-meta"><span class="hub-stat">Smart study guidance</span><span class="btn btn-soft btn-sm">Open AI Advisor</span></div>',
    "      </div>",
    "    </div>",
    '    <section class="section-block" aria-label="All Study Groups">',
    '      <div class="section-header"><h2 class="section-title">All Study Groups</h2><button class="btn-secondary btn-sm" type="button" onclick="loadGroups()">Refresh Groups</button></div>',
    '      <div id="allGroupsList" class="all-groups-stack" aria-live="polite"><div class="state-box">Loading study groups...</div></div>',
    "    </section>",
    "  </main>",
    '  <div id="groupsModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Study Groups Workspace">',
    '    <div class="modal-panel">',
    '      <div class="popover-head"><span class="popover-title">Study Groups</span><button class="popover-close" type="button" aria-label="Close window" onclick="closeModal(\'groupsModal\')">&times;</button></div>',
    '      <div class="sub-card">',
    '        <span class="section-label">Create New Group</span>',
    '        <div class="form-grid-3">',
    '          <div class="field-block"><input id="groupTitle" type="text" placeholder="Group title" aria-label="Group title" /><span class="field-hint">Cohort name (e.g. Algorithms).</span></div>',
    '          <div class="field-block"><input id="groupSubject" type="text" placeholder="Subject" aria-label="Subject" /><span class="field-hint">Course or topic.</span></div>',
    '          <div class="field-block"><input id="groupCapacity" type="number" min="1" placeholder="Max capacity" aria-label="Max capacity" /><span class="field-hint">Total seats (min. 1).</span></div>',
    "        </div>",
    '        <div class="btn-row"><button class="btn-primary btn-sm" type="button" onclick="createNewGroup()">Create Group</button></div>',
    "      </div>",
    '      <div class="sub-card" style="margin-top:14px;">',
    '        <span class="section-label">Join or Leave Group (by ID or Name)</span>',
    '        <div class="form-grid-2">',
    '          <div class="field-block"><input id="membershipGroupId" type="number" min="1" placeholder="Group ID" aria-label="Group ID" oninput="syncFromIdInput()" /><span class="field-hint">Numeric ID.</span></div>',
    '          <div class="field-block"><input id="groupPrefixQuery" type="text" placeholder="Type starting letters of group name..." aria-label="Search group by name prefix" oninput="filterGroupsByPrefix()" /><span class="field-hint">Matches from 1st letter, 2nd letter, and so on.</span></div>',
    "        </div>",
    '        <div id="groupsCards" class="group-list" aria-live="polite"></div>',
    '        <div id="pickedGroupCard"></div>',
    "      </div>",
    '      <p id="groupMsg" class="banner" role="status" aria-live="polite"></p>',
    "    </div>",
    "  </div>",
    '  <div id="groupActionModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="Group Membership Action">',
    '    <div class="modal-panel">',
    '      <div class="popover-head"><span id="actionModalTitle" class="popover-title">Group Details</span><button class="popover-close" type="button" aria-label="Close window" onclick="closeModal(\'groupActionModal\')">&times;</button></div>',
    '      <div id="actionModalDetails"></div>',
    '      <div class="confirm-box">',
    '        <div class="btn-row" style="margin-top:0;">',
    '          <button id="btnOpenJoinConfirm" class="btn-primary btn-sm" type="button" onclick="prepareConfirm(\'join\')">Join Group</button>',
    '          <button id="btnOpenLeaveConfirm" class="btn-danger-soft btn-sm" type="button" onclick="prepareConfirm(\'leave\')">Leave Group</button>',
    "        </div>",
    '        <div id="confirmStepBox" style="display:none; margin-top:12px;">',
    '          <div class="field-block"><input id="confirmActionInput" type="text" placeholder="Type CONFIRM to proceed" aria-label="Confirmation text" /><span id="confirmActionHint" class="field-hint">Type CONFIRM and click Confirm Action below.</span></div>',
    '          <div class="btn-row"><button id="btnExecuteConfirm" class="btn-primary btn-sm" type="button" onclick="executeConfirmedAction()">Confirm Action</button><button class="btn-secondary btn-sm" type="button" onclick="cancelConfirm()">Cancel</button></div>',
    "        </div>",
    '        <p id="actionModalMsg" class="banner" role="status" aria-live="polite"></p>',
    "      </div>",
    "    </div>",
    "  </div>",
    '  <div id="aiModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="AI Advisor Window">',
    '    <div class="modal-panel">',
    '      <div class="popover-head"><span class="popover-title">AI Advisor</span><button class="popover-close" type="button" aria-label="Close window" onclick="closeModal(\'aiModal\')">&times;</button></div>',
    '      <div class="field-block"><input id="prefsInput" type="text" placeholder="Topic, schedule, or study level" aria-label="Study preferences" /><span class="field-hint">Example: Web Programming, evenings, intermediate.</span></div>',
    '      <div class="chip-row">',
    '        <button class="chip-btn" type="button" onclick="applyPreset(\'Web Programming, evenings, intermediate\')">Web Programming</button>',
    '        <button class="chip-btn" type="button" onclick="applyPreset(\'Databases & SQL, weekend lab, beginner\')">Databases &amp; SQL</button>',
    '        <button class="chip-btn" type="button" onclick="applyPreset(\'Cloud & Distributed Systems, exam prep\')">Cloud Systems</button>',
    "      </div>",
    '      <div class="btn-row"><button class="btn-primary btn-sm" type="button" onclick="getRecommendations()">Get Recommendations</button></div>',
    '      <div id="aiFormatted" class="ai-result" aria-live="polite">Enter your topic and preferences above, then click Get Recommendations.</div>',
    "    </div>",
    "  </div>",
    "  <script>",
    "    const CURRENT_USER_EMAIL = " + JSON.stringify(user?.email || "") + ";",
    "    const CURRENT_USER_NAME = " + JSON.stringify(user?.name || "") + ";",
    "    let allGroupsCache = [];",
    "    let activeModalGroupId = 0;",
    "    let pendingActionType = '';",
    "    function getMeetingTime(g) {",
    "      if (g && (g.meeting_time || g.meetingTime || g.schedule)) return String(g.meeting_time || g.meetingTime || g.schedule);",
    "      const slots = ['Mon 17:00 · Weekly', 'Tue 18:30 · Lab sync', 'Wed 16:00 · Study session', 'Thu 19:00 · Review', 'Fri 15:30 · Q&A'];",
    "      return slots[Math.abs(Number(g?.id || 1) - 1) % slots.length];",
    "    }",
    "    function isUserJoined(g) {",
    "      if (!CURRENT_USER_EMAIL && !CURRENT_USER_NAME) return false;",
    "      const members = Array.isArray(g?.members) ? g.members : (Array.isArray(g?.participants) ? g.participants : []);",
    "      const targets = [CURRENT_USER_EMAIL, CURRENT_USER_NAME].map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);",
    "      return members.some((m) => {",
    "        const val = typeof m === 'string' ? m : (m?.email || m?.name || m?.user || '');",
    "        return targets.includes(String(val).trim().toLowerCase());",
    "      });",
    "    }",
    "    function formatMembersList(g) {",
    "      const members = Array.isArray(g?.members) ? g.members : (Array.isArray(g?.participants) ? g.participants : []);",
    "      if (members.length) return members.map((m) => typeof m === 'string' ? m : (m?.name || m?.email || m?.user || 'Member')).join(', ');",
    "      const count = Number(g?.member_count ?? g?.current_members ?? 0);",
    "      return count > 0 ? (count + (count === 1 ? ' enrolled student' : ' enrolled students')) : 'No members listed yet';",
    "    }",
    "    function toggleAccountPopover(e) {",
    "      if (e) e.stopPropagation();",
    "      const pop = document.getElementById('accountPopover');",
    "      const btn = document.getElementById('accountIconBtn');",
    "      if (!pop) return;",
    "      const next = !pop.classList.contains('open');",
    "      pop.classList.toggle('open', next);",
    "      if (btn) btn.setAttribute('aria-expanded', String(next));",
    "    }",
    "    function closeAccountPopover() {",
    "      const pop = document.getElementById('accountPopover');",
    "      const btn = document.getElementById('accountIconBtn');",
    "      if (pop) pop.classList.remove('open');",
    "      if (btn) btn.setAttribute('aria-expanded', 'false');",
    "    }",
    "    function openModal(id) {",
    "      closeAccountPopover();",
    "      const el = document.getElementById(id);",
    "      if (el) el.classList.add('open');",
    "    }",
    "    function closeModal(id) {",
    "      const el = document.getElementById(id);",
    "      if (el) el.classList.remove('open');",
    "    }",
    "    function applyPreset(text) {",
    "      const p = document.getElementById('prefsInput');",
    "      if (p) p.value = text;",
    "      getRecommendations();",
    "    }",
    "    document.addEventListener('click', (e) => {",
    "      const pop = document.getElementById('accountPopover');",
    "      const btn = document.getElementById('accountIconBtn');",
    "      if (pop && pop.classList.contains('open') && !pop.contains(e.target) && (!btn || !btn.contains(e.target))) closeAccountPopover();",
    "      if (e.target.classList && e.target.classList.contains('modal-backdrop')) e.target.classList.remove('open');",
    "    });",
    "    document.addEventListener('keydown', (e) => {",
    "      if (e.key === 'Escape') { closeAccountPopover(); document.querySelectorAll('.modal-backdrop.open').forEach((m) => m.classList.remove('open')); }",
    "    });",
    "    function setBanner(elId, message, type) {",
    "      const el = document.getElementById(elId);",
    "      if (!el) return;",
    "      if (!message) { el.textContent = ''; el.className = 'banner'; return; }",
    "      el.textContent = message;",
    "      el.className = 'banner show ' + (type || 'info');",
    "    }",
    "    async function loginUser() {",
    "      setBanner('authMsg', 'Signing in...', 'info');",
    "      const email = document.getElementById('authEmail').value;",
    "      const password = document.getElementById('authPassword').value;",
    "      try {",
    "        const res = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });",
    "        const data = await res.json();",
    "        if (res.ok) { setBanner('authMsg', 'Signed in.', 'success'); location.reload(); }",
    "        else { setBanner('authMsg', data.error || 'Sign in failed.', 'error'); }",
    "      } catch { setBanner('authMsg', 'Network error while signing in.', 'error'); }",
    "    }",
    "    async function registerUser() {",
    "      setBanner('authMsg', 'Creating account...', 'info');",
    "      const name = document.getElementById('authName').value;",
    "      const email = document.getElementById('authEmail').value;",
    "      const password = document.getElementById('authPassword').value;",
    "      try {",
    "        const res = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password }) });",
    "        const data = await res.json();",
    "        if (res.ok) { setBanner('authMsg', 'Account created.', 'success'); location.reload(); }",
    "        else { setBanner('authMsg', data.error || 'Registration failed.', 'error'); }",
    "      } catch { setBanner('authMsg', 'Network error while creating account.', 'error'); }",
    "    }",
    "    async function logout() { await fetch('/auth/logout', { method: 'POST' }); location.reload(); }",
    "    function openGroupActionModal(groupId) {",
    "      const g = allGroupsCache.find((item) => Number(item.id) === Number(groupId));",
    "      if (!g) return;",
    "      activeModalGroupId = Number(g.id);",
    "      pendingActionType = '';",
    "      document.getElementById('confirmStepBox').style.display = 'none';",
    "      document.getElementById('confirmActionInput').value = '';",
    "      setBanner('actionModalMsg', '', 'info');",
    "      const membersCount = Number(g.member_count ?? g.current_members ?? 0);",
    "      const capCount = Number(g.max_capacity ?? 0);",
    "      const freeSeats = capCount > 0 ? Math.max(0, capCount - membersCount) : 0;",
    "      const joined = isUserJoined(g);",
    "      document.getElementById('actionModalTitle').textContent = (g.title || 'Study Group') + ' (#' + g.id + ')';",
    "      const detailsEl = document.getElementById('actionModalDetails');",
    "      detailsEl.textContent = '';",
    "      const grid = document.createElement('div');",
    "      grid.className = 'detail-grid';",
    "      const addField = (labelText, valueText, spanFull) => {",
    "        const cell = document.createElement('div');",
    "        if (spanFull) cell.style.gridColumn = '1 / -1';",
    "        const strong = document.createElement('strong');",
    "        strong.textContent = labelText + ': ';",
    "        cell.appendChild(strong);",
    "        cell.appendChild(document.createTextNode(valueText));",
    "        grid.appendChild(cell);",
    "      };",
    "      addField('Subject', g.subject || 'General', false);",
    "      addField('Meeting time', getMeetingTime(g), false);",
    "      addField('Seats', membersCount + ' taken · ' + freeSeats + ' free (of ' + capCount + ')', false);",
    "      addField('Status', joined ? 'Already joined' : 'Not joined', false);",
    "      addField('Members', formatMembersList(g), true);",
    "      detailsEl.appendChild(grid);",
    "      const joinBtn = document.getElementById('btnOpenJoinConfirm');",
    "      const leaveBtn = document.getElementById('btnOpenLeaveConfirm');",
    "      joinBtn.disabled = joined || (capCount > 0 && membersCount >= capCount);",
    "      leaveBtn.style.display = joined ? 'inline-flex' : 'none';",
    "      openModal('groupActionModal');",
    "    }",
    "    function prepareConfirm(type) {",
    "      pendingActionType = type;",
    "      const box = document.getElementById('confirmStepBox');",
    "      const hint = document.getElementById('confirmActionHint');",
    "      const inp = document.getElementById('confirmActionInput');",
    "      if (box) box.style.display = 'block';",
    "      if (inp) { inp.value = ''; inp.focus(); }",
    "      if (hint) hint.textContent = type === 'join' ? 'Type CONFIRM and click Confirm Action to join this group.' : 'Type CONFIRM and click Confirm Action to leave this group.';",
    "    }",
    "    function cancelConfirm() {",
    "      pendingActionType = '';",
    "      const box = document.getElementById('confirmStepBox');",
    "      if (box) box.style.display = 'none';",
    "    }",
    "    async function executeConfirmedAction() {",
    "      const val = (document.getElementById('confirmActionInput')?.value || '').trim().toUpperCase();",
    "      if (val !== 'CONFIRM') {",
    "        setBanner('actionModalMsg', 'Please type CONFIRM in the box first.', 'error');",
    "        return;",
    "      }",
    "      if (!activeModalGroupId || !pendingActionType) return;",
    "      const endpoint = pendingActionType === 'join' ? ('/api/groups/' + activeModalGroupId + '/join') : ('/api/groups/' + activeModalGroupId + '/leave');",
    "      const labelDone = pendingActionType === 'join' ? ('You joined group #' + activeModalGroupId + '.') : ('You left group #' + activeModalGroupId + '.');",
    "      setBanner('actionModalMsg', 'Saving membership change...', 'info');",
    "      try {",
    "        const res = await fetch(endpoint, { method: 'POST' });",
    "        const data = await res.json();",
    "        if (res.ok) {",
    "          const doneMsg = data.message || labelDone;",
    "          cancelConfirm();",
    "          await loadGroups();",
    "          openGroupActionModal(activeModalGroupId);",
    "          setBanner('actionModalMsg', doneMsg, 'success');",
    "        } else {",
    "          setBanner('actionModalMsg', data.error || 'Action could not be completed.', 'error');",
    "        }",
    "      } catch {",
    "        setBanner('actionModalMsg', 'Network error while updating membership.', 'error');",
    "      }",
    "    }",
    "    function renderPickedGroupCard(group) {",
    "      const target = document.getElementById('pickedGroupCard');",
    "      if (!target) return;",
    "      target.textContent = '';",
    "      if (!group) return;",
    "      const membersCount = Number(group.member_count ?? group.current_members ?? 0);",
    "      const capCount = Number(group.max_capacity ?? 0);",
    "      const freeSeats = capCount > 0 ? Math.max(0, capCount - membersCount) : 0;",
    "      const joined = isUserJoined(group);",
    "      const card = document.createElement('div');",
    "      card.className = 'detail-card';",
    "      const head = document.createElement('div');",
    "      head.className = 'popover-head';",
    "      head.style.marginBottom = '4px';",
    "      const titleSpan = document.createElement('span');",
    "      titleSpan.className = 'group-name';",
    "      titleSpan.textContent = 'Selected Group: ' + (group.title || 'Study Group') + ' (#' + group.id + ')';",
    "      const btn = document.createElement('button');",
    "      btn.className = 'btn-primary btn-sm';",
    "      btn.type = 'button';",
    "      btn.textContent = 'Join / Leave';",
    "      btn.onclick = () => openGroupActionModal(group.id);",
    "      head.appendChild(titleSpan);",
    "      head.appendChild(btn);",
    "      const grid = document.createElement('div');",
    "      grid.className = 'detail-grid';",
    "      const addItem = (k, v) => {",
    "        const d = document.createElement('div');",
    "        const b = document.createElement('strong');",
    "        b.textContent = k + ': ';",
    "        d.appendChild(b);",
    "        d.appendChild(document.createTextNode(v));",
    "        grid.appendChild(d);",
    "      };",
    "      addItem('Subject', group.subject || 'General');",
    "      addItem('Meeting time', getMeetingTime(group));",
    "      addItem('Seats', membersCount + ' taken · ' + freeSeats + ' free');",
    "      addItem('Members', formatMembersList(group));",
    "      const note = document.createElement('div');",
    "      note.style.marginTop = '8px';",
    "      note.style.fontSize = '0.78rem';",
    "      note.style.color = 'var(--muted)';",
    "      note.textContent = joined ? 'Already joined this group. Open Join / Leave to leave.' : 'Not joined yet. Open Join / Leave to confirm.';",
    "      card.appendChild(head);",
    "      card.appendChild(grid);",
    "      card.appendChild(note);",
    "      target.appendChild(card);",
    "    }",
    "    function pickGroupById(groupId) {",
    "      const g = allGroupsCache.find((item) => Number(item.id) === Number(groupId));",
    "      if (!g) return;",
    "      const idInput = document.getElementById('membershipGroupId');",
    "      const prefixInput = document.getElementById('groupPrefixQuery');",
    "      if (idInput) idInput.value = String(g.id);",
    "      if (prefixInput) prefixInput.value = String(g.title || '');",
    "      renderPickedGroupCard(g);",
    "    }",
    "    function renderAllGroupsSection(groups) {",
    "      const container = document.getElementById('allGroupsList');",
    "      if (!container) return;",
    "      container.textContent = '';",
    "      if (!groups.length) {",
    "        const empty = document.createElement('div');",
    "        empty.className = 'state-box';",
    "        empty.textContent = 'No study groups available yet.';",
    "        container.appendChild(empty);",
    "        return;",
    "      }",
    "      for (const g of groups) {",
    "        const membersCount = Number(g.member_count ?? g.current_members ?? 0);",
    "        const capCount = Number(g.max_capacity ?? 0);",
    "        const freeSeats = capCount > 0 ? Math.max(0, capCount - membersCount) : 0;",
    "        const isFull = capCount > 0 && membersCount >= capCount;",
    "        const pct = capCount > 0 ? Math.min(100, Math.round((membersCount / capCount) * 100)) : 0;",
    "        const joined = isUserJoined(g);",
    "        const card = document.createElement('div');",
    "        card.className = 'cohort-card';",
    "        card.onclick = () => openGroupActionModal(g.id);",
    "        const main = document.createElement('div');",
    "        main.className = 'cohort-main';",
    "        const titleDiv = document.createElement('div');",
    "        titleDiv.className = 'cohort-title';",
    "        titleDiv.textContent = (g.title || 'Untitled Group') + ' #' + g.id;",
    "        const metaRow = document.createElement('div');",
    "        metaRow.className = 'cohort-meta-row';",
    "        const makeTag = (cls, txt) => { const s = document.createElement('span'); s.className = 'tag ' + cls; s.textContent = txt; return s; };",
    "        metaRow.appendChild(makeTag('', g.subject || 'General'));",
    "        metaRow.appendChild(makeTag('time', 'Meeting: ' + getMeetingTime(g)));",
    "        if (joined) metaRow.appendChild(makeTag('joined', 'Already joined'));",
    "        main.appendChild(titleDiv);",
    "        main.appendChild(metaRow);",
    "        const side = document.createElement('div');",
    "        side.className = 'cohort-side';",
    "        const capText = document.createElement('div');",
    "        capText.className = 'capacity-text';",
    "        const leftSpan = document.createElement('span');",
    "        leftSpan.textContent = membersCount + '/' + (capCount || '∞') + ' taken';",
    "        const rightSpan = document.createElement('span');",
    "        rightSpan.textContent = freeSeats + ' free';",
    "        capText.appendChild(leftSpan);",
    "        capText.appendChild(rightSpan);",
    "        const track = document.createElement('div');",
    "        track.className = 'meter-track';",
    "        const fill = document.createElement('div');",
    "        fill.className = 'meter-fill ' + (isFull ? 'full' : '');",
    "        fill.style.width = pct + '%';",
    "        track.appendChild(fill);",
    "        side.appendChild(capText);",
    "        side.appendChild(track);",
    "        const actions = document.createElement('div');",
    "        actions.className = 'cohort-actions';",
    "        actions.onclick = (ev) => ev.stopPropagation();",
    "        const joinBtn = document.createElement('button');",
    "        joinBtn.className = 'btn-primary btn-sm';",
    "        joinBtn.type = 'button';",
    "        joinBtn.textContent = 'Join';",
    "        joinBtn.onclick = () => openGroupActionModal(g.id);",
    "        actions.appendChild(joinBtn);",
    "        if (joined) {",
    "          const leaveBtn = document.createElement('button');",
    "          leaveBtn.className = 'btn-danger-soft btn-sm';",
    "          leaveBtn.type = 'button';",
    "          leaveBtn.textContent = 'Leave';",
    "          leaveBtn.onclick = () => openGroupActionModal(g.id);",
    "          actions.appendChild(leaveBtn);",
    "        }",
    "        card.appendChild(main);",
    "        card.appendChild(side);",
    "        card.appendChild(actions);",
    "        container.appendChild(card);",
    "      }",
    "    }",
    "    function renderFilterMatches(groups) {",
    "      const container = document.getElementById('groupsCards');",
    "      if (!container) return;",
    "      container.textContent = '';",
    "      if (!groups.length) {",
    "        const empty = document.createElement('div');",
    "        empty.className = 'state-box';",
    "        empty.textContent = 'No matching groups for that prefix or ID.';",
    "        container.appendChild(empty);",
    "        return;",
    "      }",
    "      for (const g of groups) {",
    "        const membersCount = Number(g.member_count ?? g.current_members ?? 0);",
    "        const capCount = Number(g.max_capacity ?? 0);",
    "        const freeSeats = capCount > 0 ? Math.max(0, capCount - membersCount) : 0;",
    "        const joined = isUserJoined(g);",
    "        const row = document.createElement('div');",
    "        row.className = 'group-card';",
    "        const left = document.createElement('div');",
    "        const nameDiv = document.createElement('div');",
    "        nameDiv.className = 'group-name';",
    "        nameDiv.textContent = '#' + g.id + ' · ' + (g.title || 'Untitled Group');",
    "        const tags = document.createElement('div');",
    "        tags.className = 'cohort-meta-row';",
    "        const makeTag = (cls, txt) => { const s = document.createElement('span'); s.className = 'tag ' + cls; s.textContent = txt; return s; };",
    "        tags.appendChild(makeTag('', g.subject || 'General'));",
    "        tags.appendChild(makeTag('time', getMeetingTime(g)));",
    "        tags.appendChild(makeTag('open', freeSeats + ' free'));",
    "        if (joined) tags.appendChild(makeTag('joined', 'Already joined'));",
    "        left.appendChild(nameDiv);",
    "        left.appendChild(tags);",
    "        const actions = document.createElement('div');",
    "        actions.className = 'cohort-actions';",
    "        const pickBtn = document.createElement('button');",
    "        pickBtn.className = 'btn-secondary btn-sm';",
    "        pickBtn.type = 'button';",
    "        pickBtn.textContent = 'Pick';",
    "        pickBtn.onclick = () => pickGroupById(g.id);",
    "        const joinBtn = document.createElement('button');",
    "        joinBtn.className = 'btn-primary btn-sm';",
    "        joinBtn.type = 'button';",
    "        joinBtn.textContent = 'Join';",
    "        joinBtn.onclick = () => openGroupActionModal(g.id);",
    "        actions.appendChild(pickBtn);",
    "        actions.appendChild(joinBtn);",
    "        if (joined) {",
    "          const leaveBtn = document.createElement('button');",
    "          leaveBtn.className = 'btn-danger-soft btn-sm';",
    "          leaveBtn.type = 'button';",
    "          leaveBtn.textContent = 'Leave';",
    "          leaveBtn.onclick = () => openGroupActionModal(g.id);",
    "          actions.appendChild(leaveBtn);",
    "        }",
    "        row.appendChild(left);",
    "        row.appendChild(actions);",
    "        container.appendChild(row);",
    "      }",
    "    }",
    "    function syncFromIdInput() {",
    "      const idVal = Number(document.getElementById('membershipGroupId')?.value || 0);",
    "      if (!idVal) return;",
    "      const found = allGroupsCache.find((g) => Number(g.id) === idVal);",
    "      if (found) renderPickedGroupCard(found);",
    "    }",
    "    function filterGroupsByPrefix() {",
    "      const q = (document.getElementById('groupPrefixQuery')?.value || '').trim().toLowerCase();",
    "      const idInput = document.getElementById('membershipGroupId');",
    "      if (!q) { renderFilterMatches(allGroupsCache); return; }",
    "      const prefixMatches = allGroupsCache.filter((g) => String(g.title || '').trim().toLowerCase().startsWith(q));",
    "      const list = prefixMatches.length ? prefixMatches : allGroupsCache.filter((g) => String(g.title || '').toLowerCase().includes(q));",
    "      renderFilterMatches(list);",
    "      if (list.length === 1) { if (idInput) idInput.value = String(list[0].id); renderPickedGroupCard(list[0]); }",
    "    }",
    "    async function loadGroups() {",
    "      try {",
    "        const res = await fetch('/api/groups');",
    "        const data = await res.json();",
    "        const list = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : []);",
    "        allGroupsCache = list;",
    "        const hubStat = document.getElementById('hubGroupsStat');",
    "        if (hubStat) hubStat.textContent = list.length + (list.length === 1 ? ' active group' : ' active groups');",
    "        renderAllGroupsSection(list);",
    "        filterGroupsByPrefix();",
    "        const currentId = Number(document.getElementById('membershipGroupId')?.value || 0);",
    "        if (currentId) { const picked = list.find((item) => Number(item.id) === currentId); if (picked) renderPickedGroupCard(picked); }",
    "      } catch { setBanner('groupMsg', 'Could not load study groups.', 'error'); }",
    "    }",
    "    async function createNewGroup() {",
    "      setBanner('groupMsg', 'Creating study group...', 'info');",
    "      const title = document.getElementById('groupTitle').value;",
    "      const subject = document.getElementById('groupSubject').value;",
    "      const max_capacity = Number(document.getElementById('groupCapacity').value);",
    "      try {",
    "        const res = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, subject, max_capacity }) });",
    "        const data = await res.json();",
    "        if (res.ok) { setBanner('groupMsg', 'Created group #' + data.group.id + '.', 'success'); await loadGroups(); pickGroupById(data.group.id); }",
    "        else { setBanner('groupMsg', data.error || 'Could not create group.', 'error'); }",
    "      } catch { setBanner('groupMsg', 'Network error while creating group.', 'error'); }",
    "    }",
    "    async function getRecommendations() {",
    "      const formattedEl = document.getElementById('aiFormatted');",
    "      if (formattedEl) formattedEl.textContent = 'Generating recommendations...';",
    "      const preferences = document.getElementById('prefsInput').value || 'Web Programming';",
    "      try {",
    "        const res = await fetch('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferences }) });",
    "        const data = await res.json();",
    "        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.recommendation || data?.message || 'Recommendations received.';",
    "        if (formattedEl) formattedEl.textContent = String(text);",
    "      } catch { if (formattedEl) formattedEl.textContent = 'Could not load recommendations right now.'; }",
    "    }",
    "    loadGroups();",
    "  </script>",
    "</body>",
    "</html>"
  ].join("\n");
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