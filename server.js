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

  const sessionPillText = isAuth ? "Signed in: " + safeEmail : "Guest session";
  const dotClass = isAuth ? "status-dot active" : "status-dot";
  const metricSessionTitle = isAuth ? safeName : "Not signed in";
  const metricSessionSub = isAuth ? safeEmail : "Sign in to create or join";

  const accountSectionHtml = user
    ? '<div class="profile-box">' +
        '<div>' +
          '<div class="profile-email">' + safeEmail + '</div>' +
          '<div class="profile-meta">' + safeName + ' · Active session</div>' +
        '</div>' +
        '<button class="btn-secondary btn-sm" type="button" onclick="logout()">Sign out</button>' +
      '</div>'
    : '<div class="btn-row" style="margin-top: 0;">' +
        '<a class="btn btn-soft" href="/auth/google">Continue with Google</a>' +
      '</div>' +
      '<hr class="divider" />' +
      '<span class="section-label">Email &amp; Password</span>' +
      '<div class="form-grid-auth">' +
        '<input id="authName" type="text" placeholder="Full name (for registration)" aria-label="Full name" />' +
        '<input id="authEmail" type="email" placeholder="Email address" aria-label="Email address" />' +
        '<input id="authPassword" type="password" placeholder="Password (min. 6 characters)" aria-label="Password" />' +
      '</div>' +
      '<div class="btn-row">' +
        '<button class="btn-primary" type="button" onclick="loginUser()">Sign in</button>' +
        '<button class="btn-secondary" type="button" onclick="registerUser()">Create account</button>' +
      '</div>' +
      '<p id="authMsg" class="banner" role="status" aria-live="polite"></p>';

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
    "      <nav class=\"nav-group\" aria-label=\"Primary navigation\">\n" +
    "        <a class=\"nav-link\" href=\"#groups-card\">Study Groups</a>\n" +
    "        <a class=\"nav-link\" href=\"#ai-card\">AI Advisor</a>\n" +
    "        <a class=\"nav-link\" href=\"#account-card\">Account</a>\n" +
    "        <span class=\"session-pill\" id=\"sessionStatus\">\n" +
    "          <span class=\"" + dotClass + "\"></span>\n" +
    "          <span>" + sessionPillText + "</span>\n" +
    "        </span>\n" +
    "      </nav>\n" +
    "    </div>\n" +
    "  </header>\n" +
    "  <main class=\"container\">\n" +
    "    <div class=\"page-header\">\n" +
    "      <h1>Collaborative Study Groups</h1>\n" +
    "      <p>Organize study groups, manage seat capacity, and get AI-powered study recommendations.</p>\n" +
    "    </div>\n" +
    "    <section class=\"metrics-grid\" aria-label=\"Overview metrics\">\n" +
    "      <div class=\"metric-card\">\n" +
    "        <div class=\"metric-label\">Study Groups</div>\n" +
    "        <div class=\"metric-value\" id=\"statGroupsCount\">-</div>\n" +
    "        <div class=\"metric-sub\">Available cohorts</div>\n" +
    "      </div>\n" +
    "      <div class=\"metric-card\">\n" +
    "        <div class=\"metric-label\">Total Capacity</div>\n" +
    "        <div class=\"metric-value\" id=\"statSeatsCount\">-</div>\n" +
    "        <div class=\"metric-sub\">Combined seats across groups</div>\n" +
    "      </div>\n" +
    "      <div class=\"metric-card\">\n" +
    "        <div class=\"metric-label\">Account Session</div>\n" +
    "        <div class=\"metric-value\" style=\"font-size: 1.15rem; margin-top: 8px;\">" + metricSessionTitle + "</div>\n" +
    "        <div class=\"metric-sub\">" + metricSessionSub + "</div>\n" +
    "      </div>\n" +
    "    </section>\n" +
    "    <div class=\"workspace-grid\">\n" +
    "      <div class=\"column-stack\">\n" +
    "        <section class=\"card\" id=\"groups-card\">\n" +
    "          <div class=\"card-top\">\n" +
    "            <div>\n" +
    "              <h2 class=\"card-title\">Study Groups</h2>\n" +
    "              <p class=\"card-desc\">Create a group, join or leave by ID, and inspect live cohorts.</p>\n" +
    "            </div>\n" +
    "            <button class=\"btn-secondary btn-sm\" type=\"button\" onclick=\"loadGroups()\">Refresh</button>\n" +
    "          </div>\n" +
    "          <span class=\"section-label\">New Study Group</span>\n" +
    "          <div class=\"form-grid\">\n" +
    "            <input id=\"groupTitle\" type=\"text\" placeholder=\"Group title\" aria-label=\"Group title\" />\n" +
    "            <input id=\"groupSubject\" type=\"text\" placeholder=\"Subject\" aria-label=\"Subject\" />\n" +
    "            <input id=\"groupCapacity\" type=\"number\" min=\"1\" placeholder=\"Max capacity\" aria-label=\"Max capacity\" />\n" +
    "          </div>\n" +
    "          <div class=\"btn-row\">\n" +
    "            <button class=\"btn-primary\" type=\"button\" onclick=\"createNewGroup()\">Create Group</button>\n" +
    "          </div>\n" +
    "          <hr class=\"divider\" />\n" +
    "          <span class=\"section-label\">Membership Actions</span>\n" +
    "          <div class=\"btn-row\" style=\"margin-top: 0;\">\n" +
    "            <input id=\"membershipGroupId\" type=\"number\" min=\"1\" placeholder=\"Group ID\" aria-label=\"Group ID\" style=\"max-width: 140px;\" />\n" +
    "            <button class=\"btn-secondary\" type=\"button\" onclick=\"joinSelectedGroup()\">Join Group</button>\n" +
    "            <button class=\"btn-secondary\" type=\"button\" onclick=\"leaveSelectedGroup()\">Leave Group</button>\n" +
    "          </div>\n" +
    "          <p id=\"groupMsg\" class=\"banner\" role=\"status\" aria-live=\"polite\"></p>\n" +
    "          <hr class=\"divider\" />\n" +
    "          <span class=\"section-label\">Active Groups</span>\n" +
    "          <div id=\"groupsCards\" class=\"group-list\" aria-live=\"polite\">\n" +
    "            <div class=\"state-box\">Loading groups...</div>\n" +
    "          </div>\n" +
    "          <details>\n" +
    "            <summary>Inspect JSON response</summary>\n" +
    "            <pre id=\"groupsOutput\">Loading...</pre>\n" +
    "          </details>\n" +
    "        </section>\n" +
    "      </div>\n" +
    "      <div class=\"column-stack\">\n" +
    "        <section class=\"card\" id=\"account-card\">\n" +
    "          <div class=\"card-top\">\n" +
    "            <div>\n" +
    "              <h2 class=\"card-title\">Account &amp; Session</h2>\n" +
    "              <p class=\"card-desc\">" + (isAuth ? "Your authenticated session details." : "Sign in to manage group membership.") + "</p>\n" +
    "            </div>\n" +
    "          </div>\n" +
    "          " + accountSectionHtml + "\n" +
    "        </section>\n" +
    "        <section class=\"card\" id=\"ai-card\">\n" +
    "          <div class=\"card-top\">\n" +
    "            <div>\n" +
    "              <h2 class=\"card-title\">AI Study Recommendations</h2>\n" +
    "              <p class=\"card-desc\">Enter your topic, schedule, or level to get study suggestions.</p>\n" +
    "            </div>\n" +
    "          </div>\n" +
    "          <input id=\"prefsInput\" type=\"text\" placeholder=\"Topic, schedule, level (e.g. Web Programming)\" aria-label=\"Study preferences\" />\n" +
    "          <div class=\"btn-row\">\n" +
    "            <button class=\"btn-primary\" type=\"button\" onclick=\"getRecommendations()\">Get Recommendations</button>\n" +
    "          </div>\n" +
    "          <div id=\"aiFormatted\" class=\"ai-result\" aria-live=\"polite\">Enter preferences above and click Get Recommendations.</div>\n" +
    "          <details>\n" +
    "            <summary>Inspect raw model payload</summary>\n" +
    "            <pre id=\"aiOutput\">No request sent yet.</pre>\n" +
    "          </details>\n" +
    "        </section>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </main>\n" +
    "  <script>\n" +
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
    "        if (res.ok) { setBanner(\"authMsg\", \"Signed in successfully.\", \"success\"); location.reload(); }\n" +
    "        else { setBanner(\"authMsg\", data.error || \"Login failed.\", \"error\"); }\n" +
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
    "      } catch { setBanner(\"authMsg\", \"Network error while registering.\", \"error\"); }\n" +
    "    }\n" +
    "    async function logout() { await fetch(\"/auth/logout\", { method: \"POST\" }); location.reload(); }\n" +
    "    function renderGroupCards(groups) {\n" +
    "      const container = document.getElementById(\"groupsCards\");\n" +
    "      container.textContent = \"\";\n" +
    "      const countEl = document.getElementById(\"statGroupsCount\");\n" +
    "      const seatsEl = document.getElementById(\"statSeatsCount\");\n" +
    "      if (countEl) countEl.textContent = String(groups.length);\n" +
    "      if (seatsEl) {\n" +
    "        const totalCap = groups.reduce((acc, g) => acc + (Number(g.max_capacity) || 0), 0);\n" +
    "        seatsEl.textContent = String(totalCap);\n" +
    "      }\n" +
    "      if (!groups.length) {\n" +
    "        const empty = document.createElement(\"div\");\n" +
    "        empty.className = \"state-box\";\n" +
    "        empty.textContent = \"No study groups yet. Create the first group above.\";\n" +
    "        container.appendChild(empty);\n" +
    "        return;\n" +
    "      }\n" +
    "      for (const g of groups) {\n" +
    "        const item = document.createElement(\"div\");\n" +
    "        item.className = \"group-card\";\n" +
    "        const info = document.createElement(\"div\");\n" +
    "        const title = document.createElement(\"div\");\n" +
    "        title.className = \"group-name\";\n" +
    "        title.textContent = \"#\" + g.id + \" · \" + (g.title || \"Untitled Group\");\n" +
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
    "        selectBtn.textContent = \"Select ID\";\n" +
    "        selectBtn.onclick = () => { const idInput = document.getElementById(\"membershipGroupId\"); if (idInput) idInput.value = String(g.id); };\n" +
    "        const joinBtn = document.createElement(\"button\");\n" +
    "        joinBtn.type = \"button\";\n" +
    "        joinBtn.className = \"btn-primary btn-sm\";\n" +
    "        joinBtn.textContent = \"Join\";\n" +
    "        joinBtn.disabled = isFull;\n" +
    "        joinBtn.onclick = async () => { const idInput = document.getElementById(\"membershipGroupId\"); if (idInput) idInput.value = String(g.id); await joinSelectedGroup(); };\n" +
    "        actions.appendChild(selectBtn);\n" +
    "        actions.appendChild(joinBtn);\n" +
    "        item.appendChild(info);\n" +
    "        item.appendChild(actions);\n" +
    "        container.appendChild(item);\n" +
    "      }\n" +
    "    }\n" +
    "    async function loadGroups() {\n" +
    "      const container = document.getElementById(\"groupsCards\");\n" +
    "      if (container) {\n" +
    "        container.textContent = \"\";\n" +
    "        const loading = document.createElement(\"div\");\n" +
    "        loading.className = \"state-box\";\n" +
    "        loading.textContent = \"Loading groups...\";\n" +
    "        container.appendChild(loading);\n" +
    "      }\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups\");\n" +
    "        const data = await res.json();\n" +
    "        document.getElementById(\"groupsOutput\").textContent = JSON.stringify(data, null, 2);\n" +
    "        const list = Array.isArray(data) ? data : (Array.isArray(data.groups) ? data.groups : []);\n" +
    "        renderGroupCards(list);\n" +
    "      } catch { setBanner(\"groupMsg\", \"Failed to load study groups.\", \"error\"); }\n" +
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
    "      const groupId = Number(document.getElementById(\"membershipGroupId\").value);\n" +
    "      if (!groupId) { setBanner(\"groupMsg\", \"Enter or select a valid Group ID first.\", \"error\"); return; }\n" +
    "      setBanner(\"groupMsg\", \"Joining group #\" + groupId + \"...\", \"info\");\n" +
    "      try {\n" +
    "        const res = await fetch(\"/api/groups/\" + groupId + \"/join\", { method: \"POST\" });\n" +
    "        const data = await res.json();\n" +
    "        setBanner(\"groupMsg\", res.ok ? (data.message || \"Joined group.\") : (data.error || \"Could not join group.\"), res.ok ? \"success\" : \"error\");\n" +
    "        await loadGroups();\n" +
    "      } catch { setBanner(\"groupMsg\", \"Network error while joining group.\", \"error\"); }\n" +
    "    }\n" +
    "    async function leaveSelectedGroup() {\n" +
    "      const groupId = Number(document.getElementById(\"membershipGroupId\").value);\n" +
    "      if (!groupId) { setBanner(\"groupMsg\", \"Enter or select a valid Group ID first.\", \"error\"); return; }\n" +
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
    "        document.getElementById(\"aiOutput\").textContent = JSON.stringify(data, null, 2);\n" +
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