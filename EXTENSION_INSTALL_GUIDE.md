# Chrome Extension Install Guide — Gen Z Digital Store

## For Clients (End Users)

### Installing the Extension

1. Log in to your Gen Z Digital Store dashboard at `https://app.genzdigitalstore.com`.
2. Go to the **Chrome Extension** page (link in the sidebar or navigate to `/chrome-extension`).
3. Download the extension ZIP file.
4. Open Chrome and go to `chrome://extensions/`.
5. Enable **Developer mode** (toggle in the top-right corner).
6. Click **Load unpacked** — but first you need to unzip the downloaded file.
7. Select the unzipped `chrome-extension` folder.
8. The Gen Z Digital Store extension icon will appear in your Chrome toolbar.

### Connecting the Extension

The extension connects automatically when you visit the client dashboard while logged in. You do not need to click anything in the popup.

- If the extension shows as **Disconnected**, refresh the dashboard page.
- The popup status bar shows **"Managed by admin"** — you do not manage connection settings yourself.

### Opening a Tool

1. Log in to the dashboard.
2. Find the tool in your **My Tools** list.
3. Click the **Access** button.
4. The tool will open in a new tab with your authorized session applied automatically.

You do not need to log in to the tool manually. The authorized session is managed by your admin.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Extension shows Disconnected | Refresh the dashboard. The extension auto-connects within a few seconds. |
| Access button says "Session expired" | Your tool assignment may have ended. Contact your admin. |
| Tool opens but shows a login page | The authorized session bundle may need updating. Contact your admin. |
| Extension icon missing | Re-install from the `/chrome-extension` page. |

---

## For Admins (Building / Updating the Extension ZIP)

### Build the Extension ZIP

From the project root:

```bash
# Windows PowerShell
Compress-Archive -Path chrome-extension\* -DestinationPath frontend\public\downloads\genz-digital-store-extension.zip -Force
```

Or on Mac/Linux:

```bash
cd chrome-extension
zip -r ../frontend/public/downloads/genz-digital-store-extension.zip . --exclude "*.DS_Store"
```

### After Updating the Extension

1. Rebuild the ZIP (see above).
2. Rebuild the frontend (`npm run build` in `frontend/`).
3. Re-upload `frontend/build/` to hosting.
4. Clients will need to re-download and re-install the updated extension.

### Manifest Version

The current extension uses **Manifest V3**. It requires Chrome 88 or later.

### Updating `externally_connectable`

If you publish the extension to the Chrome Web Store, add the published extension ID to `externally_connectable` in `manifest.json`:

```json
"externally_connectable": {
  "ids": ["YOUR_CHROME_WEB_STORE_EXTENSION_ID"],
  "matches": [
    "https://genzdigitalstore.com/*",
    "https://app.genzdigitalstore.com/*",
    "http://localhost:3000/*"
  ]
}
```
