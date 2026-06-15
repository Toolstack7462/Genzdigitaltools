// Single source of truth for the Chrome extension download.
// Keep EXT_VERSION in sync with chrome-extension/manifest.json "version".
// The ZIP is a static, same-origin file under /downloads — no auth, so the
// "Install Extension" action never bounces through the client-login guard.
export const EXT_VERSION = '3.8.7';
export const EXT_ZIP_FILENAME = 'genz-digital-store-extension.zip';
// Version query-string cache-busts so members never get a stale build.
export const EXT_ZIP_URL = `/downloads/${EXT_ZIP_FILENAME}?v=${EXT_VERSION}`;
