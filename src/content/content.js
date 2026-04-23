/**
 * igLeadFinder – Content Script
 *
 * Runs inside the user's instagram.com tab (already authenticated).
 * Uses Instagram's own internal REST API—the exact same calls the
 * Instagram web app makes—so no third-party scraping library is needed.
 *
 * Flow triggered by background:
 *   1. RUN_SCRAPE  → resolve target account → paginate followers
 *                    → per-follower profile fetch (bio) → keyword filter
 *                    → send LEAD_FOUND for each match
 *   2. STOP_SCRAPE → set stop flag, exit gracefully
 */

// Guard against double-injection (SPA navigation + scripting.executeScript)
if (window.__igLeadFinderLoaded) {
  // Re-register the message listener in case the previous one is stale
  // (this path is hit on execute-script re-injection)
} else {
  window.__igLeadFinderLoaded = true;
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------
const IG_APP_ID = '936619743392459'; // Standard Instagram web app ID

const DELAY_PROFILES = {
  conservative: { min: 3000, max: 8000, pageMin: 2000, pageMax: 4000 },
  normal:       { min: 2000, max: 5000, pageMin: 1000, pageMax: 2500 },
  fast:         { min: 1000, max: 3000, pageMin:  700, pageMax: 1500 },
};

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------
let stopFlag = false;

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------
function randomDelay(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCsrfToken() {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : '';
}

function buildHeaders() {
  return {
    'X-IG-App-ID': IG_APP_ID,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRFToken': getCsrfToken(),
  };
}

function matchesKeywords(bio, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const lowerBio = (bio || '').toLowerCase();
  return keywords.some((kw) => lowerBio.includes(kw.toLowerCase().trim()));
}

// --------------------------------------------------------------------------
// Instagram API calls – all run in the context of the logged-in tab,
// so the session cookies are sent automatically.
// --------------------------------------------------------------------------

async function fetchUserInfo(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, { headers: buildHeaders(), credentials: 'include' });

  if (res.status === 404) throw new Error(`Account "@${username}" not found.`);
  if (res.status === 401) throw new Error('Not logged in to Instagram. Please log in and try again.');
  if (!res.ok) throw new Error(`Failed to fetch profile (HTTP ${res.status}).`);

  const json = await res.json();
  const user = json?.data?.user;
  if (!user) throw new Error('Unexpected response from Instagram. Try refreshing the page.');

  return {
    userId: user.id,
    username: user.username,
    fullName: user.full_name,
    followerCount: user.edge_followed_by?.count ?? null,
    isPrivate: user.is_private,
  };
}

async function fetchFollowersPage(userId, cursor) {
  let url = `https://www.instagram.com/api/v1/friendships/${userId}/followers/?count=50`;
  if (cursor) url += `&max_id=${encodeURIComponent(cursor)}`;

  const res = await fetch(url, { headers: buildHeaders(), credentials: 'include' });

  if (res.status === 429) throw Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true });
  if (res.status === 401) throw new Error('Instagram session expired. Please refresh the page.');
  if (!res.ok) throw new Error(`Followers request failed (HTTP ${res.status}).`);

  return res.json();
}

async function fetchUserProfile(userId) {
  const url = `https://www.instagram.com/api/v1/users/${userId}/info/`;
  const res = await fetch(url, { headers: buildHeaders(), credentials: 'include' });

  if (res.status === 429) throw Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true });
  if (!res.ok) return null;

  const json = await res.json();
  return json?.user ?? null;
}

// --------------------------------------------------------------------------
// Core scrape loop
// --------------------------------------------------------------------------
async function runScrape(config) {
  stopFlag = false;

  const {
    username,
    keywords = [],
    maxLeads = 100,
    delayProfile = 'normal',
    resumeCursor  = null,
    resumeScanned = 0,
    resumeLeads   = 0,
  } = config;

  const delays = DELAY_PROFILES[delayProfile] ?? DELAY_PROFILES.normal;

  // ── Step 1: resolve target account ──────────────────────────────────────
  sendProgress(`Looking up @${username}…`, 0, 0);
  console.log(`[igLeadFinder] Looking up @${username}…`);

  let targetUser;
  try {
    targetUser = await fetchUserInfo(username);
    console.log('[igLeadFinder] fetchUserInfo result:', JSON.stringify(targetUser));
  } catch (err) {
    console.error('[igLeadFinder] fetchUserInfo failed:', err.message);
    sendError(err.message);
    return;
  }

  if (targetUser.isPrivate) {
    sendError(`@${username} is a private account. igLeadFinder can only scrape public accounts' followers.`);
    return;
  }

  const followerLabel = targetUser.followerCount != null
    ? targetUser.followerCount.toLocaleString()
    : 'unknown';

  sendProgress(
    `Found @${targetUser.username} (${followerLabel} followers). Scanning…`,
    0, 0
  );

  console.log(`[igLeadFinder] Resolved userId: ${targetUser.userId}. Starting follower pagination…`);

  // ── Step 2: paginate followers ───────────────────────────────────────────
  let cursor       = resumeCursor;
  let totalScanned = resumeScanned;
  let totalLeads   = resumeLeads;

  if (resumeCursor) {
    console.log(`[igLeadFinder] Resuming from cursor=${resumeCursor}, scanned=${resumeScanned}, leads=${resumeLeads}`);
    sendProgress(`Resuming from follower #${resumeScanned + 1}…`, totalScanned, totalLeads);
  }

  while (!stopFlag) {
    if (totalLeads >= maxLeads) break;

    console.log(`[igLeadFinder] Fetching followers page. cursor=${cursor ?? 'start'}`);
    sendProgress(`Loading followers page… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

    // Fetch a page of followers
    let pageData;
    try {
      pageData = await fetchFollowersPage(targetUser.userId, cursor);
      console.log('[igLeadFinder] Raw followers page response:', JSON.stringify(pageData).slice(0, 400));
    } catch (err) {
      if (err.isRateLimit) {
        sendProgress('Rate limited by Instagram. Pausing 90 seconds…', totalScanned, totalLeads);
        await pause(90_000);
        continue;
      }
      console.error('[igLeadFinder] fetchFollowersPage error:', err.message);
      sendError(err.message);
      return;
    }

    const followers = pageData.users ?? [];
    console.log(`[igLeadFinder] Page fetched. Followers on this page: ${followers.length}. next_max_id: ${pageData.next_max_id ?? 'none'}`);

    if (followers.length === 0) {
      console.warn('[igLeadFinder] Empty followers array – either no more followers, or Instagram requires you to follow this account to see its followers.');
      sendProgress('No followers returned. The account may require you to follow it first, or you have reached the end.', totalScanned, totalLeads);
      break;
    }

    // ── Step 3: per-follower  ─────────────────────────────────────────────
    for (const follower of followers) {
      if (stopFlag || totalLeads >= maxLeads) break;

      totalScanned++;

      console.log(`[igLeadFinder] [${totalScanned}] Checking @${follower.username} (private: ${follower.is_private})`);

      // Fast-path: skip private accounts without an extra request
      if (follower.is_private) {
        sendProgress(`Skipped @${follower.username} (private) · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);
        await randomDelay(200, 500);
        continue;
      }

      sendProgress(`Fetching bio for @${follower.username}… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

      // Fetch the full profile to get biography
      let profile = null;
      try {
        await randomDelay(delays.min, delays.max);
        profile = await fetchUserProfile(follower.pk);
      } catch (err) {
        if (err.isRateLimit) {
          sendProgress('Rate limited. Pausing 90 seconds…', totalScanned, totalLeads);
          await pause(90_000);
          // Re-try this follower
          try {
            profile = await fetchUserProfile(follower.pk);
          } catch (_) {
            console.warn(`[igLeadFinder] Skipping @${follower.username} after rate-limit retry failed.`);
            continue;
          }
        } else {
          console.warn(`[igLeadFinder] Profile fetch failed for @${follower.username}:`, err.message);
          continue;
        }
      }

      if (!profile) {
        console.warn(`[igLeadFinder] Null profile returned for @${follower.username}`);
        continue;
      }

      console.log(`[igLeadFinder] @${profile.username} bio: "${profile.biography}"`);

      // Double-check privacy on the full profile
      if (profile.is_private) {
        console.log(`[igLeadFinder] @${profile.username} is private (full profile check). Skipping.`);
        continue;
      }

      // Keyword filter
      const matched = matchesKeywords(profile.biography, keywords);
      console.log(`[igLeadFinder] @${profile.username} keyword match: ${matched}`);
      if (!matched) continue;

      totalLeads++;

      const lead = {
        username: profile.username,
        fullName: profile.full_name ?? '',
        bio: profile.biography ?? '',
        followerCount: profile.follower_count ?? null,
        followingCount: profile.following_count ?? null,
        postCount: profile.media_count ?? null,
        isVerified: profile.is_verified ?? false,
        profileUrl: `https://www.instagram.com/${profile.username}/`,
        scrapedAt: new Date().toISOString(),
      };

      chrome.runtime.sendMessage({ action: 'LEAD_FOUND', lead });
      sendProgress(
        `Scanned ${totalScanned} profiles · ${totalLeads} leads found…`,
        totalScanned,
        totalLeads
      );
    }

    // Move to next follower page
    cursor = pageData.next_max_id ?? null;

    // Persist cursor so the user can resume if they stop
    chrome.runtime.sendMessage({ action: 'CURSOR_UPDATE', cursor, totalScanned, totalLeads });

    if (!cursor) break;

    await randomDelay(delays.pageMin, delays.pageMax);
  }

  chrome.runtime.sendMessage({
    action: 'SCRAPE_DONE',
    totalScanned,
    totalLeads,
  });
}

// --------------------------------------------------------------------------
// Message helpers
// --------------------------------------------------------------------------
function sendProgress(message, scanned, found) {
  chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', message, scanned, found });
}

function sendError(error) {
  chrome.runtime.sendMessage({ action: 'SCRAPE_ERROR', error });
}

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// Message listener
// --------------------------------------------------------------------------
// Remove any previously-registered listener to prevent stacking on re-inject
if (window.__igLeadFinderListener) {
  chrome.runtime.onMessage.removeListener(window.__igLeadFinderListener);
}

window.__igLeadFinderListener = function (message, _sender, sendResponse) {
  if (message.action === 'RUN_SCRAPE') {
    runScrape(message.config);
    sendResponse({ started: true });
  } else if (message.action === 'STOP_SCRAPE') {
    stopFlag = true;
    sendResponse({ stopped: true });
  }
  return true;
};

chrome.runtime.onMessage.addListener(window.__igLeadFinderListener);
