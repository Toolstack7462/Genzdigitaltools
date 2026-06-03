# Gen Z Digital Store — Premium SaaS Platform

Your all-in-one digital tools hub. Access AI, academic, SEO, design, productivity, marketing, and business tools from one secure Gen Z Digital Store membership.

## Project Stack

- **Frontend**: React 19, Tailwind CSS, Shadcn/UI, React Router v7
- **Backend**: Node.js, Express 5, MongoDB (Mongoose), JWT (httpOnly cookies)
- **Chrome Extension**: Manifest v3, multi-strategy auto-login
- **Auth**: Opaque refresh tokens (DB-backed), short-lived access tokens (JWT), device binding

## Color System

| Token             | Value     | Usage                         |
|-------------------|-----------|-------------------------------|
| `genz-navy`       | `#001030` | Primary background            |
| `genz-deep-navy`  | `#000820` | Deep background               |
| `genz-teal`       | `#00AFC1` | Primary brand color / CTAs    |
| `genz-dark-teal`  | `#008EA3` | Secondary teal / hover states |
| `genz-white`      | `#FFFFFF` | Text / card backgrounds       |
| `genz-muted`      | `#8A98A8` | Muted text                    |
| `genz-border`     | `#D9E4EA` | Card / input borders          |

## Authentication Architecture

### Secure Token Flow (Fixed)
1. **Login** → Server generates opaque refresh token (64-byte hex) + JWT access token
2. **Both tokens** set as httpOnly, sameSite=lax cookies (never in response body)
3. **API requests** send access token via cookie (or Authorization header)
4. **Refresh** → Server looks up opaque token in MongoDB (no JWT.verify) + checks expiry/revoked
5. **Logout** → Refresh token revoked in DB, cookies cleared

### Security Features
- ✅ Device binding (prevents account sharing)
- ✅ Rate limiting on login/register endpoints
- ✅ httpOnly cookies (XSS-proof)
- ✅ Token rotation on refresh
- ✅ Token version invalidation (force logout)
- ✅ CORS allowlist via env var
- ✅ Helmet.js security headers
- ✅ Input validation (Joi schemas)

## Local Development

### Backend
```bash
cd backend
cp .env.example .env
# Fill in all required values
npm install
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm start
```

### Chrome Extension
1. Open Chrome → Extensions → Enable Developer Mode
2. Click "Load unpacked" → Select `chrome-extension/` folder

## Deployment

### Production Checklist
- [ ] Set `NODE_ENV=production` in backend `.env`
- [ ] Generate secure JWT secrets (64+ hex chars each)
- [ ] Set `ALLOWED_ORIGINS` to your actual frontend domain
- [ ] Enable MongoDB authentication
- [ ] Use HTTPS (secure cookie flag requires HTTPS)
- [ ] Configure reverse proxy (nginx/caddy) to backend port

### Build Commands
```bash
# Frontend production build
cd frontend && npm run build

# Backend production start
cd backend && npm start
```
