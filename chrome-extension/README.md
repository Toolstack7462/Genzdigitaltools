# Gen Z Digital Store Access - Chrome Extension v2.1

Enterprise-grade auto-login system with intelligent strategy fallback, MFA detection, and multi-step login support.

## 🚀 New in v2.1

### Login Orchestrator
- **Unified login flow** - Single entry point manages the entire login lifecycle
- **Automatic method selection** - Chooses the best login method based on available credentials
- **Smart fallbacks** - If one method fails, automatically tries the next
- **Retry logic with exponential backoff** - Handles temporary failures gracefully

### Enhanced Form Login
- **MutationObserver** - Detects dynamically rendered login forms (SPAs)
- **Multi-step login support** - Handles email-first, then password flows (Google, Microsoft style)
- **Same-origin iframe support** - Works with login forms inside iframes
- **MFA detection** - Stops automation when 2FA/MFA is detected, shows user-friendly message
- **Native value setter** - Works with React, Vue, Angular controlled inputs

### Improved SSO/OAuth
- **New tab/popup monitoring** - Tracks OAuth flows across browser tabs
- **Account chooser detection** - Notifies user when account selection is needed
- **Better provider button detection** - Finds SSO buttons by selector, text, and aria-label
- **Session extraction** - Captures cookies/tokens after successful OAuth for future use

### Better Cookie/Storage Injection
- **Proper attribute normalization** - Correctly handles domain, sameSite, secure, path
- **Pre-navigation injection** - Injects before page load for best reliability
- **Reload coordination** - Automatic page reload after injection

### Diagnostics
- **Debug mode toggle** - Enable in profile to see detailed logs
- **Structured logging** - Easy to read, categorized log entries
- **Secret masking** - NEVER exposes passwords, tokens, or cookies in logs
- **User-friendly errors** - Clear messages when login fails

## 📁 Project Structure

```
chrome-extension/
├── manifest.json                 # Extension manifest (MV3)
├── popup.html                    # Popup UI
├── css/
│   └── popup.css                 # Popup styles
├── icons/                        # Extension icons
├── js/
│   ├── api.js                    # API client & storage utilities
│   ├── background.js             # Service worker (main controller)
│   ├── content.js                # Content script (login detection)
│   ├── popup.js                  # Popup controller
│   ├── core/
│   │   ├── LoginOrchestrator.js  # Unified login flow controller
│   │   ├── SuccessDetector.js    # Login success verification
│   │   └── Logger.js             # Structured logging system
│   ├── strategies/
│   │   ├── BaseStrategy.js       # Strategy base class
│   │   ├── CookieStrategy.js     # Cookie injection
│   │   ├── TokenStrategy.js      # localStorage/sessionStorage injection
│   │   ├── FormStrategy.js       # Form fill & submit
│   │   ├── SSOStrategy.js        # OAuth/SSO flows
│   │   ├── HeadersStrategy.js    # Custom header auth
│   │   └── StrategyEngine.js     # Strategy orchestration
│   └── config/
│       └── toolConfigs.js        # Tool configuration templates
```

## 🔧 Installation

### Development (unpacked)

1. Clone the repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (top right toggle)
4. Click "Load unpacked"
5. Select the `chrome-extension` folder

### Production

1. Create a ZIP of the `chrome-extension` folder
2. Upload to Chrome Web Store (or distribute internally)

## 🧪 How to Test

### Prerequisites
- Chrome browser (v110+)
- Backend API running (for credential fetching)
- At least one tool configured with credentials

### Testing One-Click Login

1. **Install the extension** (see Installation above)

2. **Configure API URL**
   - Click the extension icon
   - Click "Configure API" link
   - Enter your backend API URL
   - Click "Save"

3. **Login to the extension**
   - Enter your email/password
   - Click "Login"

4. **Grant Permissions**
   - Click a tool card
   - When prompted, click "Grant" to allow access to the tool's domain

5. **Test One-Click Login**
   - Click "Open" on any tool card
   - The extension should:
     - Open a new tab
     - Inject session data OR fill login form OR trigger SSO
     - Navigate to the dashboard/post-login page

### Testing Form Login

1. **Configure a tool with form credentials**:
   ```json
   {
     "type": "form",
     "payload": {
       "username": "user@example.com",
       "password": "***"
     }
   }
   ```

2. **Click "Open" on the tool**

3. **Expected behavior**:
   - Hidden tab opens with login page
   - Form fields are filled automatically
   - Form is submitted
   - Tab becomes visible on success
   - If MFA appears, tab becomes visible with message

### Testing SSO

1. **Configure a tool with SSO credentials**:
   ```json
   {
     "type": "sso",
     "payload": {
       "authStartUrl": "https://app.example.com/sso/start",
       "postLoginUrl": "https://app.example.com/dashboard",
       "provider": "google",
       "autoClick": true
     }
   }
   ```

2. **Click "Open" on the tool**

3. **Expected behavior**:
   - Tab opens with SSO start URL
   - If `autoClick` is true, SSO button is clicked
   - OAuth flow proceeds
   - If account chooser appears, you'll see "Please select an account"
   - On success, lands on post-login URL

### Testing Cookie Injection

1. **Configure a tool with cookie credentials**:
   ```json
   {
     "type": "cookies",
     "payload": {
       "cookies": [
         {
           "name": "session_id",
           "value": "abc123...",
           "domain": ".example.com",
           "path": "/",
           "secure": true,
           "sameSite": "lax"
         }
       ]
     }
   }
   ```

2. **Click "Open" on the tool**

3. **Expected behavior**:
   - Cookies are injected before navigation
   - Tab opens to target URL
   - Page loads in logged-in state

### Debug Mode

1. **Enable debug mode**:
   - Click the profile icon (top right of popup)
   - Toggle "Debug Mode" ON

2. **View logs**:
   - Open Chrome DevTools on any page
   - Go to the "Console" tab
   - Look for logs prefixed with `[Gen Z Digital Store Content]` or `[Orchestrator]`

3. **Check background logs**:
   - Go to `chrome://extensions/`
   - Click "Inspect views: service worker" under Gen Z Digital Store Access
   - View console output

### Common Test Scenarios

| Scenario | Expected Result |
|----------|----------------|
| Tool with valid cookies | Opens directly to dashboard |
| Tool with form credentials | Fills and submits form, lands on dashboard |
| Tool with expired cookies | Falls back to form login if available |
| Multi-step login (Google style) | Fills email, clicks next, fills password, submits |
| MFA required | Tab shows with message "MFA required - please complete manually" |
| Invalid credentials | Error message shown, option to retry |
| Account chooser (SSO) | Message "Please select an account" |

### Troubleshooting

**Login always fails**
1. Enable debug mode and check console logs
2. Verify credentials are correctly formatted in the API
3. Check if the tool's domain has been granted permission

**Form not detected**
1. The form might be inside an iframe (cross-origin won't work)
2. The form might be dynamically loaded - wait a few seconds
3. Custom selectors might be needed in tool config

**SSO stuck on account selection**
1. This is expected - select an account manually
2. The extension will continue monitoring and complete

**Cookies not working**
1. Check cookie domain matches the target
2. Ensure sameSite and secure flags are correct for the site
3. Some sites require specific cookie attributes

## 🔒 Security

- **No secrets in logs** - All passwords, tokens, and cookies are masked
- **Minimal permissions** - Only requests access to domains when needed
- **No external calls** - Only communicates with configured API URL
- **Session isolation** - Each tool's data is kept separate

## 📝 Configuration

### Tool Configuration Schema

```typescript
interface ToolConfig {
  id: string;
  name: string;
  domain: string;
  targetUrl: string;           // Post-login URL
  loginUrl?: string;           // Login page URL (for form/SSO)
  credentialVersion?: number;  // For cache invalidation
  
  // Optional custom selectors
  selectors?: {
    username?: string;
    password?: string;
    submit?: string;
    mfa?: string;
  };
  
  // Optional success check overrides
  successCheck?: {
    urlIncludes?: string;
    urlExcludes?: string;
    urlPattern?: string;       // Regex
    elementExists?: string;    // CSS selector
    elementNotExists?: string; // CSS selector
    cookieNames?: string[];    // Required cookies
    storageKeys?: string[];    // Required storage keys
  };
}
```

### Credential Types

| Type | Description | Required Payload Fields |
|------|-------------|------------------------|
| `cookies` | Session cookies | `cookies` (array) |
| `token` | Bearer/JWT token | `value`, optional `key` |
| `localStorage` | Local storage data | Object with key-value pairs |
| `sessionStorage` | Session storage data | Object with key-value pairs |
| `form` | Login form credentials | `username`, `password` |
| `sso` | OAuth/SSO flow | `authStartUrl`, `postLoginUrl`, optional `provider` |
| `headers` | Custom headers | `headerName`, `value` |

## 📞 Support

For issues or questions, please contact your IT administrator or create an issue in the repository.
