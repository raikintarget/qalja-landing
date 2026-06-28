const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://innovative-friendship-production-0449.up.railway.app';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

app.use(express.json());
app.use(express.static(__dirname));

// ── Facebook OAuth: старт ──
app.get('/auth/facebook', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const scope = 'ads_management,ads_read,business_management';
  const url = `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scope}` +
    `&state=${state}` +
    `&response_type=code`;
  res.redirect(url);
});

// ── Facebook OAuth: callback ──
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/auth.html?error=access_denied');
  }

  try {
    // Кодты токенге айырбастау
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });

    const { access_token } = tokenRes.data;

    // Пайдаланушы мәліметтері
    const userRes = await axios.get('https://graph.facebook.com/v19.0/me', {
      params: { access_token, fields: 'id,name,email' }
    });

    // Рекламалық аккаунттар
    const adsRes = await axios.get('https://graph.facebook.com/v19.0/me/adaccounts', {
      params: {
        access_token,
        fields: 'id,name,account_status,currency,amount_spent'
      }
    });

    const payload = encodeURIComponent(JSON.stringify({
      token: access_token,
      user: userRes.data,
      adAccounts: adsRes.data.data || []
    }));

    res.redirect(`/ai-targetolog-app.html?meta=${payload}`);
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/auth.html?error=oauth_failed');
  }
});

// ── API: Кампаниялар ──
app.get('/api/campaigns', async (req, res) => {
  const { token, account_id } = req.query;
  if (!token || !account_id) return res.status(400).json({ error: 'token and account_id required' });

  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/campaigns`, {
      params: {
        access_token: token,
        fields: 'id,name,status,objective,daily_budget,lifetime_budget,created_time',
        limit: 20
      }
    });
    res.json(r.data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── API: Статистика ──
app.get('/api/insights', async (req, res) => {
  const { token, account_id, date_preset = 'last_7d' } = req.query;
  if (!token || !account_id) return res.status(400).json({ error: 'token and account_id required' });

  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/insights`, {
      params: {
        access_token: token,
        fields: 'impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type',
        date_preset,
        level: 'account'
      }
    });
    res.json(r.data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── API: Кампанияны қосу/тоқтату ──
app.post('/api/campaign/toggle', async (req, res) => {
  const { token, campaign_id, status } = req.body;
  if (!token || !campaign_id || !status) return res.status(400).json({ error: 'Missing params' });

  try {
    const r = await axios.post(`https://graph.facebook.com/v19.0/${campaign_id}`, null, {
      params: { access_token: token, status }
    });
    res.json(r.data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── API: Аккаунт ақпараты ──
app.get('/api/account', async (req, res) => {
  const { token, account_id } = req.query;
  if (!token || !account_id) return res.status(400).json({ error: 'Missing params' });

  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${account_id}`, {
      params: {
        access_token: token,
        fields: 'id,name,account_status,currency,amount_spent,balance,spend_cap'
      }
    });
    res.json(r.data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
});
