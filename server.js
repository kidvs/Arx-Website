/**
 * ARX Collective — Express Backend
 * server.js
 *
 * Endpoints:
 *   POST /api/apply                          — Student application (multipart) w/ whitelist check + AI detection
 *   GET  /api/status                         — Club operational metrics
 *   GET  /api/meetings                       — Public meetings feed
 *   GET  /api/lookup                         — Application status lookup by telegram handle
 *   POST /api/tg/webhook                     — Telegram bot webhook (captures chat_id)
 *   GET  /admin/api/…                        — Protected admin routes
 *   GET  /admin/api/whitelist                — List authorised usernames
 *   POST /admin/api/whitelist/add            — Add a username to the whitelist
 *   POST /admin/api/whitelist/remove         — Remove a username from the whitelist
 */

'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════════════════
   ADMIN CREDENTIALS
   Production: set ADMIN_USERNAME + ADMIN_PASSWORD_HASH
   (pre-computed bcrypt hash, 12 rounds) in your .env.
   Development: set ADMIN_PASSWORD and the server hashes
   it once synchronously at startup.
══════════════════════════════════════════════════ */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'arx_admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH
  || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Admin@ARX2026!', 12);

if (!process.env.ADMIN_PASSWORD_HASH) {
  console.warn('[ARX-ADMIN] ⚠  ADMIN_PASSWORD_HASH not set — hashing ADMIN_PASSWORD at startup (dev mode only).');
}

/* ══════════════════════════════════════════════════
   ADMIN ROUTING & IP SECURITY CONFIG
   1. Obscure custom path: non-standard route URL
   2. IP Whitelisting: restrict to trusted IP addresses
══════════════════════════════════════════════════ */
const ADMIN_SECRET_PATH_RAW = process.env.ADMIN_SECRET_PATH || '/arx-ops-console-7729';
const ADMIN_BASE_PATH = ('/' + ADMIN_SECRET_PATH_RAW.replace(/^\/+|\/+$/g, '')).toLowerCase();

const ADMIN_ALLOWED_IPS_RAW = process.env.ADMIN_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1';

/**
 * normalizeIp(ip)
 * Strips the IPv6-mapped IPv4 prefix (::ffff:) so all addresses are stored
 * and compared in their canonical bare form. Called at both Set-build time
 * and at request time to guarantee a single consistent representation.
 *
 * Examples:
 *   '::ffff:127.0.0.1'  → '127.0.0.1'
 *   '::FFFF:10.0.0.5'   → '10.0.0.5'
 *   '::1'               → '::1'   (pure IPv6 — unchanged)
 *   '192.168.1.100'     → '192.168.1.100'
 */
function normalizeIp(ip) {
  if (typeof ip !== 'string' || !ip) return '';
  let n = ip.trim().toLowerCase();
  // Strip IPv6-mapped IPv4 prefix (handles upper/lower case variants)
  if (n.startsWith('::ffff:')) {
    n = n.slice(7); // '::ffff:'.length === 7
  }
  return n;
}

/**
 * ADMIN_ALLOWED_IPS — canonical Set built once at startup.
 * Every entry is normalized through normalizeIp() so that .env entries
 * like '::ffff:127.0.0.1' and '127.0.0.1' both resolve to '127.0.0.1',
 * eliminating any dead/duplicate whitelist entries.
 */
const ADMIN_ALLOWED_IPS = new Set(
  ADMIN_ALLOWED_IPS_RAW
    .split(',')
    .map(ip => normalizeIp(ip))
    .filter(Boolean)
);

// Warn if running in production with a wildcard IP whitelist (open to any IP)
if (process.env.NODE_ENV === 'production' && ADMIN_ALLOWED_IPS.has('*')) {
  console.warn('[ARX-SECURITY] ⚠  ADMIN_ALLOWED_IPS is set to "*" in production — the admin portal is accessible from ANY IP address. Set explicit static IPs in .env!');
}

/**
 * getClientIp(req)
 * Returns the normalized canonical IP of the connecting client.
 *
 * Resolution order (most reliable first):
 *   1. req.ip  — Express's proxy-aware value (respects `trust proxy` setting).
 *                This is the ONLY value that correctly accounts for the
 *                X-Forwarded-For hop count configured via `app.set('trust proxy', N)`.
 *                Trusting raw X-Forwarded-For headers directly is a spoofing vector.
 *   2. req.socket.remoteAddress — raw TCP socket address, used only if req.ip
 *                is missing (should not happen in normal Express usage).
 *
 * The result is always passed through normalizeIp() so ::ffff: prefixes are
 * stripped and all comparisons are against the same canonical representation.
 */
function getClientIp(req) {
  // Prefer Express's proxy-resolved IP (trusts only the configured hop count)
  const raw = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return normalizeIp(raw);
}

/**
 * isIpWhitelisted(clientIp)
 * Checks if a normalized client IP is authorized to access the admin portal.
 *
 * Because both the whitelist Set and clientIp are normalized by the same
 * normalizeIp() function, a single Set.has() lookup is sufficient for all
 * address forms — IPv4, IPv6, and IPv6-mapped IPv4.
 *
 * Wildcard '*' or an empty set → allow any IP (dev/open mode).
 */
function isIpWhitelisted(clientIp) {
  if (ADMIN_ALLOWED_IPS.has('*') || ADMIN_ALLOWED_IPS.size === 0) return true;
  return ADMIN_ALLOWED_IPS.has(clientIp);
}

/**
 * adminIpWhitelistMiddleware(req, res, next)
 * Blocks unauthorized IP addresses with HTTP 403 Forbidden.
 */
function adminIpWhitelistMiddleware(req, res, next) {
  const clientIp = getClientIp(req);
  if (!isIpWhitelisted(clientIp)) {
    console.warn(`[ARX-SECURITY] ⛔ Blocked unauthorized IP access to admin route: ${clientIp} -> ${req.originalUrl}`);
    const wantsHTML = (req.headers.accept || '').includes('text/html');
    if (wantsHTML) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>403 Forbidden</title>
          <style>
            body { background: #07070f; color: #ff3366; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .box { border: 1px solid #ff3366; padding: 2rem; background: #0d0d1a; text-align: center; border-radius: 6px; max-width: 500px; box-shadow: 0 0 30px rgba(255, 51, 102, 0.2); }
            h1 { font-size: 1.5rem; margin-bottom: 0.75rem; letter-spacing: 2px; }
            p { color: #8888aa; font-size: 0.85rem; line-height: 1.6; }
            .ip { color: #00d4ff; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>403 // ACCESS DENIED</h1>
            <p>Your client IP (<span class="ip">${clientIp || 'UNKNOWN'}</span>) is not authorized on this console gateway.</p>
            <p>This incident has been logged.</p>
          </div>
        </body>
        </html>
      `);
    }
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Access Denied: Your IP address is not authorized to access this administrative portal.'
    });
  }
  next();
}

/* ══════════════════════════════════════════════════
   SESSION SECRET
══════════════════════════════════════════════════ */
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.warn('[ARX-ADMIN] ⚠  SESSION_SECRET not set — using insecure fallback. Set it in production!');
}

/* ══════════════════════════════════════════════════
   TELEGRAM BOT CONFIG
   Set TELEGRAM_BOT_TOKEN in .env to enable automatic
   welcome message dispatch upon applicant acceptance.
══════════════════════════════════════════════════ */
let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'Arx_IT_BoT';
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[ARX-TG] ⚠  TELEGRAM_BOT_TOKEN not set — Telegram welcome messages will be skipped.');
}


/* ══════════════════════════════════════════════════
   INVITE-ONLY USERNAME WHITELIST
   Only usernames present in this Set are permitted
   to submit an application. All others receive a
   generic denial — the existence of the whitelist
   is never disclosed to the applicant.

   Populate via .env:
     AUTHORIZED_USERNAMES=alice,bob,charlie
   Alternatively, manage at runtime through the
   protected admin API routes:
     GET  /admin/api/whitelist
     POST /admin/api/whitelist/add
     POST /admin/api/whitelist/remove
══════════════════════════════════════════════════ */
const AUTHORIZED_USERNAMES = new Set(
  (process.env.AUTHORIZED_USERNAMES || '*')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean)
);

if (AUTHORIZED_USERNAMES.has('*') || AUTHORIZED_USERNAMES.has('all') || AUTHORIZED_USERNAMES.size === 0) {
  console.log('[ARX-WHITELIST] Open recruitment active: ANY person / username is authorized to apply.');
} else {
  console.log(`[ARX-WHITELIST] Loaded ${AUTHORIZED_USERNAMES.size} authorised username(s).`);
}

/**
 * isWhitelisted(username)
 * Case-insensitive check against the authorised username set.
 * Returns true if the supplied username is permitted to apply.
 * If AUTHORIZED_USERNAMES includes '*' or is empty, allows ANY person.
 */
function isWhitelisted(username) {
  if (!username || typeof username !== 'string') return false;
  if (AUTHORIZED_USERNAMES.has('*') || AUTHORIZED_USERNAMES.has('all') || AUTHORIZED_USERNAMES.size === 0) {
    return true;
  }
  const clean = username.trim().toLowerCase();
  if (AUTHORIZED_USERNAMES.has(clean)) return true;
  if (typeof findBestRosterMatch === 'function' && findBestRosterMatch(username)) return true;
  return false;
}

/* Maps Telegram handle (lowercase, no @) → chat_id captured from /start webhook */
const telegramChatStore = new Map();

/* ══════════════════════════════════════════════════
   FILE UPLOAD CONFIG (multer)
   Max 3 files × 5 MB, JPEG / PNG / WebP / PDF only
══════════════════════════════════════════════════ */
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'certificates');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMES = new Set(['image/jpeg','image/png','image/webp','application/pdf']);
const ALLOWED_EXTS  = new Set(['.jpg','.jpeg','.png','.webp','.pdf']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES     = 3;

const certStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req,  file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const safeName = `cert-${Date.now()}-${uuidv4().replace(/-/g,'').slice(0,12)}${ext}`;
    cb(null, safeName);
  },
});

const certUpload = multer({
  storage: certStorage,
  limits:  { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIMES.has(file.mimetype) && ALLOWED_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`INVALID_FILE_TYPE: only JPEG, PNG, WebP, and PDF are accepted (got ${file.mimetype})`));
    }
  },
});

/* ══════════════════════════════════════════════════
   CALLSIGN GENERATOR
   Generates a unique ARX Operative Callsign.
══════════════════════════════════════════════════ */
const CODENAMES = [
  'CIPHER','VORTEX','GHOST','NOVA','NEXUS','RAVEN','ALPHA','SIGMA',
  'ECHO','PHANTOM','DELTA','PRISM','VECTOR','BYTE','PULSE','FORGE',
  'APEX','BLAZE','CHAIN','DUSK','EMBER','FLUX','GLYPH','HELIX',
  'INDEX','JADE','KARMA','LYRA','MATRIX','NULL','OMEGA','PROXY',
  'QUARK','RELAY','SHARD','TRACE','ULTRA','VITAL','WARP','XENON',
  'YIELD','ZENITH','BLADE','COMET','DRONE','EPOCH','FROST','GATE',
];

const ROSTER_FILE = path.join(__dirname, 'data', 'roster.json');
let studentRoster = [];

function loadRoster() {
  try {
    if (fs.existsSync(ROSTER_FILE)) {
      const raw = fs.readFileSync(ROSTER_FILE, 'utf-8');
      studentRoster = JSON.parse(raw);
      console.log(`[ARX-ROSTER] Loaded ${studentRoster.length} designated student roster records.`);
    } else {
      console.warn('[ARX-ROSTER] Roster file data/roster.json not found.');
    }
  } catch (err) {
    console.error('[ARX-ROSTER] Error loading roster:', err.message);
  }
}

function normalizeName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDist(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }
  return d[m][n];
}

function nameSimilarity(a, b) {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - (levenshteinDist(a, b) / maxLen);
}

/**
 * findBestRosterMatch(inputName, extraContext)
 * Performs multi-tier fuzzy matching against the student roster:
 * 1. Exact normalized match (ignoring case, extra spaces, special chars)
 * 2. Token overlap & permutation match (e.g. reversed names or middle initials)
 * 3. Levenshtein edit distance similarity (handles minor spelling/transliteration differences)
 * 4. Section disambiguation (e.g. 10E, 9B, 11A) if multiple students share the same name
 */
function findBestRosterMatch(inputName, extraContext = '') {
  if (!studentRoster || studentRoster.length === 0) return null;
  const normInput = normalizeName(inputName);
  if (!normInput || normInput.length < 3) return null;

  const combinedText = `${inputName} ${extraContext}`.toUpperCase();
  const sectionMatch = combinedText.match(/\b(9|10|11|12)[A-E]\b/);
  const targetSection = sectionMatch ? sectionMatch[0] : null;

  const inputTokens = normInput.split(' ').filter(Boolean);

  let bestMatch = null;
  let bestScore = -1;

  for (const entry of studentRoster) {
    const normEntry = normalizeName(entry.fullName);
    const entryTokens = normEntry.split(' ').filter(Boolean);

    // Bonus if applicant specified their grade/section
    const sectionBonus = (targetSection && entry.section === targetSection) ? 0.06 : 0;

    // 1. Exact normalized match
    if (normInput === normEntry) {
      const score = 1.0 + sectionBonus;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { entry, score: Math.min(1.0, score), matchType: 'EXACT' };
      }
      continue;
    }

    // 2. Token set overlap (word-level matching)
    let matchedTokenCount = 0;
    for (const et of entryTokens) {
      if (inputTokens.some(it => it === et || nameSimilarity(it, et) >= 0.82)) {
        matchedTokenCount++;
      }
    }
    const tokenScore = matchedTokenCount / Math.max(entryTokens.length, inputTokens.length);
    const isFullTokenMatch = (matchedTokenCount >= entryTokens.length) && (entryTokens.length >= 2);

    // 3. String-level Levenshtein similarity
    const strSim = nameSimilarity(normInput, normEntry);

    // Combined score
    let score = Math.max(strSim, tokenScore) + sectionBonus;
    if (isFullTokenMatch) {
      score = Math.max(score, 0.92 + sectionBonus);
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { entry, score: Math.min(1.0, score), matchType: score >= 0.95 ? 'HIGH_SIMILARITY' : 'FUZZY' };
    }
  }

  // Threshold: at least 0.75 similarity
  if (bestScore >= 0.75) {
    return bestMatch;
  }
  return null;
}

function generateCallsign(appId, name = '', context = '') {
  if (name) {
    const rosterMatch = findBestRosterMatch(name, context);
    if (rosterMatch && rosterMatch.entry && rosterMatch.entry.callsign) {
      return rosterMatch.entry.callsign;
    }
  }
  const codename = CODENAMES[Math.floor(Math.random() * CODENAMES.length)];
  const hex = String(appId).padStart(4, '0');
  return `ARX-${codename}-${hex}`;
}

/* ══════════════════════════════════════════════════
   PERSISTENT STORAGE (JSON Files in data/)
══════════════════════════════════════════════════ */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const APPS_FILE = path.join(DATA_DIR, 'applications.json');
const TG_CHATS_FILE = path.join(DATA_DIR, 'tg-chats.json');

function saveApplications() {
  try {
    fs.writeFileSync(APPS_FILE, JSON.stringify(applicationStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ARX-STORAGE] Error saving applications:', err.message);
  }
}

function loadApplications() {
  try {
    if (fs.existsSync(APPS_FILE)) {
      const raw = fs.readFileSync(APPS_FILE, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const valid = list.filter(a => a && a.id);
        applicationStore.length = 0;
        applicationStore.push(...valid);
        appIdCounter = valid.length > 0 ? Math.max(...valid.map(a => a.id || 0)) + 1 : 1;
        console.log(`[ARX-STORAGE] Loaded ${applicationStore.length} saved applications.`);
      }
    }
  } catch (err) {
    console.error('[ARX-STORAGE] Error loading applications:', err.message);
  }
}

function saveTelegramChats() {
  try {
    fs.writeFileSync(TG_CHATS_FILE, JSON.stringify([...telegramChatStore.entries()], null, 2), 'utf-8');
  } catch (err) {
    console.error('[ARX-STORAGE] Error saving tg chats:', err.message);
  }
}

function loadTelegramChats() {
  try {
    if (fs.existsSync(TG_CHATS_FILE)) {
      const raw = fs.readFileSync(TG_CHATS_FILE, 'utf-8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const [k, v] of entries) {
          telegramChatStore.set(k, v);
        }
        console.log(`[ARX-STORAGE] Loaded ${telegramChatStore.size} saved Telegram chat mappings.`);
      }
    }
  } catch (err) {
    console.error('[ARX-STORAGE] Error loading tg chats:', err.message);
  }
}

/* ══════════════════════════════════════════════════
   TELEGRAM MESSAGING & BOT INTEGRATION
══════════════════════════════════════════════════ */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendTelegramMessage(chatId, htmlText) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const d = await res.json();
    if (d.ok) {
      console.log(`[ARX-TG] ✔ Message successfully sent to chatId ${chatId}`);
      return true;
    } else {
      console.error(`[ARX-TG] ✖ Failed to send message to chatId ${chatId}:`, d.description || d);
      return false;
    }
  } catch (err) {
    console.error(`[ARX-TG] ✖ Network error sending message to ${chatId}:`, err.message);
    return false;
  }
}

async function sendTelegramWelcome(chatId, app) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  const callsign = app.specialUsername || app.callsign || generateCallsign(app.id, app.fullName || app.username);
  const applicantName = escapeHtml(app.fullName || app.username || 'Operative');
  const botHandle = TELEGRAM_BOT_USERNAME || 'Arx_IT_BoT';

  console.log(`[ARX-TG] 🚀 Dispatching acceptance welcome to chatId ${chatId} for ${applicantName} (Callsign: ${callsign})`);

  const text =
`⚡️ <b>ARX COLLECTIVE // CLEARANCE GRANTED</b> ⚡️
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Welcome to the Collective, Operative.
Your application has been reviewed and officially <b>ACCEPTED</b>.

🎖 <b>ASSIGNED CALLSIGN:</b> <code>${escapeHtml(callsign)}</code>
👤 <b>APPLICANT:</b> ${applicantName}
🏷 <b>CLEARANCE LEVEL:</b> OPERATIVE_TIER_1
🌐 <b>BOT INTERFACE:</b> @${botHandle}

<b>NEXT DIRECTIVES:</b>
1. Securely record your Operative Callsign: <code>${escapeHtml(callsign)}</code>
2. Await access coordinates for private domain sprints.
3. Stay tuned to this bot channel for mission updates.

<i>// ALL SYSTEMS OPERATIONAL. WELCOME ABOARD.</i>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  return sendTelegramMessage(chatId, text);
}

/* ══════════════════════════════════════════════════
   TELEGRAM UPDATE HANDLER
   Handles updates from both polling and webhook
══════════════════════════════════════════════════ */
async function handleTelegramUpdate(update) {
  try {
    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat && msg.chat.id;
    const fromUser = msg.from;
    const username = (fromUser && fromUser.username || '').toLowerCase();
    const firstName = fromUser?.first_name || 'Operative';
    const text = (msg.text || '').trim();

    if (!chatId) return;

    // Map username & numeric chatId
    if (username) telegramChatStore.set(username, chatId);
    telegramChatStore.set(String(chatId), chatId);
    saveTelegramChats();

    console.log(`[ARX-TG] Received message from @${username || '(no-username)'} (chatId: ${chatId}): "${text}"`);

    // Handle deep-link verification: /start VERIFY_{appId}_{token}
    const verifyMatch = text.match(/^\/start\s+VERIFY_(\d+)_([a-f0-9]+)$/i);
    if (verifyMatch) {
      const [, appIdStr, token] = verifyMatch;
      const stored = verifyTokenStore.get(appIdStr);
      if (stored && stored.token === token && Date.now() < stored.expiresAt) {
        const appEntry = applicationStore.find(a => a.id === Number(appIdStr));
        if (appEntry) {
          const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
          if (tgHandle) telegramChatStore.set(tgHandle, chatId);
          saveTelegramChats();

          if (appEntry.status === 'ACCEPTED') {
            const sent = await sendTelegramWelcome(chatId, appEntry);
            appEntry.tgMessageSent = sent;
            saveApplications();
            verifyTokenStore.delete(appIdStr);
            return;
          }
        }
      }
    }

    // Match against applications in applicationStore
    const matchingApp = applicationStore.find(a => {
      const h = (a.telegram || '').toLowerCase().replace(/^@/, '');
      const u = (a.username || '').toLowerCase();
      return (username && (h === username || u === username)) || (String(chatId) === h);
    });

    if (matchingApp) {
      const h = (matchingApp.telegram || '').toLowerCase().replace(/^@/, '');
      if (h) telegramChatStore.set(h, chatId);
      saveTelegramChats();

      // STRICT REQUIREMENT: Only send Telegram message if the application has been officially ACCEPTED by admin!
      if (matchingApp.status === 'ACCEPTED') {
        if (!matchingApp.tgMessageSent) {
          const sent = await sendTelegramWelcome(chatId, matchingApp);
          matchingApp.tgMessageSent = sent;
          saveApplications();
        }
        return;
      }

      console.log(`[ARX-TG] Chat ID ${chatId} stored for @${username || '(no-username)'}. Candidate status is "${matchingApp.status}" (NOT accepted). No Telegram message sent.`);
      return;
    }

    // If no matching application or candidate not accepted yet:
    // Do NOT send any Telegram messages. Admin must explicitly review and accept first.
    console.log(`[ARX-TG] Chat ID ${chatId} stored for @${username || '(no-username)'}. No accepted application found — no message sent.`);
  } catch (err) {
    console.error('[ARX-TG] Error processing update:', err);
  }
}

/* ══════════════════════════════════════════════════
   TELEGRAM LONG POLLING WORKER
══════════════════════════════════════════════════ */
let tgPollingOffset = 0;
let tgPollingActive = false;

async function startTelegramPolling() {
  if (!TELEGRAM_BOT_TOKEN) return;
  if (tgPollingActive) return;
  tgPollingActive = true;
  console.log(`[ARX-TG] Starting Telegram polling worker for @${TELEGRAM_BOT_USERNAME}...`);

  // Clear webhook so getUpdates succeeds
  try {
    const delRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=false`);
    const delData = await delRes.json();
    console.log(`[ARX-TG] Telegram webhook cleared: ${delData.description || delData.ok}`);
  } catch (err) {
    console.warn(`[ARX-TG] Could not delete webhook: ${err.message}`);
  }

  (async function pollLoop() {
    while (tgPollingActive) {
      try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${tgPollingOffset}&timeout=20&allowed_updates=["message"]`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          console.warn(`[ARX-TG] Polling response error: ${res.status}`);
          await new Promise(r => setTimeout(r, 4000));
          continue;
        }

        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            tgPollingOffset = update.update_id + 1;
            await handleTelegramUpdate(update);
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('[ARX-TG] Polling error:', err.message);
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
}

async function initTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (data.ok && data.result) {
      TELEGRAM_BOT_USERNAME = data.result.username || TELEGRAM_BOT_USERNAME;
      console.log(`[ARX-TG] ✔ Verified Telegram Bot: @${TELEGRAM_BOT_USERNAME} ("${data.result.first_name}")`);
      startTelegramPolling();
    } else {
      console.error('[ARX-TG] Failed to verify bot token:', data);
    }
  } catch (err) {
    console.error('[ARX-TG] Network error querying getMe:', err.message);
  }
}

/* ══════════════════════════════════════════════════
   DEEP-LINK VERIFICATION TOKEN STORE
   appId → { token, expiresAt }
══════════════════════════════════════════════════ */
const verifyTokenStore = new Map();

/* ══════════════════════════════════════════════════
   APPLICATION STORE & PERSISTENCE
══════════════════════════════════════════════════ */
const applicationStore = [];
let appIdCounter = 1;

// Load existing data from disk
loadTelegramChats();
loadRoster();
loadApplications();

/**
 * storeApplication({ username, phone, telegram, essay, certificates, ip, detection, status })
 * Persists a submitted application internally for admin review.
 */
function storeApplication({ username, phone, telegram, essay, certificates, ip, detection, status }) {
  const id = appIdCounter++;
  const rawName = (username || '').trim();
  const rosterMatch = findBestRosterMatch(rawName, `${essay || ''} ${phone || ''}`);
  const assignedUsername = rosterMatch ? rosterMatch.entry.callsign : null;
  const section = rosterMatch ? rosterMatch.entry.section : null;
  const rosterName = rosterMatch ? rosterMatch.entry.fullName : null;

  if (rosterMatch) {
    console.log(`[ARX-ROSTER] Applicant "${rawName}" matched roster: ${rosterName} (${section}) -> Assigned Username: ${assignedUsername} (Score: ${rosterMatch.score.toFixed(2)}, Type: ${rosterMatch.matchType})`);
  }

  const newApp = {
    id,
    timestamp: new Date().toISOString(),
    username: rawName,
    fullName: rawName,
    section: section,
    rosterName: rosterName,
    phone: (phone || '').trim(),
    telegram: (telegram || '').trim(),
    essay: essay.trim(),
    certificates: certificates || [],  // [{ id, originalName, fileName, mimeType, size, url }]
    ip,
    aiScore: detection.score,
    aiLabel: detection.label,
    aiFlags: detection.flags,
    status: status || 'PENDING',       // ALWAYS starts as PENDING — admin decides!
    specialUsername: null,             // Assigned ONLY when admin clicks ACCEPT
    callsign: null,                    // Assigned ONLY when admin clicks ACCEPT
    rosterCallsign: assignedUsername,  // Reserved callsign from roster, activated on ACCEPTED
    acceptedAt: null,
    tgMessageSent: false,
  };
  applicationStore.push(newApp);
  saveApplications();
  return id;
}

/* ══════════════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════
   SECURITY MIDDLEWARE — Helmet, CORS, Body Limits
   All applied before any route handler.
══════════════════════════════════════════════════ */
app.disable('x-powered-by'); // Belt-and-suspenders: helmet also removes it

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:      ["'self'"],
      styleSrc:        ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:         ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc:       ["'self'"],
      connectSrc:      ["'self'"],
      imgSrc:          ["'self'", 'data:', 'blob:', 'https:'],
      frameSrc:        ["'self'"],
      objectSrc:       ["'self'"],
      baseUri:         ["'self'"],
      formAction:      ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: {
    maxAge: 31536000,          // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

/* CORS — only allow same-origin in production; loosen for local dev */
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, mobile apps)
    if (!origin) return callback(null, false);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin "${origin}" not allowed`));
  },
  credentials: false,   // no cross-origin cookies
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
}));

/* Strict body-size limits — mitigate DoS / buffer-exhaustion */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

/* Session middleware (required for admin auth) — MUST be mounted before authenticated routes */
app.use(session({
  secret: SESSION_SECRET || 'arx-dev-insecure-fallback-change-me',
  resave: false,
  saveUninitialized: false,
  name: 'arx.sid',        // non-default cookie name reduces fingerprinting
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 2 * 60 * 60 * 1000,     // 2 hours
  },
}));

/* Serve uploaded certificates — static route */
app.use('/uploads/certificates', express.static(UPLOAD_DIR));

app.use(express.static(path.join(__dirname, 'public')));

/* ══════════════════════════════════════════════════
   IN-MEMORY STRIKE / LOCKOUT STORE
   Key: IP address  →  { strikes: Number, lockedUntil: Number|null }
   In production replace with Redis or a persistent store.
══════════════════════════════════════════════════ */
const strikeStore = new Map();

const MAX_STRIKES = 1;                     // one strike = immediate ban on AI detection
const LOCKOUT_DURATION = 24 * 60 * 60 * 1000;  // 24 h in ms

function getRecord(ip) {
  if (!strikeStore.has(ip)) {
    strikeStore.set(ip, { strikes: 0, lockedUntil: null });
  }
  return strikeStore.get(ip);
}

function isLockedOut(record) {
  if (!record.lockedUntil) return false;
  if (Date.now() < record.lockedUntil) return true;
  // Lockout expired — reset automatically
  record.strikes = 0;
  record.lockedUntil = null;
  return false;
}

function addStrike(record) {
  record.strikes += 1;
  if (record.strikes >= MAX_STRIKES) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION;
  }
  return record.strikes;
}

/* ══════════════════════════════════════════════════
   RATE LIMITERS
   — General:     50 req / 15 min  (all /api routes)
   — Apply:        5 req / 15 min  (POST /api/apply)
   — Lookup:      20 req / 15 min  (GET /api/lookup)
   — Admin login:  5 req / 15 min  (POST /admin/login)
══════════════════════════════════════════════════ */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again later.' },
});

/* Strict per-IP limiter for the application submission endpoint */
const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  message: { error: 'RATE_LIMIT_EXCEEDED', status: 'BANNED', message: 'Too many application attempts. Try again in 15 minutes.' },
});

/* Lookup limiter — prevent handle enumeration */
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many lookup requests. Try again later.' },
});

app.use('/api', apiLimiter);

/* ══════════════════════════════════════════════════
   ADMIN BRUTE-FORCE PROTECTION & PROGRESSIVE LOCKOUT
   Dual-layer protection against automated brute-force attacks:
   1. In-memory progressive penalty tracking:
      — 3 failed attempts: 60-second cooldown penalty
      — 5 failed attempts: 15-minute lockout
      — 8+ failed attempts: 1-hour ban
   2. Express rate-limit per normalized client IP
   3. 600ms artificial anti-timing jitter delay
══════════════════════════════════════════════════ */
const adminLoginAttempts = new Map(); // ip -> { count: number, lockedUntil: number | null }

function checkAdminBruteForce(ip) {
  const record = adminLoginAttempts.get(ip);
  if (!record) return { locked: false };
  const now = Date.now();
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return { locked: true, remainingSec, attempts: record.count };
  }
  return { locked: false };
}

function recordAdminFailedLogin(ip) {
  const now = Date.now();
  let record = adminLoginAttempts.get(ip);
  if (!record) {
    record = { count: 0, lockedUntil: null };
    adminLoginAttempts.set(ip, record);
  }
  record.count += 1;

  if (record.count >= 8) {
    record.lockedUntil = now + 60 * 60 * 1000; // 1 hour lockout
  } else if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000; // 15 mins lockout
  } else if (record.count >= 3) {
    record.lockedUntil = now + 60 * 1000;      // 1 min cooldown
  }
  return record;
}

function clearAdminLoginAttempts(ip) {
  adminLoginAttempts.delete(ip);
}

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,        // only count failed attempts
  keyGenerator: (req) => getClientIp(req),
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many failed login attempts. IP temporarily locked. Try again in 15 minutes.'
  },
});

/* ══════════════════════════════════════════════════
   AI ESSAY DETECTION ENGINE
══════════════════════════════════════════════════ */
const AI_MARKERS = {

  transitions: [
    'furthermore', 'moreover', 'additionally', 'in conclusion', 'in summary',
    'to summarize', 'it is important to note', 'it is worth noting',
    'undoubtedly', 'certainly', 'obviously', 'as previously mentioned',
    "in today's world", 'in the modern era', 'one of the most',
    'this is because', 'as a result', 'therefore', 'consequently',
    'in addition', 'not only that', 'having said that', 'with that being said',
    'needless to say', 'it goes without saying', 'in order to', 'as such',
    'at the end of the day', 'this is especially true', 'it is clear that',
    'there are many', 'a wide range of', 'a variety of', 'in terms of',
    'when it comes to', 'due to the fact that', 'it can be seen',
    'it should be noted', 'it is essential', 'it is crucial',
    'in light of', 'taking into account', 'it is imperative', 'on the other hand',
    'it is evident', 'to this end', 'for instance', 'for example',
  ],

  genericPhrases: [
    'passion for technology', 'passion for learning', 'passion for computer science',
    'i have always been passionate', 'i have always been interested',
    'ever since i was young', 'since a young age', 'since childhood',
    'i believe that', 'this would allow me to', 'opportunity to grow',
    'expand my horizons', 'take my skills to the next level',
    'make a difference', 'contribute to the community', 'give back',
    'team player', 'hard worker', 'fast learner', 'quick learner',
    'i am a dedicated', 'i am committed to', 'i am eager to',
    'i strive to', 'i look forward to', 'i am excited to',
    'i would be honored', 'grateful for the opportunity',
    'valuable experience', 'enhance my knowledge',
    'broaden my understanding', 'gain hands-on experience',
    'real-world experience', 'sharpen my skills',
    'i am highly motivated', 'driven individual',
    // Modern ChatGPT-era phrases
    'delve into', 'it is worth', 'in the realm of', 'at its core',
    'a testament to', 'navigate the', 'landscape of', 'crucial role',
    'pivotal role', 'foster a', 'foster growth', 'empower', 'empowering',
    'in conclusion,', 'in summary,', 'to summarize,',
  ],

  structureRegexes: [
    /^(first(?:ly)?|second(?:ly)?|third(?:ly)?|finally|lastly)[,\s]/im,
    /^in (conclusion|summary|closing)[,\s]/im,
    /\.\s+(furthermore|moreover|additionally|in addition)[,\s]/i,
    /\.\s+(consequently|as a result|therefore)[,\s]/i,
    /\.\s+(however|nevertheless|nonetheless)[,\s]/i,
    /(not only|but also)/i,
    /\b(utilize|utilise)\b/i,
    /\b(leverage(?:d|s)?)\b/i,
    /\b(synergy|synergies)\b/i,
    /\b(paradigm shift)\b/i,
    /\b(holistic approach)\b/i,
    /\b(cutting[- ]edge)\b/i,
    /\b(robust solution)\b/i,
    /\b(scalable|streamline)\b/i,
    // ChatGPT-era structural cues
    /\bdelve\b/i,
    /\btapestry\b/i,
    /\bnuanced\b/i,
    /\bunwavering\b/i,
    /\bmeticulous(?:ly)?\b/i,
    /\bpivotal\b/i,
    /\bfoster(?:ing)?\b/i,
    /\bnavigate\b/i,
    /\blandscape\b/i,
    /\bempower(?:ing|ment)?\b/i,
    /\btestament\b/i,
    /\bin essence\b/i,
    /\bsignificantly\b/i,
  ],

  corpSpeak: [
    'utilize', 'facilitate', 'endeavor', 'leverage', 'synergy', 'paradigm',
    'holistic', 'streamline', 'optimize', 'comprehensive', 'robust',
    'scalable', 'dynamic', 'innovative', 'cutting-edge', 'proactive',
    'best practices', 'value-add', 'deliverables', 'bandwidth', 'deep dive',
    'circle back', 'touch base', 'move the needle', 'think outside the box',
    // Modern additions
    'delve', 'tapestry', 'nuanced', 'unwavering', 'meticulous',
    'pivotal', 'foster', 'navigate', 'empower', 'testament',
  ],
};

/**
 * analyzeEssay(text)
 * Returns: { score: 0-100, flags: string[], label: string }
 *
 * Scoring rubric (additive, capped at 100):
 *   Transition count ≥ 1             → +8 flat; high density → +15–25
 *   Generic phrase (×1)              → +10; ×2 → +20; ×4 → +15 more
 *   AI structural patterns ×1        → +8; ×2 → +18; ×4 → +12 more
 *   Low burstiness (<0.22 stddev)    → +18  (min 3 sentences)
 *   Moderate burstiness (0.22-0.35)  → +8
 *   Repetitive vocabulary            → +10
 *   Avg sentence length > 26 words   → +12
 *   Low first-person ratio           → +10
 *   Corp-speak density ≥ 2           → +12
 *   Opening formality marker         → +10
 *
 * Threshold for admin FLAGGED status: score ≥ 45
 */
function analyzeEssay(text) {
  if (!text || text.trim().length < 30) {
    return { score: 0, flags: [], label: 'TOO_SHORT' };
  }

  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/);
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.split(/\s+/).length > 2);
  const flags = [];
  let score = 0;

  /* — Transition count + density — */
  let transitionCount = 0;
  for (const t of AI_MARKERS.transitions) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = (lower.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
    transitionCount += hits;
  }
  if (transitionCount >= 1) {
    // Flat bonus for any transition word usage
    score += 8;
    flags.push('AI_TRANSITION_WORDS');
  }
  const transitionDensity = transitionCount / Math.max(sentences.length, 1);
  if (transitionDensity > 0.55) {
    score += transitionDensity > 1.0 ? 17 : 7;
    flags.push('HIGH_TRANSITION_DENSITY');
  }

  /* — Generic phrase cluster — */
  let genericHits = 0;
  for (const p of AI_MARKERS.genericPhrases) {
    if (lower.includes(p)) genericHits++;
  }
  if (genericHits >= 1) { score += 10; flags.push('GENERIC_PHRASES_DETECTED'); }
  if (genericHits >= 2) { score += 10; flags.push('GENERIC_PHRASE_CLUSTER'); }
  if (genericHits >= 4) { score += 15; flags.push('SEVERE_GENERIC_DENSITY'); }

  /* — Structure / format patterns — */
  let patternHits = 0;
  for (const re of AI_MARKERS.structureRegexes) {
    if (re.test(text)) patternHits++;
  }
  if (patternHits >= 1) { score += 8; flags.push('AI_STRUCTURAL_PATTERN'); }
  if (patternHits >= 2) { score += 10; flags.push('STRUCTURED_AI_FORMAT'); }
  if (patternHits >= 4) { score += 12; flags.push('HIGH_FORMAT_REGULARITY'); }

  /* — Burstiness (sentence length variance) — min 3 sentences — */
  if (sentences.length >= 3) {
    const lengths = sentences.map(s => s.split(/\s+/).length);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length;
    const stdDev = Math.sqrt(variance);
    const burstiness = mean > 0 ? stdDev / mean : 1;
    if (burstiness < 0.22) { score += 18; flags.push('LOW_BURSTINESS'); }
    else if (burstiness < 0.35) { score += 8; flags.push('MODERATE_BURSTINESS'); }
  }

  /* — Repetitive vocabulary — */
  const wordFreq = {};
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    if (clean.length > 4) wordFreq[clean] = (wordFreq[clean] || 0) + 1;
  }
  const repeatedWordCount = Object.values(wordFreq).filter(v => v > 3).length;
  if (repeatedWordCount > 3) { score += 10; flags.push('REPETITIVE_VOCABULARY'); }

  /* — Average sentence length — */
  if (sentences.length > 2) {
    const avgLen = words.length / sentences.length;
    if (avgLen > 26) { score += 12; flags.push('OVERLY_LONG_SENTENCES'); }
  }

  /* — First-person ratio — */
  const firstPersonMatches = (text.match(/\b(I|my|me|myself|I've|I'm|I'd|I'll)\b/g) || []).length;
  const firstPersonRatio = firstPersonMatches / Math.max(words.length, 1);
  if (firstPersonRatio < 0.02 && words.length > 50) {
    score += 10;
    flags.push('LOW_PERSONAL_VOICE');
  }

  /* — Corp-speak density — */
  const corpHits = AI_MARKERS.corpSpeak.filter(w => lower.includes(w)).length;
  if (corpHits >= 2) { score += 12; flags.push('CORP_SPEAK_DETECTED'); }

  /* — Formal opening marker (classic AI essay opener) — */
  const firstSentence = sentences[0] ? sentences[0].toLowerCase() : '';
  const formalOpeners = [
    'in today', 'in the modern', 'in recent', 'as a', 'it is', 'there is',
    'throughout history', 'since the dawn', 'the world of', 'the field of',
    'technology has', 'with the rapid', 'the rise of', 'in an era',
  ];
  if (formalOpeners.some(o => firstSentence.startsWith(o))) {
    score += 10;
    flags.push('FORMAL_OPENING');
  }

  score = Math.min(score, 100);

  const label = score < 25 ? 'HUMAN_LIKELY'
    : score < 50 ? 'SUSPICIOUS'
      : score < 70 ? 'AI_PROBABLE'
        : 'AI_DETECTED';

  return { score, flags, label };
}

/* ══════════════════════════════════════════════════
   INPUT VALIDATION HELPERS
══════════════════════════════════════════════════ */
function validateUsername(username) {
  if (typeof username !== 'string') return 'USERNAME_INVALID_TYPE';
  const trimmed = username.trim();
  if (trimmed.length < 2)  return 'USERNAME_TOO_SHORT';
  if (trimmed.length > 64) return 'USERNAME_TOO_LONG';
  // Allow letters, digits, spaces, hyphens, underscores, dots, slashes, apostrophes for full names
  if (!/^[a-zA-Z0-9_\-.\s/'`]+$/.test(trimmed)) return 'USERNAME_INVALID_CHARS';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'PASSWORD_INVALID_TYPE';
  if (password.length < 8)   return 'PASSWORD_TOO_SHORT';
  if (password.length > 128) return 'PASSWORD_TOO_LONG';
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit) return 'PASSWORD_WEAK';
  return null;
}

function validatePhone(phone) {
  if (!phone || phone.trim() === '') return 'PHONE_REQUIRED';
  if (typeof phone !== 'string')      return 'PHONE_INVALID_TYPE';
  const stripped = phone.trim().replace(/[\s\-().+]/g, '');
  if (!/^\d{6,15}$/.test(stripped))  return 'PHONE_INVALID_FORMAT';
  return null;
}

function validateTelegram(telegram) {
  if (!telegram || telegram.trim() === '') return 'TELEGRAM_REQUIRED';
  if (typeof telegram !== 'string')        return 'TELEGRAM_INVALID_TYPE';
  const handle = telegram.trim().replace(/^@/, '');
  if (handle.length < 2)                  return 'TELEGRAM_TOO_SHORT';
  if (handle.length > 64)                 return 'TELEGRAM_TOO_LONG';
  if (!/^[a-zA-Z0-9_\-.]+$/.test(handle)) return 'TELEGRAM_INVALID_CHARS';
  return null;
}

function validateEssay(essay) {
  if (typeof essay !== 'string') return 'ESSAY_INVALID_TYPE';
  const trimmed = essay.trim();
  if (trimmed.length < 150)   return 'ESSAY_TOO_SHORT';
  if (trimmed.length > 10000) return 'ESSAY_TOO_LONG';
  return null;
}

/**
 * sanitizeText(str)
 * Strips HTML tags and dangerous characters from free-text fields
 * to prevent Stored XSS when content is later rendered in admin panel.
 */
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/&/g, '&amp;')            // encode ampersands
    .replace(/"/g, '&quot;')           // encode double-quotes
    .replace(/'/g, '&#x27;')           // encode single-quotes
    .replace(/`/g, '&#x60;')           // encode backticks
    .trim();
}

/* ══════════════════════════════════════════════════
   SAPLING AI DETECTION INTEGRATION
   https://sapling.ai/api — score: 0.0 (human) → 1.0 (AI)
   Falls back to heuristic if API is unavailable or times out.
══════════════════════════════════════════════════ */

/**
 * httpsPost(url, payload)
 * Lightweight HTTPS POST helper returning { status, body }.
 * Resolves in ≤ TIMEOUT_MS; rejects on network error.
 */
const SAPLING_TIMEOUT_MS = 5000;

function httpsPost(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });

    req.setTimeout(SAPLING_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Sapling API request timed out'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * callSaplingAPI(text)
 * Calls the Sapling /aidetect endpoint.
 * Returns a score 0–100 (100 = definitely AI), or null if unavailable.
 */
async function callSaplingAPI(text) {
  const key = process.env.SAPLING_API_KEY;
  if (!key) return null;

  try {
    const result = await httpsPost('https://api.sapling.ai/api/v1/aidetect', {
      key,
      text,
    });

    if (result.status === 200 && typeof result.body.score === 'number') {
      // Sapling: 0.0 = human, 1.0 = AI → multiply by 100 for our 0–100 scale
      return Math.round(result.body.score * 100);
    }

    console.warn(`[ARX-SAPLING] Unexpected response ${result.status}:`, result.body);
    return null;
  } catch (err) {
    console.warn('[ARX-SAPLING] API unavailable — falling back to heuristic:', err.message);
    return null;
  }
}

/**
 * analyzeEssayWithSapling(text)
 * Primary detection pipeline:
 *   1. Always runs the local heuristic (fast, gets flags)
 *   2. Calls Sapling API for a precise score
 *   3. Merges: final score = 80% Sapling + 20% heuristic (when Sapling available)
 *   4. Falls back to 100% heuristic if Sapling is unavailable
 */
async function analyzeEssayWithSapling(text) {
  const heuristic = analyzeEssay(text);         // always run — provides flags
  const saplingScore = await callSaplingAPI(text); // null if unavailable

  let finalScore;
  const flags = [...heuristic.flags];

  if (saplingScore !== null) {
    // Weighted merge: Sapling is the authoritative source
    finalScore = Math.round(saplingScore * 0.8 + heuristic.score * 0.2);
    flags.push('SAPLING_VERIFIED');
    console.log(`[ARX-SAPLING] Score: sapling=${saplingScore}, heuristic=${heuristic.score}, final=${finalScore}`);
  } else {
    finalScore = heuristic.score;
  }

  finalScore = Math.min(finalScore, 100);

  const label = finalScore < 25 ? 'HUMAN_LIKELY'
    : finalScore < 50 ? 'SUSPICIOUS'
      : finalScore < 70 ? 'AI_PROBABLE'
        : 'AI_DETECTED';

  return { score: finalScore, flags, label };
}

/* ══════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════ */

/**
 * POST /api/apply
 *
 * Accepts multipart/form-data with optional certificate file uploads.
 * Fields: username, password, phone, telegram, essay
 * Files:  certificates[] (up to 3, max 5MB each, JPEG/PNG/WebP/PDF)
 *
 * Responses:
 *   200  { status: 'PENDING', message }
 *   400  { status: 'FLAGGED', message }
 *   422  { status: 'VALIDATION_ERROR', field, error }
 *   429  { status: 'BANNED', message }
 *   500  Internal server error
 */
app.post('/api/apply', applyLimiter, (req, res, next) => {
  certUpload.array('certificates', MAX_FILES)(req, res, (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: 'Each certificate file must be under 5 MB.' });
      }
      if (uploadErr.code === 'LIMIT_FILE_COUNT') {
        return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: 'Maximum 3 certificate files allowed.' });
      }
      // Never leak raw multer error messages to client
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: 'Invalid file upload.' });
    }
    applyHandler(req, res).catch(next);
  });
});

async function applyHandler(req, res) {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const record = getRecord(ip);

    /* — Check lockout — */
    if (isLockedOut(record)) {
      // Clean up any uploaded files if locked out
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(429).json({
        status: 'BANNED',
        message: 'AI-generated content was previously detected in your application. You are no longer eligible to apply.',
      });
    }

    // Support both JSON body (legacy) and multipart body
    const body     = req.body || {};
    // Coerce all fields to strings to prevent prototype-pollution via type confusion
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const essay    = typeof body.essay    === 'string' ? body.essay    : '';
    const phone    = typeof body.phone    === 'string' ? body.phone.trim()    : '';
    const telegram = typeof body.telegram === 'string' ? body.telegram.trim() : '';

    /* — Field validation — */
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'username', error: usernameErr });
    }

    const passwordErr = validatePassword(password);
    if (passwordErr) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'password', error: passwordErr });
    }

    const phoneErr = validatePhone(phone);
    if (phoneErr) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'phone', error: phoneErr });
    }

    const telegramErr = validateTelegram(telegram);
    if (telegramErr) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'telegram', error: telegramErr });
    }

    const essayErr = validateEssay(essay);
    if (essayErr) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'essay', error: essayErr });
    }

    /* ── Invite-only whitelist gate ──────────────────────────────────────────
       This check is performed AFTER format validation so that the error
       response is indistinguishable from a general access denial.
       The whitelist check is stealth — its existence is never surfaced
       to the applicant; they see only a generic access denial.
    ──────────────────────────────────────────────────────────────────────── */
    if (!isWhitelisted(username)) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
      console.warn(`[ARX-WHITELIST] Denied non-whitelisted username "${username.trim()}" from ip: ${ip}`);
      return res.status(403).json({
        status: 'ACCESS_DENIED',
        message: 'Unauthorized access — Username not registered on club whitelist.',
      });
    }

    /* — Build certificate metadata from uploaded files — */
    const certificates = (req.files || []).map(f => ({
      id:           uuidv4(),
      originalName: f.originalname,
      fileName:     f.filename,
      mimeType:     f.mimetype,
      size:         f.size,
      url:          `/uploads/certificates/${f.filename}`,
    }));

    /* — Sanitize essay before storage (strip HTML/script tags for XSS prevention) — */
    const sanitizedEssay = sanitizeText(essay);

    /* — AI detection via Sapling + heuristic fallback (stealth — never exposed to client) — */
    const detection = await analyzeEssayWithSapling(sanitizedEssay);

    if (detection.score >= 45) {
      // Immediately ban the IP — no warnings, first offence = lockout
      addStrike(record);
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });

      const source = detection.flags.includes('SAPLING_VERIFIED') ? 'sapling+heuristic' : 'heuristic';
      console.log(`[ARX] AI detected & banned — ip: ${ip}, user: ${username.trim()}, score: ${detection.score}, flags: [${detection.flags.join(', ')}] (${source})`);

      storeApplication({ username: sanitizeText(username), phone: sanitizeText(phone), telegram: sanitizeText(telegram), essay: sanitizedEssay, certificates: [], ip, detection, status: 'FLAGGED' });

      return res.status(400).json({
        status: 'FLAGGED',
        message: 'AI-generated content detected. Your application has been flagged and you are no longer eligible to apply.',
      });
    }

    /* — Queued for admin review — */
    const source = detection.flags.includes('SAPLING_VERIFIED') ? 'sapling+heuristic' : 'heuristic';
    console.log(`[ARX] New application from ${ip} — user: ${username.trim()} — essay score: ${detection.score} (${source}) — certs: ${certificates.length}`);

    // Store as PENDING — admin must manually Accept or Decline
    // All text fields sanitized before persistence to prevent stored XSS
    storeApplication({ username: sanitizeText(username), phone: sanitizeText(phone), telegram: sanitizeText(telegram), essay: sanitizedEssay, certificates, ip, detection, status: 'PENDING' });

    return res.status(200).json({
      status: 'PENDING',
      message: 'APPLICATION_RECEIVED // Payload encrypted and queued for committee review.',
    });

  } catch (err) {
    console.error('[ARX] /api/apply error:', err);
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });
    return res.status(500).json({ status: 'SERVER_ERROR', message: 'Internal system fault.' });
  }
}

/**
 * GET /api/status
 *
 * Returns club operational metrics.
 */
app.get('/api/status', (_req, res) => {
  const now     = new Date();
  const accepted = applicationStore.filter(a => a.status === 'ACCEPTED').length;

  // Next upcoming meeting from meetingStore
  const upcoming = meetingStore
    .filter(m => new Date(`${m.date}T${m.startTime}`) > now)
    .sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`));
  const nextMtg = upcoming.length > 0
    ? new Date(`${upcoming[0].date}T${upcoming[0].startTime}`).toISOString()
    : new Date('2026-10-05T18:00:00').toISOString();

  return res.json({
    status: 'OPERATIONAL',
    timestamp: now.toISOString(),
    recruitment: 'OPEN',
    activeMembers: accepted,
    projects: 4,
    nextMeeting: nextMtg,
    domains: [
      { id: 'web_dev',       status: 'ACTIVE', members: 0 },
      { id: 'robotics',      status: 'ACTIVE', members: 0 },
      { id: 'cybersecurity', status: 'ACTIVE', members: 0 },
      { id: 'python',        status: 'ACTIVE', members: 0 },
    ],
  });
});

/* ══════════════════════════════════════════════════
   IN-MEMORY MEETINGS STORE
   Each meeting: { id, title, domain, date, startTime, endTime,
                   type, link, description, host, isLive }
══════════════════════════════════════════════════ */
const meetingStore = [
  {
    id: 1,
    title: 'Web Dev Sprint — React Fundamentals',
    domain: 'WEB_DEV',
    date: '2026-10-05',
    startTime: '18:00',
    endTime: '20:00',
    type: 'CAMPUS',
    link: '',
    description: 'Hands-on session covering React hooks, component architecture and live coding challenges.',
    host: 'ARX Core Team',
    isLive: false,
  },
  {
    id: 2,
    title: 'Cybersecurity CTF Prep',
    domain: 'CYBERSECURITY',
    date: '2026-10-12',
    startTime: '17:30',
    endTime: '19:30',
    type: 'ONLINE',
    link: 'https://meet.arx.club/ctf-prep',
    description: 'Capture-The-Flag training: binary exploitation, SQL injection, reverse engineering basics.',
    host: 'ARX Security Division',
    isLive: false,
  },
  {
    id: 3,
    title: 'Python & ML Workshop',
    domain: 'PYTHON',
    date: '2026-10-19',
    startTime: '18:00',
    endTime: '20:30',
    type: 'CAMPUS',
    link: '',
    description: 'Intro to NumPy, Pandas, and building your first neural network with PyTorch.',
    host: 'ARX Data Science Lab',
    isLive: false,
  },
  {
    id: 4,
    title: 'Robotics & Embedded Systems',
    domain: 'ROBOTICS',
    date: '2026-10-26',
    startTime: '16:00',
    endTime: '18:00',
    type: 'CAMPUS',
    link: '',
    description: 'Arduino & Raspberry Pi programming, sensor integration, and building autonomous movement systems.',
    host: 'ARX Robotics Lab',
    isLive: false,
  },
];
let meetingIdCounter = meetingStore.length + 1;

/**
 * GET /api/meetings
 * Returns all meetings split into live, upcoming, and past.
 */
app.get('/api/meetings', (_req, res) => {
  const now = new Date();
  const meetings = meetingStore.map(m => {
    const start = new Date(`${m.date}T${m.startTime}`);
    const end   = new Date(`${m.date}T${m.endTime}`);
    const isLive = now >= start && now <= end;
    return { ...m, isLive };
  });
  const live = meetings.filter(m => m.isLive);
  const upcoming = meetings
    .filter(m => !m.isLive && new Date(`${m.date}T${m.startTime}`) > now)
    .sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`));
  const past = meetings
    .filter(m => !m.isLive && new Date(`${m.date}T${m.endTime}`) <= now)
    .sort((a, b) => new Date(`${b.date}T${b.startTime}`) - new Date(`${a.date}T${a.startTime}`));

  return res.json({ live, upcoming, past, total: meetingStore.length });
});


/* ══════════════════════════════════════════════════
   STRICT SERVER-SIDE ADMIN AUTHORIZATION MIDDLEWARE
   Enforces rigorous server-side verification:
   — Valid active session cookie
   — Verified role: session.isAdmin === true
   — Valid username: session.adminUser === ADMIN_USERNAME
   — Lifetime expiration: session age <= 2 hours
   — Client IP binding check to prevent session hijacking
   Never relies on frontend checks.
══════════════════════════════════════════════════ */
function requireAdmin(req, res, next) {
  const clientIp = getClientIp(req);
  const session  = req.session;

  // 1. Session and admin flag validation
  if (!session || !session.isAdmin || session.adminUser !== ADMIN_USERNAME) {
    const wantsHTML = (req.headers.accept || '').includes('text/html');
    if (wantsHTML) return res.redirect(ADMIN_BASE_PATH);
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Admin authentication required. Access denied.'
    });
  }

  // 2. Strict session expiration check (2 hours)
  const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
  if (!session.loginAt || (Date.now() - session.loginAt) > SESSION_MAX_AGE_MS) {
    console.warn(`[ARX-AUTH] ⚠ Expired session rejected for user: ${session.adminUser}`);
    req.session.destroy(() => {});
    const wantsHTML = (req.headers.accept || '').includes('text/html');
    if (wantsHTML) return res.redirect(ADMIN_BASE_PATH);
    return res.status(401).json({
      error: 'SESSION_EXPIRED',
      message: 'Session has expired. Please log in again.'
    });
  }

  // 3. Session IP binding check (mitigate cookie theft / session hijacking).
  //    Both session.clientIp and clientIp are normalized via normalizeIp() so
  //    all address forms (IPv4, ::1, ::ffff:x.x.x.x) compare correctly as-is.
  //    No localhost equivalence special-case needed — normalization handles it.
  if (session.clientIp && session.clientIp !== clientIp) {
    console.warn(`[ARX-AUTH] 🚨 Session IP mismatch detected! Bound IP: ${session.clientIp}, Incoming IP: ${clientIp}`);
    req.session.destroy(() => {});
    return res.status(401).json({
      error: 'SESSION_HIJACK_DETECTED',
      message: 'Security violation: session bound to a different client IP. Authentication invalidated.'
    });
  }

  next();
}

/* ══════════════════════════════════════════════════
   ADMIN ROUTER
   Encapsulates all administrative routes under the
   configurable obscure path (ADMIN_BASE_PATH).
══════════════════════════════════════════════════ */
const adminRouter = express.Router();

/* ── GET / ── Serves the admin panel HTML (never exposed as a static asset) */
adminRouter.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

/* ── POST /login ── Authenticates admin with brute-force lockout & rate limiting */
adminRouter.post('/login', adminLoginLimiter, async (req, res) => {
  const clientIp = getClientIp(req);

  // Progressive lockout check
  const bfCheck = checkAdminBruteForce(clientIp);
  if (bfCheck.locked) {
    console.warn(`[ARX-SECURITY] 🚨 Blocked login from locked IP: ${clientIp} (${bfCheck.remainingSec}s cooldown remaining)`);
    return res.status(429).json({
      error: 'ACCOUNT_LOCKED',
      message: `Too many failed login attempts. Temporarily locked. Try again in ${bfCheck.remainingSec} seconds.`,
      retryAfter: bfCheck.remainingSec,
    });
  }

  try {
    const { username, password } = req.body || {};

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      recordAdminFailedLogin(clientIp);
      await new Promise(r => setTimeout(r, 600)); // anti-timing jitter delay
      return res.status(400).json({ error: 'CREDENTIALS_REQUIRED' });
    }

    if (username.length > 128 || password.length > 256) {
      recordAdminFailedLogin(clientIp);
      await new Promise(r => setTimeout(r, 600));
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    }

    const passwordOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    const a = Buffer.alloc(256);
    const b = Buffer.alloc(256);
    a.write(ADMIN_USERNAME);
    b.write(username);
    const usernameOk = crypto.timingSafeEqual(a, b);

    if (!usernameOk || !passwordOk) {
      const rec = recordAdminFailedLogin(clientIp);
      console.warn(`[ARX-ADMIN] ✖ Failed login attempt #${rec.count} — ip: ${clientIp}, attempted user: "${username.slice(0, 32)}"`);
      await new Promise(r => setTimeout(r, 600)); // anti-timing jitter delay
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
        attempts: rec.count,
      });
    }

    // Login successful — clear brute force attempts
    clearAdminLoginAttempts(clientIp);

    // Regenerate session ID to prevent session-fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('[ARX-ADMIN] Session regeneration error:', err);
        return res.status(500).json({ error: 'SESSION_ERROR' });
      }
      req.session.isAdmin   = true;
      req.session.adminUser = ADMIN_USERNAME;
      req.session.clientIp  = clientIp;
      req.session.loginAt   = Date.now();
      console.log(`[ARX-ADMIN] ✔ Successful login — ip: ${clientIp}, user: "${ADMIN_USERNAME}"`);
      return res.json({ ok: true, username: ADMIN_USERNAME, basePath: ADMIN_BASE_PATH });
    });

  } catch (err) {
    console.error('[ARX-ADMIN] /login error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ── POST /logout ── Destroys admin session and clears cookie */
adminRouter.post('/logout', requireAdmin, (req, res) => {
  const user = req.session.adminUser;
  req.session.destroy((err) => {
    if (err) {
      console.error('[ARX-ADMIN] Session destroy error:', err);
      return res.status(500).json({ error: 'SESSION_ERROR' });
    }
    res.clearCookie('arx.sid');
    console.log(`[ARX-ADMIN] Logout — user: "${user}"`);
    return res.json({ ok: true });
  });
});

/* ── GET /api/me ── Returns active session info */
adminRouter.get('/api/me', requireAdmin, (req, res) => {
  return res.json({
    username: req.session.adminUser,
    loginAt: req.session.loginAt,
    basePath: ADMIN_BASE_PATH,
  });
});

/* ── GET /api/applications ── Returns all stored applications */
adminRouter.get('/api/applications', requireAdmin, (_req, res) => {
  const sorted = [...applicationStore].sort((a, b) => b.id - a.id);
  return res.json({
    total: applicationStore.length,
    pending: applicationStore.filter(a => a.status === 'PENDING').length,
    accepted: applicationStore.filter(a => a.status === 'ACCEPTED').length,
    declined: applicationStore.filter(a => a.status === 'DECLINED').length,
    flagged: applicationStore.filter(a => a.status === 'FLAGGED').length,
    applications: sorted,
  });
});

/* ── GET /api/stats ── Aggregate metrics for dashboard */
adminRouter.get('/api/stats', requireAdmin, (_req, res) => {
  const total = applicationStore.length;
  const pending = applicationStore.filter(a => a.status === 'PENDING').length;
  const accepted = applicationStore.filter(a => a.status === 'ACCEPTED').length;
  const declined = applicationStore.filter(a => a.status === 'DECLINED').length;
  const flagged = applicationStore.filter(a => a.status === 'FLAGGED').length;
  const avgScore = total > 0
    ? Math.round(applicationStore.reduce((s, a) => s + a.aiScore, 0) / total)
    : 0;
  return res.json({ total, pending, accepted, declined, flagged, avgScore });
});

/* ── PATCH /api/applications/:id/status ── Accept or Decline */
adminRouter.patch('/api/applications/:id/status', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};

  const ALLOWED = ['ACCEPTED', 'DECLINED', 'PENDING'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({ error: 'INVALID_STATUS', allowed: ALLOWED });
  }

  const appEntry = applicationStore.find(a => a.id === id);
  if (!appEntry) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `No application with id ${id}` });
  }

  const previous = appEntry.status;
  appEntry.status = status;
  console.log(`[ARX-ADMIN] Application #${id} status changed: ${previous} → ${status} by ${req.session.adminUser}`);

  // Assign callsign and send Telegram welcome ONLY when accepting
  let specialUsername = appEntry.specialUsername;
  let tgSent = false;
  let inviteLink = null;

  if (status === 'ACCEPTED') {
    if (!appEntry.specialUsername) {
      const rosterMatch = findBestRosterMatch(appEntry.fullName || appEntry.username, `${appEntry.essay || ''} ${appEntry.phone || ''}`);
      specialUsername = appEntry.rosterCallsign || (rosterMatch ? rosterMatch.entry.callsign : generateCallsign(id, appEntry.fullName || appEntry.username));
      appEntry.specialUsername = specialUsername;
      appEntry.callsign = specialUsername;
      if (rosterMatch) {
        appEntry.section = rosterMatch.entry.section;
        appEntry.rosterName = rosterMatch.entry.fullName;
      }
      appEntry.acceptedAt = new Date().toISOString();
    } else {
      specialUsername = appEntry.specialUsername;
    }

    // Automatic Telegram welcome if chatId is known
    const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
    const chatId   = tgHandle ? (telegramChatStore.get(tgHandle) || telegramChatStore.get(String(tgHandle))) : null;

    if (chatId) {
      tgSent = await sendTelegramWelcome(chatId, appEntry);
      appEntry.tgMessageSent = tgSent;
      console.log(`[ARX-ADMIN] Acceptance text sent to @${tgHandle} (chatId: ${chatId}): ${tgSent}`);
    } else {
      console.log(`[ARX-ADMIN] Candidate @${tgHandle} has not messaged @${TELEGRAM_BOT_USERNAME} yet.`);
    }

    // Deep-link invite
    let tokenRecord = verifyTokenStore.get(String(id));
    let token = tokenRecord ? tokenRecord.token : crypto.randomBytes(16).toString('hex');
    if (!tokenRecord) {
      verifyTokenStore.set(String(id), {
        token,
        appId: id,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
    }
    inviteLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=VERIFY_${id}_${token}`;
    appEntry.inviteLink = inviteLink;

    console.log(`[ARX-ADMIN] Callsign: ${specialUsername} | TG sent: ${tgSent} | invite: ${inviteLink}`);
  } else {
    // When DECLINED or returned to PENDING, clear assigned clearance
    appEntry.specialUsername = null;
    appEntry.callsign = null;
    appEntry.acceptedAt = null;
    appEntry.tgMessageSent = false;
    specialUsername = null;
  }
  saveApplications();

  const total   = applicationStore.length;
  const pending  = applicationStore.filter(a => a.status === 'PENDING').length;
  const accepted = applicationStore.filter(a => a.status === 'ACCEPTED').length;
  const declined = applicationStore.filter(a => a.status === 'DECLINED').length;
  const flagged  = applicationStore.filter(a => a.status === 'FLAGGED').length;

  return res.json({ ok: true, id, status, specialUsername, tgSent, inviteLink, stats: { total, pending, accepted, declined, flagged } });
});

/* ── POST /api/clear-strikes ── Clears lockout record */
adminRouter.post('/api/clear-strikes', requireAdmin, (req, res) => {
  const { ip } = req.body || {};
  if (ip) {
    strikeStore.delete(ip);
    console.log(`[ARX-ADMIN] Strikes cleared for ip: ${ip} by ${req.session.adminUser}`);
    return res.json({ ok: true, cleared: ip });
  }
  const count = strikeStore.size;
  strikeStore.clear();
  console.log(`[ARX-ADMIN] All strikes cleared (${count} records) by ${req.session.adminUser}`);
  return res.json({ ok: true, cleared: 'ALL', count });
});

/* ── Admin Meetings Endpoints ── */
adminRouter.get('/api/meetings', requireAdmin, (_req, res) => {
  return res.json({ meetings: meetingStore, total: meetingStore.length });
});

adminRouter.post('/api/meetings', requireAdmin, (req, res) => {
  const { title, domain, date, startTime, endTime, type, link, description, host } = req.body || {};
  if (!title || !domain || !date || !startTime || !endTime || !type) {
    return res.status(400).json({ error: 'MISSING_REQUIRED_FIELDS' });
  }
  const meeting = {
    id:          meetingIdCounter++,
    title:       String(title).trim().slice(0, 120),
    domain:      String(domain).trim().toUpperCase(),
    date:        String(date).trim(),
    startTime:   String(startTime).trim(),
    endTime:     String(endTime).trim(),
    type:        ['ONLINE','CAMPUS'].includes(String(type).toUpperCase()) ? String(type).toUpperCase() : 'CAMPUS',
    link:        String(link || '').trim(),
    description: String(description || '').trim().slice(0, 500),
    host:        String(host || 'ARX Core Team').trim(),
    isLive:      false,
  };
  meetingStore.push(meeting);
  console.log(`[ARX-ADMIN] Meeting #${meeting.id} created: "${meeting.title}" by ${req.session.adminUser}`);
  return res.status(201).json({ ok: true, meeting });
});

adminRouter.delete('/api/meetings/:id', requireAdmin, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const idx = meetingStore.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'NOT_FOUND' });
  const [removed] = meetingStore.splice(idx, 1);
  console.log(`[ARX-ADMIN] Meeting #${id} "${removed.title}" deleted by ${req.session.adminUser}`);
  return res.json({ ok: true, id });
});

/* ── Admin Whitelist Management ── */
adminRouter.get('/api/whitelist', requireAdmin, (_req, res) => {
  return res.json({
    total: AUTHORIZED_USERNAMES.size,
    usernames: [...AUTHORIZED_USERNAMES].sort(),
  });
});

adminRouter.post('/api/whitelist/add', requireAdmin, (req, res) => {
  const raw = String(req.body.username || '').trim();
  if (!raw) return res.status(400).json({ error: 'USERNAME_REQUIRED' });
  const err = validateUsername(raw);
  if (err) return res.status(422).json({ error: err });
  const lower = raw.toLowerCase();
  if (AUTHORIZED_USERNAMES.has(lower)) {
    return res.json({ ok: true, added: false, username: lower, message: 'Already on whitelist.' });
  }
  AUTHORIZED_USERNAMES.add(lower);
  console.log(`[ARX-WHITELIST] Added "${lower}" by ${req.session.adminUser}`);
  return res.json({ ok: true, added: true, username: lower, total: AUTHORIZED_USERNAMES.size });
});

adminRouter.post('/api/whitelist/remove', requireAdmin, (req, res) => {
  const raw = String(req.body.username || '').trim();
  if (!raw) return res.status(400).json({ error: 'USERNAME_REQUIRED' });
  const lower = raw.toLowerCase();
  if (!AUTHORIZED_USERNAMES.has(lower)) {
    return res.json({ ok: true, removed: false, username: lower, message: 'Not on whitelist.' });
  }
  AUTHORIZED_USERNAMES.delete(lower);
  console.log(`[ARX-WHITELIST] Removed "${lower}" by ${req.session.adminUser}`);
  return res.json({ ok: true, removed: true, username: lower, total: AUTHORIZED_USERNAMES.size });
});

/* ── POST /api/applications/:id/tg-send ── */
adminRouter.post('/api/applications/:id/tg-send', requireAdmin, async (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const appEntry = applicationStore.find(a => a.id === id);
  if (!appEntry) return res.status(404).json({ error: 'NOT_FOUND' });
  if (appEntry.status !== 'ACCEPTED') {
    return res.status(400).json({ error: 'NOT_ACCEPTED', message: 'Application must be ACCEPTED first.' });
  }

  if (!appEntry.specialUsername) {
    const rosterMatch = findBestRosterMatch(appEntry.fullName || appEntry.username, `${appEntry.essay || ''} ${appEntry.phone || ''}`);
    appEntry.specialUsername = rosterMatch ? rosterMatch.entry.callsign : generateCallsign(id, appEntry.fullName || appEntry.username);
    appEntry.callsign = appEntry.specialUsername;
    if (rosterMatch) {
      appEntry.section = rosterMatch.entry.section;
      appEntry.rosterName = rosterMatch.entry.fullName;
    }
    saveApplications();
  }

  const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
  const chatId   = tgHandle ? (telegramChatStore.get(tgHandle) || telegramChatStore.get(String(tgHandle))) : null;

  if (!chatId) {
    let stored = [...verifyTokenStore.entries()].find(([k, v]) => v.appId === id);
    let token = stored ? stored[1].token : crypto.randomBytes(16).toString('hex');
    if (!stored) {
      verifyTokenStore.set(String(id), { token, appId: id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
    }
    const inviteLink = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=VERIFY_${id}_${token}`;
    appEntry.inviteLink = inviteLink;
    saveApplications();

    return res.json({
      ok: false,
      reason: 'CHAT_ID_UNKNOWN',
      inviteLink,
      message: `Candidate @${tgHandle} has not messaged @${TELEGRAM_BOT_USERNAME} yet. Please share the invite link so Telegram allows the bot to text them.`,
    });
  }

  const sent = await sendTelegramWelcome(chatId, appEntry);
  appEntry.tgMessageSent = sent;
  saveApplications();
  return res.json({ ok: sent, tgSent: sent, message: sent ? 'Telegram acceptance message sent!' : 'Telegram API failed to deliver message.' });
});

/* ══════════════════════════════════════════════════
   PUBLIC API ENDPOINTS
   — GET  /api/lookup     (status check by handle)
   — POST /api/tg/webhook (Telegram webhook)
   — GET  /api/tg/info    (Bot username info)
══════════════════════════════════════════════════ */
app.get('/api/lookup', lookupLimiter, (req, res) => {
  const raw = String(req.query.handle || '').trim().replace(/^@/, '');
  if (!raw || raw.length < 2 || raw.length > 64) return res.status(400).json({ error: 'HANDLE_REQUIRED' });
  if (!/^[a-zA-Z0-9_\-.\s]+$/.test(raw)) return res.status(400).json({ error: 'HANDLE_INVALID' });
  const handle = raw.toLowerCase();
  const match = applicationStore.find(a =>
    (a.telegram || '').toLowerCase().replace(/^@/, '') === handle ||
    (a.username  || '').toLowerCase() === handle ||
    (a.fullName  || '').toLowerCase() === handle ||
    (a.specialUsername || '').toLowerCase() === handle ||
    (a.callsign  || '').toLowerCase() === handle
  );
  if (!match) return res.status(404).json({ found: false, message: 'No application found.' });
  return res.json({
    found: true,
    status: match.status,
    specialUsername: match.status === 'ACCEPTED' ? (match.specialUsername || match.callsign || null) : null,
    section: match.section || null,
  });
});

app.post('/api/tg/webhook', express.json(), async (req, res) => {
  try {
    await handleTelegramUpdate(req.body);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[ARX-TG] Webhook error:', err);
    return res.status(500).json({ ok: false });
  }
});

app.get('/api/tg/info', (_req, res) => {
  return res.json({
    botUsername: TELEGRAM_BOT_USERNAME,
    botLink: `https://t.me/${TELEGRAM_BOT_USERNAME}`,
  });
});

/* ══════════════════════════════════════════════════
   MOUNT ADMIN ROUTER
   Secured behind IP whitelisting at custom secret path
══════════════════════════════════════════════════ */
app.use(ADMIN_BASE_PATH, adminIpWhitelistMiddleware, adminRouter);

/* ══════════════════════════════════════════════════
   STEALTH 404 FOR GENERIC /admin ROUTES
   Obscures the existence of any admin portal at /admin
══════════════════════════════════════════════════ */
app.all(['/admin', '/admin/*'], (_req, res) => {
  return res.status(404).send('<!DOCTYPE html><html lang="en"><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>The requested URL was not found on this server.</p></body></html>');
});

/* Catch-all — serve index.html for SPA routing (must stay last) */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


/* ══════════════════════════════════════════════════
   GLOBAL ERROR HANDLER
   Must be defined AFTER all routes.
   Catches any unhandled error thrown in route handlers.
   NEVER leaks stack traces, paths, or raw error messages
   to the client — only a safe, generic message.
══════════════════════════════════════════════════ */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Log full error server-side for debugging
  console.error('[ARX-ERROR]', err);

  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Malformed JSON payload.' });
  }

  // Multer / payload errors — return 413
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds size limit.' });
  }

  // CORS rejection
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: 'CORS_REJECTED' });
  }

  // Default: generic 500 — no internal details exposed
  return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' });
});


/* ══════════════════════════════════════════════════
   START
══════════════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║               ARX COLLECTIVE — SERVER ONLINE                ║
  ║               http://localhost:${PORT}                          ║
  ║                                                              ║
  ║   [ADMIN PORTAL SECURITY HARDENING ACTIVE]                   ║
  ║   Secret Path:    http://localhost:${PORT}${ADMIN_BASE_PATH}
  ║   IP Whitelist:   ${[...ADMIN_ALLOWED_IPS].join(', ')}
  ║   Brute Force:    5 attempts / 15m + Progressive Lockout     ║
  ║   Authorization:  Server-Side Strict + Session IP Binding    ║
  ╚══════════════════════════════════════════════════════════════╝
  `);

  if (TELEGRAM_BOT_TOKEN) {
    try {
      await initTelegramBot();
    } catch (err) {
      console.error('[ARX-TG] Error during bot startup:', err.message);
    }
  }
});

module.exports = app; // for testing
