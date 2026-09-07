/**
 * igLeadFinder – Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Receive START / STOP commands from the popup via a long-lived Port
 *  - Open / reuse an instagram.com tab and dispatch work to the content script
 *  - Relay LEAD_FOUND and PROGRESS_UPDATE messages back to the popup
 *  - Persist accumulated leads in chrome.storage.local so they survive
 *    a popup close/reopen
 */

// --------------------------------------------------------------------------
// Port management  (popup keeps a long-lived connection)
// --------------------------------------------------------------------------
let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => { popupPort = null; });

  // Send current job state immediately so the popup can restore its UI
  chrome.storage.local.get('job', ({ job }) => {
    if (job) port.postMessage({ action: 'JOB_STATE', job });
  });
});

function notifyPopup(message) {
  if (!popupPort) return;
  try { popupPort.postMessage(message); } catch (_) { /* popup closed */ }
}

// --------------------------------------------------------------------------
// Main message router  (content script → background)
// --------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'START_SCRAPE':
      handleStartScrape(message.config).catch(console.error);
      sendResponse({ ok: true });
      break;

    case 'STOP_SCRAPE':
      handleStopScrape().catch(console.error);
      sendResponse({ ok: true });
      break;

    case 'LEAD_FOUND':
      handleLeadFound(message.lead).catch(console.error);
      break;

    case 'CURSOR_UPDATE':
      handleCursorUpdate(message).catch(console.error);
      break;

    case 'PROGRESS_UPDATE':
      handleProgressUpdate(message).catch(console.error);
      break;

    case 'SCRAPE_DONE':
      handleScrapeDone(message).catch(console.error);
      break;

    case 'SCRAPE_ERROR':
      handleScrapeError(message).catch(console.error);
      break;

    default:
      break;
  }
  // Return true to keep the message channel open for async work
  return true;
});

// --------------------------------------------------------------------------
// Unified serialised job write queue
//
// Every handler that mutates the job object MUST go through updateJob().
// This guarantees all reads happen on the latest state and no write can
// overwrite changes made by a concurrent operation.
//
// Usage:  updateJob(job => ({ ...job, status: 'done' }))
// --------------------------------------------------------------------------
let jobWriteQueue = Promise.resolve();

function updateJob(updaterFn) {
  jobWriteQueue = jobWriteQueue
    .then(async () => {
      const { job } = await chrome.storage.local.get('job');
      if (!job) return;
      const newJob = updaterFn(job);
      await chrome.storage.local.set({ job: newJob });
    })
    .catch(console.error);
  return jobWriteQueue;
}

// --------------------------------------------------------------------------
// Handlers
// --------------------------------------------------------------------------
async function handleStartScrape(config) {
  const isResume = !!config.resumeCursor;

  // When resuming, keep the leads already collected in the previous run
  let existingLeads = [];
  if (isResume) {
    const { job: prevJob } = await chrome.storage.local.get('job');
    existingLeads = prevJob?.leads ?? [];
  }

  // Reset / initialise job state
  await chrome.storage.local.set({
    job: {
      status: 'running',
      config,
      leads: existingLeads,
      scanned: config.resumeScanned ?? 0,
      found:   config.resumeLeads   ?? 0,
      cursor:  config.resumeCursor  ?? null,
      statusMessage: isResume ? 'Resuming…' : 'Starting…',
      startedAt: Date.now(),
    },
  });
  notifyPopup({ action: 'SCRAPE_STARTED' });

  let tab;
  try {
    tab = await getOrCreateInstagramTab();
    await waitForTabReady(tab.id);
  } catch (err) {
    await setJobStatus('error', err.message);
    notifyPopup({ action: 'SCRAPE_ERROR', error: err.message });
    return;
  }

  // Small settle delay after tab is ready
  await delay(1200);

  try {
    // Ensure the content script is present (handles SPA reloads)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/content.js'],
    });
  } catch (_) {
    // Already injected – that's fine; the guard in content.js prevents double-init
  }

  await delay(500);

  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'RUN_SCRAPE', config });
  } catch (err) {
    const msg =
      'Could not reach the Instagram tab. ' +
      'Please make sure Instagram is open and not on a login screen, then try again.';
    await setJobStatus('error', msg);
    notifyPopup({ action: 'SCRAPE_ERROR', error: msg });
  }
}

async function handleStopScrape() {
  // Persist stopped status through the queue so it lands after any in-flight lead writes
  await updateJob((job) => ({ ...job, status: 'stopped', statusMessage: 'Stopped' }));

  // Tell every Instagram tab (there may be more than one) to stop
  const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  await Promise.allSettled(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, { action: 'STOP_SCRAPE' }))
  );

  // Include cursor so popup can show/hide Resume without a second storage read
  const { job } = await chrome.storage.local.get('job');
  notifyPopup({ action: 'SCRAPE_STOPPED', cursor: job?.cursor ?? null });
}

// Serialise all lead storage writes to prevent concurrent read-modify-write races.
// Without this, two leads arriving quickly both read the same old array and the
// second write silently overwrites the first, losing leads from storage.
async function handleLeadFound(lead) {
  await updateJob((job) => {
    const leads = [...(job.leads || []), lead];
    return { ...job, leads, found: leads.length };
  });
  // Notify popup AFTER the write is confirmed so the popup's leads array
  // always reflects what is actually in storage.
  notifyPopup({ action: 'LEAD_FOUND', lead });
}

// Progress updates are ephemeral display data — relay to popup only, never
// write to storage. Writing on every profile would race with lead writes and
// overwrite newly saved leads with stale job snapshots.
function handleProgressUpdate(message) {
  notifyPopup({ action: 'PROGRESS_UPDATE', ...message });
}

async function handleScrapeDone({ totalScanned, totalLeads }) {
  // Goes through the queue so it waits for any in-flight lead writes to finish
  // before marking the job as done. Without this, the done write can land
  // before the last lead write and overwrite it with a stale leads array.
  await updateJob((job) => ({
    ...job,
    status: 'done',
    scanned: totalScanned,
    found: totalLeads,
    statusMessage: 'Finished',
    cursor: null,
  }));
  notifyPopup({ action: 'SCRAPE_DONE', totalScanned, totalLeads });
}

async function handleScrapeError({ error }) {
  await updateJob((job) => ({ ...job, status: 'error', statusMessage: error }));
  notifyPopup({ action: 'SCRAPE_ERROR', error });
}

async function handleCursorUpdate({ cursor, totalScanned, totalLeads }) {
  await updateJob((job) => ({ ...job, cursor, scanned: totalScanned, found: totalLeads }));
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
async function getOrCreateInstagramTab() {
  const [existing] = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  if (existing) return existing;
  return chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
}

function waitForTabReady(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    function poll() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (tab.status === 'complete') return resolve(tab);
        if (Date.now() - started > timeout) return reject(new Error('Tab load timed out'));
        setTimeout(poll, 400);
      });
    }
    poll();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
