/**
 * ARX Collective — Admin Panel Client
 * public/admin-panel.js
 *
 * Responsibilities:
 *   1. Check session state on load (GET /admin/api/me)
 *   2. Handle admin login / logout
 *   3. Fetch and render applicant data from GET /admin/api/applications
 *   4. Client-side search, filter (All / Pending / Accepted / Declined / Flagged), and sort
 *   5. Full-essay modal with word count + reading time
 *   6. Accept / Decline decision buttons on cards AND inside the modal
 *   7. PATCH /admin/api/applications/:id/status — live status updates + stat refresh
 */

'use strict';

const ADMIN_BASE = (window.ADMIN_BASE || window.location.pathname.replace(/\/+$/, '') || '/admin');

/* ─────────────────────────────────────────────────
   DOM REFERENCES
───────────────────────────────────────────────── */
const loginScreen    = document.getElementById('login-screen');
const dashboard      = document.getElementById('dashboard');
const loginForm      = document.getElementById('login-form');
const loginError     = document.getElementById('login-error');
const loginBtn       = document.getElementById('login-btn');
const logoutBtn      = document.getElementById('logout-btn');
const adminUserEl    = document.getElementById('admin-user');
const sessionTimeEl  = document.getElementById('session-time');

const searchEl   = document.getElementById('search');
const filterBtns = document.querySelectorAll('[data-filter]');
const sortEl     = document.getElementById('sort-select');
const appsGrid   = document.getElementById('apps-grid');
const refreshBtn = document.getElementById('refresh-btn');

const statTotal    = document.getElementById('stat-total');
const statPending  = document.getElementById('stat-pending');
const statAccepted = document.getElementById('stat-accepted');
const statDeclined = document.getElementById('stat-declined');
const statAvg      = document.getElementById('stat-avg');

const essayModal         = document.getElementById('essay-modal');
const modalClose         = document.getElementById('modal-close');
const modalContent       = document.getElementById('modal-content');
const modalAcceptBtn     = document.getElementById('modal-accept-btn');
const modalDeclineBtn    = document.getElementById('modal-decline-btn');
const modalCurrentStatus = document.getElementById('modal-current-status');

/* ── Panel tabs ── */
const tabApplications  = document.getElementById('tab-applications');
const tabMeetings      = document.getElementById('tab-meetings');
const tabTelegram      = document.getElementById('tab-telegram');
const secApplications  = document.getElementById('section-applications');
const secMeetings      = document.getElementById('section-meetings');
const secTelegram      = document.getElementById('section-telegram');

/* ─────────────────────────────────────────────────
   TOAST NOTIFICATION SYSTEM
───────────────────────────────────────────────── */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `arx-toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 350);
  }, 4500);
}

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
let allApplications   = [];
let currentFilter     = 'all';
let currentSort       = 'date-desc';
let sessionLoginAt    = null;
let activeModalId     = null;   // ID of the application currently open in the modal
let currentBotUsername = 'Arx_IT_BoT';

/* ─────────────────────────────────────────────────
   PANEL TAB SWITCHING
───────────────────────────────────────────────── */
function activateTab(tab) {
  if (!tab) return;
  const tabs = [tabApplications, tabMeetings, tabTelegram].filter(Boolean);
  const secs = [secApplications, secMeetings, secTelegram].filter(Boolean);
  tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
  secs.forEach(s => s && s.classList.remove('active'));
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  const target = document.getElementById(tab.getAttribute('aria-controls'));
  if (target) target.classList.add('active');
  if (tab === tabMeetings) loadAdminMeetings();
  if (tab === tabTelegram) loadTelegramAdmin();
}

if (tabApplications) tabApplications.addEventListener('click', () => activateTab(tabApplications));
if (tabMeetings)     tabMeetings.addEventListener('click',     () => activateTab(tabMeetings));
if (tabTelegram)     tabTelegram.addEventListener('click',     () => activateTab(tabTelegram));

// Bot banner button switches directly to Telegram tab
const btnBannerConfigBot = document.getElementById('btn-banner-configure-bot');
if (btnBannerConfigBot && tabTelegram) {
  btnBannerConfigBot.addEventListener('click', () => {
    activateTab(tabTelegram);
    const input = document.getElementById('tg-token-input');
    if (input) input.focus();
  });
}

/* ─────────────────────────────────────────────────
   INITIALIZATION
───────────────────────────────────────────────── */
async function init() {
  try {
    const res = await fetch(`${ADMIN_BASE}/api/me`);
    if (res.ok) {
      const data = await res.json();
      adminUserEl.textContent = data.username;
      sessionLoginAt = data.loginAt;
      startSessionTimer();
      showDashboard();
      await loadApplications();
      checkBotConfigured();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

/* ─────────────────────────────────────────────────
   AUTH VIEWS
───────────────────────────────────────────────── */
function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
  document.getElementById('admin-username').focus();
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
}

/* ─────────────────────────────────────────────────
   LOGIN
───────────────────────────────────────────────── */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;

  loginError.textContent = '';
  loginError.classList.add('hidden');
  loginBtn.disabled = true;
  loginBtn.textContent = '// AUTHENTICATING...';

  try {
    const res = await fetch(`${ADMIN_BASE}/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (res.ok) {
      adminUserEl.textContent = data.username;
      sessionLoginAt = Date.now();
      startSessionTimer();
      showDashboard();
      await loadApplications();
    } else {
      loginError.textContent = data.message || 'Invalid credentials';
      loginError.classList.remove('hidden');
      document.getElementById('admin-password').value = '';
      document.getElementById('admin-password').focus();
    }
  } catch {
    loginError.textContent = 'Network error — is the server running?';
    loginError.classList.remove('hidden');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '// AUTHENTICATE';
  }
});

/* ─────────────────────────────────────────────────
   LOGOUT
───────────────────────────────────────────────── */
logoutBtn.addEventListener('click', async () => {
  await fetch(`${ADMIN_BASE}/logout`, { method: 'POST' });
  allApplications = [];
  activeModalId = null;
  clearInterval(sessionTimerInterval);
  showLogin();
});

/* ─────────────────────────────────────────────────
   SESSION TIMER
───────────────────────────────────────────────── */
let sessionTimerInterval = null;

function startSessionTimer() {
  clearInterval(sessionTimerInterval);
  sessionTimerInterval = setInterval(() => {
    if (!sessionLoginAt) return;
    const elapsed = Date.now() - sessionLoginAt;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    sessionTimeEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }, 1000);
}

/* ─────────────────────────────────────────────────
   DATA LOADING
───────────────────────────────────────────────── */
async function loadApplications() {
  appsGrid.innerHTML = '<div class="loading-state"><span class="spinner"></span> LOADING DATA...</div>';
  try {
    const res = await fetch(`${ADMIN_BASE}/api/applications`);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    allApplications = data.applications || [];
    updateStats(data);
    renderApplications();
  } catch (err) {
    appsGrid.innerHTML = `<div class="error-state">⚠ Failed to load applications: ${escapeHtml(err.message)}</div>`;
  }
}

refreshBtn.addEventListener('click', loadApplications);

/* ─────────────────────────────────────────────────
   STATS
───────────────────────────────────────────────── */
function updateStats(data) {
  const total    = data.total    || 0;
  const pending  = data.pending  || 0;
  const accepted = data.accepted || 0;
  const declined = data.declined || 0;
  const avgScore = total > 0
    ? Math.round(allApplications.reduce((s, a) => s + a.aiScore, 0) / total)
    : 0;

  animateCount(statTotal,    total);
  animateCount(statPending,  pending);
  animateCount(statAccepted, accepted);
  animateCount(statDeclined, declined);
  if (statAvg) {
    statAvg.textContent = avgScore ? avgScore : '—';
    if (avgScore) statAvg.style.color = scoreColor(avgScore);
  }
}

function animateCount(el, target) {
  if (!el) return;
  const start    = parseInt(el.textContent, 10) || 0;
  const duration = 600;
  const startMs  = performance.now();
  function step(now) {
    const t = Math.min((now - startMs) / duration, 1);
    el.textContent = Math.round(start + (target - start) * t);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ─────────────────────────────────────────────────
   FILTER + SEARCH + SORT
───────────────────────────────────────────────── */
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderApplications();
  });
});

searchEl.addEventListener('input', () => renderApplications());
sortEl.addEventListener('change', () => {
  currentSort = sortEl.value;
  renderApplications();
});

function getFilteredApps() {
  const query = searchEl.value.toLowerCase().trim();
  let apps = [...allApplications];

  if (currentFilter !== 'all') {
    apps = apps.filter(a => a.status.toLowerCase() === currentFilter);
  }

  if (query) {
    apps = apps.filter(a =>
      a.username.toLowerCase().includes(query) ||
      (a.fullName && a.fullName.toLowerCase().includes(query)) ||
      (a.specialUsername && a.specialUsername.toLowerCase().includes(query)) ||
      (a.section && a.section.toLowerCase().includes(query)) ||
      (a.rosterName && a.rosterName.toLowerCase().includes(query)) ||
      a.essay.toLowerCase().includes(query)    ||
      a.aiLabel.toLowerCase().includes(query)  ||
      (a.phone    || '').toLowerCase().includes(query) ||
      (a.telegram || '').toLowerCase().includes(query) ||
      String(a.id).includes(query)
    );
  }

  switch (currentSort) {
    case 'date-desc':  apps.sort((a, b) => b.id - a.id);           break;
    case 'date-asc':   apps.sort((a, b) => a.id - b.id);           break;
    case 'score-desc': apps.sort((a, b) => b.aiScore - a.aiScore); break;
    case 'score-asc':  apps.sort((a, b) => a.aiScore - b.aiScore); break;
  }

  return apps;
}

/* ─────────────────────────────────────────────────
   RENDERING UTILITIES
───────────────────────────────────────────────── */
function scoreColor(score) {
  if (score < 31) return '#00ff88';
  if (score < 70) return '#ffb400';
  return '#ff3366';
}

/** Returns CSS class + label for AI probability tier badge. */
function aiTier(score) {
  if (score < 31) return { cls: 'ai-tier-human', label: 'LIKELY HUMAN' };
  if (score < 70) return { cls: 'ai-tier-mixed', label: 'UNCERTAIN'    };
  return              { cls: 'ai-tier-ai',    label: 'HIGH AI PROB'  };
}

/** Returns CSS class + text for a status badge. */
function statusBadge(status) {
  switch (status) {
    case 'ACCEPTED': return { cls: 'badge-green', text: 'ACCEPTED' };
    case 'DECLINED': return { cls: 'badge-blue',  text: 'DECLINED' };
    case 'FLAGGED':  return { cls: 'badge-red',   text: 'FLAGGED'  };
    default:         return { cls: 'badge-amber', text: 'PENDING'  };
  }
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function readingTime(words) {
  const mins = Math.ceil(words / 200);
  return mins === 1 ? '~1 min read' : `~${mins} min read`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

/* ─────────────────────────────────────────────────
   ACCEPT / DECLINE API CALL
───────────────────────────────────────────────── */
async function updateStatus(id, newStatus, { acceptBtn, declineBtn } = {}) {
  if (acceptBtn)  acceptBtn.disabled  = true;
  if (declineBtn) declineBtn.disabled = true;

  try {
    const res = await fetch(`${ADMIN_BASE}/api/applications/${id}/status`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });

    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // Update in-memory record immediately
    const app = allApplications.find(a => a.id === id);
    if (app) {
      app.status = newStatus;
      if (data.specialUsername) {
        app.specialUsername = data.specialUsername;
        app.callsign = data.specialUsername;
      }
      if (data.tgSent !== undefined) app.tgMessageSent = data.tgSent;
      if (data.inviteLink) app.inviteLink = data.inviteLink;
      if (data.application) Object.assign(app, data.application);
    }

    // Refresh stat counters from server response (no extra fetch needed)
    if (data.stats) updateStats(data.stats);

    // Re-render cards so badges + button states update
    renderApplications();

    // If the modal is open for this application, refresh its status line
    if (activeModalId === id) syncModalStatus(id);

    // Dynamic toast notification feedback
    if (newStatus === 'ACCEPTED') {
      if (data.tgSent) {
        showToast(`✔ Application #${id} ACCEPTED — Acceptance welcome & Callsign automatically texted to candidate on Telegram!`, 'success');
      } else {
        showToast(`✔ Application #${id} ACCEPTED (Callsign: ${data.specialUsername || app?.callsign || 'ASSIGNED'}). Candidate has not messaged the bot yet — message will automatically send when they open Telegram!`, 'info');
      }
    } else if (newStatus === 'DECLINED') {
      showToast(`Application #${id} declined.`, 'warning');
    } else {
      showToast(`Application #${id} status updated to ${newStatus}.`, 'info');
    }

    // Refresh bot status if Telegram tab is open
    checkBotConfigured();

  } catch (err) {
    showToast(`Failed to update status: ${err.message}`, 'error');
  } finally {
    if (acceptBtn)  acceptBtn.disabled  = false;
    if (declineBtn) declineBtn.disabled = false;
  }
}

/* ─────────────────────────────────────────────────
   APPLICATION CARDS
───────────────────────────────────────────────── */
function renderApplications() {
  const apps = getFilteredApps();

  if (apps.length === 0) {
    const hasFilter = currentFilter !== 'all' || searchEl.value.trim();
    appsGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">◈</div>
        <p>${hasFilter ? 'NO RESULTS MATCH YOUR FILTER' : 'NO APPLICATIONS RECEIVED YET'}</p>
        ${hasFilter ? '<p class="empty-sub">Clear your search or filter to see all applications.</p>' : ''}
      </div>`;
    return;
  }

  appsGrid.innerHTML = apps.map(app => {
    const color   = scoreColor(app.aiScore);
    const tier    = aiTier(app.aiScore);
    const sb      = statusBadge(app.status);
    const flags   = app.aiFlags && app.aiFlags.length > 0
      ? app.aiFlags.map(f => `<span class="flag-chip">${escapeHtml(f.replace(/_/g,' '))}</span>`).join('')
      : '';
    const preview = escapeHtml(app.essay.slice(0, 220)) + (app.essay.length > 220 ? '\u2026' : '');
    const isAcc   = app.status === 'ACCEPTED';
    const isDec   = app.status === 'DECLINED';

    // Phone / Telegram contact row
    const tgHandle  = (app.telegram || '').replace(/^@/, '');
    const tgLink    = tgHandle
      ? `<a href="https://t.me/${escapeHtml(tgHandle)}" target="_blank" rel="noopener noreferrer" title="Open Telegram">${escapeHtml(app.telegram)}</a>`
      : '<span style="opacity:.5">N/A</span>';
    const phoneLink = app.phone
      ? `<a href="tel:${escapeHtml(app.phone)}">${escapeHtml(app.phone)}</a>`
      : '<span style="opacity:.5">N/A</span>';
    const contactRow = `<div class="card-contact-row"><span><span class="card-contact-label">TG:</span>${tgLink}</span><span><span class="card-contact-label">\ud83d\udcde</span>${phoneLink}</span></div>`;

    // Telegram contact CTA (only when accepted)
    const tgBtn = isAcc && tgHandle
      ? `<a class="btn-tg-contact" href="https://t.me/${escapeHtml(tgHandle)}" target="_blank" rel="noopener noreferrer">📱 CANDIDATE PROFILE (@${escapeHtml(tgHandle)})</a>`
      : '';

    // Telegram bot dispatch status row (when accepted)
    let tgBox = '';
    if (isAcc) {
      if (app.tgMessageSent) {
        tgBox = `
          <div class="card-tg-box sent">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span>✔ Acceptance text sent via @${escapeHtml(currentBotUsername)}</span>
              <button class="btn-tg-resend" data-action="tg-send" data-id="${app.id}">📱 Re-send</button>
            </div>
          </div>`;
      } else {
        const invLink = app.inviteLink || (tgHandle ? `https://t.me/${escapeHtml(currentBotUsername)}` : '');
        tgBox = `
          <div class="card-tg-box pending">
            <span>⏳ Bot Text Pending: candidate has not messaged @${escapeHtml(currentBotUsername)}</span>
            <div class="card-tg-actions">
              <button class="btn-tg-resend" data-action="tg-send" data-id="${app.id}">📱 Text via Bot</button>
              ${invLink ? `<button class="btn-tg-copy" data-action="tg-copy-link" data-link="${escapeHtml(invLink)}">📋 Copy Bot Link</button>` : ''}
              <button class="btn-tg-resend" data-action="open-link-modal-for-app" data-id="${app.id}">🔗 Link Chat ID</button>
            </div>
          </div>`;
      }
    }

    // Certificates preview strip on card
    let certsStrip = '';
    if (app.certificates && app.certificates.length > 0) {
      const items = app.certificates.map(c => {
        const isPdf = c.mimeType === 'application/pdf' || (c.fileName && c.fileName.toLowerCase().endsWith('.pdf'));
        const thumb = isPdf
          ? `<span style="color:var(--pink);font-size:.62rem;font-weight:900">📄 PDF</span>`
          : `<img class="card-cert-thumb" src="${escapeHtml(c.url)}" alt="${escapeHtml(c.originalName)}" />`;
        return `<a class="card-cert-item" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" title="Click to open ${escapeHtml(c.originalName)}">${thumb}<span>${escapeHtml(c.originalName)}</span></a>`;
      }).join('');
      certsStrip = `
        <div class="card-certs-row">
          <div class="card-certs-header">
            <span>📎 CERTIFICATES &amp; FILES (${app.certificates.length})</span>
          </div>
          <div class="card-certs-list">${items}</div>
        </div>`;
    }

    return `
      <article class="app-card" data-id="${app.id}">
        <header class="card-header">
          <div class="card-identity">
            <span class="card-id">#${String(app.id).padStart(4,'0')}</span>
            <span class="card-username">${escapeHtml(app.fullName || app.username)}</span>
            ${app.specialUsername ? `<span class="badge" style="font-family:var(--font-mono);font-size:0.75rem;background:rgba(0,255,136,0.12);color:var(--green);border:1px solid rgba(0,255,136,0.3);padding:2px 6px;border-radius:4px" title="Assigned Callsign">${escapeHtml(app.specialUsername)}${app.section ? ` · ${escapeHtml(app.section)}` : ''}</span>` : ''}
          </div>
          <div class="card-badges">
            <span class="badge ${sb.cls}">${sb.text}</span>
            <span class="ai-tier ${tier.cls}">${tier.label}</span>
          </div>
        </header>

        ${contactRow}
        ${certsStrip}

        <div class="card-ai-block">
          <div class="card-ai-header">
            <span class="card-ai-label">AI DETECTION</span>
            <span class="ai-tier ${tier.cls}">${tier.label}</span>
          </div>
          <div class="card-ai-score-row">
            <div class="score-track">
              <div class="score-fill" style="width:max(5%,${app.aiScore}%);background:${color}"></div>
            </div>
            <span class="score-num" style="color:${color}">${app.aiScore}<span class="score-denom">/100</span></span>
          </div>
        </div>

        ${flags ? `<div class="card-flags">${flags}</div>` : ''}

        <p class="card-preview">${preview}</p>

        <footer class="card-footer">
          <span class="card-time">${formatDate(app.timestamp)}</span>
          <button class="btn-view" data-action="open-modal" data-id="${app.id}">
            READ FULL ESSAY →
          </button>
        </footer>

        <div class="decision-row">
          <button
            class="btn-accept"
            data-action="accept"
            data-id="${app.id}"
            ${isAcc ? 'disabled' : ''}
            title="${isAcc ? 'Already accepted' : 'Accept this application'}"
          >${isAcc ? '✔ ACCEPTED' : '✔ ACCEPT'}</button>
          <button
            class="btn-decline"
            data-action="decline"
            data-id="${app.id}"
            ${isDec ? 'disabled' : ''}
            title="${isDec ? 'Already declined' : 'Decline this application'}"
          >${isDec ? '✖ DECLINED' : '✖ DECLINE'}</button>
        </div>
        ${tgBox}
        ${tgBtn}
      </article>`;
  }).join('');
}

/* ─────────────────────────────────────────────────
   EVENT DELEGATION — card grid
   Handles all button clicks inside #apps-grid
   without relying on inline onclick handlers.
───────────────────────────────────────────────── */
appsGrid.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;

  const id     = parseInt(btn.dataset.id, 10);
  const action = btn.dataset.action;

  if (action === 'open-modal') {
    openModal(id);
    return;
  }

  if (action === 'accept' || action === 'decline') {
    const newStatus  = action === 'accept' ? 'ACCEPTED' : 'DECLINED';
    const card       = btn.closest('[data-id="' + id + '"]');
    const acceptBtn  = card ? card.querySelector('[data-action="accept"]')  : null;
    const declineBtn = card ? card.querySelector('[data-action="decline"]') : null;
    updateStatus(id, newStatus, { acceptBtn, declineBtn });
    return;
  }

  if (action === 'tg-send') {
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.textContent = '...SENDING';
    try {
      const res = await fetch(`${ADMIN_BASE}/api/applications/${id}/tg-send`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast('✔ Acceptance message successfully texted to candidate on Telegram!', 'success');
        const app = allApplications.find(a => a.id === id);
        if (app) app.tgMessageSent = true;
        renderApplications();
      } else {
        if (data.reason === 'CHAT_ID_UNKNOWN') {
          if (data.inviteLink) navigator.clipboard.writeText(data.inviteLink).catch(() => {});
          showToast(`Candidate has not messaged the bot yet. Bot invite link copied to clipboard!`, 'warning');
        } else {
          showToast('Failed to send Telegram message: ' + (data.message || data.error), 'error');
        }
      }
    } catch (err) {
      showToast('Error contacting server: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
    return;
  }

  if (action === 'tg-copy-link') {
    const link = btn.dataset.link;
    if (link) {
      navigator.clipboard.writeText(link).then(() => {
        const prev = btn.textContent;
        btn.textContent = '✔ COPIED!';
        showToast('Invite link copied to clipboard!', 'success');
        setTimeout(() => { btn.textContent = prev; }, 2000);
      }).catch(() => {
        prompt('Copy this bot invite link:', link);
      });
    }
    return;
  }

  if (action === 'open-link-modal-for-app') {
    openLinkChatModal(id);
    return;
  }
});

/* ─────────────────────────────────────────────────
   ESSAY MODAL
───────────────────────────────────────────────── */
function openModal(id) {
  const app = allApplications.find(a => a.id === id);
  if (!app) return;

  activeModalId = id;
  renderModalContent(app);
  syncModalStatus(id);

  essayModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    const fill = modalContent.querySelector('.modal-score-fill');
    if (fill) fill.style.transition = 'width .5s ease';
  });
}

function renderModalContent(app) {
  const color = scoreColor(app.aiScore);
  const tier  = aiTier(app.aiScore);
  const flags = app.aiFlags && app.aiFlags.length > 0
    ? app.aiFlags.map(f => `<span class="flag-chip">${escapeHtml(f.replace(/_/g,' '))}</span>`).join('')
    : '<span class="text-dim">none detected</span>';

  const wc = wordCount(app.essay);
  const rt = readingTime(wc);

  const tgHandle  = (app.telegram || '').replace(/^@/, '');
  const tgDisplay = app.telegram || 'N/A';
  const tgHref    = tgHandle
    ? `<a href="https://t.me/${escapeHtml(tgHandle)}" target="_blank" rel="noopener noreferrer" style="color:var(--cyan)">${escapeHtml(tgDisplay)}</a>`
    : '<span class="text-dim">N/A</span>';
  const phoneHref = app.phone
    ? `<a href="tel:${escapeHtml(app.phone)}" style="color:var(--cyan)">${escapeHtml(app.phone)}</a>`
    : '<span class="text-dim">N/A</span>';

  // Render full certificates gallery
  let certsGallery = '';
  if (app.certificates && app.certificates.length > 0) {
    const cards = app.certificates.map(c => {
      const isPdf = c.mimeType === 'application/pdf' || (c.fileName && c.fileName.toLowerCase().endsWith('.pdf'));
      const preview = isPdf
        ? `<div class="modal-cert-pdf-preview"><span class="modal-cert-pdf-icon">📄</span><span style="font-size:.65rem;font-weight:700">PDF DOCUMENT</span></div>`
        : `<img src="${escapeHtml(c.url)}" alt="${escapeHtml(c.originalName)}" onclick="window.open('${escapeHtml(c.url)}', '_blank')" title="Click to view full picture" />`;

      return `
        <div class="modal-cert-card">
          <div class="modal-cert-preview">
            ${preview}
          </div>
          <div class="modal-cert-details">
            <span class="modal-cert-name" title="${escapeHtml(c.originalName)}">${escapeHtml(c.originalName)}</span>
            <span class="modal-cert-size">${formatFileSize(c.size)} &middot; ${isPdf ? 'PDF' : 'IMAGE'}</span>
          </div>
          <div class="modal-cert-btns">
            <a class="btn-cert-action btn-cert-view" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">
              🔍 VIEW ${isPdf ? 'PDF' : 'IMAGE'}
            </a>
            <a class="btn-cert-action btn-cert-dl" href="${escapeHtml(c.url)}" download="${escapeHtml(c.originalName)}">
              ⬇ SAVE
            </a>
          </div>
        </div>`;
    }).join('');

    certsGallery = `
      <div class="modal-certs-section">
        <div class="modal-certs-title">
          <span>📎 ATTACHED CERTIFICATES &amp; DOCUMENTS (${app.certificates.length})</span>
        </div>
        <div class="modal-certs-grid">
          ${cards}
        </div>
      </div>`;
  }

  modalContent.innerHTML = `
    <div class="modal-meta-grid">
      <div class="meta-item">
        <span class="meta-key">APPLICANT</span>
        <span class="meta-val">${escapeHtml(app.fullName || app.username)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">ASSIGNED USERNAME / CALLSIGN</span>
        <span class="meta-val" style="color:${app.status === 'ACCEPTED' ? 'var(--green)' : 'var(--yellow)'};font-family:var(--font-mono);font-weight:700">
          ${app.status === 'ACCEPTED' ? `${escapeHtml(app.specialUsername || app.callsign)} ${app.section ? `(${escapeHtml(app.section)})` : ''}` : `PENDING ADMIN APPROVAL ${app.rosterCallsign ? `<span style="color:var(--text-dim);font-weight:normal">(Designated: ${escapeHtml(app.rosterCallsign)})</span>` : ''}`}
        </span>
      </div>
      <div class="meta-item">
        <span class="meta-key">APPLICATION ID</span>
        <span class="meta-val">#${String(app.id).padStart(4,'0')}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">TELEGRAM</span>
        <span class="meta-val">${tgHref}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">PHONE</span>
        <span class="meta-val">${phoneHref}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">SUBMITTED</span>
        <span class="meta-val">${formatDate(app.timestamp)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">ORIGIN IP</span>
        <span class="meta-val text-dim">${escapeHtml(app.ip)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">ESSAY LENGTH</span>
        <span class="meta-val">${wc} words &nbsp;&middot;&nbsp; ${rt}</span>
      </div>
      <div class="meta-item">
        <span class="meta-key">AI DETECTION SCORE</span>
        <span class="meta-val" style="color:${color}">
          ${app.aiScore}/100 &mdash; <span class="ai-tier ${tier.cls}">${tier.label}</span>
        </span>
      </div>
      <div class="meta-item meta-item-full">
        <span class="meta-key">DETECTION FLAGS</span>
        <div class="meta-flags">${flags}</div>
      </div>
    </div>

    <div class="modal-score-bar">
      <div class="modal-score-fill" style="width:${app.aiScore}%;background:${color}"></div>
    </div>

    <div class="modal-essay">
      <p class="modal-essay-label">// SUBMITTED ESSAY <span class="text-dim">(${app.essay.length} chars &middot; ${wc} words)</span></p>
      <div class="modal-essay-body">${escapeHtml(app.essay)}</div>
    </div>
    ${certsGallery}`;
}

/**
 * Syncs the modal footer status badge and button states
 * to match the current application status in memory.
 */
function syncModalStatus(id) {
  const app = allApplications.find(a => a.id === id);
  if (!app) return;

  const sb = statusBadge(app.status);
  modalCurrentStatus.innerHTML = `<span class="badge ${sb.cls}">${sb.text}</span>`;

  const isAcc = app.status === 'ACCEPTED';
  const isDec = app.status === 'DECLINED';

  modalAcceptBtn.disabled  = isAcc;
  modalDeclineBtn.disabled = isDec;
  modalAcceptBtn.textContent  = isAcc ? '\u2714 ACCEPTED' : '\u2714 ACCEPT';
  modalDeclineBtn.textContent = isDec ? '\u2716 DECLINED' : '\u2716 DECLINE';

  // Manage Telegram contact button below the decision row
  const existingBtn = document.getElementById('modal-tg-contact-btn');
  if (existingBtn) existingBtn.remove();

  if (isAcc && app.telegram) {
    const tgHandle = app.telegram.replace(/^@/, '');
    const a = document.createElement('a');
    a.id        = 'modal-tg-contact-btn';
    a.className = 'btn-tg-contact';
    a.href      = `https://t.me/${encodeURIComponent(tgHandle)}`;
    a.target    = '_blank';
    a.rel       = 'noopener noreferrer';
    a.textContent = `\ud83d\udcf1 CONTACT ${app.telegram} via Telegram`;
    const decRow = document.getElementById('modal-decision-row');
    if (decRow) decRow.insertAdjacentElement('afterend', a);
  }
}

modalAcceptBtn.addEventListener('click', () => {
  if (activeModalId === null) return;
  updateStatus(activeModalId, 'ACCEPTED', {
    acceptBtn:  modalAcceptBtn,
    declineBtn: modalDeclineBtn,
  });
});

modalDeclineBtn.addEventListener('click', () => {
  if (activeModalId === null) return;
  updateStatus(activeModalId, 'DECLINED', {
    acceptBtn:  modalAcceptBtn,
    declineBtn: modalDeclineBtn,
  });
});

function closeModal() {
  essayModal.classList.add('hidden');
  document.body.style.overflow = '';
  // Remove any TG contact button appended outside modal-box
  const btn = document.getElementById('modal-tg-contact-btn');
  if (btn) btn.remove();
  activeModalId = null;
}

modalClose.addEventListener('click', closeModal);
essayModal.addEventListener('click', e => { if (e.target === essayModal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ─────────────────────────────────────────────────
   ADMIN MEETINGS PANEL
───────────────────────────────────────────────── */
const DOMAIN_COLORS = {
  WEB_DEV:       '#00f3ff',
  CYBERSECURITY: '#ff0055',
  PYTHON:        '#00ff66',
  ROBOTICS:      '#ffb400',
  GENERAL:       '#4a7090',
};

let adminMeetingsLoaded = false;

async function loadAdminMeetings() {
  const listEl = document.getElementById('meeting-admin-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading-state"><span class="spinner"></span> LOADING...</div>';

  try {
    const res  = await fetch(`${ADMIN_BASE}/api/meetings`);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAdminMeetings(listEl, data.meetings || []);
    adminMeetingsLoaded = true;
  } catch (err) {
    listEl.innerHTML = `<div class="error-state">⚠ Failed to load meetings: ${escapeHtml(err.message)}</div>`;
  }
}

function renderAdminMeetings(container, meetings) {
  if (!meetings.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">◈</div><p>No meetings scheduled yet.</p></div>';
    return;
  }

  container.innerHTML = meetings.map(m => {
    const color = DOMAIN_COLORS[m.domain] || '#4a7090';
    return `
      <div class="meeting-admin-item" data-meeting-id="${m.id}">
        <div class="meeting-admin-info">
          <span class="meeting-admin-title">${escapeHtml(m.title)}</span>
          <span class="meeting-admin-meta">
            <span class="meeting-admin-domain" style="color:${color};border-color:${color}40">${escapeHtml(m.domain.replace(/_/g,' '))}</span>
            ${escapeHtml(m.date)} | ${escapeHtml(m.startTime)}–${escapeHtml(m.endTime)} | ${escapeHtml(m.type)}
          </span>
          ${m.link ? `<span class="meeting-admin-meta" style="color:var(--cyan);font-size:.6rem">🔗 ${escapeHtml(m.link)}</span>` : ''}
        </div>
        <button class="btn-delete-meeting" data-action="delete-meeting" data-id="${m.id}" title="Delete meeting">✕ DELETE</button>
      </div>`;
  }).join('');
}

// Delegate click for delete-meeting
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="delete-meeting"]');
  if (!btn || btn.disabled) return;
  const id = parseInt(btn.dataset.id, 10);
  if (!confirm(`Delete meeting #${id}?`)) return;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const res = await fetch(`${ADMIN_BASE}/api/meetings/${id}`, { method: 'DELETE' });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const listEl = document.getElementById('meeting-admin-list');
    const item = listEl ? listEl.querySelector(`[data-meeting-id="${id}"]`) : null;
    if (item) item.remove();
    if (listEl && !listEl.querySelector('.meeting-admin-item')) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-icon">◈</div><p>No meetings scheduled yet.</p></div>';
    }
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
    btn.disabled = false;
    btn.textContent = '\u2715 DELETE';
  }
});

// Create meeting form handler
const createMeetingBtn = document.getElementById('create-meeting-btn');
if (createMeetingBtn) {
  createMeetingBtn.addEventListener('click', async () => {
    const msgEl = document.getElementById('meeting-form-msg');
    const title = (document.getElementById('cf-title')?.value || '').trim();
    const domain = document.getElementById('cf-domain')?.value || 'GENERAL';
    const type   = document.getElementById('cf-type')?.value   || 'CAMPUS';
    const date   = document.getElementById('cf-date')?.value   || '';
    const host   = (document.getElementById('cf-host')?.value  || '').trim() || 'ARX Core Team';
    const start  = document.getElementById('cf-start')?.value  || '';
    const end    = document.getElementById('cf-end')?.value    || '';
    const link   = (document.getElementById('cf-link')?.value  || '').trim();
    const desc   = (document.getElementById('cf-desc')?.value  || '').trim();

    if (!title || !date || !start || !end) {
      if (msgEl) { msgEl.style.color = 'var(--pink)'; msgEl.style.display = 'block'; msgEl.textContent = 'ERR: Title, date, and times are required.'; }
      return;
    }

    createMeetingBtn.disabled = true;
    createMeetingBtn.textContent = '// SCHEDULING...';
    try {
      const res = await fetch(`${ADMIN_BASE}/api/meetings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ title, domain, date, startTime: start, endTime: end, type, link, description: desc, host }),
      });
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Reload the list
      adminMeetingsLoaded = false;
      await loadAdminMeetings();

      // Clear form
      ['cf-title','cf-host','cf-date','cf-start','cf-end','cf-link','cf-desc'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      if (msgEl) { msgEl.style.color = 'var(--green)'; msgEl.style.display = 'block'; msgEl.textContent = `\u2713 Meeting "${data.meeting.title}" scheduled.`; }
    } catch (err) {
      if (msgEl) { msgEl.style.color = 'var(--pink)'; msgEl.style.display = 'block'; msgEl.textContent = `ERR: ${err.message}`; }
    } finally {
      createMeetingBtn.disabled = false;
      createMeetingBtn.textContent = '\u2295 SCHEDULE MEETING';
    }
  });
}

/* ─────────────────────────────────────────────────
   TELEGRAM BOT ADMIN PANEL
───────────────────────────────────────────────── */
let tgStatusLoaded = false;

async function checkBotConfigured() {
  try {
    const res = await fetch(`${ADMIN_BASE}/api/telegram/status`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.botUsername) currentBotUsername = data.botUsername;
    const banner = document.getElementById('bot-config-banner');
    if (banner) {
      if (data.configured) {
        banner.classList.add('hidden');
      } else {
        banner.classList.remove('hidden');
      }
    }
  } catch (_) {}
}

async function loadTelegramAdmin() {
  const tbody = document.getElementById('tg-chats-tbody');
  const badge = document.getElementById('tg-status-badge');
  const valUser = document.getElementById('tg-val-username');
  const valPolling = document.getElementById('tg-val-polling');
  const valToken = document.getElementById('tg-val-token');
  const valChats = document.getElementById('tg-val-chats');
  const valDispatched = document.getElementById('tg-val-dispatched');
  const valPending = document.getElementById('tg-val-pending-dispatch');

  try {
    const res = await fetch(`${ADMIN_BASE}/api/telegram/status`);
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.botUsername) currentBotUsername = data.botUsername;

    // 1. Update status metrics
    if (badge) {
      if (data.configured && data.pollingActive) {
        badge.className = 'tg-badge online';
        badge.textContent = 'ONLINE (POLLING)';
      } else if (data.configured) {
        badge.className = 'tg-badge online';
        badge.textContent = 'CONFIGURED';
      } else {
        badge.className = 'tg-badge offline';
        badge.textContent = 'OFFLINE (NO TOKEN)';
      }
    }

    if (valUser)    valUser.textContent    = `@${data.botUsername || 'Arx_IT_BoT'}`;
    if (valPolling) valPolling.textContent = data.pollingActive ? 'ACTIVE (POLLING)' : 'INACTIVE';
    if (valToken)   valToken.textContent   = data.configured ? `YES (${data.tokenMasked})` : 'NO';
    if (valChats)   valChats.textContent   = String(data.totalChats || 0);
    if (valDispatched) valDispatched.textContent = String(data.acceptedWithTgSent || 0);
    if (valPending)    valPending.textContent    = String(data.acceptedPendingTg || 0);

    // Update banner in applications tab
    const banner = document.getElementById('bot-config-banner');
    if (banner) {
      if (data.configured) banner.classList.add('hidden');
      else banner.classList.remove('hidden');
    }

    // 2. Render connected chat mappings table
    if (!tbody) return;
    const chats = data.chats || [];
    if (!chats.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center;padding:1.8rem;color:var(--text-dim)">
            No chat mappings detected yet. Candidates must start @${escapeHtml(data.botUsername || 'Arx_IT_BoT')} on Telegram to appear here.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = chats.map(c => {
      const isLinked = Boolean(c.linkedAppId);
      const isAccepted = c.status === 'ACCEPTED';
      const sb = c.status ? statusBadge(c.status) : '<span style="opacity:.4">—</span>';
      const sentBadge = isAccepted
        ? (c.tgMessageSent ? '<span style="color:var(--green);font-weight:700">✔ SENT</span>' : '<span style="color:var(--amber);font-weight:700">⏳ PENDING</span>')
        : '<span style="opacity:.4">N/A</span>';

      let actionHtml = '';
      if (isLinked) {
        if (isAccepted) {
          actionHtml = `<button class="btn-tg-resend" data-action="tg-send" data-id="${c.linkedAppId}">📱 Re-send</button>`;
        } else {
          actionHtml = `<button class="btn-tg-resend" data-action="quick-accept-from-tg" data-id="${c.linkedAppId}">✔ Accept &amp; Send</button>`;
        }
      } else {
        actionHtml = `<button class="btn-view" data-action="link-unmatched-chat" data-chat-id="${c.chatId}" style="font-size:.56rem">🔗 Link App</button>`;
      }

      const applicantDisplay = isLinked
        ? `<strong>${escapeHtml(c.applicantName || 'Operative')}</strong> <span style="font-size:.6rem;color:var(--text-dim)">(#${c.linkedAppId}${c.callsign ? ` • ${escapeHtml(c.callsign)}` : ''})</span>`
        : '<span style="opacity:.5">Unmatched</span>';

      return `
        <tr>
          <td><code>${escapeHtml(c.key)}</code></td>
          <td><code>${escapeHtml(c.chatId)}</code></td>
          <td>${applicantDisplay}</td>
          <td>${sb}</td>
          <td>${sentBadge}</td>
          <td>${actionHtml}</td>
        </tr>`;
    }).join('');

    tgStatusLoaded = true;
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--pink);padding:1rem">⚠ Failed to load bot status: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// Save Bot Token Handler
const btnSaveTgToken = document.getElementById('btn-save-tg-token');
if (btnSaveTgToken) {
  btnSaveTgToken.addEventListener('click', async () => {
    const input = document.getElementById('tg-token-input');
    const msgEl = document.getElementById('tg-token-msg');
    const token = (input?.value || '').trim();

    if (!token) {
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = 'rgba(255,51,102,0.1)';
        msgEl.style.border = '1px solid var(--pink)';
        msgEl.style.color = 'var(--pink)';
        msgEl.textContent = 'ERR: Telegram Bot Token cannot be empty.';
      }
      return;
    }

    btnSaveTgToken.disabled = true;
    btnSaveTgToken.textContent = '// CONNECTING TO TELEGRAM...';
    if (msgEl) msgEl.style.display = 'none';

    try {
      const res = await fetch(`${ADMIN_BASE}/api/telegram/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Telegram rejected token');

      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = 'rgba(22,163,74,0.1)';
        msgEl.style.border = '1px solid var(--green)';
        msgEl.style.color = 'var(--green)';
        msgEl.textContent = `✔ Connected to @${data.botUsername}! Polling worker active.${data.dispatched > 0 ? ` Auto-sent ${data.dispatched} pending acceptance welcome(s)!` : ''}`;
      }
      showToast(`✔ Bot @${data.botUsername} connected successfully!`, 'success');
      input.value = '';

      await loadTelegramAdmin();
      await loadApplications();
    } catch (err) {
      if (msgEl) {
        msgEl.style.display = 'block';
        msgEl.style.background = 'rgba(255,51,102,0.1)';
        msgEl.style.border = '1px solid var(--pink)';
        msgEl.style.color = 'var(--pink)';
        msgEl.textContent = `ERR: ${err.message}`;
      }
      showToast(`Token Error: ${err.message}`, 'error');
    } finally {
      btnSaveTgToken.disabled = false;
      btnSaveTgToken.textContent = '⚡ SAVE & CONNECT BOT';
    }
  });
}

// Refresh Bot Status Button
const btnRefreshTg = document.getElementById('btn-refresh-tg');
if (btnRefreshTg) {
  btnRefreshTg.addEventListener('click', async () => {
    btnRefreshTg.disabled = true;
    btnRefreshTg.textContent = '...REFRESHING';
    await loadTelegramAdmin();
    showToast('Telegram Bot status refreshed.', 'info');
    btnRefreshTg.disabled = false;
    btnRefreshTg.textContent = '🔄 REFRESH BOT STATUS';
  });
}

// Dispatch All Pending Accepts Button
const btnDispatchPending = document.getElementById('btn-dispatch-pending-tg');
if (btnDispatchPending) {
  btnDispatchPending.addEventListener('click', async () => {
    btnDispatchPending.disabled = true;
    btnDispatchPending.textContent = '...DISPATCHING';
    try {
      const res = await fetch(`${ADMIN_BASE}/api/telegram/dispatch-all-pending`, { method: 'POST' });
      const data = await res.json();
      showToast(data.message, data.dispatched > 0 ? 'success' : 'info');
      await loadTelegramAdmin();
      await loadApplications();
    } catch (err) {
      showToast(`Dispatch failed: ${err.message}`, 'error');
    } finally {
      btnDispatchPending.disabled = false;
      btnDispatchPending.textContent = '🚀 DISPATCH ALL PENDING ACCEPTS';
    }
  });
}

// Link Chat Modal
const linkChatModal = document.getElementById('link-chat-modal');
const btnOpenLinkChatModal = document.getElementById('btn-open-link-chat-modal');
const linkModalClose = document.getElementById('link-modal-close');
const linkAppSelect = document.getElementById('link-app-select');
const linkChatInput = document.getElementById('link-chat-input');
const linkSendWelcome = document.getElementById('link-send-welcome');
const btnSubmitLinkChat = document.getElementById('btn-submit-link-chat');
const linkModalMsg = document.getElementById('link-modal-msg');

function populateLinkAppSelect(preselectId = null) {
  if (!linkAppSelect) return;
  linkAppSelect.innerHTML = allApplications.map(a => `
    <option value="${a.id}" ${preselectId === a.id ? 'selected' : ''}>
      #${a.id} — ${escapeHtml(a.fullName || a.username)} (${a.status}${a.telegram ? ` | ${escapeHtml(a.telegram)}` : ''})
    </option>
  `).join('');
}

function openLinkChatModal(preselectId = null, prefillChatId = '') {
  if (!linkChatModal) return;
  populateLinkAppSelect(preselectId);
  if (linkChatInput && prefillChatId) linkChatInput.value = prefillChatId;
  if (linkModalMsg) linkModalMsg.style.display = 'none';
  linkChatModal.classList.remove('hidden');
}

function closeLinkChatModal() {
  if (linkChatModal) linkChatModal.classList.add('hidden');
}

if (btnOpenLinkChatModal) btnOpenLinkChatModal.addEventListener('click', () => openLinkChatModal());
if (linkModalClose) linkModalClose.addEventListener('click', closeLinkChatModal);
if (linkChatModal) {
  linkChatModal.addEventListener('click', e => { if (e.target === linkChatModal) closeLinkChatModal(); });
}

if (btnSubmitLinkChat) {
  btnSubmitLinkChat.addEventListener('click', async () => {
    const appId = linkAppSelect?.value;
    const chatId = (linkChatInput?.value || '').trim();
    const sendWelcome = linkSendWelcome ? linkSendWelcome.checked : true;

    if (!appId || !chatId) {
      if (linkModalMsg) {
        linkModalMsg.style.display = 'block';
        linkModalMsg.style.color = 'var(--pink)';
        linkModalMsg.textContent = 'ERR: Select an applicant and enter a Chat ID.';
      }
      return;
    }

    btnSubmitLinkChat.disabled = true;
    btnSubmitLinkChat.textContent = '// LINKING...';

    try {
      const res = await fetch(`${ADMIN_BASE}/api/telegram/link-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, chatId, sendWelcome }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Linking failed');

      showToast(`✔ Application #${appId} linked to Chat ID ${chatId}!${data.sent ? ' Acceptance welcome sent!' : ''}`, 'success');
      closeLinkChatModal();
      await loadApplications();
      await loadTelegramAdmin();
    } catch (err) {
      if (linkModalMsg) {
        linkModalMsg.style.display = 'block';
        linkModalMsg.style.color = 'var(--pink)';
        linkModalMsg.textContent = `ERR: ${err.message}`;
      }
      showToast(`Linking Error: ${err.message}`, 'error');
    } finally {
      btnSubmitLinkChat.disabled = false;
      btnSubmitLinkChat.textContent = '🔗 SAVE LINK';
    }
  });
}

// Global click delegation for Telegram table actions
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;

  if (action === 'quick-accept-from-tg') {
    const id = parseInt(btn.dataset.id, 10);
    if (!confirm(`Accept candidate #${id} and automatically dispatch Telegram welcome?`)) return;
    btn.disabled = true;
    btn.textContent = '...';
    await updateStatus(id, 'ACCEPTED');
    await loadTelegramAdmin();
  }

  if (action === 'link-unmatched-chat') {
    const chatId = btn.dataset.chatId;
    openLinkChatModal(null, chatId);
  }
});

/* ─────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────── */
init();

