/**
 * igLeadFinder – Options Page Script
 */

const defaultDelayEl    = document.getElementById('default-delay');
const dailyLimitEl      = document.getElementById('daily-limit');
const defaultMaxLeadsEl = document.getElementById('default-max-leads');
const saveBtn           = document.getElementById('save-btn');
const clearDataBtn      = document.getElementById('clear-data-btn');
const saveStatusEl      = document.getElementById('save-status');

const DEFAULTS = {
  defaultDelay:    'normal',
  dailyLimit:      300,
  defaultMaxLeads: 100,
};

// Load saved settings on open
chrome.storage.local.get('settings', ({ settings }) => {
  const s = { ...DEFAULTS, ...(settings || {}) };
  defaultDelayEl.value    = s.defaultDelay;
  dailyLimitEl.value      = s.dailyLimit;
  defaultMaxLeadsEl.value = s.defaultMaxLeads;
});

// Save
saveBtn.addEventListener('click', () => {
  const settings = {
    defaultDelay:    defaultDelayEl.value,
    dailyLimit:      Math.min(Math.max(parseInt(dailyLimitEl.value, 10) || 300, 10), 1000),
    defaultMaxLeads: Math.min(Math.max(parseInt(defaultMaxLeadsEl.value, 10) || 100, 1), 500),
  };

  chrome.storage.local.set({ settings }, () => {
    saveStatusEl.style.display = 'block';
    setTimeout(() => { saveStatusEl.style.display = 'none'; }, 2000);
  });
});

// Clear lead data (keeps settings intact)
clearDataBtn.addEventListener('click', () => {
  if (!confirm('This will delete all stored leads. Are you sure?')) return;
  chrome.storage.local.remove('job', () => {
    alert('All stored lead data has been cleared.');
  });
});
