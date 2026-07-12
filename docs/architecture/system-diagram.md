# System Diagrams (As-Built)

> Mermaid diagrams built only from verified code paths. Node labels reference real files.

---

## 1. Frontend → Backend flow

```mermaid
flowchart LR
  subgraph Browser["Browser (app.genzdigitalstore.com)"]
    Page["Page (pages/**)"]
    Svc["Service (services/*Service.js)"]
    Api["axios (services/api.js)\nbaseURL /api/crm\nwithCredentials"]
    Guard["Guards\nAdminRoute.js / ClientRoute.js"]
    San["Sanitizer\nauthDiagnostics.js"]
    Page --> Svc --> Api
    Guard --> Api
    Api -->|error| San --> Page
  end

  subgraph API["api.genzdigitalstore.com (Passenger)"]
    Cors["CORS + helmet + body limits\nserver-crm.js"]
    Auth["requireAuth / requireAdminAuth / requireClientAuth\nmiddleware/authEnhanced.js"]
    Routes["Routers\nroutes/**"]
    Adapter["mysqlAdapter.js\n(models)"]
    Cors --> Auth --> Routes --> Adapter
  end

  Api -->|HTTPS + cookies| Cors
  Adapter --> DB[("MySQL/MariaDB")]

  Api -. "401 → POST /auth/*/refresh (interceptor)" .-> Cors
```

## 2. Backend → Database flow

```mermaid
flowchart TD
  Route["Route handler\nroutes/**"] --> Model["Model\nmodels/** via createModel()"]
  Model --> AdapterQ["mysqlAdapter query engine\nmatchesQuery / pushdown"]
  AdapterQ -->|"PK or 1 indexed string field"| Push["SQL WHERE (gc_field / id)"]
  AdapterQ -->|"then always"| Refilter["JS re-filter matchesQuery()"]
  Push --> Pool["mysql2 pool\nrunQuery (retry once on dead conn)"]
  Refilter --> Result["docs"]
  Pool --> Tables[("table: id, data(JSON), createdAt, updatedAt\n+ gc_field VIRTUAL indexes")]
  Tables --> Pool
  Pool --> Refilter
  Result --> Route
```

## 3. Authentication flow (client shown; admin identical with admin* cookies)

```mermaid
sequenceDiagram
  participant FE as authService.js
  participant AX as api.js
  participant R as routes/authEnhanced.js
  participant M as middleware/authEnhanced.js
  participant DB as mysqlAdapter (User/RefreshToken/DeviceProfile)

  FE->>AX: POST /auth/client/login (email,password,deviceId, X-Request-Id)
  AX->>R: (authLimiter, normalizeAuthInputs, validate)
  R->>DB: User.find({email: emailMatch, role:/^CLIENT$/i})
  DB-->>R: candidate rows
  R->>R: comparePassword() over candidates (bcrypt)
  alt no match / disabled
    R-->>AX: 401 / 403
    AX-->>FE: error → sanitizeError()
  else valid
    opt devicePolicy.enabled
      R->>DB: DeviceProfile.resolve()
      alt pending / blocked
        R-->>AX: 403 DEVICE_PENDING / DEVICE_BLOCKED
      end
    end
    R->>M: generateTokenPair()
    M->>DB: RefreshToken.create({token: sha256(rawRefresh)})
    R-->>AX: Set-Cookie clientAccessToken(15m) + clientRefreshToken\n{success,user}
    AX-->>FE: cache genz_client_user (display only)
  end

  Note over AX,R: Later, on 401 the interceptor calls\nPOST /auth/client/refresh → handleRefresh()\nrotates: old row revoked + replacedByToken
```

## 4. Gateway & external-service flow (per tool)

```mermaid
flowchart LR
  Client["Client portal\n'Open tool'"] -->|request lease| BE1["backend\nroutes/proxy|stealth/gateway.js\n(issues HS256 lease)"]
  BE1 -->|lease token| Client
  Client -->|/gateway?lease=TOKEN| GW["Gateway server.js\n(native Node proxy)\ncookie pg_lease / sw_lease"]
  GW -->|"Bearer lease → /validate"| BE2["backend /proxy|stealth/gateway/validate"]
  GW -->|"x-gateway-key → /session"| BE3["backend /session\n(returns account cookie bundle)"]
  BE3 --> Vault[("proxy_accounts / stealth_accounts\nAES-256-GCM sessionEncrypted")]
  GW -->|inject cookies server-side + shield + overlay| Upstream["External tool\n(hix.ai / bypassgpt.ai /\nstealthwriter / claude.ai / grok.com / writehuman.ai)"]
  Upstream -->|HTML/asset| GW -->|redacted + overlaid| Client
```

## 5. Production request flow (hosts, roots, proxies)

```mermaid
flowchart TD
  User["Member browser"] -->|https| DNS{"hostname?"}

  DNS -->|"genzdigitalstore.com / www"| MAIN["Main web root\npublic_html (.htaccess)\nmarketing SPA\napp paths → app subdomain"]
  DNS -->|"app.genzdigitalstore.com"| APP["App web root\npublic_html/app (.htaccess)\nportal SPA\nother paths → /client/login"]
  DNS -->|"api.genzdigitalstore.com"| APIP["Passenger: server-crm.js\n/api/crm/**"]
  DNS -->|"*1.genzdigitalstore.com"| GWP["Passenger: gateway server.js\n(per tool, SetEnv secrets)"]

  APP -->|"/api/* left to Passenger"| APIP
  APP -->|"SPA fetch /api/crm/**\n(cross-site, cookies)"| APIP
  APIP --> DB[("MySQL/MariaDB")]
  GWP -->|"/validate, /session (x-gateway-key)"| APIP
  GWP --> EXT["External tool origin"]

  subgraph CI["GitHub Actions"]
    WF["deploy-frontend.yml\nbuild → SFTP mirror → verify"]
  end
  WF -.->|"frontend/build → both roots"| MAIN
  WF -.->|"frontend/build → both roots"| APP
```
