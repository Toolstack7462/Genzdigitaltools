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

// Fetch the latest published extension metadata from the backend. Public,
// non-secret version info only. Falls back to the plain download path on error.
export async function getLatestExtension() {
  try {
    const { data } = await api.get('/extension/version-info');
    return {
      latest: data?.latest || null,
      minVersion: data?.minVersion || null,
      downloadPath: data?.downloadPath || EXT_ZIP_PATH,
      downloadUrl: extZipUrl(data?.latest),
    };
  } catch (_) {
    return { latest: null, minVersion: null, downloadPath: EXT_ZIP_PATH, downloadUrl: EXT_ZIP_PATH };
  }
}
