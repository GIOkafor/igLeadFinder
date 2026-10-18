# igLeadFinder

igLeadFinder is a Chrome extension built for one specific workflow: find Instagram accounts that match a keyword-based bio filter and export them as leads. It supports two collection modes:

- Followers mode: resolves a target Instagram account and walks that account's follower list.
- Commenters mode: resolves a post URL, enumerates commenters, and filters them by bio keywords.

This is a browser extension, not a server-side scraper. It runs in the user's logged-in Instagram tab and uses Instagram's own web API endpoints from within that authenticated browser session.

## What the app does

The extension helps a user quickly identify potential leads from a public Instagram audience by:

1. Accepting a target account or post URL.
2. Collecting people from that audience.
3. Fetching each profile's bio text.
4. Matching the bio against a list of comma-separated keywords.
5. Storing matched leads in the browser and exporting them as CSV.

It is intentionally built as a lightweight prospecting tool rather than a broad automation framework.

## High-level architecture

The project is a small Manifest V3 Chrome extension with four main parts:

- `manifest.json` — extension registration and permissions.
- `src/popup/` — the popup UI where the user chooses mode, keywords, and limits.
- `src/background/background.js` — the long-lived service worker that manages jobs, tab access, and state.
- `src/content/content.js` — the code that actually interacts with Instagram pages and APIs.
- `src/options/` — settings page for defaults and local data management.

## Runtime flow

### 1) User configures a search

When the popup opens, it renders the form with:

- target username or post URL
- keywords
- max lead limit
- request speed profile
- selected mode (Followers or Commenters)

The popup validates values before sending a message to the background worker.

### 2) Background worker starts the job

The background script listens for commands from the popup on a long-lived port. When the user clicks Start, it:

- creates or reuses an Instagram tab
- waits for the tab to be ready
- ensures the content script is present in the tab
- sends a `RUN_SCRAPE` command into the Instagram page context

It also persists the current job in `chrome.storage.local` so the UI can restore a running or incomplete job after a popup close.

### 3) Content script performs the scraping loop

The content script runs inside the Instagram tab and understands the two modes:

- `followers`: resolve the account, then paginate follower results
- `commenters`: resolve the post shortcode, then paginate comments and associated profiles

The script uses Instagram's web API endpoints such as:

- `https://www.instagram.com/api/v1/users/web_profile_info/?username=...`
- `https://www.instagram.com/api/v1/friendships/{userId}/followers/`
- `https://www.instagram.com/api/v1/users/{userId}/info/`

This lets it use the same authenticated session and same internal request format the Instagram web app itself uses.

### 4) filtering logic runs per profile

Each profile is inspected for bio text. The app checks one or both of these fields depending on the API response shape:

- `profile.biography`
- `profile.biography_with_entities.raw_text`

Then it matches keywords using a custom function that:

- trims and normalizes keyword input
- ignores empty entries
- supports exact phrase-like text and regex word boundaries
- handles short uppercase acronyms carefully so examples like `AI`, `IT`, or `CS` are treated as acronyms instead of plain words
- falls back to substring matching for emoji or non-standard text

This is designed to reduce false positives from ordinary prose like “I am a big fan of AI” vs. “AI agency owner” depending on the exact keyword configuration.

### 5) progress and lead persistence

During scraping, the content script sends progress messages back to the background worker, which forwards them to the popup. The popup updates the status bar and lead count in real time.

Every discovered lead is written into storage through a single queued update flow to avoid race conditions. The code intentionally serializes writes so one lead doesn't overwrite another during fast bursts of updates.

### 6) Resume and export

If a scrape is interrupted, the app stores the cursor and counters in storage. The popup can show a Resume button so the user can continue from where they left off.

Once leads are accumulated, the popup can export them as CSV for use in outreach tools, CRMs, or spreadsheet workflows.

## Key technical aspects

### Manifest V3 extension model

The project uses Chrome's Manifest V3 architecture:

- `background.service_worker` runs the worker
- `content_scripts` inject into `*.instagram.com`
- `scripting.executeScript` can re-inject the content script when needed
- `chrome.storage.local` persists local state
- `tabs` and `scripting` permission allow the extension to coordinate Instagram tab access

This design keeps the extension self-contained and makes it easy to share across user sessions without a backend.

### Browser-authenticated API access

The code does not use a separate server or a third-party scraping stack. Instead, it sends requests from the browser context with the Instagram session cookies already present. That means:

- no login is stored separately
- no external service is required
- the requests are tied to the logged-in browser session

The extension also attaches the required headers such as `X-IG-App-ID` and `X-CSRFToken` to mimic normal Instagram web behavior.

### Rate limiting and safety controls

The extension includes multiple safeguards:

- request delay profiles: conservative, normal, or fast
- retry handling for HTTP 429
- human-like delays between profile fetches
- stop flag support to quit mid-scrape
- daily limit guidance in the options page

The code treats Instagram's rate limits as a first-class concern and stops when rate-limited instead of hammering the API.

### State management

The app uses a queue-based job update pattern in `background.js` to protect against a common storage race:

- progress updates are not written to storage
- lead writes are serialized
- final job completion waits for queued lead writes to finish
- cursor and counts are persisted so resumes work correctly

This is one of the more important technical details in the project because fast scraping can otherwise lose data silently.

### Data handling

All discovered leads are stored locally in the browser through `chrome.storage.local`. The options page even includes a button to clear stored leads. This keeps the tool self-contained and avoids sending prospect data to a remote server.

## Running the extension

No build step is required.

1. Open Chrome.
2. Navigate to `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select this project folder.
6. Log in to Instagram in a browser tab.
7. Open the extension popup and begin a scrape.

## Required environment

- Chrome or a Chromium-based browser
- an active Instagram session
- access to a public Instagram account or public post content

## Notable limitations and warnings

- This extension relies on Instagram's internal web APIs and browser cookies.
- It is designed for public accounts and public posts only.
- Scraping speed and volume should remain conservative to reduce account risk.
- Instagram may change its endpoints or rate limits without notice.
- Use only within the bounds of your own account and the platform's rules and terms.

## Files worth looking at

- `manifest.json`
- `src/background/background.js`
- `src/content/content.js`
- `src/popup/popup.js`
- `src/options/options.html`

## Summary

At a high level, igLeadFinder is a browser extension that turns Instagram's own web-facing APIs into a local, keyword-driven lead generation tool. The real complexity is not in the UI; it is in the orchestration of tab lifecycle, job state, rate limiting, resume support, and the browser-authenticated API calls that keep the workflow inside a single logged-in Instagram session.
