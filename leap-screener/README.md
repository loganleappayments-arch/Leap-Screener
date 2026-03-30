# Leap Payments — Lead Screener

## Project structure

```
leap-screener/
├── server/
│   ├── index.js          ← Node.js backend (Sugar + Anthropic proxy)
│   ├── package.json
│   └── .env.example      ← Copy to .env and fill in
└── public/
    └── index.html        ← Frontend (deploy alongside or separately)
```

---

## 1. Backend setup

### Install dependencies
```bash
cd server
npm install
```

### Configure environment
```bash
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...       # Your Anthropic API key
SUGAR_URL=https://yourcompany.sugarcrm.com
SUGAR_USER=screener@yourcompany.com
SUGAR_PASS=your-password
PORT=3000
ALLOWED_ORIGIN=https://screener.yourcompany.com
```

> **Tip:** Create a dedicated read-only Sugar user for the screener.
> This way you can revoke access without touching anyone's real account.

### Run the server
```bash
# Production
npm start

# Development (auto-restarts on changes)
npm run dev
```

---

## 2. Sugar CRM — getting an API user

1. Log into Sugar as admin
2. Go to **Admin → User Management → Create User**
3. Set role to **Regular User** (read-only is fine)
4. Note the username + password → add to `.env`

Sugar cloud (sugarcrm.com) uses OAuth password grant on `/rest/v11/oauth2/token`.
The server handles token caching and refresh automatically.

---

## 3. Frontend deployment

### Option A — Same server (simplest)
The backend already serves `public/` as static files.
Just visit `http://yourserver:3000` and it works.

### Option B — Separate hosting (Nginx, Apache, S3, etc.)
Deploy `public/index.html` anywhere.
Set `ALLOWED_ORIGIN` in `.env` to that domain.
The frontend auto-detects same-origin vs cross-origin:
```js
const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : ''; // empty = same origin
```
If hosting separately, change the fallback to your server URL:
```js
  : 'https://api.yourcompany.com'
```

---

## 4. How the Sugar URL import works

Reps paste any of these URL formats — all work:
- `https://yourcompany.sugarcrm.com/index.php?module=Leads&action=DetailView&record=LEAD_ID`
- `https://yourcompany.sugarcrm.com/#Leads/LEAD_ID`

The frontend extracts the lead ID, calls `/api/sugar/lead/:id`,
the server authenticates with Sugar and returns the normalized lead data.
Fields auto-populate with a green "✓ from Sugar" indicator.

---

## 5. Production checklist

- [ ] `.env` is filled in and **not** committed to git (it's in `.gitignore`)
- [ ] `ALLOWED_ORIGIN` is locked to your screener's domain
- [ ] Run behind HTTPS (use nginx reverse proxy + Let's Encrypt)
- [ ] Consider PM2 to keep the server running: `pm2 start index.js --name screener`

### Nginx reverse proxy example
```nginx
server {
    server_name screener.yourcompany.com;

    location / {
        root /var/www/leap-screener/public;
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }

    listen 443 ssl;
    # ... SSL config
}
```

---

## 6. Adding real API checks (v2 upgrade)

When ready to swap in live data sources:

| Check | API | Notes |
|-------|-----|-------|
| Phone validation | [AbstractAPI](https://www.abstractapi.com/phone-validation-api) | ~$0.01/call, free tier available |
| Email validation | [Hunter.io](https://hunter.io/api) | Free tier: 25 searches/mo |
| Domain age | [WhoisXML API](https://whois.whoisxmlapi.com/) | Free tier: 500 queries/mo |
| ScamAdviser | [ScamAdviser API](https://www.scamadviser.com/api) | Paid, contact for pricing |

Add these in `server/index.js` — call them in the `/api/screen` route before
passing results to Claude, then include the real data in the prompt.
