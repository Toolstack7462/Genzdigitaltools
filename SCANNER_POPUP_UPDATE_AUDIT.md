# Security Scanner Popup Update

Applied changes:

- Security scanner is shown as active by default in the extension popup.
- Removed the popup Opt Out / Enable Scanner controls.
- Removed the long four-point Troubleshooting list from the popup.
- Replaced it with one compact help note.
- Added `management` to required extension permissions so the scanner can run without a separate manual permission prompt.
- Added `GENZ_ENABLE_SCANNER_AUTO` message handling.
- Scanner runs after scheduled sync when an extension token exists.
- Scanner still only reports safe metadata: extension name, ID, permissions summary, and risk level.
- Scanner does not collect cookies, passwords, browsing history, page contents, or raw session data.

Cross-checks run:

```bash
node --check chrome-extension/js/background.js
node --check chrome-extension/js/popup.js
node --check chrome-extension/js/bridge.js
python3 -m json.tool chrome-extension/manifest.json
```

Notes:

- If this extension is published publicly, disclose the active scanner and `management` permission in the privacy policy and onboarding copy.
- The four troubleshooting points are not required in the popup. MFA/CAPTCHA guidance is retained as a short note.
