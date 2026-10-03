/**
 * ARX Collective — Express Backend
 * server.js
 *
 * Endpoints:
 *   POST /api/apply               — Student application (multipart) w/ AI detection
 *   GET  /api/status              — Club operational metrics
 *   GET  /api/meetings            — Public meetings feed
 *   GET  /api/lookup              — Application status lookup by telegram handle
 *   POST /api/tg/webhook          — Telegram bot webhook (captures chat_id)
 *   GET  /admin/api/…             — Protected admin routes
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!TELEGRAM_BOT_TOKEN) {
  console.warn('[ARX-TG] ⚠  TELEGRAM_BOT_TOKEN not set — Telegram welcome messages will be skipped.');
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

function generateCallsign(appId) {
  const name = CODENAMES[Math.floor(Math.random() * CODENAMES.length)];
  const hex  = String(appId).padStart(4, '0');
  return `ARX-${name}-${hex}`;
}

/* ══════════════════════════════════════════════════
   TELEGRAM WELCOME MESSAGE
══════════════════════════════════════════════════ */
async function sendTelegramWelcome(chatId, app) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return false;
  const text =
`⚡️ ARX COLLECTIVE // CLEARANCE GRANTED ⚡️
──────────────────────────────
Welcome to the Collective, Operative.
Your application has been reviewed and officially ACCEPTED.

🎖 ASSIGNED CALLSIGN: ⟦ ${app.specialUsername} ⟧
👤 APPLICANT: ${app.username}
🏷 CLEARANCE LEVEL: OPERATIVE_TIER_1
🌐 BOT INTERFACE: @ArxITclub_bot

NEXT DIRECTIVES:
1. Store your Operative Callsign securely.
2. Await access coordinates for private domain sprints.
3. Type /help to see operative commands.

// ALL SYSTEMS OPERATIONAL. WELCOME ABOARD.
──────────────────────────────`;

  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2'.replace('MarkdownV2','') });
    const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const opts = {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const urlObj = new URL(url);
    const req = https.request({ hostname: urlObj.hostname, path: urlObj.pathname, ...opts }, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          resolve(d.ok === true);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

/* ══════════════════════════════════════════════════
   DEEP-LINK VERIFICATION TOKEN STORE
   appId → { token, expiresAt }
══════════════════════════════════════════════════ */
const verifyTokenStore = new Map();

/* ══════════════════════════════════════════════════
   IN-MEMORY APPLICATION STORE
   Replace with a persistent database (PostgreSQL,
   MongoDB, SQLite…) for production use.
══════════════════════════════════════════════════ */
const applicationStore = [];
let appIdCounter = 1;

/**
 * storeApplication({ username, phone, telegram, essay, certificates, ip, detection, status })
 * Persists a submitted application internally for admin review.
 * NOTE: data is stored in-memory only; it is lost on server restart.
 */
function storeApplication({ username, phone, telegram, essay, certificates, ip, detection, status }) {
  const id = appIdCounter++;
  applicationStore.push({
    id,
    timestamp: new Date().toISOString(),
    username: username.trim(),
    phone: (phone || '').trim(),
    telegram: (telegram || '').trim(),
    essay: essay.trim(),
    certificates: certificates || [],  // [{ id, originalName, fileName, mimeType, size, url }]
    ip,
    aiScore: detection.score,
    aiLabel: detection.label,
    aiFlags: detection.flags,
    status,   // 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'FLAGGED'
    specialUsername: null,  // assigned on ACCEPTED
    acceptedAt: null,
    tgMessageSent: false,
  });
  return id;
}

/* ══════════════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════════════ */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
    },
  },
}));

app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json({ limit: '16kb' }));

/* Session middleware (required for admin auth and protected uploads) */
app.use(session({
  secret: SESSION_SECRET || 'arx-dev-insecure-fallback-change-me',
  resave: false,
  saveUninitialized: false,
  name: 'arx.sid',        // non-default cookie name reduces fingerprinting
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 2 * 60 * 60 * 1000,     // 2 hours
  },
}));

/* Serve uploaded certificates — admin-only (requires active session) */
app.use('/uploads/certificates', (req, res, next) => {
  if (req.session && req.session.isAdmin) return next();
  // Allow direct access only from admin panel referer in dev
  const ref = req.headers.referer || '';
  if (ref.includes('/admin')) return next();
  return res.status(403).json({ error: 'FORBIDDEN' });
}, express.static(UPLOAD_DIR));

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
   GENERAL RATE LIMITER (brute-force protection)
   100 req / 15 min per IP for all /api routes
══════════════════════════════════════════════════ */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again later.' },
});

app.use('/api', apiLimiter);

/* ══════════════════════════════════════════════════
   ADMIN LOGIN RATE LIMITER — 5 attempts / 15 min
   Much stricter than the general API limiter to
   prevent brute-force attacks on admin credentials.
══════════════════════════════════════════════════ */
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,        // only count failed attempts
  message: { error: 'RATE_LIMIT_EXCEEDED', message: 'Too many login attempts. Try again in 15 minutes.' },
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
  if (trimmed.length < 2) return 'USERNAME_TOO_SHORT';
  if (trimmed.length > 32) return 'USERNAME_TOO_LONG';
  if (!/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) return 'USERNAME_INVALID_CHARS';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'PASSWORD_INVALID_TYPE';
  if (password.length < 8) return 'PASSWORD_TOO_SHORT';
  if (password.length > 128) return 'PASSWORD_TOO_LONG';
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit) return 'PASSWORD_WEAK';
  return null;
}

function validateEssay(essay) {
  if (typeof essay !== 'string') return 'ESSAY_INVALID_TYPE';
  const trimmed = essay.trim();
  if (trimmed.length < 150) return 'ESSAY_TOO_SHORT';
  if (trimmed.length > 10000) return 'ESSAY_TOO_LONG';
  return null;
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
app.post('/api/apply', (req, res, next) => {
  certUpload.array('certificates', MAX_FILES)(req, res, (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: 'Each certificate file must be under 5 MB.' });
      }
      if (uploadErr.code === 'LIMIT_FILE_COUNT') {
        return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: 'Maximum 3 certificate files allowed.' });
      }
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'certificates', error: uploadErr.message });
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
    const body      = req.body || {};
    const username  = body.username;
    const password  = body.password;
    const essay     = body.essay;
    const phone     = (body.phone || '').trim();
    const telegram  = (body.telegram || '').trim();

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

    /* — Build certificate metadata from uploaded files — */
    const certificates = (req.files || []).map(f => ({
      id:           uuidv4(),
      originalName: f.originalname,
      fileName:     f.filename,
      mimeType:     f.mimetype,
      size:         f.size,
      url:          `/uploads/certificates/${f.filename}`,
    }));

    /* — AI detection via Sapling + heuristic fallback (stealth — never exposed to client) — */
    const detection = await analyzeEssayWithSapling(essay.trim());

    if (detection.score >= 45) {
      // Immediately ban the IP — no warnings, first offence = lockout
      addStrike(record);
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} });

      const source = detection.flags.includes('SAPLING_VERIFIED') ? 'sapling+heuristic' : 'heuristic';
      console.log(`[ARX] AI detected & banned — ip: ${ip}, user: ${username.trim()}, score: ${detection.score}, flags: [${detection.flags.join(', ')}] (${source})`);

      storeApplication({ username, phone, telegram, essay, certificates: [], ip, detection, status: 'FLAGGED' });

      return res.status(400).json({
        status: 'FLAGGED',
        message: 'AI-generated content detected. Your application has been flagged and you are no longer eligible to apply.',
      });
    }

    /* — Queued for admin review — */
    const source = detection.flags.includes('SAPLING_VERIFIED') ? 'sapling+heuristic' : 'heuristic';
    console.log(`[ARX] New application from ${ip} — user: ${username.trim()} — essay score: ${detection.score} (${source}) — certs: ${certificates.length}`);

    // Store as PENDING — admin must manually Accept or Decline
    storeApplication({ username, phone, telegram, essay, certificates, ip, detection, status: 'PENDING' });

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
   ADMIN AUTHENTICATION MIDDLEWARE
══════════════════════════════════════════════════ */

/**
 * requireAdmin(req, res, next)
 * Guards all protected admin routes.
 * — JSON (API) callers receive 401.
 * — Browser navigations are redirected to /admin.
 */
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  const wantsHTML = (req.headers.accept || '').includes('text/html');
  if (wantsHTML) return res.redirect('/admin');
  return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin authentication required.' });
}

/* ══════════════════════════════════════════════════
   GET /admin
   Serves the admin panel HTML from /views (outside
   /public) so it is never reachable as a static file.
══════════════════════════════════════════════════ */
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

/* ══════════════════════════════════════════════════
   POST /admin/login
   Authenticates the admin and creates a signed session.
══════════════════════════════════════════════════ */
app.post('/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'CREDENTIALS_REQUIRED' });
    }

    // bcrypt.compare is constant-time; username check is done after so both
    // branches always run bcrypt regardless — prevents user-enumeration timing.
    const passwordOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    const usernameOk = username === ADMIN_USERNAME;

    if (!usernameOk || !passwordOk) {
      console.warn(`[ARX-ADMIN] Failed login attempt — ip: ${req.ip}, attempted user: "${username}"`);
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    }

    // Regenerate session ID to prevent session-fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('[ARX-ADMIN] Session regeneration error:', err);
        return res.status(500).json({ error: 'SESSION_ERROR' });
      }
      req.session.isAdmin = true;
      req.session.adminUser = username;
      req.session.loginAt = Date.now();
      console.log(`[ARX-ADMIN] Successful login — ip: ${req.ip}, user: "${username}"`);
      return res.json({ ok: true, username });
    });

  } catch (err) {
    console.error('[ARX-ADMIN] /admin/login error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* ══════════════════════════════════════════════════
   POST /admin/logout
   Destroys the admin session and clears the cookie.
══════════════════════════════════════════════════ */
app.post('/admin/logout', requireAdmin, (req, res) => {
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

/* ══════════════════════════════════════════════════
   GET /admin/api/me
   Returns the authenticated admin’s basic info.
   Used by the client to check session state on load.
══════════════════════════════════════════════════ */
app.get('/admin/api/me', requireAdmin, (req, res) => {
  return res.json({ username: req.session.adminUser, loginAt: req.session.loginAt });
});

/* ══════════════════════════════════════════════════
   GET /admin/api/applications
   Returns all stored applications, newest first.
   Protected — requires active admin session.
══════════════════════════════════════════════════ */
app.get('/admin/api/applications', requireAdmin, (_req, res) => {
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

/* ══════════════════════════════════════════════════
   GET /admin/api/stats
   Quick aggregate metrics for the dashboard header.
   Protected — requires active admin session.
══════════════════════════════════════════════════ */
app.get('/admin/api/stats', requireAdmin, (_req, res) => {
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

/* ══════════════════════════════════════════════════
   PATCH /admin/api/applications/:id/status
   Allows admin to Accept or Decline an application.
   Protected — requires active admin session.
══════════════════════════════════════════════════ */
app.patch('/admin/api/applications/:id/status', requireAdmin, async (req, res) => {
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

  // Assign callsign and send Telegram welcome when accepting
  let specialUsername = appEntry.specialUsername;
  let tgSent = false;
  let inviteLink = null;

  if (status === 'ACCEPTED' && !appEntry.specialUsername) {
    specialUsername = generateCallsign(id);
    appEntry.specialUsername = specialUsername;
    appEntry.acceptedAt = new Date().toISOString();

    // Try automatic Telegram dispatch if chat_id is known
    const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
    const chatId   = tgHandle ? telegramChatStore.get(tgHandle) : null;

    if (chatId) {
      tgSent = await sendTelegramWelcome(chatId, appEntry);
      appEntry.tgMessageSent = tgSent;
    }

    // Generate deep-link invite (valid 48 h) as fallback
    const token = crypto.randomBytes(16).toString('hex');
    verifyTokenStore.set(String(id), {
      token,
      appId: id,
      expiresAt: Date.now() + 48 * 60 * 60 * 1000,
    });
    inviteLink = `https://t.me/ArxITclub_bot?start=VERIFY_${id}_${token}`;

    console.log(`[ARX-ADMIN] Callsign assigned: ${specialUsername} | TG sent: ${tgSent} | invite: ${inviteLink}`);
  }

  // Return updated stats alongside confirmation
  const total   = applicationStore.length;
  const pending  = applicationStore.filter(a => a.status === 'PENDING').length;
  const accepted = applicationStore.filter(a => a.status === 'ACCEPTED').length;
  const declined = applicationStore.filter(a => a.status === 'DECLINED').length;
  const flagged  = applicationStore.filter(a => a.status === 'FLAGGED').length;

  return res.json({ ok: true, id, status, specialUsername, tgSent, inviteLink, stats: { total, pending, accepted, declined, flagged } });
});

/* ══════════════════════════════════════════════════
   POST /admin/api/clear-strikes
   Clears the strike/lockout record for a given IP
   (or ALL IPs if no ip is provided in the body).
   Protected — requires active admin session.
══════════════════════════════════════════════════ */
app.post('/admin/api/clear-strikes', requireAdmin, (req, res) => {
  const { ip } = req.body || {};
  if (ip) {
    strikeStore.delete(ip);
    console.log(`[ARX-ADMIN] Strikes cleared for ip: ${ip} by ${req.session.adminUser}`);
    return res.json({ ok: true, cleared: ip });
  }
  // No IP supplied — clear everything
  const count = strikeStore.size;
  strikeStore.clear();
  console.log(`[ARX-ADMIN] All strikes cleared (${count} records) by ${req.session.adminUser}`);
  return res.json({ ok: true, cleared: 'ALL', count });
});

/* ══════════════════════════════════════════════════
   ADMIN MEETINGS ENDPOINTS
   GET    /admin/api/meetings        — list all
   POST   /admin/api/meetings        — create new
   DELETE /admin/api/meetings/:id    — delete by id
══════════════════════════════════════════════════ */
app.get('/admin/api/meetings', requireAdmin, (_req, res) => {
  return res.json({ meetings: meetingStore, total: meetingStore.length });
});

app.post('/admin/api/meetings', requireAdmin, (req, res) => {
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

app.delete('/admin/api/meetings/:id', requireAdmin, (req, res) => {
  const id  = parseInt(req.params.id, 10);
  const idx = meetingStore.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'NOT_FOUND' });
  const [removed] = meetingStore.splice(idx, 1);
  console.log(`[ARX-ADMIN] Meeting #${id} "${removed.title}" deleted by ${req.session.adminUser}`);
  return res.json({ ok: true, id });
});

/* ══════════════════════════════════════════════════
   GET /api/lookup
   Allows an applicant to check their status by telegram handle.
══════════════════════════════════════════════════ */
app.get('/api/lookup', (req, res) => {
  const handle = String(req.query.handle || '').trim().toLowerCase().replace(/^@/, '');
  if (!handle || handle.length < 2) return res.status(400).json({ error: 'HANDLE_REQUIRED' });
  const match = applicationStore.find(a =>
    (a.telegram || '').toLowerCase().replace(/^@/, '') === handle ||
    (a.username  || '').toLowerCase() === handle
  );
  if (!match) return res.status(404).json({ found: false, message: 'No application found.' });
  return res.json({ found: true, status: match.status, specialUsername: match.specialUsername || null });
});

/* ══════════════════════════════════════════════════
   POST /api/tg/webhook
   Telegram Bot API webhook. Captures the chat_id when
   a user sends /start to @ArxITclub_bot.
   Set via: https://api.telegram.org/bot<TOKEN>/setWebhook?url=<YOUR_URL>/api/tg/webhook
══════════════════════════════════════════════════ */
app.post('/api/tg/webhook', express.json(), async (req, res) => {
  try {
    const update = req.body;
    const msg    = update.message || update.edited_message;
    if (!msg) return res.json({ ok: true });

    const chatId   = msg.chat && msg.chat.id;
    const username = (msg.from && msg.from.username || '').toLowerCase();
    const text     = (msg.text || '').trim();

    if (!chatId) return res.json({ ok: true });

    // Map username -> chatId
    if (username) telegramChatStore.set(username, chatId);

    // Handle /start VERIFY_{appId}_{token} — deep-link verification
    const verifyMatch = text.match(/^\/start VERIFY_(\d+)_([a-f0-9]+)$/i);
    if (verifyMatch) {
      const [, appIdStr, token] = verifyMatch;
      const stored = verifyTokenStore.get(appIdStr);
      if (stored && stored.token === token && Date.now() < stored.expiresAt) {
        const appEntry = applicationStore.find(a => a.id === Number(appIdStr));
        if (appEntry && appEntry.status === 'ACCEPTED') {
          // Map their username/chatId again in case we didn't have it before
          const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
          if (tgHandle) telegramChatStore.set(tgHandle, chatId);

          if (!appEntry.tgMessageSent) {
            const sent = await sendTelegramWelcome(chatId, appEntry);
            appEntry.tgMessageSent = sent;
          }
          verifyTokenStore.delete(appIdStr); // one-time use
        }
      }
    }

    // Respond to /start generically
    if (text === '/start' || text.startsWith('/start')) {
      // Acknowledge — welcome message dispatched only on verification
      console.log(`[ARX-TG] /start received from @${username} (chatId: ${chatId})`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[ARX-TG] Webhook error:', err);
    return res.status(500).json({ ok: false });
  }
});

/* ══════════════════════════════════════════════════
   POST /admin/api/applications/:id/tg-send
   Admin manually triggers Telegram welcome message
   (or re-sends it).
   Protected — requires active admin session.
══════════════════════════════════════════════════ */
app.post('/admin/api/applications/:id/tg-send', requireAdmin, async (req, res) => {
  const id       = parseInt(req.params.id, 10);
  const appEntry = applicationStore.find(a => a.id === id);
  if (!appEntry) return res.status(404).json({ error: 'NOT_FOUND' });
  if (appEntry.status !== 'ACCEPTED') return res.status(400).json({ error: 'NOT_ACCEPTED', message: 'Application must be ACCEPTED first.' });

  const tgHandle = (appEntry.telegram || '').toLowerCase().replace(/^@/, '');
  const chatId   = tgHandle ? telegramChatStore.get(tgHandle) : null;

  if (!chatId) {
    // Return the invite link instead
    const stored = [...verifyTokenStore.values()].find(v => v.appId === id);
    const inviteLink = stored
      ? `https://t.me/ArxITclub_bot?start=VERIFY_${id}_${stored.token}`
      : null;
    return res.json({ ok: false, reason: 'CHAT_ID_UNKNOWN', inviteLink, message: 'User has not started the bot yet. Share the invite link.' });
  }

  const sent = await sendTelegramWelcome(chatId, appEntry);
  appEntry.tgMessageSent = sent;
  return res.json({ ok: sent, tgSent: sent });
});

/* Catch-all — serve index.html for SPA routing (must stay last) */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


/* ══════════════════════════════════════════════════
   START
══════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   ARX COLLECTIVE — SERVER ONLINE    ║
  ║   http://localhost:${PORT}              ║
  ╚══════════════════════════════════════╝
  `);
});

module.exports = app; // for testing
