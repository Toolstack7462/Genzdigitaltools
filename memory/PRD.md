# Gen Z Digital Store CRM - Product Requirements Document

## Project Overview
Full-stack CRM application for managing tools, clients, and assignments with role-based access control and Chrome Extension support for credential sync.

## Tech Stack
- **Frontend:** React, Tailwind CSS, React Router, Axios
- **Backend:** FastAPI (Python gateway) + Node.js/Express (CRM service)
- **Database:** MongoDB
- **Authentication:** JWT with Access/Refresh tokens
- **Chrome Extension:** Manifest V3

## Architecture
```
Frontend (React) :3000
    ↓
FastAPI Gateway :8001 → /api/crm/*
    ↓
Node.js CRM Service :8002
    ↓
MongoDB

Chrome Extension ←→ /api/crm/extension/*
```

## Credentials
- **Admin:** `<set-via-INITIAL_ADMIN_EMAIL-env-var>` / `<set-via-INITIAL_ADMIN_PASSWORD-env-var>`
- **Client:** `we2@gmail.com` / `Client123!`

---

## ✅ Completed Features (Jan 24, 2026)

### Chrome Extension Feature Complete ✅
- [x] **Admin Tool Form** - Added credential type selector (cookies/token/localStorage/none)
- [x] **Token Config** - Token header name, prefix, and value fields for bearer auth
- [x] **Extension Settings** - Checkboxes for auto-inject, inject on page load, clear existing cookies
- [x] **Client Portal Banner** - Chrome Extension download banner with link to /chrome-extension.zip
- [x] **Permanent Fixes** - Server.py now auto-starts CRM backend, validation updated for all credential fields

### Bug Fixes
- [x] **Tool Creation/Editing Fixed** - Fixed `next is not a function` error in Tool.js pre-save hook by converting to async/await
- [x] **Filter Dropdowns Styling** - Added global CSS to remove browser default focus rings and ensure consistent dark theme styling
- [x] **Tools Page Layout** - Improved to use 3-column professional card grid with hover effects
- [x] **Cookies Textarea** - Added spellCheck="false" to prevent red underlines on JSON content
- [x] **CRM Backend Auto-Start** - FastAPI gateway now auto-starts Node.js CRM server on port 8002

---

## ✅ Completed Features (Jan 2026)

### Authentication System
- [x] Admin login with SUPER_ADMIN/ADMIN/SUPPORT role support
- [x] Client login with device binding security
- [x] JWT access + refresh token flow
- [x] Protected routes (AdminRoute, ClientRoute)
- [x] Extension token authentication

### Tool Management
- [x] Tool CRUD operations
- [x] Category support (AI, Academic, SEO, Productivity, etc.)
- [x] Status toggle (active/inactive)
- [x] Credential versioning for extension sync
- [x] Multiple credential types: cookies, tokens, localStorage

### Client Management
- [x] Client CRUD operations
- [x] Device binding feature
- [x] Bulk tool assignment
- [x] Individual tool assignment

### Activity Log
- [x] Comprehensive activity tracking
- [x] User email display in descriptions
- [x] 24-hour auto-deletion (TTL index)
- [x] Role and action filtering

### Chrome Extension (NEW)
- [x] Manifest V3 extension
- [x] Client authentication via extension token
- [x] Auto-sync credentials (15-minute interval)
- [x] Credential versioning detection
- [x] Optional host permissions per domain
- [x] Cookie injection via chrome.cookies API
- [x] Audit logging for credential access

---

## Chrome Extension API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/crm/extension/auth` | POST | Authenticate client, get extension token |
| `/api/crm/extension/logout` | POST | Revoke extension token |
| `/api/crm/extension/tools` | GET | Get assigned tools with versions |
| `/api/crm/extension/tools/versions` | GET | Lightweight version check |
| `/api/crm/extension/tools/:id/credentials` | GET | Get decrypted credentials |
| `/api/crm/extension/tools/:id/opened` | POST | Log tool opened event |
| `/api/crm/extension/profile` | GET | Get client profile |
| `/api/crm/extension/domains` | GET | Get list of tool domains |

---

## Database Models

### Tool (Updated)
```javascript
{
  name: String,
  description: String,
  targetUrl: String,
  domain: String, // Auto-extracted
  category: String,
  status: String,
  credentialType: 'cookies' | 'token' | 'localStorage' | 'none',
  cookiesEncrypted: String,
  tokenEncrypted: String,
  tokenHeader: String,
  tokenPrefix: String,
  localStorageEncrypted: String,
  credentialVersion: Number, // Auto-incremented on credential change
  credentialUpdatedAt: Date,
  extensionSettings: Object
}
```

### ExtensionToken (New)
```javascript
{
  clientId: ObjectId,
  tokenHash: String,
  expiresAt: Date,
  lastUsedAt: Date,
  isRevoked: Boolean,
  deviceInfo: Object
}
```

### CredentialAccessLog (New)
```javascript
{
  clientId: ObjectId,
  toolId: ObjectId,
  extensionTokenId: ObjectId,
  action: String,
  credentialVersion: Number,
  deviceInfo: Object,
  success: Boolean
}
```

---

## Key Files

### Backend - Extension Routes
- `/app/backend/routes/extension/index.js` - Extension API endpoints
- `/app/backend/models/ExtensionToken.js` - Extension token model
- `/app/backend/models/CredentialAccessLog.js` - Audit log model
- `/app/backend/models/Tool.js` - Updated with credential versioning

### Chrome Extension
- `/app/chrome-extension/manifest.json` - Manifest V3 config
- `/app/chrome-extension/popup.html` - Extension popup UI
- `/app/chrome-extension/js/popup.js` - Popup logic
- `/app/chrome-extension/js/background.js` - Auto-sync service worker
- `/app/chrome-extension/js/api.js` - API client
- `/app/chrome-extension/README.md` - Documentation

---

## Testing

### Test Credentials
- Extension auth: `we2@gmail.com` / `Client123!`
- Admin: `<set-via-INITIAL_ADMIN_EMAIL-env-var>` / `<set-via-INITIAL_ADMIN_PASSWORD-env-var>`

### Verified
- Backend: 100% (16/16 tests)
- Frontend: 100% (6/6 UI tests)
- Extension API: Manually verified

---

## Backlog

1. **Admin UI for Credential Management** - Add form fields for credential type, token config
2. **Client Portal Extension Download** - Link to install extension
3. **Production Packaging** - Build Chrome Web Store package
4. **Token Header Injection** - Complete webRequest listener for token injection
