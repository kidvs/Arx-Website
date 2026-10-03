/**
 * ARX Collective — Express Backend
 * server.js
 *
 * Endpoints:
 *   POST /api/apply   — Student application with server-side AI detection
 *   GET  /api/status  — Club operational metrics
 */

'use strict';

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ══════════════════════════════════════════════════
   MIDDLEWARE
══════════════════════════════════════════════════ */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc:   ["'self'"],
      connectSrc:  ["'self'"],
      imgSrc:      ["'self'", 'data:'],
    },
  },
}));

app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ══════════════════════════════════════════════════
   IN-MEMORY STRIKE / LOCKOUT STORE
   Key: IP address  →  { strikes: Number, lockedUntil: Number|null }
   In production replace with Redis or a persistent store.
══════════════════════════════════════════════════ */
const strikeStore = new Map();

const MAX_STRIKES       = 3;
const LOCKOUT_DURATION  = 24 * 60 * 60 * 1000; // 24 h in ms

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
  record.strikes     = 0;
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
   AI ESSAY DETECTION ENGINE
══════════════════════════════════════════════════ */
const AI_MARKERS = {

  transitions: [
    'furthermore','moreover','additionally','in conclusion','in summary',
    'to summarize','it is important to note','it is worth noting',
    'undoubtedly','certainly','obviously','as previously mentioned',
    "in today's world",'in the modern era','one of the most',
    'this is because','as a result','therefore','consequently',
    'in addition','not only that','having said that','with that being said',
    'needless to say','it goes without saying','in order to','as such',
    'at the end of the day','this is especially true','it is clear that',
    'there are many','a wide range of','a variety of','in terms of',
    'when it comes to','due to the fact that','it can be seen',
    'it should be noted','it is essential','it is crucial',
  ],

  genericPhrases: [
    'passion for technology','passion for learning','passion for computer science',
    'i have always been passionate','i have always been interested',
    'ever since i was young','since a young age','since childhood',
    'i believe that','this would allow me to','opportunity to grow',
    'expand my horizons','take my skills to the next level',
    'make a difference','contribute to the community','give back',
    'team player','hard worker','fast learner','quick learner',
    'i am a dedicated','i am committed to','i am eager to',
    'i strive to','i look forward to','i am excited to',
    'i would be honored','grateful for the opportunity',
    'valuable experience','enhance my knowledge',
    'broaden my understanding','gain hands-on experience',
    'real-world experience','sharpen my skills',
    'i am highly motivated','driven individual',
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
  ],

  corpSpeak: [
    'utilize','facilitate','endeavor','leverage','synergy','paradigm',
    'holistic','streamline','optimize','comprehensive','robust',
    'scalable','dynamic','innovative','cutting-edge','proactive',
    'best practices','value-add','deliverables','bandwidth','deep dive',
    'circle back','touch base','move the needle','think outside the box',
  ],
};

/**
 * analyzeEssay(text)
 * Returns: { score: 0-100, flags: string[], label: string }
 *
 * Scoring rubric (additive, capped at 100):
 *   High transition density          → +15–25
 *   Generic phrase cluster           → +20 (×2 hits) +15 (×4 hits)
 *   AI structural patterns           → +18 (×2 matches) +12 (×4)
 *   Low burstiness (<0.22 stddev)    → +18
 *   Moderate burstiness (0.22-0.35)  → +8
 *   Repetitive vocabulary            → +10
 *   Avg sentence length > 28 words   → +12
 *   Low first-person ratio           → +10
 *   Corp-speak density ≥ 3           → +12
 *
 * Threshold for rejection: score ≥ 45
 */
function analyzeEssay(text) {
  if (!text || text.trim().length < 30) {
    return { score: 0, flags: [], label: 'TOO_SHORT' };
  }

  const lower     = text.toLowerCase();
  const words     = text.trim().split(/\s+/);
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.split(/\s+/).length > 3);
  const flags     = [];
  let   score     = 0;

  /* — Transition density — */
  let transitionCount = 0;
  for (const t of AI_MARKERS.transitions) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hits = (lower.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
    transitionCount += hits;
  }
  const transitionDensity = transitionCount / Math.max(sentences.length, 1);
  if (transitionDensity > 0.55) {
    score += transitionDensity > 1.0 ? 25 : 15;
    flags.push('HIGH_TRANSITION_DENSITY');
  }

  /* — Generic phrase cluster — */
  let genericHits = 0;
  for (const p of AI_MARKERS.genericPhrases) {
    if (lower.includes(p)) genericHits++;
  }
  if (genericHits >= 2) { score += 20; flags.push('GENERIC_PHRASE_CLUSTER'); }
  if (genericHits >= 4) { score += 15; flags.push('SEVERE_GENERIC_DENSITY'); }

  /* — Structure / format patterns — */
  let patternHits = 0;
  for (const re of AI_MARKERS.structureRegexes) {
    if (re.test(text)) patternHits++;
  }
  if (patternHits >= 2) { score += 18; flags.push('STRUCTURED_AI_FORMAT'); }
  if (patternHits >= 4) { score += 12; flags.push('HIGH_FORMAT_REGULARITY'); }

  /* — Burstiness (sentence length variance) — */
  if (sentences.length >= 4) {
    const lengths = sentences.map(s => s.split(/\s+/).length);
    const mean    = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length;
    const stdDev  = Math.sqrt(variance);
    const burstiness = mean > 0 ? stdDev / mean : 1;
    if (burstiness < 0.22)      { score += 18; flags.push('LOW_BURSTINESS'); }
    else if (burstiness < 0.35) { score += 8;  flags.push('MODERATE_BURSTINESS'); }
  }

  /* — Repetitive vocabulary — */
  const wordFreq = {};
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    if (clean.length > 4) wordFreq[clean] = (wordFreq[clean] || 0) + 1;
  }
  const repeatedWordCount = Object.values(wordFreq).filter(v => v > 3).length;
  if (repeatedWordCount > 4) { score += 10; flags.push('REPETITIVE_VOCABULARY'); }

  /* — Average sentence length — */
  if (sentences.length > 2) {
    const avgLen = words.length / sentences.length;
    if (avgLen > 28) { score += 12; flags.push('OVERLY_LONG_SENTENCES'); }
  }

  /* — First-person ratio — */
  const firstPersonMatches = (text.match(/\b(I|my|me|myself|I've|I'm|I'd|I'll)\b/g) || []).length;
  const firstPersonRatio   = firstPersonMatches / Math.max(words.length, 1);
  if (firstPersonRatio < 0.02 && words.length > 60) {
    score += 10;
    flags.push('LOW_PERSONAL_VOICE');
  }

  /* — Corp-speak density — */
  const corpHits = AI_MARKERS.corpSpeak.filter(w => lower.includes(w)).length;
  if (corpHits >= 3) { score += 12; flags.push('CORP_SPEAK_DETECTED'); }

  score = Math.min(score, 100);

  const label = score < 25  ? 'HUMAN_LIKELY'
              : score < 50  ? 'SUSPICIOUS'
              : score < 70  ? 'AI_PROBABLE'
              :               'AI_DETECTED';

  return { score, flags, label };
}

/* ══════════════════════════════════════════════════
   INPUT VALIDATION HELPERS
══════════════════════════════════════════════════ */
function validateUsername(username) {
  if (typeof username !== 'string') return 'USERNAME_INVALID_TYPE';
  const trimmed = username.trim();
  if (trimmed.length < 2)  return 'USERNAME_TOO_SHORT';
  if (trimmed.length > 32) return 'USERNAME_TOO_LONG';
  if (!/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) return 'USERNAME_INVALID_CHARS';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'PASSWORD_INVALID_TYPE';
  if (password.length < 8)  return 'PASSWORD_TOO_SHORT';
  if (password.length > 128) return 'PASSWORD_TOO_LONG';
  const hasUpper  = /[A-Z]/.test(password);
  const hasLower  = /[a-z]/.test(password);
  const hasDigit  = /[0-9]/.test(password);
  if (!hasUpper || !hasLower || !hasDigit) return 'PASSWORD_WEAK';
  return null;
}

function validateEssay(essay) {
  if (typeof essay !== 'string') return 'ESSAY_INVALID_TYPE';
  const trimmed = essay.trim();
  if (trimmed.length < 150)   return 'ESSAY_TOO_SHORT';
  if (trimmed.length > 10000) return 'ESSAY_TOO_LONG';
  return null;
}

/* ══════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════ */

/**
 * POST /api/apply
 *
 * Body: { username: string, password: string, essay: string }
 *
 * Responses:
 *   200  { status: 'ACCEPTED', message }
 *   400  { status: 'FLAGGED', strikes, strikesRemaining, score, flags, label, message }
 *   422  { status: 'VALIDATION_ERROR', field, error }
 *   429  { status: 'LOCKED_OUT', lockedUntil, remainingMs, message }
 *   500  Internal server error
 */
app.post('/api/apply', (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const record = getRecord(ip);

    /* — Check lockout — */
    if (isLockedOut(record)) {
      return res.status(429).json({
        status: 'REJECTED',
        message: 'Application submission error. Please try again later.',
      });
    }

    const { username, password, essay } = req.body || {};

    /* — Field validation — */
    const usernameErr = validateUsername(username);
    if (usernameErr) {
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'username', error: usernameErr });
    }

    const passwordErr = validatePassword(password);
    if (passwordErr) {
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'password', error: passwordErr });
    }

    const essayErr = validateEssay(essay);
    if (essayErr) {
      return res.status(422).json({ status: 'VALIDATION_ERROR', field: 'essay', error: essayErr });
    }

    /* — AI detection (stealth — results never exposed to client) — */
    const detection = analyzeEssay(essay.trim());

    if (detection.score >= 45) {
      const strikes = addStrike(record);

      // Log internally for ops visibility only
      console.log(`[ARX] Essay flagged — ip: ${ip}, user: ${username.trim()}, score: ${detection.score}, flags: [${detection.flags.join(', ')}], strikes: ${strikes}/${MAX_STRIKES}`);

      if (isLockedOut(record)) {
        return res.status(429).json({
          status: 'REJECTED',
          message: 'Application submission error. Please try again later.',
        });
      }

      return res.status(400).json({
        status: 'REJECTED',
        message: 'Application submission error — criteria not met. Please review your submission and try again.',
      });
    }

    /* — Accepted — */
    // In production: persist to database, send confirmation email, etc.
    console.log(`[ARX] New application from ${ip} — user: ${username.trim()} — essay score: ${detection.score}`);

    return res.status(200).json({
      status:  'ACCEPTED',
      message: 'APPLICATION_RECEIVED // Payload encrypted and queued for committee review.',
      score:   detection.score,
      label:   detection.label,
    });

  } catch (err) {
    console.error('[ARX] /api/apply error:', err);
    return res.status(500).json({ status: 'SERVER_ERROR', message: 'Internal system fault.' });
  }
});

/**
 * GET /api/status
 *
 * Returns club operational metrics.
 */
app.get('/api/status', (_req, res) => {
  const now  = new Date();
  // Next meeting: Monday, October 5, 2026 at 18:00
  const next = new Date('2026-10-05T18:00:00');

  return res.json({
    status:        'OPERATIONAL',
    timestamp:     now.toISOString(),
    recruitment:   'OPEN',
    activeMembers: 47,
    projects:      12,
    nextMeeting:   next.toISOString(),
    domains: [
      { id: 'web_dev',      status: 'ACTIVE', members: 15 },
      { id: 'robotics',     status: 'ACTIVE', members: 10 },
      { id: 'cybersecurity',status: 'ACTIVE', members: 12 },
      { id: 'python',       status: 'ACTIVE', members: 10 },
    ],
  });
});

/* Catch-all — serve index.html for SPA routing */
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
