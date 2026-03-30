/**
 * Leap Payments — Lead Screener Backend
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
  ].join(',');

    const sugarRes = await fetch(
      `${base}/rest/v11/Leads/${id}?fields=${fields}`,
      { headers: { 'OAuth-Token': token } }
    );

    if (sugarRes.status === 404) {
      return res.status(404).json({ error: 'Lead not found. Check the URL and try again.' });
    }
    if (!sugarRes.ok) {
      const err = await sugarRes.text();
      throw new Error(`Sugar fetch failed: ${err}`);
    }

const lead = await sugarRes.json();
console.log('Sugar lead fields:', JSON.stringify(lead, null, 2));
    
    // Normalize into a clean shape for the frontend
    res.json({
      id:        lead.id,
      firstName: lead.first_name  || '',
      lastName:  lead.last_name   || '',
      ownerName: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      bizName: lead.account_name || lead.company || lead.merchant_name || lead.dba_name || '',
      phone:     lead.phone_work  || lead.phone_mobile || '',
      email:     lead.email1      || '',
      website:   lead.website     || '',
      state:     lead.primary_address_state || '',
      source:    lead.lead_source || '',
      status:    lead.status      || '',
    });

  } catch (err) {
    console.error('[Sugar]', err.message);
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Leap Screener backend running on port ${PORT}`));
