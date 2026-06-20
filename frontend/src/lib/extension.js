// Single source of truth for the Chrome extension download.
// The ZIP is a static, same-origin file under /downloads (the EXISTING download
// folder/link) — no auth, so "Install Extension" never bounces through the
// client-login guard. The version is NOT hardcoded: it is read from the backend
// (admin uploads the latest ZIP; the backend extracts the version from the ZIP's
// manifest.json). The download path stays the same — only the cache-bust version
// is filled in dynamically so members always get the latest uploaded build.
import api from '../services/api';

export const EXT_ZIP_FILENAME = 'genz-digital-store-extension.zip';
export const EXT_ZIP_PATH = `/downloads/${EXT_ZIP_FILENAME}`;

// Backward-compatible export (plain same-origin path). The file is replaced in
// place on the server, so this path always resolves to the latest upload.
export const EXT_ZIP_URL = EXT_ZIP_PATH;

// Append a cache-bust version when known, so a replaced ZIP is never served stale.
export function extZipUrl(version) {
  return version ? `${EXT_ZIP_PATH}?v=${encodeURIComponent(version)}` : EXT_ZIP_PATH;
}

// Suggested SAVE-AS filename including the version, e.g.
// genz-digital-store-extension-v3.9.3.zip. The file on disk keeps its stable
// name (existing link) — only the browser's download name is versioned, which
// also avoids the confusing "extension (12).zip" duplicate-name suffix.
export function versionedZipName(version) {
  const v = String(version || '').trim().replace(/^v/i, '');
  return v ? `genz-digital-store-extension-v${v}.zip` : EXT_ZIP_FILENAME;
}

// Fetch the latest published extension metadata from the backend. Public,
// non-secret version info only. Falls back to the plain download path on error.
export async function getLatestExtension(installed) {
  try {
    const qs = installed ? `?installed=${encodeURIComponent(installed)}` : '';
    const { data } = await api.get(`/extension/version-info${qs}`);
    return {
      latest: data?.latest || null,
      minVersion: data?.minVersion || null,
      forceUpdate: !!data?.forceUpdate,
      isOutdated: !!data?.isOutdated,
      updateAvailable: !!data?.updateAvailable,
      updateRequired: !!data?.updateRequired,
      filename: data?.filename || versionedZipName(data?.latest),
      downloadPath: data?.downloadPath || EXT_ZIP_PATH,
      downloadUrl: extZipUrl(data?.latest),
      publishedAt: data?.publishedAt || null,
    };
  } catch (_) {
    return { latest: null, minVersion: null, forceUpdate: false, isOutdated: false, updateAvailable: false, updateRequired: false, filename: EXT_ZIP_FILENAME, downloadPath: EXT_ZIP_PATH, downloadUrl: EXT_ZIP_PATH };
  }
}
