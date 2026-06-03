# Enterprise Managed Chrome — Extension Policy Guide

## Overview

The most reliable way to prevent unauthorized browser extensions (including cookie/session editors) on member devices is via **Google Chrome Enterprise Policy**.

This is **optional** and only applicable to organizations managing Chrome via Google Admin Console or a device management platform (MDM/EMM).

---

## Policy: Block All Extensions Except Gen Z Digital Store

### Google Admin Console

1. Go to **Admin Console → Devices → Chrome → Apps & Extensions → Users & Browsers**
2. Under **Additional Settings**, expand **Extensions**
3. Set **Block extensions by default** (ExtensionInstallBlocklist = `*`)
4. Under **Force-installed Extensions**, add your Gen Z Digital Store Extension ID
5. Under **Allowed Extensions**, add your Extension ID

### Chrome Policy JSON (for managed devices via Group Policy / MDM)

```json
{
  "ExtensionInstallBlocklist": ["*"],
  "ExtensionInstallAllowlist": ["YOUR_EXTENSION_ID_HERE"],
  "ExtensionInstallForcelist": ["YOUR_EXTENSION_ID_HERE;https://clients2.google.com/service/update2/crx"]
}
```

Replace `YOUR_EXTENSION_ID_HERE` with the actual Chrome Web Store extension ID for Gen Z Digital Store.

---

## What This Achieves

| Threat                                    | Without Policy | With Policy |
|-------------------------------------------|:--------------:|:-----------:|
| Member installs cookie-editor extension   | Detectable*    | Blocked     |
| Member installs session-export extension  | Detectable*    | Blocked     |
| Admin-approved extensions only            | ✗              | ✓           |

*The optional Risk Scanner detects risky extension indicators and notifies admins, but **cannot block** extensions without managed Chrome policy.

---

## Important Caveats

- **Unmanaged personal devices**: Policy only applies to managed corporate Chrome profiles. Members using personal devices cannot be restricted this way.
- **This is advisory**: Even without managed Chrome, the Risk Scanner can alert admins to high-risk extension configurations on member devices (with member consent).
- **No false certainty**: Detecting a risky extension does not prove data was copied. It is a risk indicator requiring investigation.

---

## Privacy Disclosure

When the optional Risk Scanner is enabled by the member:
- We scan installed browser extensions for permissions that may indicate session data access risk.
- We collect: extension name, extension ID, permissions summary (e.g. "cookies, tabs, <all_urls>"), and calculated risk level.
- We do **not** collect: cookie values, browsing history, tab contents, personal data, or any extension's internal data.
- The member can revoke scanner consent at any time from the extension popup.
- Scan results are stored for up to 90 days and visible to your account's administrators.
- Full details are in our Privacy Policy.

---

## References

- [Chrome Enterprise Policy List](https://chromeenterprise.google/policies/)
- [ExtensionInstallBlocklist](https://chromeenterprise.google/policies/#ExtensionInstallBlocklist)
- [ExtensionInstallAllowlist](https://chromeenterprise.google/policies/#ExtensionInstallAllowlist)
