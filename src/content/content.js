/**
 * igLeadFinder – Content Script
 *
 * Runs inside the user's instagram.com tab (already authenticated).
 * Uses Instagram's own internal REST API—the exact same calls the
 * Instagram web app makes—so no third-party scraping library is needed.
 *
 * Modes:
 *   followers  → resolve target account → paginate followers
 *               → per-follower profile fetch (bio) → keyword filter
 *   commenters → resolve post shortcode → paginate comments
 *               → per-commenter profile fetch (bio) → keyword filter
 *
 * STOP_SCRAPE → set stop flag, exit gracefully
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

/**
 * Resolve the biography text from a raw Instagram user profile object.
 * Instagram returns the bio in one of two fields depending on the client version:
 *   1. profile.biography            – plain string (older / mobile API)
 *   2. profile.biography_with_entities.raw_text – newer API wrapper
 * We try both so the keyword filter always has the real bio text.
 */
function getBio(profile) {
  return profile.biography
    || profile.biography_with_entities?.raw_text
    || '';
}

function matchesKeywords(bio, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const rawBio  = bio || '';
  const lowerBio = rawBio.toLowerCase();
  return keywords.some((kw) => {
    const raw  = kw.trim();
    if (raw.length === 0) return false;
    // Short all-caps acronyms (IT, AI, CS, QA): case-sensitive so the pronoun
    // "it" or article "an" in ordinary prose never triggers a tech keyword.
    const isAcronym = raw.length <= 3 && /^[A-Z0-9]+$/.test(raw);
    const term      = isAcronym ? raw : raw.toLowerCase();
    const haystack  = isAcronym ? rawBio : lowerBio;
    if (/^[a-zA-Z0-9 -]+$/.test(raw)) {
      const escaped = term.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, isAcronym ? '' : 'i').test(haystack);
    }
    // Emoji / non-ASCII keywords (e.g. 💻) fall back to substring match.
    return lowerBio.includes(raw.toLowerCase());
  });
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

      console.log(`[igLeadFinder] @${profile.username} bio: "${getBio(profile)}"`);

      // Double-check privacy on the full profile
      if (profile.is_private) {
        console.log(`[igLeadFinder] @${profile.username} is private (full profile check). Skipping.`);
        continue;
      }

      // Keyword filter
      const matched = matchesKeywords(getBio(profile), keywords);
      console.log(`[igLeadFinder] @${profile.username} keyword match: ${matched}`);
      if (!matched) continue;

      totalLeads++;

      const lead = {
        username: profile.username,
        fullName: profile.full_name ?? '',
        bio: getBio(profile),
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

  if (!stopFlag) {
    chrome.runtime.sendMessage({ action: 'SCRAPE_DONE', totalScanned, totalLeads });
  }
}

// --------------------------------------------------------------------------
// Commenter-mode API helpers
// --------------------------------------------------------------------------

/**
 * Convert an Instagram shortcode to its numeric media ID.
 *
 * Instagram shortcodes are base64url-encoded big integers using the alphabet:
 *   A-Z (0-25)  a-z (26-51)  0-9 (52-61)  - (62)  _ (63)
 *
 * This is a well-documented public algorithm (same one Instagram's own web
 * app uses internally).  Converting locally means:
 *   • Zero network requests for this step — one less API call to make
 *   • No chance of a 404 or rate-limit before we even start
 *   • Instant resolution, no async needed
 *
 * Example: 'DXb1QK9jRDK' → '3576109241987654321'
 */
function shortcodeToMediaId(shortcode) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = BigInt(0);
  for (const char of shortcode) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid shortcode character “${char}” — check the post URL.`);
    id = id * BigInt(64) + BigInt(idx);
  }
  return id.toString();
}

/**
 * Fetch one page of top-level comments for a media ID.
 *
 * Instagram has TWO pagination directions for comments:
 *
 *   Forward  (newer):  max_id    / has_more_comments
 *   Headload (older):  min_id    / has_more_headload_comments
 *
 * With permalink_enabled=true + ranked mode (the default for posts), Instagram
 * returns the top-ranked batch on the first call.  The REMAINING comments come
 * back via the HEADLOAD direction (min_id / next_min_id), NOT max_id.
 * has_more_comments will be false on the first page even though 37+ comments
 * are still waiting behind has_more_headload_comments: true.
 *
 * filter param:
 *   (omitted) = visible comments only
 *   3         = hidden/spam-filtered comments
 */
async function fetchCommentsPage(mediaId, maxId, minId, filter) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=true`;
  if (maxId)  url += `&max_id=${encodeURIComponent(maxId)}`;
  if (minId)  url += `&min_id=${encodeURIComponent(minId)}`;
  if (filter) url += `&filter=${encodeURIComponent(filter)}`;

  const res = await fetch(url, { headers: buildHeaders(), credentials: 'include' });

  // console.log(`[igLeadFinder] fetchCommentsPage URL: ${url}`);
  // console.log(`[igLeadFinder] fetchCommentsPage response body: ${await res.text()}`);

  if (res.status === 429) throw Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true });
  if (res.status === 401) throw new Error('Instagram session expired. Please refresh the page.');
  if (!res.ok) throw new Error(`Comments request failed (HTTP ${res.status}).`);

  return res.json();
}

/**
 * Get list of post likes
*/
async function fetchLikersPage(mediaId, cursor) {
  let url = `https://www.instagram.com/api/v1/media/${mediaId}/likers/`;
  if (cursor) url += `?max_id=${encodeURIComponent(cursor)}`;

  const res = await fetch(url, { headers: buildHeaders(), credentials: 'include' });

  if (res.status === 429) throw Object.assign(new Error('RATE_LIMITED'), { isRateLimit: true });
  if (res.status === 401) throw new Error('Instagram session expired. Please refresh the page.');
  if (!res.ok) throw new Error(`Likers request failed (HTTP ${res.status}).`);

  return res.json();
}

// --------------------------------------------------------------------------
// Commenter scrape loop
// --------------------------------------------------------------------------
async function runCommentScrape(config) {
  stopFlag = false;

  const {
    shortcode,
    keywords    = [],
    maxLeads    = 100,
    delayProfile = 'normal',
    resumeCursor  = null,
    resumeScanned = 0,
    resumeLeads   = 0,
  } = config;

  const delays = DELAY_PROFILES[delayProfile] ?? DELAY_PROFILES.normal;

  // ── Step 1: resolve media ID (pure client-side, no API call) ─────────────────────
  sendProgress(`Resolving post…`, 0, 0);
  console.log(`[igLeadFinder] Decoding shortcode: ${shortcode}`);

  let mediaId;
  try {
    mediaId = shortcodeToMediaId(shortcode);
    console.log(`[igLeadFinder] Decoded mediaId: ${mediaId}`);
  } catch (err) {
    console.error('[igLeadFinder] shortcodeToMediaId failed:', err.message);
    sendError(err.message);
    return;
  }

  sendProgress(`Post resolved. Loading comments…`, 0, 0);

  // ── Step 2: paginate comments ────────────────────────────────────────────
  // Cursors: Instagram uses two pagination directions.
  // We store them as a JSON object {maxId, minId}; legacy plain-string cursors
  // (from earlier versions) are treated as max_id for backward compat.
  let maxCursor = null;
  let minCursor = null;
  if (resumeCursor) {
    try {
      const parsed = JSON.parse(resumeCursor);
      maxCursor = parsed.maxId ?? null;
      minCursor = parsed.minId ?? null;
    } catch {
      maxCursor = resumeCursor; // legacy: plain string was always a max_id cursor
    }
  }

  let totalScanned = resumeScanned;
  let totalLeads   = resumeLeads;

  if (resumeCursor) {
    sendProgress(`Resuming from comment #${resumeScanned + 1}…`, totalScanned, totalLeads);
  }

  // Track commenter user IDs already processed on this run to avoid
  // re-fetching profiles when someone comments multiple times on the same post.
  const processedUserIds = new Set();

  while (!stopFlag) {
    if (totalLeads >= maxLeads) break;

    console.log(`[igLeadFinder] Fetching comments page. maxCursor=${maxCursor ?? '-'} minCursor=${minCursor ? minCursor.slice(0, 40) + '…' : '-'}`);
    sendProgress(`Loading comments page… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

    let pageData;
    try {
      pageData = await fetchCommentsPage(mediaId, maxCursor, minCursor);
      console.log('[igLeadFinder] Raw comments page:', JSON.stringify(pageData).slice(0, 400));
    } catch (err) {
      if (err.isRateLimit) {
        sendProgress('Rate limited. Pausing 90 seconds…', totalScanned, totalLeads);
        await pause(90_000);
        continue;
      }
      console.error('[igLeadFinder] fetchCommentsPage error:', err.message);
      sendError(err.message);
      return;
    }

    const comments = pageData.comments ?? [];
    console.log(`[igLeadFinder] Comments on page: ${comments.length}. has_more_comments: ${pageData.has_more_comments}. has_more_headload: ${pageData.has_more_headload_comments}. next_max_id: ${pageData.next_max_id ?? 'none'}. next_min_id: ${pageData.next_min_id ? '(present)' : 'none'}`);

    if (comments.length === 0) {
      sendProgress('No more comments found.', totalScanned, totalLeads);
      break;
    }

    // Flatten top-level comments and their inline child replies into one list.
    // Instagram nests the first ~3 replies inside comment.child_comments on the
    // same response page — if we don't include them we silently miss those users.
    // (Deep reply threads with more replies have their own pagination via a
    // separate endpoint, but inline replies cover the vast majority of cases.)
    const allCommenters = [];
    for (const comment of comments) {
      if (comment.user) allCommenters.push(comment.user);
      for (const reply of (comment.child_comments ?? [])) {
        if (reply.user) allCommenters.push(reply.user);
      }
    }
    console.log(`[igLeadFinder] Unique commenters to process (top-level + replies): ${allCommenters.length}`);

    // ── Step 3: per-commenter ─────────────────────────────────────────────
    for (const commenter of allCommenters) {
      if (stopFlag || totalLeads >= maxLeads) break;

      // Skip users we already processed (multiple comments from same person)
      if (processedUserIds.has(String(commenter.pk))) continue;
      processedUserIds.add(String(commenter.pk));

      totalScanned++;

      console.log(`[igLeadFinder] [${totalScanned}] Checking @${commenter.username} (private: ${commenter.is_private})`);

      // Fast-path: skip private accounts
      if (commenter.is_private) {
        sendProgress(`Skipped @${commenter.username} (private) · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);
        await randomDelay(200, 500);
        continue;
      }

      sendProgress(`Fetching bio for @${commenter.username}… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

      let profile = null;
      try {
        await randomDelay(delays.min, delays.max);
        profile = await fetchUserProfile(commenter.pk);
      } catch (err) {
        if (err.isRateLimit) {
          sendProgress('Rate limited. Pausing 90 seconds…', totalScanned, totalLeads);
          await pause(90_000);
          try {
            profile = await fetchUserProfile(commenter.pk);
          } catch (_) {
            console.warn(`[igLeadFinder] Skipping @${commenter.username} after retry.`);
            continue;
          }
        } else {
          console.warn(`[igLeadFinder] Profile fetch failed for @${commenter.username}:`, err.message);
          continue;
        }
      }

      if (!profile) {
        console.warn(`[igLeadFinder] Null profile for @${commenter.username}`);
        continue;
      }

      const bio = getBio(profile);
      console.log(`[igLeadFinder] @${profile.username} bio: "${bio}"`);

      if (profile.is_private) continue;

      const matched = matchesKeywords(bio, keywords);
      console.log(`[igLeadFinder] @${profile.username} keyword match: ${matched} (keywords: ${JSON.stringify(keywords)})`);
      if (!matched) continue;

      totalLeads++;

      const lead = {
        username:       profile.username,
        fullName:       profile.full_name ?? '',
        bio:            profile.biography ?? '',
        followerCount:  profile.follower_count ?? null,
        followingCount: profile.following_count ?? null,
        postCount:      profile.media_count ?? null,
        isVerified:     profile.is_verified ?? false,
        profileUrl:     `https://www.instagram.com/${profile.username}/`,
        scrapedAt:      new Date().toISOString(),
      };

      chrome.runtime.sendMessage({ action: 'LEAD_FOUND', lead });
      sendProgress(
        `Scanned ${totalScanned} commenters · ${totalLeads} leads found…`,
        totalScanned,
        totalLeads
      );
    }

    // Advance to next page.  Instagram uses two independent pagination signals:
    //   max_id  / has_more_comments         — forward direction (newer comments)
    //   min_id  / has_more_headload_comments — headload direction (older/more ranked)
    // With permalink_enabled=true the first page exhausts the forward direction
    // immediately; all remaining comments come via headload (min_id).
    maxCursor = pageData.next_max_id ?? null;
    minCursor = pageData.next_min_id ?? null;
    const hasMoreForward  = !!(pageData.has_more_comments          && maxCursor);
    const hasMoreHeadload = !!(pageData.has_more_headload_comments && minCursor);

    const cursorForStorage = (maxCursor || minCursor)
      ? JSON.stringify({ maxId: maxCursor, minId: minCursor })
      : null;
    chrome.runtime.sendMessage({ action: 'CURSOR_UPDATE', cursor: cursorForStorage, totalScanned, totalLeads });

    if (!hasMoreForward && !hasMoreHeadload) break;

    await randomDelay(delays.pageMin, delays.pageMax);
  }

  // ── Hidden / spam-filtered comments pass ──────────────────────────────────
  // Instagram hides certain comments (spam, offensive) behind filter=3.
  // These are never returned by the standard endpoint regardless of pagination.
  // We make a separate single-page request here to catch those users too.
  if (!stopFlag && totalLeads < maxLeads) {
    sendProgress(`Checking hidden/filtered comments… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);
    console.log('[igLeadFinder] Fetching hidden/filtered comments (filter=3)…');

    await randomDelay(delays.pageMin, delays.pageMax);

    try {
      let hiddenMaxCursor = null;
      let hiddenMinCursor = null;
      // Hidden comments can also span multiple pages (both directions)
      while (!stopFlag && totalLeads < maxLeads) {
        const hiddenPage = await fetchCommentsPage(mediaId, hiddenMaxCursor, hiddenMinCursor, '3');
        const hiddenComments = hiddenPage.comments ?? [];
        console.log(`[igLeadFinder] Hidden comments on page: ${hiddenComments.length}. has_more_headload: ${hiddenPage.has_more_headload_comments}`);

        if (hiddenComments.length === 0) break;

        const hiddenCommenters = [];
        for (const comment of hiddenComments) {
          if (comment.user) hiddenCommenters.push(comment.user);
          for (const reply of (comment.child_comments ?? [])) {
            if (reply.user) hiddenCommenters.push(reply.user);
          }
        }

        for (const commenter of hiddenCommenters) {
          if (stopFlag || totalLeads >= maxLeads) break;
          if (processedUserIds.has(String(commenter.pk))) continue;
          processedUserIds.add(String(commenter.pk));

          totalScanned++;

          if (commenter.is_private) {
            await randomDelay(200, 500);
            continue;
          }

          sendProgress(`Checking hidden commenter @${commenter.username}… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);
          await randomDelay(delays.min, delays.max);

          let profile = null;
          try {
            profile = await fetchUserProfile(commenter.pk);
          } catch (err) {
            if (err.isRateLimit) {
              await pause(90_000);
              try { profile = await fetchUserProfile(commenter.pk); } catch (_) { continue; }
            } else { continue; }
          }

          if (!profile || profile.is_private) continue;
          if (!matchesKeywords(getBio(profile), keywords)) continue;

          totalLeads++;
          const lead = {
            username:       profile.username,
            fullName:       profile.full_name ?? '',
            bio:            getBio(profile),
            followerCount:  profile.follower_count ?? null,
            followingCount: profile.following_count ?? null,
            postCount:      profile.media_count ?? null,
            isVerified:     profile.is_verified ?? false,
            profileUrl:     `https://www.instagram.com/${profile.username}/`,
            scrapedAt:      new Date().toISOString(),
          };
          chrome.runtime.sendMessage({ action: 'LEAD_FOUND', lead });
          sendProgress(`Scanned ${totalScanned} commenters · ${totalLeads} leads found…`, totalScanned, totalLeads);
        }

        hiddenMaxCursor = hiddenPage.next_max_id ?? null;
        hiddenMinCursor = hiddenPage.next_min_id ?? null;
        const hiddenHasMore = !!(hiddenPage.has_more_comments && hiddenMaxCursor) ||
                              !!(hiddenPage.has_more_headload_comments && hiddenMinCursor);
        if (!hiddenHasMore) break;
        await randomDelay(delays.pageMin, delays.pageMax);
      }
    } catch (err) {
      // Hidden comments are a best-effort pass — don’t abort the whole job
      console.warn('[igLeadFinder] Hidden comments fetch failed (non-fatal):', err.message);
    }
  }

  if (!stopFlag) {
    chrome.runtime.sendMessage({ action: 'SCRAPE_DONE', totalScanned, totalLeads });
  }
}

// get profile data on post likers and update UI
async function runLikerScrape(config) {
  stopFlag = false;

  const {
    shortcode,
    keywords     = [],
    maxLeads     = 100,
    delayProfile = 'normal',
    resumeCursor  = null,
    resumeScanned = 0,
    resumeLeads   = 0,
  } = config;

  const delays = DELAY_PROFILES[delayProfile] ?? DELAY_PROFILES.normal;

  sendProgress(`Resolving post…`, 0, 0);

  let mediaId;
  try {
    mediaId = shortcodeToMediaId(shortcode);
  } catch (err) {
    sendError(err.message);
    return;
  }

  sendProgress(`Post resolved. Loading likers…`, 0, 0);

  let cursor       = resumeCursor;
  let totalScanned = resumeScanned;
  let totalLeads   = resumeLeads;

  if (resumeCursor) {
    sendProgress(`Resuming from liker #${resumeScanned + 1}…`, totalScanned, totalLeads);
  }

  while (!stopFlag) {
    if (totalLeads >= maxLeads) break;

    sendProgress(`Loading likers page… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

    let pageData;
    try {
      pageData = await fetchLikersPage(mediaId, cursor);
      console.log('[igLeadFinder] Raw likers page:', JSON.stringify(pageData).slice(0, 400));
    } catch (err) {
      if (err.isRateLimit) {
        sendProgress('Rate limited. Pausing 90 seconds…', totalScanned, totalLeads);
        await pause(90_000);
        continue;
      }
      sendError(err.message);
      return;
    }

    const likers = pageData.users ?? [];
    console.log(`[igLeadFinder] Likers on page: ${likers.length}. next_max_id: ${pageData.next_max_id ?? 'none'}`);

    if (likers.length === 0) {
      sendProgress('No likers returned.', totalScanned, totalLeads);
      break;
    }

    for (const liker of likers) {
      if (stopFlag || totalLeads >= maxLeads) break;

      totalScanned++;

      if (liker.is_private) {
        sendProgress(`Skipped @${liker.username} (private) · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);
        await randomDelay(200, 500);
        continue;
      }

      sendProgress(`Fetching bio for @${liker.username}… · ${totalScanned} scanned · ${totalLeads} leads`, totalScanned, totalLeads);

      let profile = null;
      try {
        await randomDelay(delays.min, delays.max);
        profile = await fetchUserProfile(liker.pk);
      } catch (err) {
        if (err.isRateLimit) {
          sendProgress('Rate limited. Pausing 90 seconds…', totalScanned, totalLeads);
          await pause(90_000);
          try {
            profile = await fetchUserProfile(liker.pk);
          } catch (_) {
            console.warn(`[igLeadFinder] Skipping @${liker.username} after retry.`);
            continue;
          }
        } else {
          console.warn(`[igLeadFinder] Profile fetch failed for @${liker.username}:`, err.message);
          continue;
        }
      }

      if (!profile || profile.is_private) continue;

      const bio = getBio(profile);
      if (!matchesKeywords(bio, keywords)) continue;

      totalLeads++;

      const lead = {
        username:       profile.username,
        fullName:       profile.full_name ?? '',
        bio,
        followerCount:  profile.follower_count ?? null,
        followingCount: profile.following_count ?? null,
        postCount:      profile.media_count ?? null,
        isVerified:     profile.is_verified ?? false,
        profileUrl:     `https://www.instagram.com/${profile.username}/`,
        scrapedAt:      new Date().toISOString(),
      };

      chrome.runtime.sendMessage({ action: 'LEAD_FOUND', lead });
      sendProgress(`Scanned ${totalScanned} likers · ${totalLeads} leads found…`, totalScanned, totalLeads);
    }

    cursor = pageData.next_max_id ?? null;
    chrome.runtime.sendMessage({ action: 'CURSOR_UPDATE', cursor, totalScanned, totalLeads });

    if (!cursor) break;

    await randomDelay(delays.pageMin, delays.pageMax);
  }

  if (!stopFlag) {
    chrome.runtime.sendMessage({ action: 'SCRAPE_DONE', totalScanned, totalLeads });
  }
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
  // Resolves early if stopFlag is set, so Stop works during rate-limit waits
  return new Promise((resolve) => {
    const step = 250;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += step;
      if (stopFlag || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, step);
  });
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
    const { config } = message;
    if (config.mode === 'commenters') {
      runCommentScrape(config);
    } else if (config.mode === 'likers') {
      runLikerScrape(config);
    } else {
      runScrape(config);
    }
    sendResponse({ started: true });
  } else if (message.action === 'STOP_SCRAPE') {
    stopFlag = true;
    sendResponse({ stopped: true });
  }
  return true;
};

chrome.runtime.onMessage.addListener(window.__igLeadFinderListener);
