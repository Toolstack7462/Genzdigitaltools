# Reference Extension Analysis — Gen Z Digital Store

Analyzed: OceanHub v1.3.1 and Ghost SEO Tools Extension  
Purpose: Extract safe Chrome MV3 architecture patterns; identify and explicitly avoid any invasive, malicious, or privacy-violating logic.  
Date: 2026-06-06

---

## 1. Manifest Permissions

### OceanHub
- MV3 manifest
- Permissions: `cookies`, `tabs`, `scripting`, `storage`, `activeTab`, **`management`** (invasive — see §14)
- `host_permissions`: `https://oceanhubtool.com/*`, `<all_urls>`
- `content_scripts`: match `<all_urls>` at `document_start`
- No `externally_connectable` declaration

### Ghost SEO
- MV3 manifest
- Permissions: `tabs`, **`management`**, `storage`, `scripting`, `activeTab`, `cookies`, **`webRequest`**, **`browsingData`**, `contextMenus`, `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`
- Duplicate `scripting` entry (lint error)
- `host_permissions`: `<all_urls>`
- `content_scripts`: multiple tool-specific patterns + `<all_urls>` at `document_start`
- No `externally_connectable` declaration

### Gen Z Digital Store — Current State ✓
- Permissions: `storage`, `cookies`, `tabs`, `scripting`, `notifications` — minimal, no `management`, no `browsingData`, no `webRequest`
- `externally_connectable.matches` restricted to `https://app.genzdigitalstore.com/*`, `https://genzdigitalstore.com/*`, `http://localhost:3000/*`
- `content_scripts` match same origins at `document_idle`
- **No changes needed.**

---

## 2. Background Service Worker (SW) Architecture

### OceanHub — Safe Patterns
- SW uses import statements (MV3-compatible)
- Single `chrome.runtime.onMessage` listener dispatches to typed handlers
- Persistent state stored in `chrome.storage.local`; in-memory Maps only for ephemeral locks
- Listener returns `true` for async handlers

### Ghost SEO — Patterns
- SW is obfuscated (single minified line)
- Uses `chrome.runtime.onMessage`, `chrome.runtime.onInstalled`, `chrome.runtime.onStartup`
- Triggers destructive global operations on startup and on other extension events (see §14)

### Gen Z — Current State ✓
- Import-based SW, single `onMessage` dispatcher, async handlers return `true`, persistent state in `chrome.storage.local`
- **No changes needed.**

---

## 3. Popup UI

### OceanHub
- Shows connection status, user email, tool count
- No tool-open buttons — all tool opens triggered from external dashboard page
- Error state shows simple text, no popup-referencing messages

### Ghost SEO
- Obfuscated popup; buttons trigger global cookie wipe and tab reload via message to background (see §14)

### Gen Z — Current State ✓
- `popup.html` shows: "Signed in as", "Tools available", "Last sync", "Access policy: Managed by admin"
- Notice: "Open tools from your member dashboard — not from here. This popup shows connection status only."
- No tool-open buttons in popup
- **No changes needed.**

---

## 4. Content Script / Bridge

### OceanHub
- `content.js` injected into all tabs at `document_start`
- Posts messages to background using `chrome.runtime.sendMessage`
- **RISKY**: blocks DevTools keyboard shortcuts, overrides `document.cookie` getter/setter, hides extension-related UI elements (see §14)

### Ghost SEO
- Multiple `content_scripts` entries including `<all_urls>`
- Obfuscated; injects listeners that interact with third-party tool pages

### Gen Z — Current State ✓
- `bridge.js` injected only into matching dashboard origins
- Communicates via `window.postMessage` with typed message protocol
- Strips all credential fields from messages forwarded to page
- **No changes needed.**

---

## 5. Tool Opening Mechanism

### OceanHub — Safe Patterns
- Finds existing tab by hostname before creating a new one (tab reuse)
- `isToolOpening` boolean flag prevents re-entrant tool opens during in-progress operations
- Duplicate token check: `if (lastProcessedToken === msg.token) return;`

### Ghost SEO
- Opens tool tabs but wraps them with global cookie-clearing and tab-reloading operations

### Gen Z — Applied Changes (§15)
- `openIntentLock` Map already provides 3-second debounce per toolId ✓
- **Added**: `isToolOpening` module-level flag prevents overlapping open operations (from OceanHub)
- Tab reuse already implemented via `chrome.tabs.query` + hostname match ✓

---

## 6. Cookie / Session Management

### OceanHub — Safe Patterns
- `__Host-` prefixed cookie skip: `if (c.name.startsWith("__Host-")) continue;`
- sameSite normalization: maps `none` and **`unspecified`** → `no_restriction`
- Clears only the target domain before applying session bundle
- Does not touch unrelated domains

### Ghost SEO — RISKY (Do NOT Copy)
- `chrome.browsingData.remove` clears ALL cookies and ALL cache **globally since epoch 0** (not scoped to any domain)
- `reloadAllTabs()` reloads every open browser tab

### Gen Z — Applied Changes (§15)
- **Fixed**: sameSite `unspecified` now maps to `no_restriction` (was falling through to `lax`)
- **Added**: `__Host-` cookie name skip (cookies with this prefix enforce strict origin binding; Chrome rejects external sets, so skip them cleanly)
- Domain-scoped clear already implemented ✓
- **No global cookie wipe; no `browsingData`.**

---

## 7. localStorage / sessionStorage

### OceanHub
- Injects localStorage and sessionStorage via `chrome.scripting.executeScript`
- Scoped to target tab only

### Ghost SEO
- Not explicitly seen (obfuscated), but global cookie wipe implies data loss across all storage

### Gen Z — Current State ✓
- `injectStorage()` uses `chrome.scripting.executeScript` scoped to the target tabId
- `clearStorageForDomain()` scoped to target domain tab only
- **No changes needed.**

---

## 8. Domain Allowlist

### OceanHub
- `DOMAIN_URLS` map: hostname → canonical URL
- All cookie operations scoped to declared domains

### Ghost SEO
- `<all_urls>` host permission; operations touch all domains

### Gen Z — Current State ✓
- Tool `targetUrl` drives all cookie/storage scoping
- Extension host_permissions match only the Gen Z dashboard origins
- **No changes needed.**

---

## 9. Reconnect / Retry Logic

### OceanHub — Safe Patterns
- `isRequestProcessing` boolean flag prevents concurrent requests
- On 401 from background: clears token, returns `auth_expired` with `needsReauth: true`

### Gen Z — Current State ✓
- `auth_expired` error code with `needsReauth: true` already implemented in background.js
- `useExtension.js` already checks `result?.needsReauth` and regex matches `auth_expired` for silent reconnect
- `connectPromiseRef` deduplicates concurrent `connectExtension()` calls
- **No changes needed.**

---

## 10. Error Handling

### OceanHub
- Returns typed error objects `{ success: false, error: 'code', message: '...' }`
- No message strings reference "popup" or "reconnect from popup"

### Ghost SEO
- Obfuscated error paths; errors trigger global wipe and self-destruct

### Gen Z — Current State ✓
- All background.js messages purged of popup references
- `sanitizeError()` in `ClientDashboardEnhanced.js` filters remaining edge cases
- **No changes needed.**

---

## 11. Popup Status Display

### OceanHub
- Connected / Disconnected state shown in popup
- Connection is triggered externally (from dashboard), not from popup

### Gen Z — Current State ✓
- Popup displays Connected / Disconnected
- "Open tools from your member dashboard — not from here." notice is prominent
- **No changes needed.**

---

## 12. Tool Open Trigger

### OceanHub
- Dashboard page sends message to background via content script
- Background does all work (no tool-open buttons in popup)

### Gen Z — Current State ✓
- `useExtension.openTool()` → `bridge.js` → `background.js handleOpenTool()`
- Popup has no Access/Open buttons
- **No changes needed.**

---

## 13. Multiple Tools

### OceanHub
- `openIntentLock` / `isToolOpening` per toolId prevents race conditions
- Tab reuse: if a tab for that hostname already exists, focuses it instead of opening duplicate

### Gen Z — Current State ✓
- `openIntentLock` per toolId (3-second debounce) ✓
- `openingRef` Map in `useExtension.js` prevents double-submit per toolId ✓
- Tab reuse implemented in `handleOpenTool` ✓
- **No changes needed.**

---

## 14. Stale Session Clearing

### OceanHub
- On tool open: clears target domain cookies, then injects fresh bundle
- `forceFreshSession: true` flag in GENZ_OPEN_TOOL message

### Gen Z — Current State ✓
- `forceFreshSession: true` sent on every Access click
- `clearCookiesForDomain()` and `clearStorageForDomain()` scoped to targetUrl
- **No changes needed.**

---

## 15. Duplicate Tab Prevention

### OceanHub — Safe Pattern
- Before creating a new tab: `chrome.tabs.query({})` → filter by `url.includes(hostname)` → focus existing tab if found

### Gen Z — Current State ✓
- Existing tab reuse already implemented via hostname match in `handleOpenTool`
- **No changes needed.**

---

## Risky Logic Identified and Explicitly Avoided

| Pattern | Source | Why Avoided |
|---|---|---|
| `permanentDisableOtherExtensions()` | OceanHub | Uses `management` API to disable ALL other user extensions on a 5s polling loop. Malicious. |
| `applyFingerprintSpoofing()` | OceanHub | Overrides `navigator.userAgent/platform/language`, `screen.width/height`. Deceptive anti-detection. |
| DevTools keyboard blocking | OceanHub content.js | Blocks F12, Ctrl+Shift+I/J/C, Ctrl+U. Prevents user debugging their own browser. |
| `document.cookie` override | OceanHub content.js | Hides cookies from Cookie-Editor extension. Deceptive. |
| Extension link blocking | OceanHub content.js | Blocks clicks to `chrome://extensions` and Chrome Web Store links. |
| `chrome.browsingData.remove` (global) | Ghost SEO | Clears ALL cookies and cache since epoch 0. Not domain-scoped. |
| `reloadAllTabs()` | Ghost SEO | Reloads every open tab in browser. |
| `removeSelf()` | Ghost SEO | Self-destructs after global data wipe. |
| `checkForOtherExtensions()` | Ghost SEO | Detects and triggers self-destruct if any other extension exists. Malicious. |
| `management.onEnabled` listener | Ghost SEO | Fires `removeSelf()` whenever user enables any other extension. |

---

## Safe Patterns Applied to Gen Z Digital Store

| Pattern | Source | Applied To | Change |
|---|---|---|---|
| `__Host-` cookie skip | OceanHub background.js | `chrome-extension/js/background.js` | Skip cookies with `__Host-` prefix in `injectCookies()` |
| sameSite `unspecified` → `no_restriction` | OceanHub background.js | `chrome-extension/js/background.js` | Added `unspecified` to the `no_restriction` branch |
| `isToolOpening` flag | OceanHub background.js | `chrome-extension/js/background.js` | Module-level flag prevents overlapping `handleOpenTool` invocations |

---

## Summary of Files Changed

- `chrome-extension/js/background.js` — 3 targeted improvements (see above)
- `REFERENCE_EXTENSION_ANALYSIS.md` — created (this document)
- `SECURITY_NOTES.md` — updated with reference analysis note
- `EXTENSION_INSTALL_GUIDE.md` — updated with session management note
- `CHANGELOG.md` — entry added

---

## Security Guarantees Preserved

- Does not steal cookies from unrelated browser sites
- Does not copy data from other extensions
- Does not block DevTools
- Does not disable other user extensions
- Does not use `browsingData` (global cookie wipe)
- Does not use fingerprint spoofing
- Does not add anti-detection or bypass logic
- Only uses admin-provided authorized session bundles stored in the backend
- Cookie/storage operations scoped exclusively to the target tool domain
