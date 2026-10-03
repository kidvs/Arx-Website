/**
 * ARX Collective — script.js
 *
 * Responsibilities:
 *   1. Hash-based SPA router (#home, #about, #domains, #signup)
 *   2. Dark / Light theme toggle (persisted in localStorage)
 *   3. GET /api/status — populate home status panel
 *   4. POST /api/apply — form submission with server response handling
 *   5. Password strength meter
 *   6. Footer clock & utilities
 */

'use strict';

/* ════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════ */
const API_BASE = '';          // same origin — Express serves static + API

/* ════════════════════════════════════════════════════
   THEME SYSTEM
════════════════════════════════════════════════════ */
const html       = document.documentElement;
const themeBtn   = document.getElementById('theme-toggle');
const themeLabel = document.getElementById('theme-label');

let currentTheme = localStorage.getItem('arx_theme') || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  html.setAttribute('data-theme', theme);
  const isLight = theme === 'light';
  themeLabel.textContent = isLight ? 'DARK' : 'LIGHT';
  themeBtn.setAttribute('aria-pressed', String(isLight));
  localStorage.setItem('arx_theme', theme);
  // Swap icon: sun for light mode, moon for dark mode
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.innerHTML = isLight
      ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
}

applyTheme(currentTheme);

themeBtn.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

/* ════════════════════════════════════════════════════
   HASH ROUTER
════════════════════════════════════════════════════ */
const VALID_VIEWS = ['home', 'about', 'domains', 'signup'];

/** Map of view id → cached DOM element */
const viewEls = Object.fromEntries(
  VALID_VIEWS.map(id => [id, document.getElementById(`view-${id}`)])
);

/** All nav anchor elements with [data-nav] */
const navAnchors = document.querySelectorAll('[data-nav]');

/**
 * Activate a view by hash string (e.g. '#home', '#about').
 * Falls back to 'home' if the hash is unknown.
 */
function activateView(hash) {
  const id = (hash || '').replace(/^#/, '') || 'home';
  const target = VALID_VIEWS.includes(id) ? id : 'home';

  // Toggle view visibility
  VALID_VIEWS.forEach(v => viewEls[v].classList.toggle('active', v === target));

  // Update nav link states
  navAnchors.forEach(a => {
    const isCurrent = a.getAttribute('data-nav') === target;
    a.setAttribute('aria-current', isCurrent ? 'page' : 'false');
  });

  window.scrollTo({ top: 0, behavior: 'instant' });

  if (target === 'domains') animateStatBars();
}

// Intercept all internal hash links so we control navigation
document.addEventListener('click', e => {
  const anchor = e.target.closest('a[href^="#"]');
  if (!anchor) return;
  const hash = anchor.getAttribute('href');
  const id   = hash.replace(/^#/, '');
  if (VALID_VIEWS.includes(id)) {
    e.preventDefault();
    history.pushState(null, '', hash);
    activateView(hash);
  }
});

window.addEventListener('hashchange', () => activateView(location.hash));

// Initialise to current hash (or #home)
activateView(location.hash || '#home');

/* ════════════════════════════════════════════════════
   DOMAINS — Animated stat bars
════════════════════════════════════════════════════ */
let statBarsAnimated = false;

function animateStatBars() {
  if (statBarsAnimated) return;
  statBarsAnimated = true;
  requestAnimationFrame(() => {
    document.querySelectorAll('.stat-fill').forEach(el => {
      el.style.width = el.dataset.width + '%';
    });
  });
}

/* ════════════════════════════════════════════════════
   FOOTER CLOCK
════════════════════════════════════════════════════ */
const clockEl = document.getElementById('footer-clock');
const yearEl  = document.getElementById('footer-year');

yearEl.textContent = new Date().getFullYear();

function updateClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} LOCAL`;
}
updateClock();
setInterval(updateClock, 1000);

/* ════════════════════════════════════════════════════
   GET /api/status — populate home panel
════════════════════════════════════════════════════ */
async function fetchStatus() {
  try {
    const res  = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) return;
    const data = await res.json();

    setText('s-recruit',  data.recruitment    || '--');
    setText('s-members',  `${data.activeMembers}_ACTIVE`);
    setText('s-projects', `${data.projects}_RUNNING`);

    if (data.nextMeeting) {
      const d = new Date(data.nextMeeting);
      const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      const dayCode = DAY_CODES[d.getDay()];
      const m   = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      setText('s-meeting', `${dayCode}_${m}-${day}`);
    }
  } catch (_) {
    // Server not running — leave "--" defaults
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

fetchStatus();

/* ════════════════════════════════════════════════════
   SIGNUP FORM ELEMENTS
════════════════════════════════════════════════════ */
const formEl        = document.getElementById('arx-form');
const usernameEl    = document.getElementById('f-username');
const passwordEl    = document.getElementById('f-password');
const essayEl       = document.getElementById('f-essay');
const charCountEl   = document.getElementById('char-count');
const submitBtn     = document.getElementById('submit-btn');
const formAlertEl   = document.getElementById('form-alert');
const formSuccessEl = document.getElementById('form-success');

/* ── Password strength meter ── */
const pwBars  = [1, 2, 3, 4].map(i => document.getElementById(`pw-b${i}`));
const pwLabel = document.getElementById('pw-label');

const PW_LABELS  = ['', 'WEAK', 'WEAK', 'MEDIUM', 'STRONG'];
const PW_CLASSES = ['', 'weak', 'weak', 'medium', 'strong'];

function calcStrength(pw) {
  let s = 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

passwordEl.addEventListener('input', () => {
  const strength = calcStrength(passwordEl.value);
  pwBars.forEach((bar, i) => {
    bar.className = 'pw-bar';
    if (i < strength) bar.classList.add(PW_CLASSES[strength] || '');
  });
  pwLabel.textContent = passwordEl.value.length ? PW_LABELS[strength] : '';
  pwLabel.style.color = strength <= 1 ? 'var(--pink)'
                      : strength <= 3 ? '#ffb400'
                      :                 'var(--green)';
});

/* ── Essay character counter ── */
essayEl.addEventListener('input', () => {
  const len = essayEl.value.length;
  charCountEl.textContent = `${len} chars`;
  charCountEl.className   = `char-count${len > 0 && len < 150 ? ' warn' : ''}`;
});

/* ── Alert helpers ── */
function showAlert(msg) {
  formAlertEl.textContent = msg;
  formAlertEl.hidden = false;
}

function hideAlert() {
  formAlertEl.hidden = true;
  formAlertEl.textContent = '';
}

/* ── Flash invalid input ── */
function flashError(el) {
  el.classList.add('error');
  el.focus();
  setTimeout(() => el.classList.remove('error'), 1600);
}

/* ════════════════════════════════════════════════════
   FORM SUBMISSION → POST /api/apply
════════════════════════════════════════════════════ */
formEl.addEventListener('submit', async e => {
  e.preventDefault();
  hideAlert();

  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  const essay    = essayEl.value.trim();

  /* ── Client-side pre-validation ── */
  if (!username) {
    showAlert('ERR: USERNAME_REQUIRED');
    flashError(usernameEl);
    return;
  }

  if (calcStrength(password) < 2) {
    showAlert('ERR: PASSWORD_TOO_WEAK — min 8 chars, mixed case + digit required');
    flashError(passwordEl);
    return;
  }

  if (essay.length < 150) {
    showAlert(`ERR: ESSAY_TOO_SHORT — ${essay.length}/150 chars minimum`);
    flashError(essayEl);
    return;
  }

  /* ── Disable button while in flight ── */
  submitBtn.disabled    = true;
  submitBtn.textContent = '// TRANSMITTING...';

  try {
    const res  = await fetch(`${API_BASE}/api/apply`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password, essay }),
    });

    const data = await res.json();

    /* ── Handle responses ── */
    if (res.status === 200) {
      // Application accepted
      formEl.hidden        = true;
      formSuccessEl.hidden = false;
      hideAlert();
      return;
    }

    if (res.status === 400 || res.status === 429) {
      // Rejected — show generic message (server handles AI detection silently)
      showAlert(data.message || 'Application submission error — criteria not met. Please review your submission and try again.');
      return;
    }

    if (res.status === 422) {
      // Field validation error from server
      const field = data.field || 'unknown';
      showAlert(`VALIDATION_ERR: ${data.error || 'Invalid input'} (field: ${field})`);
      const fieldEl = document.getElementById(`f-${field}`);
      if (fieldEl) flashError(fieldEl);
      return;
    }

    // Generic / unexpected error
    showAlert(`SERVER_ERR: ${data.message || 'Unexpected server fault. Try again.'}`);

  } catch (err) {
    showAlert('NETWORK_ERR: Could not reach ARX servers. Is the backend running?');
    console.error('[ARX] Submission error:', err);
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = '⟶ SUBMIT APPLICATION';
  }
});
