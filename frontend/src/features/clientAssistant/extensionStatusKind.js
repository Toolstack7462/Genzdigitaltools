// What we ACTUALLY know about the client's browser extension — five answers, not four.
//
// THE BUG THIS REPLACES. `extensionIssue()` returned a problem code or `null`, and `null` was then
// read as "everything is fine":
//
//     if (!status) return null;                       // status unknown -> "no issue"
//     …
//     if (ei) return startIssueByCode(ei, ctx);
//     // else: "Your extension looks good. Your extension is installed and connected."
//
// So with no extension bridge, a status that had not loaded yet, or a status whose `installed` field
// was simply absent, Zee asserted that the extension was installed and connected. It had never
// checked. `recheck-extension` had the same hole and reported "Your extension is connected now."
//
// UNKNOWN is now its own answer. Zee says it could not confirm and offers to check again, which is
// honest and still actionable. Only a positive reading produces 'ok'.
import { ISSUE } from './diagnosticFlows';

export const EXT_KIND = {
  MISSING: 'missing',
  OUTDATED: 'outdated',
  DISCONNECTED: 'disconnected',
  OK: 'ok',
  UNKNOWN: 'unknown',
};

const isBool = (v) => v === true || v === false;

/**
 * Classify a live extension status object.
 * @param {object|null|undefined} status from the existing extension bridge hook
 * @returns {'missing'|'outdated'|'disconnected'|'ok'|'unknown'}
 */
export function extensionStatusKind(status) {
  // No object at all: the bridge has not answered. Not an absence of problems.
  if (!status || typeof status !== 'object') return EXT_KIND.UNKNOWN;

  // `installed` must be a real boolean. A missing or non-boolean field means the bridge did not
  // report it, which is unknown — the old code treated it as "not false", hence "looks good".
  if (!isBool(status.installed)) return EXT_KIND.UNKNOWN;
  if (status.installed === false) return EXT_KIND.MISSING;

  // Installed. Version staleness is a positive signal in either field.
  if (status.isOutdated === true || status.updateAvailable === true) return EXT_KIND.OUTDATED;
  if (status.connected === false) return EXT_KIND.DISCONNECTED;

  // 'ok' needs a POSITIVE connected reading. `connected` absent means we do not know whether the
  // extension can actually talk to the page, so it is not a clean bill of health.
  if (status.connected === true) return EXT_KIND.OK;
  return EXT_KIND.UNKNOWN;
}

/** The existing ISSUE code for a problem kind, or null for 'ok' / 'unknown' (not problems). */
export function issueCodeForKind(kind) {
  switch (kind) {
    case EXT_KIND.MISSING: return ISSUE.EXTENSION_MISSING;
    case EXT_KIND.OUTDATED: return ISSUE.EXTENSION_OUTDATED;
    case EXT_KIND.DISCONNECTED: return ISSUE.EXTENSION_DISCONNECTED;
    default: return null;
  }
}

/** Convenience for call sites that only want "is there a problem code to start a flow with?". */
export function extensionIssueCode(status) {
  return issueCodeForKind(extensionStatusKind(status));
}
