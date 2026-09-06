/**
 * igLeadFinder – Popup Script
 *
 * Connects to the background service worker via a long-lived Port so that
 * real-time updates arrive even while the popup stays open.
 * On open, it restores any in-progress or completed job from storage.
 */

// --------------------------------------------------------------------------
// Element refs
// --------------------------------------------------------------------------
const targetUsernameEl = document.getElementById('target-username');
const postUrlEl        = document.getElementById('post-url');
const keywordsEl       = document.getElementById('keywords');
const maxLeadsEl       = document.getElementById('max-leads');
const delayProfileEl   = document.getElementById('delay-profile');
const formErrorEl      = document.getElementById('form-error');

const fieldUsername    = document.getElementById('field-username');
const fieldPostUrl     = document.getElementById('field-post-url');

const modeTabs         = document.querySelectorAll('.mode-tab');

const startBtn         = document.getElementById('start-btn');
const stopBtn          = document.getElementById('stop-btn');
const resumeBtn        = document.getElementById('resume-btn');
const exportBtn        = document.getElementById('export-btn');

const configSection    = document.getElementById('config-section');
const progressSection  = document.getElementById('progress-section');
const leadsSection     = document.getElementById('leads-section');

const statusIconEl     = document.getElementById('status-icon');
const statusMessageEl  = document.getElementById('status-message');
const statScannedEl    = document.getElementById('stat-scanned');
const statLeadsEl      = document.getElementById('stat-leads');
const leadsListEl      = document.getElementById('leads-list');
const leadsBadgeEl     = document.getElementById('leads-badge');

// --------------------------------------------------------------------------
// Local state
// --------------------------------------------------------------------------
let leads = [];       // accumulated lead objects
let isRunning = false;
let activeMode = 'followers'; // 'followers' | 'commenters'

// Deduplicate leads by username. Prevents double-adding when JOB_STATE restore
// overlaps with in-flight LEAD_FOUND port messages.
const seenUsernames = new Set();

// --------------------------------------------------------------------------
// Background port
// --------------------------------------------------------------------------
const port = chrome.runtime.connect({ name: 'popup' });

port.onMessage.addListener((msg) => {
  switch (msg.action) {
    case 'JOB_STATE':
      restoreJobState(msg.job);
      break;
    case 'SCRAPE_STARTED':
      setRunningUI();
      break;
    case 'SCRAPE_STOPPED':
    case 'SCRAPE_DONE':
      setIdleUI(msg);
      break;
    case 'SCRAPE_ERROR':
      setErrorUI(msg.error);
      break;
    case 'PROGRESS_UPDATE':
      updateProgress(msg.message, msg.scanned, msg.found);
      break;
    case 'LEAD_FOUND':
      addLead(msg.lead);
      break;
    default:
      break;
  }
});

// --------------------------------------------------------------------------
// Mode tabs
// --------------------------------------------------------------------------
modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeMode = tab.dataset.mode;
    modeTabs.forEach((t) => t.classList.toggle('active', t === tab));
    fieldUsername.classList.toggle('hidden', activeMode === 'commenters');
    fieldPostUrl.classList.toggle('hidden', activeMode === 'followers');
    fieldUsername.classList.toggle('hidden', activeMode !== 'followers');
    hideFormError();
  });
});

// --------------------------------------------------------------------------
// Button handlers
// --------------------------------------------------------------------------
startBtn.addEventListener('click', () => {
  const keywords = keywordsEl.value
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const maxLeads    = Math.min(Math.max(parseInt(maxLeadsEl.value, 10) || 100, 1), 500);
  const delayProfile = delayProfileEl.value;

  let config;

  if (activeMode === 'followers') {
    const username = targetUsernameEl.value.trim().replace(/^@/, '');
    if (!username) return showFormError('Please enter a target Instagram username.');
    config = { mode: 'followers', username, keywords, maxLeads, delayProfile };
  } else {
    // handles both 'commenters' and 'likers'
    const postUrl = postUrlEl.value.trim();
    const shortcode = extractShortcode(postUrl);
    if (!shortcode) return showFormError('Please enter a valid Instagram post URL (e.g. https://www.instagram.com/p/ABC123/).');
    config = { mode: activeMode, postUrl, shortcode, keywords, maxLeads, delayProfile };
  }

  hideFormError();
  leads = [];
  seenUsernames.clear();
  leadsListEl.innerHTML = '';
  leadsBadgeEl.textContent = '0';

  chrome.runtime.sendMessage({ action: 'START_SCRAPE', config });
});

// Extract the shortcode from any standard Instagram post/reel URL
function extractShortcode(url) {
  const m = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_SCRAPE' });
});

resumeBtn.addEventListener('click', () => {
  chrome.storage.local.get('job', ({ job }) => {
    if (!job || !job.cursor) return;
    hideFormError();
    // Do NOT clear leads — we append to the existing set
    chrome.runtime.sendMessage({
      action: 'START_SCRAPE',
      config: {
        ...job.config,
        resumeCursor:  job.cursor,
        resumeScanned: job.scanned,
        resumeLeads:   job.found,
      },
    });
  });
});

exportBtn.addEventListener('click', () => exportCsv());

// --------------------------------------------------------------------------
// UI state helpers
// --------------------------------------------------------------------------
function setRunningUI() {
  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  resumeBtn.classList.add('hidden');
  exportBtn.disabled = true;

  progressSection.classList.remove('hidden');
  leadsSection.classList.remove('hidden');

  statusIconEl.textContent = '⏳';
  statusIconEl.classList.add('spin');
  statusMessageEl.textContent = 'Starting…';
  statScannedEl.textContent = '0';
  statLeadsEl.textContent = '0';
}

function setIdleUI(msg) {
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  exportBtn.disabled = leads.length === 0;

  statusIconEl.classList.remove('spin');

  if (msg?.action === 'SCRAPE_DONE') {
    statusIconEl.textContent = '✅';
    statScannedEl.textContent = (msg.totalScanned ?? 0).toLocaleString();
    statLeadsEl.textContent   = leads.length.toLocaleString();
    statusMessageEl.textContent =
      `Done! Scanned ${msg.totalScanned ?? statScannedEl.textContent} · ` +
      `${leads.length} leads found.`;
    resumeBtn.classList.add('hidden');
  } else {
    // Stopped mid-run — show resume button if a cursor was saved
    statusIconEl.textContent = '⏹️';
    statusMessageEl.textContent = 'Stopped. You can resume where you left off.';
    chrome.storage.local.get('job', ({ job }) => {
      if (job?.cursor) {
        resumeBtn.classList.remove('hidden');
      }
    });
  }
}

function setErrorUI(error) {
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;

  statusIconEl.classList.remove('spin');
  statusIconEl.textContent = '❌';
  statusMessageEl.textContent = error || 'An error occurred.';

  progressSection.classList.remove('hidden');
}

function updateProgress(message, scanned) {
  statusMessageEl.textContent = message ?? '';
  if (scanned != null) statScannedEl.textContent = scanned.toLocaleString();
  // NOTE: statLeadsEl is intentionally NOT updated here.
  // It is driven exclusively by addLead() and restoreJobState() so the badge
  // and the stat counter always match the actual leads array.
}

function showFormError(msg) {
  formErrorEl.textContent = msg;
  formErrorEl.classList.remove('hidden');
}

function hideFormError() {
  formErrorEl.textContent = '';
  formErrorEl.classList.add('hidden');
}

// --------------------------------------------------------------------------
// Lead rendering
// --------------------------------------------------------------------------
function addLead(lead) {
  // Deduplicate: a lead can arrive via LEAD_FOUND port message AND be included
  // in a subsequent JOB_STATE restore — only add it once.
  if (seenUsernames.has(lead.username)) return;
  seenUsernames.add(lead.username);

  leads.push(lead);
  leadsBadgeEl.textContent = leads.length;
  statLeadsEl.textContent  = leads.length.toLocaleString();
  leadsSection.classList.remove('hidden');
  leadsListEl.prepend(buildLeadCard(lead));
  exportBtn.disabled = false;
}

function buildLeadCard(lead) {
  const card = document.createElement('div');
  card.className = 'lead-card';

  const followers  = lead.followerCount != null ? `${lead.followerCount.toLocaleString()} followers` : '';
  const posts      = lead.postCount     != null ? `${lead.postCount.toLocaleString()} posts`       : '';
  const verified   = lead.isVerified    ? '<span class="lead-verified">✓</span>' : '';
  const bioText    = escapeHtml(lead.bio || '');
  const nameText   = escapeHtml(lead.fullName || '');

  card.innerHTML = `
    <div class="lead-top">
      <a href="${lead.profileUrl}" target="_blank" class="lead-username">@${escapeHtml(lead.username)}</a>
      ${verified}
      ${nameText ? `<span class="lead-fullname">${nameText}</span>` : ''}
    </div>
    ${bioText ? `<div class="lead-bio">${bioText}</div>` : ''}
    <div class="lead-meta">
      ${followers ? `<span>${followers}</span>` : ''}
      ${posts     ? `<span>${posts}</span>`     : ''}
    </div>
  `;
  return card;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --------------------------------------------------------------------------
// CSV export  –  reads from chrome.storage.local so the full list is always
// exported, even if some LEAD_FOUND port messages were missed while the popup
// was closed.
// --------------------------------------------------------------------------
async function exportCsv() {
  // Prefer the authoritative storage copy; fall back to in-memory array.
  let allLeads = leads;
  try {
    const { job } = await chrome.storage.local.get('job');
    if (job?.leads?.length) allLeads = job.leads;
  } catch (_) { /* use in-memory fallback */ }

  if (allLeads.length === 0) return;

  const columns = ['username', 'fullName', 'bio', 'followerCount', 'followingCount', 'postCount', 'isVerified', 'profileUrl', 'scrapedAt'];
  const header  = columns.join(',');

  const rows = allLeads.map((lead) =>
    columns
      .map((col) => {
        const val = lead[col] ?? '';
        // Replace newlines with a space so bios don't break CSV row parsing
        const str = String(val).replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
        return `"${str}"`;
      })
      .join(',')
  );

  const csv = [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `leads_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------------------
// Restore state from storage when popup reopens mid-job
// --------------------------------------------------------------------------
function restoreJobState(job) {
  if (!job) return;

  // Restore leads — use addLead() so the dedup Set is populated correctly.
  // This prevents duplicates if LEAD_FOUND port messages arrive for leads that
  // are already in the storage snapshot.
  if (Array.isArray(job.leads) && job.leads.length > 0) {
    seenUsernames.clear();
    leads = [];
    leadsListEl.innerHTML = '';
    // Append (not prepend) so list order matches scrape order on restore.
    job.leads.forEach((lead) => {
      seenUsernames.add(lead.username);
      leads.push(lead);
      leadsListEl.appendChild(buildLeadCard(lead));
    });
    leadsBadgeEl.textContent = leads.length;
    statLeadsEl.textContent  = leads.length.toLocaleString();
    leadsSection.classList.remove('hidden');
    exportBtn.disabled = false;
  }

  // Restore form config
  if (job.config) {
    // Restore mode tab
    if (job.config.mode === 'commenters') {
      activeMode = 'commenters';
      modeTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === 'commenters'));
      fieldUsername.classList.add('hidden');
      fieldPostUrl.classList.remove('hidden');
      postUrlEl.value = job.config.postUrl || '';
    } else {
      activeMode = 'followers';
      modeTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === 'followers'));
      fieldUsername.classList.remove('hidden');
      fieldPostUrl.classList.add('hidden');
      targetUsernameEl.value = job.config.username || '';
    }
    keywordsEl.value     = (job.config.keywords || []).join(', ');
    maxLeadsEl.value     = job.config.maxLeads || 100;
    delayProfileEl.value = job.config.delayProfile || 'normal';
  }

  if (job.status === 'running') {
    setRunningUI();
    // setRunningUI resets the stat counters to 0; restore the real values immediately after.
    statScannedEl.textContent = (job.scanned ?? 0).toLocaleString();
    statLeadsEl.textContent   = leads.length.toLocaleString();
    updateProgress(job.statusMessage, job.scanned);
  } else if (job.status === 'done') {
    progressSection.classList.remove('hidden');
    setIdleUI({ action: 'SCRAPE_DONE', totalScanned: job.scanned, totalLeads: job.found });
  } else if (job.status === 'stopped') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusIconEl.textContent = '⏹️';
    statusIconEl.classList.remove('spin');
    statusMessageEl.textContent = 'Stopped. You can resume where you left off.';
    progressSection.classList.remove('hidden');
    exportBtn.disabled = leads.length === 0;
    updateProgress(job.statusMessage, job.scanned);
    if (job.cursor) resumeBtn.classList.remove('hidden');
  } else if (job.status === 'error') {
    setErrorUI(job.statusMessage);
  }
}
