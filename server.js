const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://innovative-friendship-production-0449.up.railway.app';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.use(express.json());
app.use(express.static(__dirname));

// ── PostgreSQL ──
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      chat_id BIGINT PRIMARY KEY,
      name TEXT,
      meta_token TEXT,
      meta_account_id TEXT,
      meta_account_name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS connect_tokens (
      token TEXT PRIMARY KEY,
      chat_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database дайын');
}

async function getClient(chatId) {
  const r = await pool.query('SELECT * FROM clients WHERE chat_id = $1', [chatId]);
  return r.rows[0] || null;
}

async function saveClient(chatId, name, metaToken, accountId, accountName) {
  await pool.query(`
    INSERT INTO clients (chat_id, name, meta_token, meta_account_id, meta_account_name)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chat_id) DO UPDATE SET
      meta_token = $3, meta_account_id = $4, meta_account_name = $5
  `, [chatId, name, metaToken, accountId, accountName]);
}

// ── Telegram хабар жіберу ──
async function tgSend(chatId, text, extra = {}) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML', ...extra
    });
  } catch(e) { console.error('TG error:', e.message); }
}

// ── Meta API деректері (клиент бойынша) ──
async function getMetaData(token, accountId) {
  const [campsRes, insRes, accRes] = await Promise.all([
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/campaigns`, {
      params: { access_token: token, fields: 'id,name,status,objective,daily_budget', limit: 20 }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr', date_preset: 'today', level: 'account' }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}`, {
      params: { access_token: token, fields: 'id,name,currency,amount_spent' }
    })
  ]);
  return {
    campaigns: campsRes.data.data || [],
    insights: insRes.data.data?.[0] || {},
    account: accRes.data
  };
}

// ── Күнделікті есеп ──
async function sendDailyReport(chatId) {
  const client = await getClient(chatId);
  if (!client || !client.meta_token) {
    return tgSend(chatId, '⚠️ Meta Ads байланыстырылмаған.\n/connect деп жазып аккаунтыңызды қосыңыз.');
  }
  try {
    const { campaigns, insights: i, account } = await getMetaData(client.meta_token, client.meta_account_id);
    const active = campaigns.filter(c => c.status === 'ACTIVE').length;
    const msg =
      `📊 <b>SmartTarget AI — Күнделікті есеп</b>\n` +
      `👤 ${client.name || 'Клиент'} · ${account.name}\n\n` +
      `📅 ${new Date().toLocaleDateString('ru-RU')}\n\n` +
      `💰 Шығын: <b>$${parseFloat(i.spend||0).toFixed(2)}</b>\n` +
      `👆 Клик: <b>${i.clicks||0}</b>\n` +
      `👁 Көрсету: <b>${parseInt(i.impressions||0).toLocaleString()}</b>\n` +
      `💵 CPC: <b>$${parseFloat(i.cpc||0).toFixed(2)}</b>\n` +
      `📈 CTR: <b>${parseFloat(i.ctr||0).toFixed(2)}%</b>\n\n` +
      `📋 Кампаниялар: ${campaigns.length} (${active} активті)\n\n` +
      `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашбордты ашу →</a>`;
    await tgSend(chatId, msg);
  } catch(e) {
    await tgSend(chatId, '❌ Қате: ' + e.message);
  }
}

// ── Telegram Webhook ──
app.post(`/tg/${TG_TOKEN}`, async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const userName = msg.from?.first_name || 'Клиент';

  if (text === '/start') {
    await tgSend(chatId,
      `👋 <b>SmartTarget AI ботына қош келдіңіз!</b>\n\n` +
      `Мен сіздің жеке AI-таргетологыңызбын 🤖\n\n` +
      `Бастау үшін Facebook Ads аккаунтыңызды байланыстырыңыз:\n\n` +
      `👉 /connect — аккаунт байланыстыру\n` +
      `📊 /report — статистика\n` +
      `ℹ️ /status — жүйе күйі\n` +
      `❓ /help — барлық командалар`
    );

  } else if (text === '/connect') {
    // Уникальный токен жасап, OAuth сілтемесін береміз
    const linkToken = crypto.randomBytes(16).toString('hex');
    await pool.query(
      'INSERT INTO connect_tokens (token, chat_id) VALUES ($1, $2) ON CONFLICT (token) DO NOTHING',
      [linkToken, chatId]
    );
    const connectUrl = `${BASE_URL}/auth/facebook?tg=${linkToken}`;
    await tgSend(chatId,
      `🔗 <b>Facebook Ads байланыстыру</b>\n\n` +
      `Төмендегі сілтемені басыңыз → Facebook-қа кіріңіз → рұқсат беріңіз:\n\n` +
      `<a href="${connectUrl}">👉 Facebook Ads-ті байланыстыру</a>\n\n` +
      `🔒 Қауіпсіз. Пароліңіз бізге жетпейді.`
    );

  } else if (text === '/report') {
    const client = await getClient(chatId);
    if (!client?.meta_token) {
      return tgSend(chatId, '⚠️ Алдымен аккаунтыңызды байланыстырыңыз: /connect');
    }
    await tgSend(chatId, '⏳ Деректер жүктелуде...');
    await sendDailyReport(chatId);

  } else if (text === '/status') {
    const client = await getClient(chatId);
    await tgSend(chatId,
      `🟢 <b>SmartTarget AI</b>\n\n` +
      `Meta Ads: ${client?.meta_token ? '✅ ' + (client.meta_account_name || 'Байланысты') : '❌ Байланыстырылмаған'}\n` +
      `Сервер: ✅ Онлайн\n\n` +
      `${!client?.meta_token ? '👉 /connect деп жазып байланыстырыңыз' : '📊 /report — статистика алу'}`
    );

  } else if (text === '/help') {
    await tgSend(chatId,
      `📋 <b>Командалар:</b>\n\n` +
      `/connect — Facebook Ads байланыстыру\n` +
      `/report — бүгінгі статистика\n` +
      `/status — байланыс күйі\n` +
      `/help — көмек\n\n` +
      `💬 Сұрақ болса: @smarttarget_support`
    );

  } else {
    await tgSend(chatId, `❓ /help деп жазыңыз — барлық командаларды көресіз.`);
  }

  res.sendStatus(200);
});

// ── OAuth: Facebook Login ──
app.get('/auth/facebook', (req, res) => {
  const tgToken = req.query.tg || '';
  const state = tgToken || crypto.randomBytes(16).toString('hex');
  const scope = 'ads_management,ads_read,business_management';
  const url = `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scope}` +
    `&state=${state}` +
    `&response_type=code`;
  res.redirect(url);
});

// ── OAuth: Callback ──
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/auth.html?error=access_denied');

  try {
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: REDIRECT_URI, code }
    });
    const { access_token } = tokenRes.data;

    const [userRes, adsRes] = await Promise.all([
      axios.get('https://graph.facebook.com/v19.0/me', { params: { access_token, fields: 'id,name' } }),
      axios.get('https://graph.facebook.com/v19.0/me/adaccounts', {
        params: { access_token, fields: 'id,name,account_status', limit: 5 }
      })
    ]);

    const adAccount = adsRes.data.data?.[0];
    const accountId = adAccount?.id?.replace('act_', '');

    // Telegram-дан келген жағдайда — клиентті DB-ге сақта
    const tgRow = await pool.query('SELECT chat_id FROM connect_tokens WHERE token = $1', [state]);
    if (tgRow.rows.length > 0) {
      const chatId = tgRow.rows[0].chat_id;
      await saveClient(chatId, userRes.data.name, access_token, accountId, adAccount?.name);
      await pool.query('DELETE FROM connect_tokens WHERE token = $1', [state]);
      await tgSend(chatId,
        `✅ <b>Facebook Ads байланысты!</b>\n\n` +
        `👤 ${userRes.data.name}\n` +
        `📊 Аккаунт: ${adAccount?.name || accountId}\n\n` +
        `📊 /report деп жазып статистиканы алыңыз!`
      );
      return res.send(`<html><body style="background:#0E0D0B;color:#EBD7A6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:48px">✅</div><h2 style="color:#D9A441">Байланысты!</h2><p>Telegram ботына оралыңыз</p></div></body></html>`);
    }

    // Веб арқылы кірген жағдайда — дашбордқа жіберу
    const payload = encodeURIComponent(JSON.stringify({
      token: access_token, user: userRes.data, adAccounts: adsRes.data.data || []
    }));
    res.redirect(`/ai-targetolog-app.html?meta=${payload}`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/auth.html?error=oauth_failed');
  }
});

// ── API: Дашборд деректері (жалпы System User токенімен) ──
app.get('/api/meta-data', async (req, res) => {
  const token = process.env.META_ACCESS_TOKEN;
  const account_id = process.env.META_AD_ACCOUNT_ID;
  if (!token || !account_id) return res.status(400).json({ error: 'Meta not configured' });
  try {
    const data = await getMetaData(token, account_id);
    res.json(data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── API: Клиент деректері (chat_id бойынша) ──
app.get('/api/client-data', async (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  const client = await getClient(chat_id);
  if (!client?.meta_token) return res.status(404).json({ error: 'Client not found' });
  try {
    const data = await getMetaData(client.meta_token, client.meta_account_id);
    res.json({ ...data, client: { name: client.name, account: client.meta_account_name } });
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ── API: Кампаниялар ──
app.get('/api/campaigns', async (req, res) => {
  const { token, account_id } = req.query;
  if (!token || !account_id) return res.status(400).json({ error: 'Missing params' });
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${account_id}/campaigns`, {
      params: { access_token: token, fields: 'id,name,status,objective,daily_budget,created_time', limit: 20 }
    });
    res.json(r.data);
  } catch (err) { res.status(400).json(err.response?.data || { error: err.message }); }
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
  } catch (err) { res.status(400).json(err.response?.data || { error: err.message }); }
});

// ── Webhook орнату ──
async function setupWebhook() {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      url: `${BASE_URL}/tg/${TG_TOKEN}`
    });
    console.log('✅ Telegram webhook орнатылды');
  } catch(e) { console.error('Webhook error:', e.message); }
}

// ── Күн сайын сағат 09:00 есеп ──
async function scheduleDailyReports() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    const clients = await pool.query('SELECT chat_id FROM clients WHERE meta_token IS NOT NULL');
    for (const row of clients.rows) await sendDailyReport(row.chat_id);
    setInterval(async () => {
      const clients = await pool.query('SELECT chat_id FROM clients WHERE meta_token IS NOT NULL');
      for (const row of clients.rows) await sendDailyReport(row.chat_id);
    }, 24 * 60 * 60 * 1000);
  }, next - now);
}

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await initDB();
  await setupWebhook();
  await scheduleDailyReports();
});
