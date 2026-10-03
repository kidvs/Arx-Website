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
const secApplications  = document.getElementById('section-applications');
const secMeetings      = document.getElementById('section-meetings');

/* ─────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────── */
let allApplications = [];
let currentFilter   = 'all';
let currentSort     = 'date-desc';
let sessionLoginAt  = null;
let activeModalId   = null;   // ID of the application currently open in the modal

/* ─────────────────────────────────────────────────
   PANEL TAB SWITCHING
───────────────────────────────────────────────── */
if (tabApplications && tabMeetings) {
  function activateTab(tab) {
    [tabApplications, tabMeetings].forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    [secApplications, secMeetings].forEach(s => s && s.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    const target = document.getElementById(tab.getAttribute('aria-controls'));
    if (target) target.classList.add('active');
    if (tab === tabMeetings) loadAdminMeetings();
  }
  tabApplications.addEventListener('click', () => activateTab(tabApplications));
  tabMeetings.addEventListener('click',     () => activateTab(tabMeetings));
}

/* ─────────────────────────────────────────────────
   INITIALIZATION
───────────────────────────────────────────────── */
async function init() {
  try {
    const res = await fetch('/admin/api/me');
    if (res.ok) {
      const data = await res.json();
      adminUserEl.textContent = data.username;
      sessionLoginAt = data.loginAt;
      startSessionTimer();
      showDashboard();
      await loadApplications();
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
    const res = await fetch('/admin/login', {
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
  await fetch('/admin/logout', { method: 'POST' });
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
    const res = await fetch('/admin/api/applications');
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
      a.essay.toLowerCase().includes(query)    ||
      a.aiLabel.toLowerCase().includes(query)  ||
      (a.phone    || '').toLowerCase().includes(query) ||
      (a.telegram || '').toLowerCase().includes(query)
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
    const res = await fetch(`/admin/api/applications/${id}/status`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });

    if (res.status === 401) { showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // Update in-memory record immediately
    const app = allApplications.find(a => a.id === id);
    if (app) app.status = newStatus;

    // Refresh stat counters from server response (no extra fetch needed)
    if (data.stats) updateStats(data.stats);

    // Re-render cards so badges + button states update
    renderApplications();

    // If the modal is open for this application, refresh its status line
    if (activeModalId === id) syncModalStatus(id);

  } catch (err) {
    alert(`Failed to update status: ${err.message}`);
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
      ? `<a class="btn-tg-contact" href="https://t.me/${escapeHtml(tgHandle)}" target="_blank" rel="noopener noreferrer">\ud83d\udcf1 CONTACT ${escapeHtml(app.telegram)} via Telegram</a>`
      : '';

    return `
      <article class="app-card" data-id="${app.id}">
        <header class="card-header">
          <div class="card-identity">
            <span class="card-id">#${String(app.id).padStart(4,'0')}</span>
            <span class="card-username">${escapeHtml(app.username)}</span>
          </div>
          <div class="card-badges">
            <span class="badge ${sb.cls}">${sb.text}</span>
            <span class="ai-tier ${tier.cls}">${tier.label}</span>
          </div>
        </header>

        ${contactRow}

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
            READ FULL ESSAY \u2192
          </button>
        </footer>

        <div class="decision-row">
          <button
            class="btn-accept"
            data-action="accept"
            data-id="${app.id}"
            ${isAcc ? 'disabled' : ''}
            title="${isAcc ? 'Already accepted' : 'Accept this application'}"
          >${isAcc ? '\u2714 ACCEPTED' : '\u2714 ACCEPT'}</button>
          <button
            class="btn-decline"
            data-action="decline"
            data-id="${app.id}"
            ${isDec ? 'disabled' : ''}
            title="${isDec ? 'Already declined' : 'Decline this application'}"
          >${isDec ? '\u2716 DECLINED' : '\u2716 DECLINE'}</button>
        </div>
        ${tgBtn}
      </article>`;
  }).join('');
}

/* ─────────────────────────────────────────────────
   EVENT DELEGATION — card grid
   Handles all button clicks inside #apps-grid
   without relying on inline onclick handlers.
───────────────────────────────────────────────── */
appsGrid.addEventListener('click', (e) => {
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

  modalContent.innerHTML = `
    <div class="modal-meta-grid">
      <div class="meta-item">
        <span class="meta-key">APPLICANT</span>
        <span class="meta-val">${escapeHtml(app.username)}</span>
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
    </div>`;
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
    const res  = await fetch('/admin/api/meetings');
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
    const res = await fetch(`/admin/api/meetings/${id}`, { method: 'DELETE' });
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
      const res = await fetch('/admin/api/meetings', {
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
   BOOT
───────────────────────────────────────────────── */
init();

