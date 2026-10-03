/**
 * ARX Collective — script.js
 *
 * Responsibilities:
 *   1. Hash-based SPA router (#home, #about, #domains, #signup, #meetings)
 *   2. Dark / Light theme toggle (persisted in localStorage)
 *   3. GET /api/status — populate home status panel
 *   4. GET /api/meetings — populate meetings panel with live/upcoming cards
 *   5. POST /api/apply — form submission (now includes phone + telegram)
 *   6. Password strength meter
 *   7. Acceptance redirect to @ArxITclub_bot
 *   8. Status lookup by telegram/handle
 *   9. Footer clock & utilities
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
const VALID_VIEWS = ['home', 'about', 'domains', 'meetings', 'signup'];

/** Map of view id → cached DOM element */
const viewEls = Object.fromEntries(
  VALID_VIEWS.map(id => [id, document.getElementById(`view-${id}`)])
);

/** All nav anchor elements with [data-nav] */
const navAnchors = document.querySelectorAll('[data-nav]');

/** Track if meetings have been loaded */
let meetingsLoaded = false;

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

  if (target === 'domains')  animateStatBars();
  if (target === 'meetings') loadMeetings();
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
const formEl         = document.getElementById('arx-form');
const usernameEl     = document.getElementById('f-username');
const passwordEl     = document.getElementById('f-password');
const phoneEl        = document.getElementById('f-phone');
const telegramEl     = document.getElementById('f-telegram');
const essayEl        = document.getElementById('f-essay');
const charCountEl    = document.getElementById('char-count');
const submitBtn      = document.getElementById('submit-btn');
const formAlertEl    = document.getElementById('form-alert');
const formSuccessEl  = document.getElementById('form-success');
const formAcceptedEl = document.getElementById('form-accepted');

/* ── Certificate upload elements ── */
const certFileInput   = document.getElementById('cert-file-input');
const certDropzone    = document.getElementById('cert-dropzone');
const certFileList    = document.getElementById('cert-file-list');
const certLimitNote   = document.getElementById('cert-limit-note');

/** Staged files (File objects) — max 3 */
let stagedCerts = [];

const MAX_CERT_FILES  = 3;
const MAX_CERT_SIZE   = 5 * 1024 * 1024; // 5 MB
const CERT_MIMES_OK   = new Set(['image/jpeg','image/png','image/webp','application/pdf']);

function formatFileSize(bytes) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024*1024)  return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

function validateCertFile(file) {
  if (!CERT_MIMES_OK.has(file.type)) return `${file.name}: unsupported type (JPEG, PNG, WebP, PDF only)`;
  if (file.size > MAX_CERT_SIZE)     return `${file.name}: exceeds 5 MB limit (${formatFileSize(file.size)})`;
  return null;
}

function renderCertList() {
  if (certLimitNote) certLimitNote.textContent = '';
  if (!certFileList) return;
  if (!stagedCerts.length) { certFileList.innerHTML = ''; return; }

  certFileList.innerHTML = stagedCerts.map((file, idx) => {
    const isPdf = file.type === 'application/pdf';
    const preview = isPdf
      ? `<span class="cert-pdf-badge">[PDF]</span>`
      : `<img class="cert-thumb" data-idx="${idx}" src="" alt="" />`;
    return `
      <div class="cert-file-card" data-idx="${idx}">
        ${preview}
        <div class="cert-file-info">
          <span class="cert-file-name" title="${escFrontend(file.name)}">${escFrontend(file.name)}</span>
          <span class="cert-file-size">${formatFileSize(file.size)}</span>
        </div>
        <button type="button" class="cert-file-remove" data-remove="${idx}" aria-label="Remove ${escFrontend(file.name)}">&times;</button>
      </div>`;
  }).join('');

  // Load image previews
  stagedCerts.forEach((file, idx) => {
    if (file.type !== 'application/pdf') {
      const img = certFileList.querySelector(`img[data-idx="${idx}"]`);
      if (img) {
        const reader = new FileReader();
        reader.onload = e => { img.src = e.target.result; };
        reader.readAsDataURL(file);
      }
    }
  });

  // Remove button handler
  certFileList.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.remove, 10);
      stagedCerts.splice(i, 1);
      renderCertList();
    });
  });
}

function addCertFiles(files) {
  if (certLimitNote) certLimitNote.textContent = '';
  for (const file of files) {
    if (stagedCerts.length >= MAX_CERT_FILES) {
      if (certLimitNote) certLimitNote.textContent = `Maximum ${MAX_CERT_FILES} files allowed.`;
      break;
    }
    const err = validateCertFile(file);
    if (err) {
      if (certLimitNote) certLimitNote.textContent = err;
      continue;
    }
    // Avoid duplicates by name+size
    if (!stagedCerts.find(f => f.name === file.name && f.size === file.size)) {
      stagedCerts.push(file);
    }
  }
  renderCertList();
}

if (certFileInput) {
  certFileInput.addEventListener('change', () => {
    addCertFiles(Array.from(certFileInput.files || []));
    certFileInput.value = ''; // reset so same file can be re-selected
  });
}

if (certDropzone) {
  // Keyboard activation
  certDropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); certFileInput && certFileInput.click(); }
  });

  certDropzone.addEventListener('click', e => {
    // Only trigger input if click is NOT on the label (label already does it)
    if (!e.target.closest('label') && certFileInput) certFileInput.click();
  });

  certDropzone.addEventListener('dragover', e => { e.preventDefault(); certDropzone.classList.add('drag-over'); });
  certDropzone.addEventListener('dragleave', () => certDropzone.classList.remove('drag-over'));
  certDropzone.addEventListener('drop', e => {
    e.preventDefault();
    certDropzone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files || []);
    addCertFiles(files);
  });
}

/* ── Status lookup elements ── */
const statusLookupForm   = document.getElementById('status-lookup-form');
const lookupHandleEl     = document.getElementById('lookup-handle');
const lookupResultEl     = document.getElementById('lookup-result');
const lookupBtn          = document.getElementById('lookup-btn');

/* ── Password strength meter ── */
const pwBars  = [1, 2, 3, 4].map(i => document.getElementById(`pw-b${i}`));
const pwLabel = document.getElementById('pw-label');

// Strength levels:  0=empty  1=too short  2=missing required chars  3=acceptable  4=strong
// Mapping index 0..4 → label / CSS class
const PW_LABELS  = ['', 'TOO SHORT', 'MISSING REQUIRED', 'ACCEPTABLE', 'STRONG'];
const PW_CLASSES = ['', 'weak',      'weak',              'medium',     'strong'];

/**
 * calcStrength(pw) → 0..4
 *
 * Scoring (additive):
 *   +1  length >= 8   (minimum server requirement)
 *   +1  has uppercase AND lowercase   (server requirement)
 *   +1  has digit                     (server requirement)
 *   +1  length >= 12 OR has symbol    (bonus: bumps to "strong")
 *
 * A score < 3 means the password WILL be rejected by the server.
 * Score 3  → ACCEPTABLE (meets all server-side rules).
 * Score 4  → STRONG (extra length or special character on top).
 */
function calcStrength(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)                              s++; // mandatory length
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw))       s++; // mandatory mixed-case
  if (/[0-9]/.test(pw))                            s++; // mandatory digit
  if (pw.length >= 12 || /[^A-Za-z0-9]/.test(pw)) s++; // bonus: long OR symbol
  return Math.min(s, 4);
}

/**
 * passwordMeetsServerRules(pw)
 * Returns true only when the password will pass server-side validatePassword().
 * Keeps client-side gate in perfect sync with the backend rules.
 */
function passwordMeetsServerRules(pw) {
  return (
    typeof pw === 'string' &&
    pw.length >= 8        &&
    pw.length <= 128      &&
    /[A-Z]/.test(pw)      &&
    /[a-z]/.test(pw)      &&
    /[0-9]/.test(pw)
  );
}

passwordEl.addEventListener('input', () => {
  const pw       = passwordEl.value;
  const strength = calcStrength(pw);

  // Animate the 4 strength bars
  pwBars.forEach((bar, i) => {
    bar.className = 'pw-bar';
    if (i < strength) bar.classList.add(PW_CLASSES[strength] || '');
  });

  // Label text
  pwLabel.textContent = pw.length ? PW_LABELS[strength] : '';

  // Label colour: red if rejected by server, amber if acceptable, green if strong
  pwLabel.style.color = !passwordMeetsServerRules(pw) ? 'var(--pink)'
                      : strength < 4                  ? '#ffb400'
                      :                                 'var(--green)';

  // Inline hint when password is non-empty but not yet acceptable
  const hint = document.getElementById('pw-hint');
  if (hint) {
    if (!pw.length) {
      hint.textContent = '';
    } else if (pw.length < 8) {
      hint.textContent = `${8 - pw.length} more character${8 - pw.length > 1 ? 's' : ''} needed`;
    } else if (!/[A-Z]/.test(pw)) {
      hint.textContent = 'Add at least one uppercase letter';
    } else if (!/[a-z]/.test(pw)) {
      hint.textContent = 'Add at least one lowercase letter';
    } else if (!/[0-9]/.test(pw)) {
      hint.textContent = 'Add at least one digit (0–9)';
    } else {
      hint.textContent = strength === 4 ? '✓ Excellent password' : 'Tip: add a symbol or make it longer';
    }
  }
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
/* ════════════════════════════════════════════════════
   TELEGRAM ACCEPTANCE REDIRECT
════════════════════════════════════════════════════ */
const ARX_TG_BOT = 'https://t.me/ArxITclub_bot';

function showAcceptanceRedirect(specialUsername) {
  if (formEl)         formEl.hidden         = true;
  if (formSuccessEl)  formSuccessEl.hidden  = true;
  if (formAcceptedEl) formAcceptedEl.hidden = false;
  hideAlert();

  // Show callsign if provided
  const revealEl    = document.getElementById('callsign-reveal');
  const callsignVal = document.getElementById('callsign-value');
  if (revealEl && callsignVal && specialUsername) {
    callsignVal.textContent = specialUsername;
    revealEl.hidden = false;
  }

  let secs = 3;
  const numEl = document.getElementById('tg-count-num');
  if (numEl) numEl.textContent = secs;

  const timer = setInterval(() => {
    secs--;
    if (numEl) numEl.textContent = Math.max(secs, 0);
    if (secs <= 0) {
      clearInterval(timer);
      window.open(ARX_TG_BOT, '_blank', 'noopener,noreferrer');
    }
  }, 1000);
}

/* ════════════════════════════════════════════════════
   STATUS LOOKUP FORM
════════════════════════════════════════════════════ */
if (statusLookupForm) {
  statusLookupForm.addEventListener('submit', async e => {
    e.preventDefault();
    const query = (lookupHandleEl ? lookupHandleEl.value.trim() : '').replace(/^@/, '');
    if (!query) return;

    if (lookupBtn) { lookupBtn.disabled = true; lookupBtn.textContent = '// QUERYING...'; }
    if (lookupResultEl) lookupResultEl.hidden = true;

    try {
      const res  = await fetch(`${API_BASE}/api/lookup?handle=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!lookupResultEl) return;
      lookupResultEl.hidden = false;

      if (res.ok && data.status) {
        if (data.status === 'ACCEPTED') {
          const callsignBlock = data.specialUsername
            ? `<div style="margin:.8rem 0;padding:.7rem 1rem;background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.25);border-radius:3px">
                 <p style="font-size:.55rem;letter-spacing:.18em;color:var(--text-dim);margin-bottom:.3rem">ASSIGNED CODENAME</p>
                 <p style="font-size:1.1rem;font-weight:900;letter-spacing:.1em;color:var(--green);text-shadow:0 0 12px rgba(0,255,136,.4)">${escFrontend(data.specialUsername)}</p>
               </div>` : '';
          lookupResultEl.innerHTML =
            `<div class="lookup-accepted">✓ Status: <strong class="c-green">ACCEPTED</strong>
             ${callsignBlock}
             <a href="${ARX_TG_BOT}" target="_blank" rel="noopener noreferrer" class="btn mt-2" style="display:block;text-align:center">📱 OPEN @ArxITclub_bot</a></div>`;
          setTimeout(() => window.open(ARX_TG_BOT, '_blank', 'noopener,noreferrer'), 1500);
        } else {
          const labels = { PENDING: 'PENDING REVIEW', DECLINED: 'DECLINED', FLAGGED: 'FLAGGED', PENDING_REVIEW: 'PENDING REVIEW' };
          const colors = { PENDING: 'var(--cyan)', DECLINED: 'var(--pink)', FLAGGED: 'var(--pink)' };
          const label = labels[data.status] || data.status;
          const color = colors[data.status] || 'var(--text-dim)';
          lookupResultEl.innerHTML =
            `<div class="lookup-status">Status for <strong>@${escFrontend(query)}</strong>: <strong style="color:${color}">${escFrontend(label)}</strong></div>`;
        }
      } else {
        lookupResultEl.innerHTML = '<div class="lookup-status" style="color:var(--text-dim)">No application found for that handle.</div>';
      }
    } catch {
      if (lookupResultEl) lookupResultEl.innerHTML = '<div class="lookup-status" style="color:var(--pink)">Could not reach server.</div>';
    } finally {
      if (lookupBtn) { lookupBtn.disabled = false; lookupBtn.textContent = '\u2315 CHECK STATUS'; }
    }
  });
}

function escFrontend(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════════
   FORM SUBMISSION → POST /api/apply
════════════════════════════════════════════════════ */
formEl.addEventListener('submit', async e => {
  e.preventDefault();
  hideAlert();

  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  const phone    = phoneEl    ? phoneEl.value.trim()    : '';
  const telegram = telegramEl ? telegramEl.value.trim() : '';
  const essay    = essayEl.value.trim();

  /* ── Client-side pre-validation ── */
  if (!username) {
    showAlert('ERR: USERNAME_REQUIRED');
    flashError(usernameEl);
    return;
  }

  if (!passwordMeetsServerRules(password)) {
    const issues = [];
    if (password.length < 8)       issues.push('min 8 characters');
    if (!/[A-Z]/.test(password))   issues.push('an uppercase letter');
    if (!/[a-z]/.test(password))   issues.push('a lowercase letter');
    if (!/[0-9]/.test(password))   issues.push('a digit (0–9)');
    showAlert('ERR: PASSWORD_TOO_WEAK — requires ' + issues.join(', '));
    flashError(passwordEl);
    return;
  }

  if (phoneEl && !phone) {
    showAlert('ERR: PHONE_REQUIRED');
    flashError(phoneEl);
    return;
  }

  if (telegramEl) {
    const tgHandle = telegram.replace(/^@/, '');
    if (!tgHandle || tgHandle.length < 5) {
      showAlert('ERR: TELEGRAM_INVALID — handle must be at least 5 characters');
      flashError(telegramEl);
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(tgHandle)) {
      showAlert('ERR: TELEGRAM_INVALID_CHARS — only letters, digits, and underscores allowed');
      flashError(telegramEl);
      return;
    }
  }

  if (essay.length < 150) {
    showAlert(`ERR: ESSAY_TOO_SHORT — ${essay.length}/150 chars minimum`);
    flashError(essayEl);
    return;
  }

  /* ── Disable button while in flight ── */
  submitBtn.disabled    = true;
  submitBtn.textContent = '// TRANSMITTING...';

  // Normalise telegram: always send with @ prefix
  const telegramNorm = telegram ? (telegram.startsWith('@') ? telegram : `@${telegram}`) : '';

  try {
    // Build FormData for multipart upload (supports file attachments)
    const fd = new FormData();
    fd.append('username', username);
    fd.append('password', password);
    fd.append('phone',    phone);
    fd.append('telegram', telegramNorm);
    fd.append('essay',    essay);
    stagedCerts.forEach(file => fd.append('certificates', file));

    const res  = await fetch(`${API_BASE}/api/apply`, {
      method: 'POST',
      body:   fd,
      // NOTE: Do NOT set Content-Type header — browser sets it with boundary automatically
    });

    const data = await res.json();

    /* ── Handle responses ── */
    if (res.status === 200) {
      if (data.status === 'ACCEPTED') {
        // Immediately accepted — redirect to Telegram bot
        showAcceptanceRedirect(data.specialUsername || null);
      } else {
        // Queued as PENDING for admin review
        formEl.hidden        = true;
        formSuccessEl.hidden = false;
        hideAlert();
      }
      return;
    }

    if (res.status === 403 && data.status === 'ACCESS_DENIED') {
      showBanAlert(data.message || 'Unauthorized access — Username not registered on club whitelist.');
      lockForm();
      return;
    }

    if (res.status === 400 && data.status === 'FLAGGED') {
      showBanAlert(data.message || 'AI-generated content detected. Your application has been flagged and you are no longer eligible to apply.');
      lockForm();
      return;
    }

    if (res.status === 429 && data.status === 'BANNED') {
      showBanAlert(data.message || 'AI-generated content was previously detected. You are no longer eligible to apply.');
      lockForm();
      return;
    }

    if (res.status === 422) {
      const field = data.field || 'unknown';
      showAlert(`VALIDATION_ERR: ${data.error || 'Invalid input'} (field: ${field})`);
      const fieldEl = document.getElementById(`f-${field}`);
      if (fieldEl) flashError(fieldEl);
      return;
    }

    showAlert(`SERVER_ERR: ${data.message || 'Unexpected server fault. Try again.'}`);

  } catch (err) {
    showAlert('NETWORK_ERR: Could not reach ARX servers. Is the backend running?');
    console.error('[ARX] Submission error:', err);
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = '\u27f6 SUBMIT APPLICATION';
  }
});

/* ── Ban helpers ── */
function showBanAlert(msg) {
  formAlertEl.textContent = '⚠ ' + msg;
  formAlertEl.hidden      = false;
  formAlertEl.style.background    = 'rgba(255,51,102,0.12)';
  formAlertEl.style.border        = '1px solid rgba(255,51,102,0.5)';
  formAlertEl.style.color         = '#ff3366';
  formAlertEl.style.padding       = '1rem';
  formAlertEl.style.borderRadius  = '4px';
  formAlertEl.style.fontWeight    = '700';
  formAlertEl.style.letterSpacing = '0.05em';
}

function lockForm() {
  // Disable all interactive elements so user cannot resubmit
  submitBtn.disabled    = true;
  submitBtn.textContent = '\u27f6 APPLICATION BLOCKED';
  submitBtn.style.opacity      = '0.4';
  submitBtn.style.cursor       = 'not-allowed';
  submitBtn.style.borderColor  = '#ff3366';
  submitBtn.style.color        = '#ff3366';
  usernameEl.disabled = true;
  passwordEl.disabled = true;
  essayEl.disabled    = true;
  if (phoneEl)        phoneEl.disabled    = true;
  if (telegramEl)     telegramEl.disabled = true;
  if (certFileInput)  certFileInput.disabled = true;
}

/* ════════════════════════════════════════════════════
   MEETINGS — fetch & render
════════════════════════════════════════════════════ */
const DOMAIN_TAGS = {
  WEB_DEV:      { label: 'WEB DEV',      color: 'var(--cyan)' },
  CYBERSECURITY:{ label: 'CYBERSECURITY',color: 'var(--pink)' },
  PYTHON:       { label: 'PYTHON',       color: 'var(--green)' },
  ROBOTICS:     { label: 'ROBOTICS',     color: '#ffb400' },
  GENERAL:      { label: 'GENERAL',      color: 'var(--text-dim)' },
};

let countdownIntervals = [];

async function loadMeetings() {
  if (meetingsLoaded) return;          // only fetch once per session
  meetingsLoaded = true;

  const liveEl     = document.getElementById('meetings-live');
  const gridEl     = document.getElementById('meetings-grid');
  if (!liveEl || !gridEl) return;

  gridEl.innerHTML = '<div class="meetings-loading"><span class="spinner-sm"></span> LOADING SCHEDULE...</div>';

  try {
    const res  = await fetch(`${API_BASE}/api/meetings`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Clear any running countdown timers
    countdownIntervals.forEach(clearInterval);
    countdownIntervals = [];

    renderLiveMeeting(liveEl, data.live || []);
    renderUpcomingMeetings(gridEl, data.upcoming || []);
  } catch (err) {
    if (gridEl) gridEl.innerHTML = `<div class="meetings-empty"><span class="empty-glyph" style="color:var(--pink)">!</span><p style="color:var(--pink)">Failed to load schedule: ${escFrontend(err.message)}</p></div>`;
  }
}

function domainTag(domain) {
  const d = DOMAIN_TAGS[domain] || DOMAIN_TAGS.GENERAL;
  return `<span class="meeting-domain-tag" style="color:${d.color};border-color:${d.color}20;background:${d.color}0f">${d.label}</span>`;
}

function renderLiveMeeting(container, live) {
  if (!live.length) {
    container.innerHTML = '<div class="meetings-empty"><span class="empty-glyph">◈</span><p>No session is live right now.</p></div>';
    return;
  }
  const m = live[0];
  const link = m.link ? `<a href="${escFrontend(m.link)}" target="_blank" rel="noopener noreferrer" class="btn meetings-join-btn">▶ ENTER SESSION</a>` : '<span class="btn meetings-join-btn" style="opacity:.4;cursor:not-allowed">▶ CAMPUS ONLY</span>';
  container.innerHTML = `
    <div class="meeting-live-card">
      <div class="live-pulse-badge"><span class="live-dot"></span> LIVE</div>
      <div class="meeting-live-body">
        <div class="meeting-live-meta">
          ${domainTag(m.domain)}
          <span class="meeting-type-badge">${escFrontend(m.type)}</span>
        </div>
        <h3 class="meeting-live-title">${escFrontend(m.title)}</h3>
        <p class="meeting-live-desc">${escFrontend(m.description)}</p>
        <div class="meeting-live-footer">
          <span class="meeting-host">👤 ${escFrontend(m.host)}</span>
          <span class="meeting-time">${escFrontend(m.startTime)} – ${escFrontend(m.endTime)}</span>
        </div>
      </div>
      <div class="meeting-live-action">${link}</div>
    </div>`;
}

function renderUpcomingMeetings(container, upcoming) {
  if (!upcoming.length) {
    container.innerHTML = '<div class="meetings-empty"><span class="empty-glyph">◈</span><p>No upcoming sessions scheduled.</p></div>';
    return;
  }

  container.innerHTML = upcoming.map(m => {
    const startDt  = new Date(`${m.date}T${m.startTime}`);
    const dateStr  = startDt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
    const link     = m.link ? `<a href="${escFrontend(m.link)}" target="_blank" rel="noopener noreferrer" class="btn meeting-card-btn">JOIN ONLINE →</a>` : `<span class="meeting-location-badge">🏛 CAMPUS</span>`;
    return `
      <article class="meeting-card hud-panel" data-meeting-id="${m.id}">
        <div class="meeting-card-header">
          ${domainTag(m.domain)}
          <span class="meeting-type-badge">${escFrontend(m.type)}</span>
        </div>
        <h3 class="meeting-card-title">${escFrontend(m.title)}</h3>
        <p class="meeting-card-desc">${escFrontend(m.description)}</p>
        <div class="meeting-card-meta">
          <span class="meeting-date">📅 ${dateStr}</span>
          <span class="meeting-time">⏰ ${escFrontend(m.startTime)} – ${escFrontend(m.endTime)}</span>
          <span class="meeting-host">👤 ${escFrontend(m.host)}</span>
        </div>
        <div class="meeting-card-footer">
          <span class="meeting-countdown" id="countdown-${m.id}" aria-live="polite"></span>
          ${link}
        </div>
      </article>`;
  }).join('');

  // Start live countdowns for each card
  upcoming.forEach(m => {
    const el = document.getElementById(`countdown-${m.id}`);
    if (!el) return;
    const startDt = new Date(`${m.date}T${m.startTime}`);
    function tick() {
      const diff = startDt - Date.now();
      if (diff <= 0) { el.textContent = 'Starting now!'; return; }
      const d  = Math.floor(diff / 86400000);
      const h  = Math.floor((diff % 86400000) / 3600000);
      const mn = Math.floor((diff % 3600000)  / 60000);
      el.textContent = d > 0 ? `Starts in ${d}d ${h}h` : h > 0 ? `Starts in ${h}h ${mn}m` : `Starts in ${mn}m`;
    }
    tick();
    countdownIntervals.push(setInterval(tick, 30000));
  });
}
