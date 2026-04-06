/**
 * Leap Payments — Lead Screener Backend // v2
 * 
 * Handles:
 *   1. Sugar CRM OAuth + lead data fetching
 *   2. Anthropic API proxy (fixes browser CORS)
 * 
 * Setup:
 *   npm install
 *   cp .env.example .env   (fill in your values)
 *   node index.js
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.static('../public'));

// ─── Sugar CRM token cache ────────────────────────────────────────────────────
let sugarToken    = null;
let sugarTokenExp = 0;

async function getSugarToken() {
  if (sugarToken && Date.now() < sugarTokenExp) return sugarToken;

  const base = process.env.SUGAR_URL; // e.g. https://yourcompany.sugarcrm.com
  const res  = await fetch(`${base}/rest/v11/oauth2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type:    'password',
      client_id:     'sugar',
      client_secret: '',
      username:      process.env.SUGAR_USER,
      password:      process.env.SUGAR_PASS,
      platform:      'base',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sugar auth failed: ${err}`);
  }

  const data    = await res.json();
  sugarToken    = data.access_token;
  sugarTokenExp = Date.now() + (data.expires_in - 60) * 1000; // 1 min buffer
  return sugarToken;
}

// ─── Route: fetch a lead from Sugar ──────────────────────────────────────────
// GET /api/sugar/lead/:id
app.get('/api/sugar/lead/:id', async (req, res) => {
  try {
    const token = await getSugarToken();
    const base  = process.env.SUGAR_URL;
    const id    = req.params.id;

    const fields = [
      'first_name', 'last_name', 'title',
      'phone_work', 'phone_mobile',
      'email1',
      'company', 'website',
      'primary_address_state',
      'lead_source', 'status', 'description',
      'merchant_name', 'account_name', 'dba_name',
      'primary_address_state_c', 'phone_mobile_c', 'app_website_address_c',
    ].join(',');

    const sugarRes = await fetch(
      `${base}/rest/v11/Leads/${id}?fields=${fields}`,
      { headers: { 'OAuth-Token': token } }
    );

    if (sugarRes.status === 404) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    if (!sugarRes.ok) {
      const err = await sugarRes.text();
      throw new Error(`Sugar fetch failed: ${err}`);
    }

    const lead = await sugarRes.json();

res.json({
  id:        lead.id,
  firstName: lead.first_name  || '',
  lastName:  lead.last_name   || '',
  ownerName: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
  bizName:   lead.account_name || lead.merchant_name || lead.company || '',
  phone:     lead.phone_work  || lead.phone_mobile_c || lead.phone_mobile || '',
  email:     lead.email1      || '',
  website:   lead.app_website_address_c || lead.website || '',
  state:     lead.primary_address_state_c || lead.primary_address_state || '',
});

  } catch (err) {
    console.error('[Sugar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: raw Sugar lead dump (for debugging) ───────────────────────────────
app.get('/api/sugar/lead/:id/raw', async (req, res) => {
  try {
    const token = await getSugarToken();
    const base  = process.env.SUGAR_URL;
    const id    = req.params.id;
    const sugarRes = await fetch(
      `${base}/rest/v11/Leads/${id}`,
      { headers: { 'OAuth-Token': token } }
    );
    const lead = await sugarRes.json();
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Route: Anthropic proxy ───────────────────────────────────────────────────
// POST /api/screen
app.post('/api/screen', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured on server.');

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1500,
        ...req.body,
      }),
    });

    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);

  } catch (err) {
    console.error('[Anthropic]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test-key', (_, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  res.json({ 
    exists: !!key, 
    prefix: key ? key.substring(0, 15) + '...' : 'MISSING'
  });
});


// ─── Route: Brave search ──────────────────────────────────────────────────────
app.get('/api/google-search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) throw new Error('BRAVE_API_KEY not configured on server.');

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&result_filter=web`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      }
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Brave API error');

    const results = (data.web?.results || []).map(item => ({
      title:   item.title,
      url:     item.url,
      snippet: item.description || '',
    }));

    res.json({ results, searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}` });

  } catch (err) {
    console.error('[Brave]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Leap Screener backend running on port ${PORT}`));
