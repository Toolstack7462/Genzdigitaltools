# Extension Site Access Update

The extension has been updated so it can work on tool websites beyond the Gen Z Digital Store dashboard.

## What changed

- Added `host_permissions` for:
  - `http://*/*`
  - `https://*/*`
- Kept `optional_host_permissions` for the same patterns so existing dynamic permission-request code still works.
- Dashboard bridge content scripts are still limited to:
  - `https://genzdigitalstore.com/*`
  - `https://app.genzdigitalstore.com/*`
  - `http://localhost:3000/*`

## Why this matters

The dashboard bridge only needs to run on Gen Z dashboard pages. The extension background service worker needs host permission for external tool websites so it can open tools and apply the allowed access strategy.

## Chrome warning

Chrome may now show a stronger permission warning such as: “Read and change your data on all websites.” This is expected when all-site host permission is declared.

## Safer alternative

For Chrome Web Store/public release, the safer model is to remove `host_permissions` and keep only `optional_host_permissions`, then request each tool domain dynamically when the client clicks Access.
