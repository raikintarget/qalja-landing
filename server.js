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

// ── API: Барлық деректер біріктірілген (дашборд үшін) ──
app.get('/api/meta-data', async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN;
  const account_id = process.env.META_AD_ACCOUNT_ID;
  if (!token || !account_id) return res.status(400).json({ error: 'Meta not configured' });

  try {
    const [campaignsRes, insightsRes, accountRes] = await Promise.all([
      axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/campaigns`, {
        params: { access_token: token, fields: 'id,name,status,objective,daily_budget,created_time', limit: 20 }
      }),
      axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/insights`, {
        params: { access_token: token, fields: 'impressions,clicks,spend,cpc,cpm,ctr,actions', date_preset: 'today', level: 'account' }
      }),
      axios.get(`https://graph.facebook.com/v19.0/act_${account_id}`, {
        params: { access_token: token, fields: 'id,name,account_status,currency,amount_spent,balance' }
      })
    ]);

    res.json({
      account: accountRes.data,
      campaigns: campaignsRes.data.data || [],
      insights: insightsRes.data.data?.[0] || {}
    });
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── TELEGRAM БОТ ──
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const chatIds = new Set(); // байланысқан chat_id-лар

async function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
  } catch(e) { console.error('TG send error:', e.message); }
}

async function sendDailyReport(chatId) {
  const token = process.env.META_ACCESS_TOKEN;
  const account_id = process.env.META_AD_ACCOUNT_ID;
  if (!token || !account_id) {
    return tgSend(chatId, '⚠️ Meta Ads әлі байланыстырылмаған.');
  }
  try {
    const [camps, ins] = await Promise.all([
      axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/campaigns`, {
        params: { access_token: token, fields: 'id,name,status', limit: 10 }
      }),
      axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/insights`, {
        params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr', date_preset: 'today', level: 'account' }
      })
    ]);

    const i = ins.data.data?.[0] || {};
    const campaigns = camps.data.data || [];
    const active = campaigns.filter(c => c.status === 'ACTIVE').length;

    const msg = `📊 <b>SmartTarget AI — Күнделікті есеп</b>\n\n` +
      `📅 Бүгін: ${new Date().toLocaleDateString('ru-RU')}\n\n` +
      `💰 Шығын: <b>$${parseFloat(i.spend||0).toFixed(2)}</b>\n` +
      `👆 Клик: <b>${i.clicks||0}</b>\n` +
      `👁 Көрсету: <b>${parseInt(i.impressions||0).toLocaleString()}</b>\n` +
      `💵 CPC: <b>$${parseFloat(i.cpc||0).toFixed(2)}</b>\n` +
      `📈 CTR: <b>${parseFloat(i.ctr||0).toFixed(2)}%</b>\n\n` +
      `📋 Кампаниялар: ${campaigns.length} (${active} активті)\n\n` +
      `🔗 <a href="https://innovative-friendship-production-0449.up.railway.app/ai-targetolog-app.html">Дашбордты ашу →</a>`;

    await tgSend(chatId, msg);
  } catch(e) {
    await tgSend(chatId, '❌ Деректерді алу қатесі: ' + e.message);
  }
}

// Telegram webhook
app.post(`/tg/${TG_TOKEN}`, async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = msg.text || '';

  chatIds.add(chatId);

  if (text === '/start') {
    await tgSend(chatId,
      `👋 <b>SmartTarget AI ботына қош келдіңіз!</b>\n\n` +
      `Мен сіздің Facebook рекламаңыздың нәтижелерін күн сайын жіберіп тұрамын.\n\n` +
      `📊 /report — қазіргі статистика\n` +
      `ℹ️ /status — жүйе күйі\n` +
      `❓ /help — барлық командалар`
    );
  } else if (text === '/report') {
    await tgSend(chatId, '⏳ Деректер жүктелуде...');
    await sendDailyReport(chatId);
  } else if (text === '/status') {
    const token = process.env.META_ACCESS_TOKEN;
    await tgSend(chatId,
      `🟢 <b>SmartTarget AI жұмыс істеп тұр</b>\n\n` +
      `Meta Ads: ${token ? '✅ Байланысты' : '❌ Байланыстырылмаған'}\n` +
      `Сервер: ✅ Онлайн`
    );
  } else if (text === '/help') {
    await tgSend(chatId,
      `📋 <b>Командалар:</b>\n\n` +
      `/start — бастау\n` +
      `/report — бүгінгі статистика\n` +
      `/status — жүйе күйі\n` +
      `/help — көмек`
    );
  } else {
    await tgSend(chatId, `❓ Білмедім. /help деп жазыңыз.`);
  }

  res.sendStatus(200);
});

// Webhook орнату
async function setupWebhook() {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      url: `${BASE_URL}/tg/${TG_TOKEN}`
    });
    console.log('✅ Telegram webhook орнатылды');
  } catch(e) { console.error('Webhook error:', e.message); }
}

// Күн сайын сағат 09:00-де есеп жіберу
function scheduleDailyReport() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    chatIds.forEach(id => sendDailyReport(id));
    setInterval(() => chatIds.forEach(id => sendDailyReport(id)), 24*60*60*1000);
  }, delay);
}

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await setupWebhook();
  scheduleDailyReport();
});
