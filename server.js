const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const FormData = require('form-data');
const cron = require('node-cron');
let stripe;
try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || ''); } catch(e) { console.log('Stripe not installed'); }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB (видео үшін)

const app = express();
const PORT = process.env.PORT || 3000;

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://innovative-friendship-production-0449.up.railway.app';
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.use(express.json());
app.use(express.static(__dirname, { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));

// ── PostgreSQL ──
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      plan TEXT DEFAULT 'free',
      meta_token TEXT,
      meta_account_id TEXT,
      meta_account_name TEXT,
      tg_chat_id BIGINT,
      settings JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_balance_alert TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_warned_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tg_link_tokens (
      token TEXT PRIMARY KEY,
      tg_chat_id BIGINT,
      user_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      campaign_name TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'new',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Database дайын');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'smarttarget_salt').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getUserBySession(token) {
  const r = await pool.query(
    'SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = $1',
    [token]
  );
  return r.rows[0] || null;
}


// ── Telegram helpers ──
async function tgSend(chatId, text, reply_markup) {
  if (!TG_TOKEN) return;
  try {
    const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, payload);
  } catch(e) { console.error('TG error:', e.message); }
}

async function tgEdit(chatId, messageId, text, reply_markup) {
  if (!TG_TOKEN) return;
  try {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (reply_markup) payload.reply_markup = reply_markup;
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, payload);
  } catch(e) {}
}

async function tgAnswer(callbackId, text = '') {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackId, text
    });
  } catch(e) {}
}

async function tgSendPhoto(chatId, photoUrl, caption) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML'
    });
  } catch(e) { console.error('TG photo error:', e.message); }
}

function mainMenuKbd() {
  return { inline_keyboard: [
    [{ text: '📊 Кешегі есеп', callback_data: 'report_yesterday' }, { text: '📅 Айлық шығын', callback_data: 'report_month' }],
    [{ text: '🤖 AI-ға сұрақ', callback_data: 'ask_question' }, { text: '🎨 Креатив жіберу', callback_data: 'send_creative' }],
    [{ text: '🔄 Статус', callback_data: 'status' }, { text: '👩‍💼 Маманмен байланыс', callback_data: 'contact_specialist' }],
    [{ text: '🗓 Күн бойынша есеп', callback_data: 'report_by_date' }]
  ]};
}

// In-memory user states for multi-step flows
const userStates = {}; // chatId -> { state, data }

async function setupBotCommands() {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
      commands: [
        { command: 'menu', description: '📋 Негізгі мәзір' },
        { command: 'report', description: '📊 Кешегі есеп' },
        { command: 'month', description: '📅 Айлық шығын (YYYY-MM)' },
        { command: 'ask', description: '🤖 AI-ға сұрақ қою' },
        { command: 'status', description: '🔄 Статус тексеру' },
        { command: 'help', description: '❓ Барлық командалар' }
      ]
    });
    console.log('✅ Telegram bot commands орнатылды');
  } catch(e) { console.error('Bot commands error:', e.message); }
}

// ── Meta API ──
// Actions массивінен лид/хат алмасу санын шығару
function extractConversations(actions = []) {
  return parseInt(
    actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value ||
    actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value ||
    actions.find(a => a.action_type === 'onsite_conversion.lead_grouped')?.value || 0
  );
}

async function getMetaData(token, accountId, datePreset = null) {
  const insightPreset = datePreset || 'last_3d';
  const [campsRes, insRes, accRes, adsetsRes, campInsRes, todayInsRes, campTodayRes] = await Promise.all([
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/campaigns`, {
      params: { access_token: token, fields: 'id,name,status,objective,daily_budget', limit: 20 }
    }),
    // Account-level insights
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr,cpm,inline_link_clicks,actions', date_preset: insightPreset, level: 'account' }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}`, {
      params: { access_token: token, fields: 'id,name,currency,amount_spent,balance,account_status,disable_reason,funding_source_details' }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/adsets`, {
      params: { access_token: token, fields: 'id,name,campaign_id,daily_budget,status', limit: 50 }
    }).catch(() => ({ data: { data: [] } })),
    // Campaign-level insights
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: {
        access_token: token,
        fields: 'campaign_id,campaign_name,spend,clicks,impressions,inline_link_clicks,actions',
        date_preset: insightPreset,
        level: 'campaign',
        limit: 50
      }
    }).catch(() => ({ data: { data: [] } })),
    // Account-level insights: TODAY
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr,actions', date_preset: 'today', level: 'account' }
    }).catch(() => ({ data: { data: [] } })),
    // Campaign-level insights: TODAY
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: {
        access_token: token,
        fields: 'campaign_id,campaign_name,spend,clicks,impressions,inline_link_clicks,actions',
        date_preset: 'today',
        level: 'campaign',
        limit: 50
      }
    }).catch(() => ({ data: { data: [] } }))
  ]);

  // Merge adset daily_budget into campaigns
  const adsets = adsetsRes.data.data || [];
  const budgetByCampaign = {};
  for (const as of adsets) {
    if (as.campaign_id && as.daily_budget) {
      budgetByCampaign[as.campaign_id] = (budgetByCampaign[as.campaign_id] || 0) + parseInt(as.daily_budget || 0);
    }
  }

  // Build campaign-level insights map (last 3 days)
  const campInsights = {};
  for (const ci of (campInsRes.data.data || [])) {
    campInsights[ci.campaign_id] = { ...ci, conversations: extractConversations(ci.actions) };
  }

  // Build campaign-level insights map (today)
  const campTodayInsights = {};
  for (const ci of (campTodayRes.data.data || [])) {
    campTodayInsights[ci.campaign_id] = { ...ci, conversations: extractConversations(ci.actions) };
  }

  const campaigns = (campsRes.data.data || []).map(c => ({
    ...c,
    daily_budget: c.daily_budget || budgetByCampaign[c.id] || 0,
    // last_3d data
    spend: parseFloat(campInsights[c.id]?.spend || 0),
    clicks: parseInt(campInsights[c.id]?.clicks || 0),
    impressions: parseInt(campInsights[c.id]?.impressions || 0),
    conversations: campInsights[c.id]?.conversations || 0,
    link_clicks: parseInt(campInsights[c.id]?.inline_link_clicks || 0),
    // today data
    today_spend: parseFloat(campTodayInsights[c.id]?.spend || 0),
    today_clicks: parseInt(campTodayInsights[c.id]?.clicks || 0),
    today_conversations: campTodayInsights[c.id]?.conversations || 0,
  }));

  const accountData = accRes.data;
  // account_status: 1=Active, 2=Disabled, 3=Unsettled, 7=PendingRiskReview, 9=InGracePeriod, 100=PendingClosure, 101=Closed, 201=AnyActiveAdSets, 202=DisabledScimProvisioning
  const accountStatus = accountData.account_status;
  const accountWarning = accountStatus === 2 ? 'DISABLED' :
    accountStatus === 3 ? 'PAYMENT_ERROR' :
    accountStatus === 9 ? 'GRACE_PERIOD' :
    accountStatus === 100 ? 'PENDING_CLOSURE' :
    accountStatus === 101 ? 'CLOSED' : null;

  return {
    campaigns,
    insights: insRes.data.data?.[0] || {},
    todayInsights: todayInsRes.data.data?.[0] || {},
    account: { ...accountData, accountWarning }
  };
}

// ══════════════════════════════
// MULTI-ACCOUNT MONITORING — бірнеше клиент аккаунтын бір жерден бақылау
// ══════════════════════════════
const MONITOR_ACCOUNTS = (process.env.MONITOR_AD_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
const MONITOR_TARGET_CPL = parseFloat(process.env.TARGET_CPL || '2.0');

let monitorCache = { updatedAt: null, accounts: [] };
const monitorAlerted = new Set(); // бір аккаунтқа қайталап alert жібермеу үшін

function monitorStatus(cpl) {
  if (cpl <= 0) return 'good';
  if (cpl > MONITOR_TARGET_CPL * 1.5) return 'danger';
  if (cpl > MONITOR_TARGET_CPL) return 'warning';
  return 'good';
}

// datePreset ('today','yesterday','last_3d',...) НЕМЕСЕ {since,until} (YYYY-MM-DD) қабылдайды
function insightsDateParam({ since, until, datePreset }) {
  if (since && until) return `time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`;
  return `date_preset=${datePreset || 'last_3d'}`;
}

async function fetchAccountsStats(range = {}) {
  if (!MONITOR_ACCOUNTS.length) return { updatedAt: new Date().toISOString(), accounts: [], targetCpl: MONITOR_TARGET_CPL };
  const metaToken = process.env.META_ACCESS_TOKEN;
  const dateParam = insightsDateParam(range);
  console.log(`📊 Мониторинг: ${MONITOR_ACCOUNTS.length} аккаунт тексерілуде (${dateParam})...`);

  // Әр аккаунтқа 3 batch item (аты + account insights + campaign insights) — бәрі 1 HTTP сұрауда
  const batch = [];
  MONITOR_ACCOUNTS.forEach(id => {
    batch.push({ method: 'GET', relative_url: `act_${id}?fields=name` });
    batch.push({ method: 'GET', relative_url: `act_${id}/insights?fields=spend,actions,ctr,cpc,cpm&${dateParam}&level=account` });
    batch.push({ method: 'GET', relative_url: `act_${id}/insights?fields=campaign_id,campaign_name,spend,actions,ctr&level=campaign&${dateParam}&limit=50` });
  });

  const res = await axios.post(
    'https://graph.facebook.com/v19.0/',
    new URLSearchParams({ access_token: metaToken, batch: JSON.stringify(batch) })
  );

  const accounts = MONITOR_ACCOUNTS.map((id, i) => {
    const nameBody = JSON.parse(res.data[i * 3]?.body || '{}');
    const insBody = JSON.parse(res.data[i * 3 + 1]?.body || '{}');
    const campBody = JSON.parse(res.data[i * 3 + 2]?.body || '{}');
    const data = insBody.data?.[0] || {};
    const spend = parseFloat(data.spend || 0);
    const leads = extractConversations(data.actions);
    const cpl = leads > 0 ? parseFloat((spend / leads).toFixed(2)) : 0;

    const campaigns = (campBody.data || []).map(c => {
      const cSpend = parseFloat(c.spend || 0);
      const cLeads = extractConversations(c.actions);
      const cCpl = cLeads > 0 ? parseFloat((cSpend / cLeads).toFixed(2)) : 0;
      return {
        id: c.campaign_id,
        name: c.campaign_name,
        spend: cSpend,
        leads: cLeads,
        cpl: cCpl,
        ctr: parseFloat(c.ctr || 0),
        status: monitorStatus(cCpl),
      };
    }).sort((a, b) => b.spend - a.spend);

    return {
      accountId: `act_${id}`,
      name: nameBody.name || id,
      spend,
      leads,
      cpl,
      ctr: parseFloat(data.ctr || 0),
      cpm: parseFloat(data.cpm || 0),
      status: monitorStatus(cpl),
      campaigns,
    };
  });

  return { updatedAt: new Date().toISOString(), accounts, targetCpl: MONITOR_TARGET_CPL };
}

// Cron/кэш үшін — тұрақты default терезе (last_3d) + Telegram алерт
async function fetchAllAccountsStats() {
  if (!MONITOR_ACCOUNTS.length) return monitorCache;
  try {
    monitorCache = await fetchAccountsStats({ datePreset: 'last_3d' });
    for (const acc of monitorCache.accounts) {
      if (acc.status === 'danger') {
        if (!monitorAlerted.has(acc.accountId) && process.env.ADMIN_TG_CHAT_ID) {
          monitorAlerted.add(acc.accountId);
          await tgSend(process.env.ADMIN_TG_CHAT_ID,
            `🚨 <b>${acc.name}</b> CPL асып кетті: $${acc.cpl} (мақсат $${MONITOR_TARGET_CPL})\nШығын: $${acc.spend.toFixed(2)} · Лид: ${acc.leads}`
          ).catch(() => {});
        }
      } else {
        monitorAlerted.delete(acc.accountId);
      }
    }
  } catch (e) {
    console.error('Monitoring batch error:', e.response?.data || e.message);
  }
  return monitorCache;
}

app.get('/api/monitoring', async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== (process.env.ADMIN_SECRET || 'smarttarget_admin_2026')) return res.status(403).json({ error: 'Forbidden' });

  const { since, until, date_preset } = req.query;
  // Пайдаланушы нақты период таңдаса — сол терезе үшін лайв сұрау (кэшке тиіспей)
  if ((since && until) || date_preset) {
    try {
      const live = await fetchAccountsStats({ since, until, datePreset: date_preset });
      return res.json(live);
    } catch (e) {
      return res.status(502).json({ error: e.response?.data?.error?.message || e.message });
    }
  }

  if (!monitorCache.accounts.length) await fetchAllAccountsStats();
  res.json(monitorCache);
});

// Барлық мониторингтегі аккаунттардың ad-деңгейлі статусы: dead/tired/testing/winning
function creativeStatus(ctr, spend, leads) {
  if (ctr < 0.8) return 'dead';
  if (ctr < 1.5) return 'tired';
  if (spend > 0 && leads === 0) return 'testing';
  return 'winning';
}

app.get('/api/monitoring/creatives', async (req, res) => {
  const secret = req.query.secret || req.headers['x-admin-secret'];
  if (secret !== (process.env.ADMIN_SECRET || 'smarttarget_admin_2026')) return res.status(403).json({ error: 'Forbidden' });
  if (!MONITOR_ACCOUNTS.length) return res.json({ ads: [] });

  const metaToken = process.env.META_ACCESS_TOKEN;
  const dateParam = insightsDateParam({ since: req.query.since, until: req.query.until, datePreset: req.query.date_preset });

  const batch = MONITOR_ACCOUNTS.map(id => ({
    method: 'GET',
    relative_url: `act_${id}/insights?fields=ad_id,ad_name,adset_id,campaign_name,spend,actions,ctr&level=ad&${dateParam}&limit=100`
  }));

  try {
    const bres = await axios.post(
      'https://graph.facebook.com/v19.0/',
      new URLSearchParams({ access_token: metaToken, batch: JSON.stringify(batch) })
    );

    const ads = MONITOR_ACCOUNTS.flatMap((id, i) => {
      const body = JSON.parse(bres.data[i]?.body || '{}');
      return (body.data || []).map(ad => {
        const spend = parseFloat(ad.spend || 0);
        const leads = extractConversations(ad.actions);
        const ctr = parseFloat(ad.ctr || 0);
        return {
          accountId: `act_${id}`,
          adId: ad.ad_id,
          adsetId: ad.adset_id,
          adName: ad.ad_name,
          campaignName: ad.campaign_name,
          spend,
          leads,
          cpl: leads > 0 ? parseFloat((spend / leads).toFixed(2)) : 0,
          ctr,
          status: creativeStatus(ctr, spend, leads),
        };
      });
    }).sort((a, b) => b.spend - a.spend);

    res.json({ ads });
  } catch (e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

if (MONITOR_ACCOUNTS.length) {
  cron.schedule('*/15 * * * *', fetchAllAccountsStats);
} else {
  console.log('⚠️ MONITOR_AD_ACCOUNTS орнатылмаған — /api/monitoring бос қайтарады');
}

// ══════════════════════════════
// AUTH API
// ══════════════════════════════

// Тіркелу
app.post('/api/register', async (req, res) => {
  const { email, name, password, plan } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const hash = hashPassword(password);
    // AI тариф — 2 күн тегін, Expert/Agency — бірден белсенді (қолмен растайды)
    const planName = plan || 'free';
    const trialDays = planName === 'free' || planName === 'ai' ? 2 : 30;
    const expiresAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    const r = await pool.query(
      'INSERT INTO users (email, name, password_hash, plan, plan_expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, plan, plan_expires_at',
      [email.toLowerCase(), name || '', hash, planName, expiresAt]
    );
    const user = r.rows[0];
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    res.json({ token, user });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Бұл email тіркелген' });
    res.status(500).json({ error: e.message });
  }
});

// Кіру
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const hash = hashPassword(password);
    const r = await pool.query(
      'SELECT id, email, name, plan, meta_account_name, tg_chat_id FROM users WHERE email = $1 AND password_hash = $2',
      [email.toLowerCase(), hash]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Email немесе пароль қате' });
    const user = r.rows[0];
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, user.id]);
    res.json({ token, user });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════
// FACEBOOK OAuth — 1 кликпен ad account байланыстыру
// ══════════════════════════════

// Клиент осы route-қа өтеді (state = оның session токені)
app.get('/auth/facebook', (req, res) => {
  const state = req.query.state || '';
  if (!META_APP_ID) return res.status(500).send('META_APP_ID конфигурацияланбаған');
  const scope = 'ads_read,ads_management,business_management,pages_show_list,pages_read_engagement';
  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const failRedirect = `${BASE_URL}/ai-targetolog-onboarding.html?fb_error=1`;
  if (error || !code) return res.redirect(failRedirect);

  try {
    // 1. code -> қысқа мерзімді токен
    const shortRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: REDIRECT_URI, code }
    });
    // 2. қысқа токенді 60 күндік ұзын токенге айырбастау
    const longRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        fb_exchange_token: shortRes.data.access_token
      }
    });
    const longToken = longRes.data.access_token;

    // 3. клиенттің рекламалық аккаунттарын алу
    const accRes = await axios.get('https://graph.facebook.com/v19.0/me/adaccounts', {
      params: { fields: 'id,name,account_status', access_token: longToken }
    });
    const accounts = accRes.data.data || [];

    const user = state ? await getUserBySession(state) : null;
    if (user && accounts.length) {
      const first = accounts[0];
      await pool.query(
        'UPDATE users SET meta_token=$1, meta_account_id=$2, meta_account_name=$3 WHERE id=$4',
        [longToken, first.id.replace('act_', ''), first.name, user.id]
      );
    }
    res.redirect(`${BASE_URL}/ai-targetolog-onboarding.html?fb_connected=1&accounts=${accounts.length}`);
  } catch (e) {
    console.error('auth/callback error:', e.response?.data || e.message);
    res.redirect(failRedirect);
  }
});

// Профиль
app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  res.json({ id: user.id, email: user.email, name: user.name, plan: user.plan,
    is_admin: user.is_admin || false,
    meta_connected: !!user.meta_token, meta_account_name: user.meta_account_name,
    meta_account_id: user.meta_account_id,
    tg_connected: !!user.tg_chat_id,
    settings: user.settings || {} });
});

// Settings сақтау
app.post('/api/settings', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  const { settings } = req.body;
  if (!settings) return res.status(400).json({ error: 'No settings' });
  await pool.query('UPDATE users SET settings=$1 WHERE id=$2', [JSON.stringify(settings), user.id]);
  res.json({ ok: true });
});

// Шығу
app.post('/api/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
});

// Маманмен байланыс (веб-чаттан)
app.post('/api/notify-specialist', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  const clientName = user?.name || 'Белгісіз клиент';
  const clientInfo = user ? `Аккаунт: ${user.meta_account_name || '—'} | Email: ${user.email}` : '';

  // Telegram хабарлама
  const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;
  if (ADMIN_ID) {
    await tgSend(ADMIN_ID,
      `👤 <b>${clientName}</b> маманмен байланысқысы келеді! (веб-платформа)\n\n${clientInfo}`
    );
  }
  res.json({ ok: true });
});

// Meta API: бюджетті масштабировать
app.post('/api/meta/scale-budget', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { campaign_id, factor } = req.body;
  if (!campaign_id || !factor) return res.status(400).json({ error: 'campaign_id and factor required' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const base = 'https://graph.facebook.com/v19.0';
  try {
    const adsetsRes = await axios.get(`${base}/${campaign_id}/adsets`, {
      params: { access_token: metaToken, fields: 'id,name,daily_budget,status', limit: 20 }
    });
    const adsets = adsetsRes.data.data || [];
    if (!adsets.length) return res.status(404).json({ error: 'Адсеттер табылмады' });
    const results = [];
    for (const adset of adsets) {
      const currentBudget = parseInt(adset.daily_budget || 0);
      if (!currentBudget) continue;
      const newBudget = Math.max(100, Math.round(currentBudget * factor));
      await axios.post(`${base}/${adset.id}`, null, {
        params: { access_token: metaToken, daily_budget: newBudget }
      });
      results.push({ name: adset.name, old: (currentBudget/100).toFixed(2), new: (newBudget/100).toFixed(2) });
    }
    res.json({ ok: true, results });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Meta API: адсетке нақты (абсолют) күнделікті бюджет қою — scale-budget факторлық емес, тура сома
app.post('/api/meta/set-budget', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { adset_id, daily_budget } = req.body; // daily_budget — доллармен, мыс: 20
  if (!adset_id || !daily_budget) return res.status(400).json({ error: 'adset_id and daily_budget required' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const base = 'https://graph.facebook.com/v19.0';
  try {
    const cents = Math.max(100, Math.round(parseFloat(daily_budget) * 100));
    await axios.post(`${base}/${adset_id}`, null, {
      params: { access_token: metaToken, daily_budget: cents }
    });
    res.json({ ok: true, adset_id, daily_budget: (cents / 100).toFixed(2) });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Meta API: кампанияны тоқтату / іске қосу
app.post('/api/meta/toggle-campaign', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { campaign_id, status } = req.body;
  if (!campaign_id || !status) return res.status(400).json({ error: 'campaign_id and status required' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${campaign_id}`, null, {
      params: { access_token: metaToken, status }
    });
    res.json({ ok: true, status });
  } catch(e) {
    res.status(400).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// Пароль өзгерту
app.post('/api/change-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Авторизация қажет' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Сессия жоқ' });
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Барлық өрістерді толтырыңыз' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Пароль кемінде 6 таңба' });
  const currentHash = hashPassword(current_password);
  if (currentHash !== user.password_hash) return res.status(400).json({ error: 'Ағымдағы пароль қате' });
  const newHash = hashPassword(new_password);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, user.id]);
  res.json({ ok: true });
});

// ══════════════════════════════
// META API (авторизацияланған)
// ══════════════════════════════

app.get('/api/meta-data', async (req, res) => {
  // Session токені бар болса — клиент деректерін бер
  const sessionToken = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

  let metaToken = process.env.META_ACCESS_TOKEN;
  let accountId = process.env.META_AD_ACCOUNT_ID;

  if (sessionToken) {
    const user = await getUserBySession(sessionToken);
    if (user?.meta_token) {
      metaToken = user.meta_token;
      accountId = user.meta_account_id;
    } else if (user?.meta_account_id) {
      // Клиенттің өз токені жоқ — System User токенімен клиент аккаунтын пайдалан
      accountId = user.meta_account_id;
    }
  }

  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta not configured' });

  const datePreset = req.query.date_preset || null;

  try {
    const data = await getMetaData(metaToken, accountId, datePreset);
    // Баланс тексеру — аз болса клиентке Telegram ескерту
    const balanceCents = parseInt(data.account?.balance || 0);
    if (sessionToken) {
      const userForCheck = await getUserBySession(sessionToken);
      if (userForCheck) checkBalance(userForCheck, balanceCents).catch(console.error);
    }
    res.json(data);
  } catch (err) {
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// ══════════════════════════════
// ПАРТНЕРСКИЙ ДОСТУП
// ══════════════════════════════

// Клиент рекламалық аккаунт ID береді — System User токенімен тексереміз
app.post('/api/connect/partner', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  const { account_id } = req.body; // клиент ads manager URL-ден алған ID: act_XXXXXXXXX немесе тек сандар
  if (!sessionToken || !account_id) return res.status(400).json({ error: 'Missing params' });

  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const sysToken = process.env.META_ACCESS_TOKEN;
  if (!sysToken) return res.status(500).json({ error: 'System token not configured' });

  // act_ префиксін алып тастаймыз, тек санды қалдырамыз
  const cleanId = account_id.replace('act_', '').trim();

  try {
    // System User токенімізбен аккаунтқа кіре аламыз ба — тексер
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${cleanId}`, {
      params: { access_token: sysToken, fields: 'id,name,account_status,currency' }
    });
    const acc = r.data;

    await pool.query(
      'UPDATE users SET meta_token=$1, meta_account_id=$2, meta_account_name=$3 WHERE id=$4',
      [sysToken, cleanId, acc.name, user.id]
    );

    // Telegram хабар
    if (user.tg_chat_id) {
      await tgSend(user.tg_chat_id,
        `✅ <b>Рекламалық аккаунт байланысты!</b>\n📊 ${acc.name}\n\n/report деп жазыңыз!`
      );
    }

    res.json({ ok: true, account: acc.name, account_id: cleanId });
  } catch(e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('connect/partner error:', msg);
    res.status(400).json({ error: 'Доступ жоқ. Партнер рет қосып, аккаунтты тағайындаңыз.' });
  }
});

// ── Facebook жоқ клиент — контактілерін сақта ──
app.post('/api/connect/nofb', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  const { ig_login, wa_phone } = req.body;
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  await pool.query(
    'UPDATE users SET meta_account_name=$1 WHERE id=$2',
    [`NOFB:${ig_login||''}:${wa_phone||''}`, user.id]
  );
  console.log(`📥 Facebook жоқ клиент: ${user.name} | IG: ${ig_login} | WA: ${wa_phone}`);
  res.json({ ok: true });
});

// ══════════════════════════════
// LEADS / CRM API
// ══════════════════════════════

app.get('/api/leads', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const r = await pool.query(
    'SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 300',
    [user.id]
  );
  res.json({ leads: r.rows });
});

app.post('/api/leads', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { name, phone, source, campaign_name, notes, status } = req.body;
  const r = await pool.query(
    'INSERT INTO leads (user_id,name,phone,source,campaign_name,notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [user.id, name||'', phone||'', source||'manual', campaign_name||'', notes||'', status||'new']
  );
  const lead = r.rows[0];
  // Notify admin
  const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;
  if (ADMIN_ID) {
    await tgSend(ADMIN_ID,
      `🔔 <b>Жаңа лид!</b>\n👤 ${lead.name||'—'}\n📱 ${lead.phone||'—'}\n📊 ${lead.campaign_name||'—'}\n💬 ${lead.notes||'—'}\n\n🏢 Клиент: ${user.name}`
    );
  }
  // Notify user via Telegram
  if (user.tg_chat_id) {
    await tgSend(user.tg_chat_id,
      `🔔 <b>Жаңа лид қосылды!</b>\n👤 ${lead.name||'—'}\n📱 ${lead.phone||'—'}\n📊 ${lead.campaign_name||'—'}`,
      mainMenuKbd()
    );
  }
  res.json({ ok: true, lead });
});

app.put('/api/leads/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { status, notes, name, phone, campaign_name } = req.body;
  const r = await pool.query(
    'UPDATE leads SET status=$1,notes=$2,name=$3,phone=$4,campaign_name=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [status, notes||'', name||'', phone||'', campaign_name||'', req.params.id, user.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, lead: r.rows[0] });
});

app.delete('/api/leads/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  await pool.query('DELETE FROM leads WHERE id=$1 AND user_id=$2', [req.params.id, user.id]);
  res.json({ ok: true });
});

// ══════════════════════════════
// БАЛАНС МОНИТОРИНГІ
// ══════════════════════════════

async function checkBalance(user, balanceCents) {
  if (!user?.id || !user?.tg_chat_id) return;
  const LOW_THRESHOLD = parseInt(process.env.LOW_BALANCE_THRESHOLD_CENTS || '3000'); // $30
  if (balanceCents > LOW_THRESHOLD) return;

  // 12 сағатта бір рет ескерту
  const r = await pool.query('SELECT last_balance_alert FROM users WHERE id=$1', [user.id]);
  const lastAlert = r.rows[0]?.last_balance_alert;
  if (lastAlert && (Date.now() - new Date(lastAlert).getTime()) < 12 * 60 * 60 * 1000) return;

  const bal = (balanceCents / 100).toFixed(2);
  const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;

  // Клиентке ескерту + "Толтырғым келеді" батырмасы
  await tgSend(user.tg_chat_id,
    `⚠️ <b>${user.name}, жарнама балансы азайды!</b>\n\n` +
    `💰 Қалды: <b>$${bal}</b>\n\n` +
    `Жарнама тоқтамасын үшін бюджетті толтыру керек.\n` +
    `Төменгі батырманы басыңыз — маман сізге төлем QR-ін жібереді.`,
    { inline_keyboard: [
      [{ text: '💳 Бюджет толтырғым келеді', callback_data: `topup_request_${user.id}` }],
      [{ text: '◀️ Мәзір', callback_data: 'back_menu' }]
    ]}
  );

  // Adminге хабарлама — URL жіберу батырмасымен
  if (ADMIN_ID) {
    await tgSend(ADMIN_ID,
      `⚠️ <b>${user.name}</b> клиентінің балансы аз!\n` +
      `💰 $${bal} қалды · ${user.meta_account_name || user.meta_account_id}\n\n` +
      `Клиентке ескерту жіберілді. Егер төлем сілтемесін жіберу керек болса — «📤 URL жіберу» батырмасын басыңыз.`,
      { inline_keyboard: [[
        { text: '📤 URL жіберу', callback_data: `admin_send_url_${user.tg_chat_id}` }
      ]]}
    );
  }

  await pool.query('UPDATE users SET last_balance_alert=NOW() WHERE id=$1', [user.id]);
}

// ══════════════════════════════
// TELEGRAM БОТ
// ══════════════════════════════

// Shared report-by-date logic
async function sendDateReport(chatId, user, reportDate) {
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id;
  const base = `https://graph.facebook.com/v19.0`;

  const [campInsRes, accInsRes] = await Promise.all([
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'campaign_id,campaign_name,spend,clicks,actions,inline_link_clicks',
        time_range: JSON.stringify({ since: reportDate, until: reportDate }),
        level: 'campaign', limit: 50
      }
    }).catch(() => ({ data: { data: [] } })),
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'spend,clicks,impressions,inline_link_clicks,actions',
        time_range: JSON.stringify({ since: reportDate, until: reportDate }),
        level: 'account'
      }
    }).catch(() => ({ data: { data: [] } }))
  ]);

  const campData = campInsRes.data.data || [];
  const accIns = accInsRes.data.data?.[0] || {};
  const totalSpend = parseFloat(accIns.spend || 0);
  const totalClicks = parseInt(accIns.inline_link_clicks || accIns.clicks || 0);

  const getConv = (actions) => {
    if (!actions) return 0;
    return parseInt(
      actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.lead_grouped')?.value || 0
    );
  };

  const totalConv = getConv(accIns.actions);
  const dateLabel = new Date(reportDate + 'T12:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  let campLines = '';
  if (campData.length) {
    campLines = campData.map(c => {
      const sp = parseFloat(c.spend || 0).toFixed(2);
      const cl = parseInt(c.inline_link_clicks || c.clicks || 0);
      const conv = getConv(c.actions);
      return `  • <b>${c.campaign_name}</b>\n    💸 $${sp} · 👆 ${cl} клик${conv > 0 ? ` · 💬 ${conv} перепис.` : ''}`;
    }).join('\n');
  } else {
    campLines = '  Бұл күні расход жоқ';
  }

  await tgSend(chatId,
    `📊 <b>Есеп · ${dateLabel}</b>\n` +
    `👤 ${user.name} · ${user.meta_account_name || accountId}\n\n` +
    `💸 Жиынтық расход: <b>$${totalSpend.toFixed(2)}</b>\n` +
    `👆 Кликтер: <b>${totalClicks}</b>\n` +
    (totalConv > 0 ? `💬 Хат алмасу: <b>${totalConv}</b>\n` : '') +
    `\n${campLines}\n\n` +
    `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`,
    mainMenuKbd()
  );
}

// Shared monthly report logic
async function sendMonthReport(chatId, user, monthStr) {
  // monthStr: 'YYYY-MM'
  const [year, month] = monthStr.split('-').map(Number);
  const since = `${monthStr}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const until = `${monthStr}-${String(lastDay).padStart(2,'0')}`;
  // Don't go past today
  const todayStr = new Date().toISOString().slice(0,10);
  const untilFinal = until > todayStr ? todayStr : until;

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id;
  const base = `https://graph.facebook.com/v19.0`;

  const [campInsRes, accInsRes] = await Promise.all([
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'campaign_name,spend,clicks,actions,inline_link_clicks',
        time_range: JSON.stringify({ since, until: untilFinal }),
        level: 'campaign', limit: 50
      }
    }).catch(() => ({ data: { data: [] } })),
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'spend,clicks,inline_link_clicks,actions',
        time_range: JSON.stringify({ since, until: untilFinal }),
        level: 'account'
      }
    }).catch(() => ({ data: { data: [] } }))
  ]);

  const campData = campInsRes.data.data || [];
  const accIns = accInsRes.data.data?.[0] || {};
  const totalSpend = parseFloat(accIns.spend || 0);
  const totalClicks = parseInt(accIns.inline_link_clicks || accIns.clicks || 0);

  const getConv = (actions) => {
    if (!actions) return 0;
    return parseInt(
      actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.lead_grouped')?.value || 0
    );
  };
  const totalConv = getConv(accIns.actions);

  const monthLabel = new Date(since + 'T12:00:00Z').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  let campLines = '';
  if (campData.length) {
    campLines = '\n' + campData.map(c => {
      const sp = parseFloat(c.spend || 0).toFixed(2);
      const cl = parseInt(c.inline_link_clicks || c.clicks || 0);
      const conv = getConv(c.actions);
      const cpl = conv > 0 ? '$' + (parseFloat(c.spend||0)/conv).toFixed(2) : '—';
      return `  • <b>${c.campaign_name}</b>\n    💸 $${sp} · 👆 ${cl} · 💬 ${conv} · CPL ${cpl}`;
    }).join('\n');
  }

  await tgSend(chatId,
    `📅 <b>Айлық есеп · ${monthLabel}</b>\n` +
    `👤 ${user.name} · ${user.meta_account_name || accountId}\n\n` +
    `💸 Жалпы расход: <b>$${totalSpend.toFixed(2)}</b>\n` +
    `👆 Кликтер: <b>${totalClicks}</b>\n` +
    (totalConv > 0 ? `💬 Хат алмасу: <b>${totalConv}</b>\n` : '') +
    (totalConv > 0 ? `📉 Орташа CPL: <b>$${(totalSpend/totalConv).toFixed(2)}</b>\n` : '') +
    `\n<b>Кампания бойынша:</b>${campLines || '\n  Деректер жоқ'}\n\n` +
    `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`,
    mainMenuKbd()
  );
}

app.post(`/tg/${TG_TOKEN}`, async (req, res) => {
  const body = req.body;

  // ── Callback query (inline button press) ──
  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;
    const callbackId = cb.id;
    await tgAnswer(callbackId);

    const userRow = await pool.query('SELECT * FROM users WHERE tg_chat_id = $1', [chatId]);
    const user = userRow.rows[0] || null;

    if (!user && data !== 'status') {
      await tgSend(chatId, '⚠️ Алдымен платформаға кіріп Telegram-ды байланыстырыңыз.\n👉 ' + BASE_URL);
      return res.sendStatus(200);
    }

    if (data === 'report_yesterday') {
      if (!user.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты жоқ.');
      await tgSend(chatId, '⏳ Жүктелуде...');
      const d = new Date(); d.setDate(d.getDate() - 1);
      await sendDateReport(chatId, user, d.toISOString().slice(0,10)).catch(e => tgSend(chatId, '❌ ' + e.message));

    } else if (data === 'report_month') {
      const now = new Date();
      const thisMonth = now.toISOString().slice(0,7);
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevMonth = prevDate.toISOString().slice(0,7);
      await tgSend(chatId,
        '📅 <b>Қай айдың есебін алайын?</b>',
        { inline_keyboard: [
          [{ text: '🗓 Осы ай', callback_data: `month_${thisMonth}` }, { text: '⬅️ Өткен ай', callback_data: `month_${prevMonth}` }],
          [{ text: '✏️ Өз айымды енгізу', callback_data: 'month_custom' }],
          [{ text: '◀️ Мәзір', callback_data: 'back_menu' }]
        ]}
      );

    } else if (data.startsWith('month_')) {
      const monthStr = data.replace('month_', '');
      if (monthStr === 'custom') {
        userStates[chatId] = { state: 'waiting_month' };
        await tgSend(chatId, '✏️ Айды енгізіңіз форматта: <b>YYYY-MM</b>\nМысалы: <code>2026-05</code>');
      } else {
        if (!user.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты жоқ.');
        await tgSend(chatId, '⏳ Жүктелуде...');
        await sendMonthReport(chatId, user, monthStr).catch(e => tgSend(chatId, '❌ ' + e.message));
      }

    } else if (data === 'report_by_date') {
      userStates[chatId] = { state: 'waiting_date' };
      await tgSend(chatId,
        '🗓 <b>Күнді енгізіңіз:</b>\n\nФормат: <code>YYYY-MM-DD</code>\nМысалы: <code>2026-06-15</code>',
        { inline_keyboard: [[{ text: '◀️ Мәзір', callback_data: 'back_menu' }]] }
      );

    } else if (data === 'ask_question') {
      userStates[chatId] = { state: 'waiting_question' };
      await tgSend(chatId,
        '🤖 <b>Сұрағыңызды жазыңыз:</b>\n\nMeta Ads, таргетинг, кампания — кез келген тақырыпта сұраңыз.',
        { inline_keyboard: [[{ text: '◀️ Болдырмау', callback_data: 'back_menu' }]] }
      );

    } else if (data === 'send_creative') {
      userStates[chatId] = { state: 'waiting_creative' };
      await tgSend(chatId,
        '🎨 <b>Креативіңізді жіберіңіз:</b>\n\nСуреті немесе видеосы бар хабарлама жіберіңіз. Мен оны сіздің профиліңізге сақтаймын.',
        { inline_keyboard: [[{ text: '◀️ Болдырмау', callback_data: 'back_menu' }]] }
      );

    } else if (data === 'status') {
      const planLabels = { free: 'Тегін', expert: 'Эксперт', agency: 'Агентство' };
      await tgSend(chatId,
        `🟢 <b>SmartTarget AI — Статус</b>\n\n` +
        `👤 Аккаунт: ${user ? '✅ ' + user.name : '❌ Байланыстырылмаған'}\n` +
        `📊 Meta Ads: ${user?.meta_account_id ? '✅ ' + (user.meta_account_name || user.meta_account_id) : '❌ Жоқ'}\n` +
        `💎 Тариф: ${planLabels[user?.plan] || user?.plan || '—'}\n` +
        `🖥 Сервер: ✅ Онлайн`,
        mainMenuKbd()
      );

    } else if (data === 'contact_specialist') {
      const clientName = user?.name || 'Белгісіз';
      const clientInfo = `📊 Аккаунт: ${user?.meta_account_name || '—'}\n💬 Telegram Chat ID: ${chatId}`;
      const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;
      if (ADMIN_ID) {
        await tgSend(ADMIN_ID,
          `👤 <b>${clientName}</b> маманмен байланысқысы келеді!\n\n${clientInfo}\n🔗 Telegram: tg://user?id=${chatId}`
        );
      }
      await tgSend(chatId,
        `✅ <b>Хабарлама жіберілді!</b>\n\nМаман жақын арада сізге жазады.`,
        mainMenuKbd()
      );

    } else if (data.startsWith('topup_request_')) {
      // Клиент бюджет толтырғысы келеді
      const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;
      if (ADMIN_ID) {
        await tgSend(ADMIN_ID,
          `💳 <b>${user?.name || chatId} бюджет толтырғысы келеді!</b>\n\n` +
          `📊 Аккаунт: ${user?.meta_account_name || user?.meta_account_id || '—'}\n\n` +
          `Meta → Billing → Добавить средства → Kaspi → сілтемені алыңыз да «📤 URL жіберу» батырмасын басыңыз.`,
          { inline_keyboard: [[
            { text: '📤 URL жіберу', callback_data: `admin_send_url_${chatId}` }
          ]]}
        );
      }
      await tgSend(chatId,
        `✅ <b>Сұрауыңыз жіберілді!</b>\n\nМаман Meta-дан төлем сілтемесін алып, жақын арада жібереді.\n\n` +
        `💡 <b>Кеңес:</b> Бюджет салмас бұрын картаңызға лимит қойыңыз — мысалы $50 немесе $100. Сонда Meta одан артық ала алмайды.`,
        mainMenuKbd()
      );

    } else if (data.startsWith('admin_send_url_')) {
      // Admin URL жіберуге дайын
      const clientChatId = data.replace('admin_send_url_', '');
      userStates[chatId] = { state: 'waiting_topup_url', clientChatId };
      await tgSend(chatId,
        `📤 <b>Alipay+ сілтемесін жіберіңіз:</b>\n\nMeta-дан алған төлем URL-ін осы жерге жіберіңіз — бот клиентке автоматты жеткізеді.`,
        { inline_keyboard: [[{ text: '❌ Болдырмау', callback_data: 'back_menu' }]] }
      );

    } else if (data.startsWith('confirm_payment_')) {
      // Тек админ
      if (String(chatId) !== String(ADMIN_TG_CHAT_ID)) { await tgAnswer(callbackId, '❌'); return res.sendStatus(200); }
      const parts = data.replace('confirm_payment_', '').split('_');
      const userId = parts[0];
      const clientChatId = parts[1];
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const confirmed = await pool.query(
        "UPDATE users SET plan = CASE WHEN plan = 'suspended' OR plan = 'free' THEN 'ai' ELSE plan END, plan_expires_at = $1, payment_warned_at = NULL WHERE id = $2 RETURNING *",
        [newExpiry, userId]
      );
      const cu = confirmed.rows[0];
      await tgAnswer(callbackId, '✅ Доступ ашылды');
      await tgSend(chatId, `✅ <b>${cu?.name || cu?.email}</b> — төлем расталды, доступ 30 күнге ашылды.`);
      // Клиентке онбординг хабарламасы
      if (clientChatId) {
        await tgSend(clientChatId,
          `✅ <b>Төлемді растадық! Доступ ашылды.</b>\n\n` +
          `🚀 Енді SmartTarget AI платформасын пайдалана аласыз!\n\n` +
          `Келесі қадамдар:\n` +
          `1️⃣ Платформаға кіріңіз\n` +
          `2️⃣ ⚙️ Настройки → Meta Ads аккаунтыңызды жалғаңыз\n` +
          `3️⃣ Телеграмды платформамен байланыстырыңыз\n` +
          `4️⃣ Бірінші кампанияны жасаңыз — AI өзі оңтайландырады!\n\n` +
          `Сұрақ болса — маманмен байланысыңыз.`,
          { inline_keyboard: [[
            { text: '🚀 Платформаға кіру', url: process.env.APP_URL || 'https://smarttarget.up.railway.app' },
            { text: '👩‍💼 Маман', url: `https://t.me/${process.env.ADMIN_TG_USERNAME || 'smarttarget_support'}` }
          ]]}
        );
      }

    } else if (data.startsWith('reject_payment_')) {
      if (String(chatId) !== String(ADMIN_TG_CHAT_ID)) { await tgAnswer(callbackId, '❌'); return res.sendStatus(200); }
      const clientChatId = data.replace('reject_payment_', '');
      await tgAnswer(callbackId, '❌ Қабылданбады');
      await tgSend(chatId, `❌ Төлем қабылданбады.`);
      if (clientChatId) {
        await tgSend(clientChatId,
          `❌ <b>Төлемді растай алмадық.</b>\n\nЧекті қайта жіберіңіз немесе маманмен байланысыңыз.`,
          { inline_keyboard: [[{ text: '👩‍💼 Маманмен байланыс', url: `https://t.me/${process.env.ADMIN_TG_USERNAME || 'smarttarget_support'}` }]] }
        );
      }

    } else if (data.startsWith('restore_sub_')) {
      // Тек админ қолдана алады
      if (String(chatId) !== String(ADMIN_TG_CHAT_ID)) {
        await tgAnswer(callbackId, '❌ Тек админ');
        return res.sendStatus(200);
      }
      const userId = data.replace('restore_sub_', '');
      // 30 күнге жаңарту
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const restored = await pool.query(
        "UPDATE users SET plan = 'ai', plan_expires_at = $1, payment_warned_at = NULL WHERE id = $2 RETURNING *",
        [newExpiry, userId]
      );
      const restoredUser = restored.rows[0];
      await tgAnswer(callbackId, '✅ Қалпына келтірілді');
      await tgSend(chatId, `✅ <b>${restoredUser?.name || restoredUser?.email}</b> — жазылым 30 күнге жаңартылды.`);
      // Клиентке хабарлама
      if (restoredUser?.tg_chat_id) {
        await tgSend(restoredUser.tg_chat_id,
          `✅ <b>Жазылымыңыз қалпына келтірілді!</b>\n\nТөлемді растадық. Рекламаларыңыз іске қосылады.\n\n🚀 SmartTarget AI жұмысын жалғастырды!`,
          mainMenuKbd()
        );
      }

    } else if (data === 'back_menu') {
      delete userStates[chatId];
      await tgSend(chatId,
        `📋 <b>SmartTarget AI — Мәзір</b>\n\n👤 ${user?.name || ''}`,
        mainMenuKbd()
      );
    }

    return res.sendStatus(200);
  }

  // ── Regular message ──
  const msg = body.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const photo = msg.photo;
  const video = msg.video;
  const document = msg.document;

  const userRow = await pool.query('SELECT * FROM users WHERE tg_chat_id = $1', [chatId]);
  const user = userRow.rows[0] || null;

  // ── State machine for multi-step flows ──
  const state = userStates[chatId]?.state;

  // Admin төлем URL-ін жіберді → клиентке жеткіз
  if (state === 'waiting_topup_url' && text && !text.startsWith('/')) {
    const clientChatId = userStates[chatId]?.clientChatId;
    delete userStates[chatId];
    if (clientChatId) {
      await tgSend(clientChatId,
        `💳 <b>Бюджет толтыру сілтемесі дайын!</b>\n\n` +
        `Төменгі сілтемені басып, Kaspi арқылы төлеңіз:\n\n` +
        `🔗 ${text}\n\n` +
        `⚠️ Сілтеме 9 минутта жарамсыз болады — тез төлеңіз!`
      );
      await tgSend(chatId, `✅ Сілтеме клиентке жіберілді!`, mainMenuKbd());
    } else {
      await tgSend(chatId, `❌ Клиент табылмады.`, mainMenuKbd());
    }
    return res.sendStatus(200);
  }

  if (state === 'waiting_question' && text && !text.startsWith('/')) {
    delete userStates[chatId];
    await tgSend(chatId, '⏳ AI жауап дайындауда...');
    try {
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) throw new Error('AI кілті орнатылмаған');
      const campCtx = user?.meta_account_id ? ` Клиент: ${user.name}, аккаунт: ${user.meta_account_name || user.meta_account_id}.` : '';
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: `Сен SmartTarget AI — Meta Ads маманысың. Қысқаша, нақты жауап бер. Telegram форматы — HTML тегтерін қолданба.${campCtx}`,
        messages: [{ role: 'user', content: text }]
      }, {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
      });
      const answer = r.data.content[0].text;
      await tgSend(chatId, `🤖 <b>AI жауабы:</b>\n\n${answer}`, mainMenuKbd());
    } catch(e) {
      await tgSend(chatId, '❌ AI қатесі: ' + e.message, mainMenuKbd());
    }
    return res.sendStatus(200);
  }

  if (state === 'waiting_date' && text && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    delete userStates[chatId];
    if (!user?.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты жоқ.').then(() => res.sendStatus(200));
    await tgSend(chatId, `⏳ ${text} деректер жүктелуде...`);
    await sendDateReport(chatId, user, text).catch(e => tgSend(chatId, '❌ ' + e.message));
    return res.sendStatus(200);
  }

  if (state === 'waiting_month' && text && /^\d{4}-\d{2}$/.test(text)) {
    delete userStates[chatId];
    if (!user?.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты жоқ.').then(() => res.sendStatus(200));
    await tgSend(chatId, `⏳ ${text} айының деректері жүктелуде...`);
    await sendMonthReport(chatId, user, text).catch(e => tgSend(chatId, '❌ ' + e.message));
    return res.sendStatus(200);
  }

  // Клиент төлем чегін жіберді (фото немесе документ)
  const ADMIN_TG_ID = process.env.ADMIN_TG_CHAT_ID;
  if (!state && (photo || document) && String(chatId) !== String(ADMIN_TG_ID)) {
    if (ADMIN_TG_ID) {
      const clientInfo = user
        ? `👤 Клиент: <b>${user.name || user.email || chatId}</b>\n📋 Тариф: ${user.plan || '—'}\n🆔 User ID: ${user.id}`
        : `👤 Telegram ID: <b>${chatId}</b> (платформада тіркелмеген)`;
      await tgSend(ADMIN_TG_ID,
        `💳 <b>Төлем чегі келді!</b>\n\n${clientInfo}\n\nЧекті тексеріп, төлемді растаңыз:`,
        { inline_keyboard: [[
          { text: '✅ Төленді — доступ ашу', callback_data: `confirm_payment_${user?.id || 0}_${chatId}` },
          { text: '❌ Қабылдамау', callback_data: `reject_payment_${chatId}` }
        ]]}
      );
      try {
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/forwardMessage`, {
          chat_id: ADMIN_TG_ID, from_chat_id: chatId, message_id: msg.message_id
        });
      } catch(e) {}
    }
    await tgSend(chatId, `✅ <b>Чегіңіз қабылданды!</b>\n\nМенеджер тексеріп, доступты ашады. Жақын арада хабарлаймыз.`);
    return res.sendStatus(200);
  }

  if (state === 'waiting_creative' && (photo || video || document)) {
    delete userStates[chatId];
    const type = photo ? 'сурет' : video ? 'видео' : 'файл';
    const ADMIN_ID = process.env.ADMIN_TG_CHAT_ID;
    if (ADMIN_ID) {
      // Forward to admin with context
      await tgSend(ADMIN_ID, `🎨 <b>Жаңа креатив</b>\n👤 ${user?.name || chatId} клиенттен ${type} жіберді.`);
      try {
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/forwardMessage`, {
          chat_id: ADMIN_ID, from_chat_id: chatId, message_id: msg.message_id
        });
      } catch(e) {}
    }
    await tgSend(chatId,
      `✅ <b>Креативіңіз қабылданды!</b>\n\nМенеджер қарайды және дайын болғанда хабарлайды.`,
      mainMenuKbd()
    );
    return res.sendStatus(200);
  }

  // ── Commands ──
  if (text.startsWith('/start')) {
    const startCode = text.split(' ')[1]?.trim().toUpperCase();

    if (startCode) {
      const linkRow = await pool.query('SELECT * FROM tg_link_tokens WHERE token = $1', [startCode]);
      if (linkRow.rows.length) {
        const userId = linkRow.rows[0].user_id;
        await pool.query('UPDATE users SET tg_chat_id = $1 WHERE id = $2', [chatId, userId]);
        await pool.query('DELETE FROM tg_link_tokens WHERE token = $1', [startCode]);
        const linkedUser = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
        await tgSend(chatId,
          `✅ <b>Байланысты!</b>\n\n` +
          `👤 ${linkedUser.rows[0]?.name || 'Клиент'}\n\n` +
          `Енді күн сайын рекламаңыздың нәтижесін жіберіп тұрамын.`,
          mainMenuKbd()
        );
        return res.sendStatus(200);
      }
    }

    await tgSend(chatId,
      `👋 <b>SmartTarget AI</b>\n\n` +
      `Мен сіздің AI-таргетологыңызбын. Күн сайын рекламаңыздың нәтижесін жіберіп тұрамын.\n\n` +
      `Платформаға кіріп, Telegram-ды байланыстырыңыз:\n` +
      `👉 <a href="${BASE_URL}/ai-targetolog-app.html">SmartTarget AI →</a>`
    );

  } else if (text.startsWith('/link ')) {
    const code = text.replace('/link ', '').trim().toUpperCase();
    const linkRow = await pool.query('SELECT * FROM tg_link_tokens WHERE token = $1', [code]);
    if (!linkRow.rows.length) {
      return tgSend(chatId, '❌ Код дұрыс емес немесе мерзімі өткен. Платформадан жаңа код алыңыз.');
    }
    const userId = linkRow.rows[0].user_id;
    await pool.query('UPDATE users SET tg_chat_id = $1 WHERE id = $2', [chatId, userId]);
    await pool.query('DELETE FROM tg_link_tokens WHERE token = $1', [code]);
    const linkedUser = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
    await tgSend(chatId,
      `✅ <b>Байланысты!</b>\n\n👤 ${linkedUser.rows[0]?.name || 'Клиент'}`,
      mainMenuKbd()
    );

  } else if (text === '/menu') {
    await tgSend(chatId,
      `📋 <b>SmartTarget AI — Мәзір</b>\n\n👤 ${user?.name || 'Қош келдіңіз!'}`,
      mainMenuKbd()
    );

  } else if (text === '/report' || text.startsWith('/report ')) {
    if (!user) return tgSend(chatId, '⚠️ Алдымен платформаға кіріп Telegram-ды байланыстырыңыз.');
    if (!user.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты байланыстырылмаған.');
    const datePart = text.replace('/report', '').trim();
    let reportDate;
    if (datePart && /^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      reportDate = datePart;
    } else {
      const d = new Date(); d.setDate(d.getDate() - 1);
      reportDate = d.toISOString().slice(0,10);
    }
    await tgSend(chatId, `⏳ ${reportDate} деректер жүктелуде...`);
    await sendDateReport(chatId, user, reportDate).catch(e => tgSend(chatId, '❌ ' + e.message));

  } else if (text === '/month' || text.startsWith('/month ')) {
    if (!user) return tgSend(chatId, '⚠️ Алдымен платформаға кіріп Telegram-ды байланыстырыңыз.');
    if (!user.meta_account_id) return tgSend(chatId, '⚠️ Meta Ads аккаунты байланыстырылмаған.');
    const mPart = text.replace('/month', '').trim();
    const monthStr = (mPart && /^\d{4}-\d{2}$/.test(mPart)) ? mPart : new Date().toISOString().slice(0,7);
    await tgSend(chatId, `⏳ ${monthStr} айының деректері жүктелуде...`);
    await sendMonthReport(chatId, user, monthStr).catch(e => tgSend(chatId, '❌ ' + e.message));

  } else if (text === '/ask') {
    userStates[chatId] = { state: 'waiting_question' };
    await tgSend(chatId, '🤖 Сұрағыңызды жазыңыз:',
      { inline_keyboard: [[{ text: '◀️ Болдырмау', callback_data: 'back_menu' }]] }
    );

  } else if (text === '/status') {
    const planLabels = { free: 'Тегін', expert: 'Эксперт', agency: 'Агентство' };
    await tgSend(chatId,
      `🟢 <b>SmartTarget AI</b>\n\n` +
      `👤 Аккаунт: ${user ? '✅ ' + user.name : '❌ Байланыстырылмаған'}\n` +
      `📊 Meta Ads: ${user?.meta_account_id ? '✅ ' + (user.meta_account_name || user.meta_account_id) : '❌ Жоқ'}\n` +
      `💎 Тариф: ${planLabels[user?.plan] || user?.plan || '—'}\n` +
      `🖥 Сервер: ✅ Онлайн`,
      mainMenuKbd()
    );

  } else if (text === '/help') {
    await tgSend(chatId,
      `📋 <b>Командалар:</b>\n\n` +
      `/menu — негізгі мәзір\n` +
      `/report — кешегі есеп\n` +
      `/report 2026-06-27 — белгілі күн\n` +
      `/month — осы айдың шығыны\n` +
      `/month 2026-05 — белгілі ай\n` +
      `/ask — AI-ға сұрақ\n` +
      `/status — байланыс күйі\n` +
      `/link КОД — платформамен байланыстыру`
    );

  } else if (text && !text.startsWith('/')) {
    // Unknown text — show menu
    await tgSend(chatId,
      `❓ Мәзірден таңдаңыз немесе /ask деп жазып AI-ға сұрақ қойыңыз.`,
      mainMenuKbd()
    );
  } else {
    await tgSend(chatId, `❓ /menu деп жазыңыз немесе /help — барлық командалар.`);
  }

  res.sendStatus(200);
});

// ── API: Claude AI proxy (клиент ключті білмейді) ──
app.post('/api/ai', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'AI not configured' });

  const { messages, system, model = 'claude-sonnet-4-6', max_tokens = 800 } = req.body;
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model, max_tokens, system, messages
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 120000
    });
    res.json({ text: r.data.content[0].text });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.code || e.message || 'Anthropic API error';
    res.status(502).json({ error: msg });
  }
});

// ── API: Creative Image Generation (OpenAI DALL-E 3) ──
app.post('/api/creative/image', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OpenAI API key not configured. Add OPENAI_API_KEY to env.' });

  const { prompt, aspect = '9:16' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  // Map aspect ratio to DALL-E 3 sizes
  const sizeMap = { '1:1': '1024x1024', '4:5': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024' };
  const size = sizeMap[aspect] || '1024x1792';

  try {
    const r = await axios.post('https://api.openai.com/v1/images/generations', {
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality: 'hd'
    }, {
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
    const imageUrl = r.data.data[0].url;
    const revisedPrompt = r.data.data[0].revised_prompt;
    res.json({ url: imageUrl, revised_prompt: revisedPrompt });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(502).json({ error: msg });
  }
});

// ── API: Meta кампания дублдеу ──
app.post('/api/meta/duplicate-campaign', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id || process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta аккаунт қосылмаған' });

  const { campaign_id, new_name } = req.body;
  if (!campaign_id) return res.status(400).json({ error: 'campaign_id міндетті' });

  try {
    // Meta /copies — deep_copy=true: кампания + adsets + ads толық көшіреді
    // ВАЖНО: deep_copy и status_option должны быть в POST body, не в query params
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${campaign_id}/copies`,
      {
        access_token: metaToken,
        deep_copy: true,
        status_option: 'PAUSED'
      },
      { timeout: 30000 }
    );
    console.log('duplicate OK:', JSON.stringify(r.data));
    const newId = r.data.copied_campaign_id || r.data.id || (r.data.data && r.data.data[0]?.id);
    res.json({ ok: true, new_campaign_id: newId });
  } catch (e) {
    const errData = e.response?.data?.error || {};
    const msg = errData.message || e.message;
    console.error('duplicate-campaign error:', msg, JSON.stringify(errData));
    res.status(502).json({ error: msg });
  }
});

// ── API: Кампанияның адсеттері мен объявлениелерін алу ──
app.get('/api/meta/campaign-details/:campaignId', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const { campaignId } = req.params;
  const base = 'https://graph.facebook.com/v19.0';
  try {
    const adsetsRes = await axios.get(`${base}/${campaignId}/adsets`, {
      params: { access_token: metaToken, fields: 'id,name,daily_budget,status,lifetime_budget', limit: 30 }
    });
    const adsets = adsetsRes.data.data || [];
    const result = [];
    for (const adset of adsets) {
      const adsRes = await axios.get(`${base}/${adset.id}/ads`, {
        params: { access_token: metaToken, fields: 'id,name,status,insights{spend,cpm,ctr,actions}', limit: 30 }
      });
      const ads = (adsRes.data.data || []).map(ad => ({
        ...ad,
        leads: extractConversations(ad.insights?.data?.[0]?.actions),
      }));
      result.push({ ...adset, ads });
    }
    res.json({ ok: true, adsets: result });
  } catch(e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── API: Адсет дубльдеу (басқа кампанияға) ──
app.post('/api/meta/duplicate-adset', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const { adset_id, campaign_id, new_name } = req.body;
  if (!adset_id) return res.status(400).json({ error: 'adset_id міндетті' });
  const base = 'https://graph.facebook.com/v19.0';
  try {
    const body = { access_token: metaToken, status_option: 'PAUSED' };
    if (campaign_id) body.campaign_id = campaign_id;
    if (new_name) body.rename_options = JSON.stringify({ rename_suffix: '', rename_prefix: '' });
    const r = await axios.post(`${base}/${adset_id}/copies`, body, { timeout: 30000 });
    res.json({ ok: true, new_adset_id: r.data.copied_adset_id || r.data.id });
  } catch(e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── API: Объявление дубльдеу (басқа адсетке) ──
app.post('/api/meta/duplicate-ad', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const { ad_id, adset_id } = req.body;
  if (!ad_id) return res.status(400).json({ error: 'ad_id міндетті' });
  const base = 'https://graph.facebook.com/v19.0';
  try {
    const body = { access_token: metaToken, status_option: 'PAUSED' };
    if (adset_id) body.adset_id = adset_id;
    const r = await axios.post(`${base}/${ad_id}/copies`, body, { timeout: 30000 });
    res.json({ ok: true, new_ad_id: r.data.copied_ad_id || r.data.id });
  } catch(e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── API: Ad Creative ауыстыру (публикация) ──
app.post('/api/meta/update-ad-creative', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const { ad_id, post_id, page_id } = req.body;
  if (!ad_id || !post_id) return res.status(400).json({ error: 'ad_id және post_id міндетті' });
  const base = 'https://graph.facebook.com/v19.0';
  try {
    // Жаңа creative жасау
    const creativeBody = {
      object_story_id: post_id,
      access_token: metaToken
    };
    const crR = await axios.post(`${base}/act_${user.meta_account_id || process.env.META_AD_ACCOUNT_ID}/adcreatives`, creativeBody, { timeout: 20000 });
    const creativeId = crR.data.id;
    // Ad-ді жаңарту
    await axios.post(`${base}/${ad_id}`, { creative: { creative_id: creativeId }, access_token: metaToken }, { timeout: 20000 });
    res.json({ ok: true });
  } catch(e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── API: Объявление / Адсет өшіру / қосу ──
app.post('/api/meta/toggle-ad', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = token ? await getUserBySession(token) : null;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const { id, type = 'ad', status } = req.body; // type: 'ad' | 'adset'
  if (!id || !status) return res.status(400).json({ error: 'id және status міндетті' });
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${id}`, null, {
      params: { access_token: metaToken, status }
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(502).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── API: Беттің соңғы публикациялары (Reels, фото, видео) ──
app.get('/api/meta/page-posts', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  if (!metaToken) return res.status(400).json({ error: 'Meta токен жоқ' });

  // page_id — клиент баптауларынан немесе query-дан
  let userSettings = user.settings || {};
  if (typeof userSettings === 'string') { try { userSettings = JSON.parse(userSettings); } catch(e) { userSettings = {}; } }
  const pageId = req.query.page_id || userSettings.pageId || userSettings.page_id || process.env.META_PAGE_ID;
  console.log('page-posts: pageId=', pageId, 'userSettings.pageId=', userSettings.pageId);

  const accountId = user.meta_account_id || process.env.META_AD_ACCOUNT_ID;
  if (!accountId) return res.status(400).json({ error: 'Meta аккаунт ID жоқ' });

  try {
    if (!pageId) return res.json({ posts: [], error: 'Page ID табылмады. Баптауларда Facebook Page ID енгізіңіз.' });
    // promotable_posts — page-тан, ads_management токенімен жұмыс істейді
    const promoRes = await axios.get(`https://graph.facebook.com/v19.0/${pageId}/promotable_posts`, {
      params: {
        access_token: metaToken,
        fields: 'id,message,story,created_time,full_picture,attachments{media_type,type}',
        limit: 40,
        is_published: true
      }
    });

    const posts = (promoRes.data?.data || []).map(p => ({
      id: p.id,
      message: p.message || p.story || '',
      created_time: p.created_time,
      picture: p.full_picture || null,
      media_type: p.attachments?.data?.[0]?.media_type || 'photo',
      type: p.attachments?.data?.[0]?.type || 'photo'
    }));

    console.log('page-posts: found', posts.length, 'promotable posts');
    res.json({ posts, page_id: pageId });
  } catch(e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('page-posts error:', msg, JSON.stringify(e.response?.data?.error||{}));
    res.status(502).json({ error: msg });
  }
});

// ── API: Meta кампания жасау ──
app.post('/api/meta/create-campaign', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id || process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta аккаунт қосылмаған' });

  let { name, objective = 'OUTCOME_ENGAGEMENT', daily_budget, dest, wa_phone, page_id, ig_account_id, geo_cities, age_min = 18, age_max = 65, gender = 0, ad_text, ad_headline, image_hash, video_id, wa_template, geo, post_id } = req.body;

  if (!name) return res.status(400).json({ error: 'Кампания атауы (name) міндетті' });

  // Objective нормализация — кез-келген форматты OUTCOME_* форматқа аудар
  const VALID_OBJECTIVES = new Set([
    'OUTCOME_AWARENESS','OUTCOME_ENGAGEMENT','OUTCOME_LEADS',
    'OUTCOME_SALES','OUTCOME_TRAFFIC','OUTCOME_APP_PROMOTION'
  ]);
  const OBJECTIVE_MAP = {
    'MESSAGES':'OUTCOME_ENGAGEMENT','POST_ENGAGEMENT':'OUTCOME_ENGAGEMENT',
    'PAGE_LIKES':'OUTCOME_ENGAGEMENT','EVENT_RESPONSES':'OUTCOME_ENGAGEMENT',
    'VIDEO_VIEWS':'OUTCOME_ENGAGEMENT','OFFER_CLAIMS':'OUTCOME_SALES',
    'CONVERSIONS':'OUTCOME_SALES','PRODUCT_CATALOG_SALES':'OUTCOME_SALES',
    'LEAD_GENERATION':'OUTCOME_LEADS','LEADS':'OUTCOME_LEADS',
    'LINK_CLICKS':'OUTCOME_TRAFFIC','TRAFFIC':'OUTCOME_TRAFFIC',
    'REACH':'OUTCOME_AWARENESS','BRAND_AWARENESS':'OUTCOME_AWARENESS',
    'LOCAL_AWARENESS':'OUTCOME_AWARENESS','AWARENESS':'OUTCOME_AWARENESS',
    'APP_INSTALLS':'OUTCOME_APP_PROMOTION','STORE_VISITS':'OUTCOME_AWARENESS',
    'ENGAGEMENT':'OUTCOME_ENGAGEMENT','SALES':'OUTCOME_SALES',
  };
  // 1. Маппинг
  if (OBJECTIVE_MAP[objective]) objective = OBJECTIVE_MAP[objective];
  // 2. Егер әлі де жарамсыз болса — dest-ке қарай default
  if (!VALID_OBJECTIVES.has(objective)) {
    if (dest === 'traffic') objective = 'OUTCOME_TRAFFIC';
    else if (dest === 'wa' || dest === 'direct') objective = 'OUTCOME_ENGAGEMENT';
    else objective = 'OUTCOME_ENGAGEMENT';
    console.log(`Objective overridden to: ${objective}`);
  }
  const budgetVal = daily_budget || 5;

  const base = `https://graph.facebook.com/v19.0`;

  // WhatsApp/Direct үшін page_id автоматты алу (егер берілмесе)
  if (!page_id && (dest === 'wa' || dest === 'direct')) {
    try {
      const pagesRes = await axios.get(`${base}/me/accounts`, {
        params: { access_token: metaToken, limit: 5 }
      });
      const pages = pagesRes.data?.data || [];
      if (pages.length > 0) {
        page_id = pages[0].id;
        console.log(`Auto page_id: ${page_id} (${pages[0].name})`);
      }
    } catch(pe) {
      console.log('page_id auto-fetch failed:', pe?.response?.data?.error?.message || pe.message);
    }
  }

  // Барлық параметрлерді лог
  console.log('create-campaign FULL:', JSON.stringify({ name, objective, dest, geo, age_min, age_max, gender, daily_budget: budgetVal, page_id, post_id }));

  try {
    // 1. Кампания
    let campR;
    try {
      campR = await axios.post(`${base}/act_${accountId}/campaigns`, {
        name,
        objective,
        status: 'PAUSED',
        special_ad_categories: [],
        access_token: metaToken
      });
    } catch(e1) {
      const m = e1.response?.data?.error?.message || e1.message;
      console.error('STEP 1 campaign error:', m, JSON.stringify(e1.response?.data?.error||{}));
      return res.status(400).json({ error: `Кампания жасалмады: ${m}` });
    }
    const campaignId = campR.data.id;
    console.log('STEP 1 OK — campaign:', campaignId);

    // 2. Ad Set — targeting
    // Қала атынан Meta city key табу
    const KZ_CITIES = {
      'атырау': '1290182', 'atyrau': '1290182',
      'алматы': '1522374', 'almaty': '1522374',
      'астана': '1522374', 'astana': '1523674', 'нур-султан': '1523674',
      'шымкент': '1523782', 'shymkent': '1523782',
      'қарағанды': '1522924', 'karagandy': '1522924',
      'актобе': '1289434', 'aktobe': '1289434',
      'тараз': '1523670', 'taraz': '1523670',
      'павлодар': '1523451', 'pavlodar': '1523451',
      'усть-каменогорск': '1523770', 'ust-kamenogorsk': '1523770',
      'семей': '1523594', 'semey': '1523594',
    };

    let geoLocations = { countries: ['KZ'] };
    if (geo_cities?.length) {
      geoLocations = { cities: geo_cities.map(c => ({ key: c.key })) };
    } else if (geo) {
      const cityKey = KZ_CITIES[geo.toLowerCase().trim()];
      if (cityKey) geoLocations = { cities: [{ key: cityKey }] };
    }

    // destination_type + optimization_goal — objective-ке сәйкес
    let destinationType, optimizationGoal, billingEvent;
    if (dest === 'traffic') {
      destinationType = 'WEBSITE';
      optimizationGoal = 'LINK_CLICKS';
      billingEvent = 'IMPRESSIONS';
    } else if (dest === 'direct') {
      destinationType = 'INSTAGRAM_DIRECT';
      optimizationGoal = 'CONVERSATIONS';
      billingEvent = 'IMPRESSIONS';
    } else {
      // WhatsApp — default
      destinationType = 'WHATSAPP';
      optimizationGoal = 'CONVERSATIONS';
      billingEvent = 'IMPRESSIONS';
    }
    // OUTCOME_LEADS objective үшін optimization_goal өзгерту
    if (objective === 'OUTCOME_LEADS') {
      optimizationGoal = 'LEAD_GENERATION';
      billingEvent = 'IMPRESSIONS';
      destinationType = 'ON_AD';
    }

    const targeting = {
      age_min, age_max,
      genders: gender === 0 ? [1, 2] : [gender],
      geo_locations: geoLocations,
    };

    // WhatsApp/Direct үшін page_id жоқта destination_type алып тастаймыз
    // (Meta rejected adset without promoted_object for WA/Direct)
    const adsetBody = {
      name: `${name} — Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(budgetVal * 100),
      billing_event: billingEvent,
      optimization_goal: optimizationGoal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      status: 'PAUSED',
      targeting,
      access_token: metaToken
    };

    // destination_type тек page_id болғанда немесе traffic үшін
    if (dest === 'traffic' || objective === 'OUTCOME_LEADS') {
      adsetBody.destination_type = destinationType;
    } else if (page_id) {
      adsetBody.destination_type = destinationType;
      adsetBody.promoted_object = { page_id };
    }
    // page_id жоқта WhatsApp/Direct: destination_type жоқ, promoted_object жоқ — Meta дефолт қолданады

    console.log('STEP 2 adset body:', JSON.stringify({...adsetBody, access_token:'***'}));
    let adsetR;
    try {
      adsetR = await axios.post(`${base}/act_${accountId}/adsets`, adsetBody);
    } catch(e2) {
      const m = e2.response?.data?.error?.message || e2.message;
      const errCode = e2.response?.data?.error?.code;
      console.error('STEP 2 adset error:', m, JSON.stringify(e2.response?.data?.error||{}));
      // Orphan кампанияны жою — adset сәтсіз болса campaign Meta-да қалмасын
      try {
        await axios.delete(`${base}/${campaignId}`, { params: { access_token: metaToken } });
        console.log('Orphan campaign deleted:', campaignId);
      } catch(_) {}
      return res.status(400).json({ error: `Ad Set жасалмады: ${m}`, code: errCode });
    }
    const adsetId = adsetR.data.id;
    console.log('STEP 2 OK — adset:', adsetId);

    // 3. Ad Creative — тек сурет/видео/пост болса ғана жасау
    // post_id немесе image_hash/video_id болса → Ad + Creative жасаймыз
    let adId = null;
    const hasCreative = post_id || image_hash || video_id;
    if (hasCreative && page_id) {
      try {
        const ctaWa = dest === 'wa'
          ? { type: 'WHATSAPP_MESSAGE', value: {
              app_destination: 'WHATSAPP',
              ...(wa_phone ? { whatsapp_number: wa_phone.replace(/\D/g,'') } : {}),
              ...(wa_template ? { link: `https://wa.me/?text=${encodeURIComponent(wa_template)}` } : {})
            }}
          : { type: 'LEARN_MORE' };

        let creativeBody;

        if (post_id) {
          // Бар публикацияны (пост/реилс) пайдалану — object_story_id
          creativeBody = {
            name: `${name} — Creative`,
            object_story_id: post_id,
            access_token: metaToken
          };
        } else {
          let storySpec;
          if (video_id) {
            storySpec = {
              page_id,
              video_data: {
                video_id,
                title: ad_headline || name,
                message: ad_text || '',
                call_to_action: ctaWa
              }
            };
          } else {
            const linkData = {
              message: ad_text || '',
              name: ad_headline || name,
              call_to_action: ctaWa
            };
            if (image_hash) linkData.image_hash = image_hash;
            storySpec = { page_id, link_data: linkData };
          }
          creativeBody = {
            name: `${name} — Creative`,
            object_story_spec: storySpec,
            access_token: metaToken
          };
        }

        const creR = await axios.post(`${base}/act_${accountId}/adcreatives`, creativeBody);
        const creativeId = creR.data.id;
        console.log('STEP 3 OK — creative:', creativeId);

        // 4. Ad
        const adR = await axios.post(`${base}/act_${accountId}/ads`, {
          name: `${name} — Ad`,
          adset_id: adsetId,
          creative: { creative_id: creativeId },
          status: 'PAUSED',
          access_token: metaToken
        });
        adId = adR.data.id;
        console.log('STEP 4 OK — ad:', adId);
      } catch(e3) {
        // Creative/Ad қатесі болса кампания мен адсет сақталады, бірақ ad жоқ
        console.error('STEP 3/4 creative/ad error:', e3.response?.data?.error?.message || e3.message);
        // ok: true — campaign + adset жасалды, ad жоқ
      }
    } else if (post_id && !page_id) {
      // page_id жоқта post_id пайдаланып object_story_id арқылы жасаймыз
      try {
        const creR = await axios.post(`${base}/act_${accountId}/adcreatives`, {
          name: `${name} — Creative`,
          object_story_id: post_id,
          access_token: metaToken
        });
        const creativeId = creR.data.id;
        const adR = await axios.post(`${base}/act_${accountId}/ads`, {
          name: `${name} — Ad`,
          adset_id: adsetId,
          creative: { creative_id: creativeId },
          status: 'PAUSED',
          access_token: metaToken
        });
        adId = adR.data.id;
        console.log('STEP 3/4 OK (post_id only) — ad:', adId);
      } catch(e3) {
        console.error('STEP 3/4 (post_id) error:', e3.response?.data?.error?.message || e3.message);
      }
    }

    res.json({ ok: true, campaign_id: campaignId, adset_id: adsetId, ad_id: adId });
  } catch (e) {
    const errData = e.response?.data?.error || {};
    const msg = errData.message || e.message;
    const details = errData.error_user_msg || errData.error_user_title || errData.error_subcode || '';
    const errorBody = e.response?.config?.data;
    console.error('create-campaign error:', msg, details, JSON.stringify(errData));
    console.error('create-campaign request body:', typeof errorBody === 'string' ? errorBody.slice(0,500) : JSON.stringify(errorBody||{}).slice(0,500));
    res.status(400).json({ error: msg, details, hint: errData.error_user_msg || '' });
  }
});

// ── API: Telegram байланыстыруға код жасау ──
app.post('/api/tg-link-code', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  // 6 таңбалы код жасау
  const code = Math.random().toString(36).substr(2, 6).toUpperCase();
  await pool.query(
    'INSERT INTO tg_link_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET user_id = $2',
    [code, user.id]
  );
  res.json({ code });
});

// ── Webhook орнату ──
async function setupWebhook() {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
      url: `${BASE_URL}/tg/${TG_TOKEN}`,
      allowed_updates: ['message', 'callback_query']
    });
    console.log('✅ Telegram webhook орнатылды');
  } catch(e) { console.error('Webhook error:', e.message); }
}

// ── Күн сайын есеп ──
// Алматы UTC+5 → 08:00 Алматы = 03:00 UTC
const ADMIN_TG_CHAT_ID = process.env.ADMIN_TG_CHAT_ID; // супер-админ Telegram chat ID

async function buildDailyReport(u) {
  // System user токенін немесе клиент токенін пайдалан
  const metaToken = u.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = u.meta_account_id;
  if (!accountId) return null;

  // Кешегі күн үшін деректер
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yIso = yesterday.toISOString().slice(0, 10);

  const base = `https://graph.facebook.com/v19.0`;
  const [campInsRes, accInsRes, accStatusRes] = await Promise.all([
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'campaign_id,campaign_name,spend,clicks,actions,inline_link_clicks',
        time_range: JSON.stringify({ since: yIso, until: yIso }),
        level: 'campaign', limit: 50
      }
    }).catch(() => ({ data: { data: [] } })),
    axios.get(`${base}/act_${accountId}/insights`, {
      params: {
        access_token: metaToken,
        fields: 'spend,clicks,impressions,inline_link_clicks,actions',
        time_range: JSON.stringify({ since: yIso, until: yIso }),
        level: 'account'
      }
    }).catch(() => ({ data: { data: [] } })),
    axios.get(`${base}/act_${accountId}`, {
      params: { access_token: metaToken, fields: 'account_status,name' }
    }).catch(() => ({ data: {} }))
  ]);

  const campData = campInsRes.data.data || [];
  const accIns = accInsRes.data.data?.[0] || {};

  // Аккаунт мәртебесін тексер
  const accStatus = accStatusRes.data?.account_status;
  const accWarningLine = accStatus === 3 ? '\n🚨 <b>АККАУНТ ТОҚТАП ҚАЛДЫ — ОШИБКА ОПЛАТЫ!</b>\nMeta Billing-те төлем деректерін жаңартыңыз:\n<a href="https://business.facebook.com/billing">business.facebook.com/billing</a>\n' :
    accStatus === 2 ? '\n🚫 <b>АККАУНТ ӨШІРІЛГЕН!</b> Meta Business Manager-де тексеріңіз.\n' :
    accStatus === 9 ? '\n⚠️ <b>Аккаунт Grace Period-та</b> — жақын арада тоқтауы мүмкін. Төлемді жаңартыңыз.\n' : '';

  const totalSpend = parseFloat(accIns.spend || 0);
  const totalClicks = parseInt(accIns.inline_link_clicks || accIns.clicks || 0);

  // Conversations from actions
  const getConv = (actions) => {
    if (!actions) return 0;
    return parseInt(
      actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value ||
      actions.find(a => a.action_type === 'onsite_conversion.lead_grouped')?.value || 0
    );
  };

  const totalConv = getConv(accIns.actions);

  // Өткен аптамен салыстыру
  const weekAgo = new Date(yesterday); weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString().slice(0, 10);
  const prevInsRes = await axios.get(`${base}/act_${accountId}/insights`, {
    params: {
      access_token: metaToken,
      fields: 'spend,actions,inline_link_clicks',
      time_range: JSON.stringify({ since: weekAgoIso, until: weekAgoIso }),
      level: 'account'
    }
  }).catch(() => ({ data: { data: [] } }));
  const prevIns = prevInsRes.data.data?.[0] || {};
  const prevSpend = parseFloat(prevIns.spend || 0);
  const prevConv = getConv(prevIns.actions);

  const dateLabel = yesterday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  // CPL есептеу
  const cpl = totalConv > 0 ? (totalSpend / totalConv) : 0;
  const prevCpl = prevConv > 0 ? (prevSpend / prevConv) : 0;
  const cplTrend = prevCpl > 0 && cpl > 0 ? Math.round((prevCpl - cpl) / prevCpl * 100) : 0;

  // Кампаниялар бойынша жолдар
  const scaleCamps = [];
  const goodCamps = [];
  const badCamps = [];

  campData.forEach(c => {
    const sp = parseFloat(c.spend || 0);
    const conv = getConv(c.actions);
    const campCpl = conv > 0 ? sp / conv : 0;
    if (conv >= 3) scaleCamps.push({ name: c.campaign_name, sp, conv, cpl: campCpl });
    else if (conv > 0) goodCamps.push({ name: c.campaign_name, sp, conv, cpl: campCpl });
    else if (sp > 5) badCamps.push({ name: c.campaign_name, sp });
  });

  let campLines = '';

  if (scaleCamps.length) {
    campLines += scaleCamps.map(c =>
      `🚀 <b>${c.name}</b>\n   ${c.conv} заявка · CPL $${c.cpl.toFixed(2)} · расход $${c.sp.toFixed(2)}`
    ).join('\n') + '\n';
  }
  if (goodCamps.length) {
    campLines += goodCamps.map(c =>
      `✅ <b>${c.name}</b>\n   ${c.conv} заявка · CPL $${c.cpl.toFixed(2)} · расход $${c.sp.toFixed(2)}`
    ).join('\n') + '\n';
  }
  if (badCamps.length) {
    campLines += badCamps.map(c =>
      `⏸ <b>${c.name}</b>\n   Заявок нет · расход $${c.sp.toFixed(2)} — AI мониторингінде`
    ).join('\n') + '\n';
  }
  if (!campLines) campLines = '📋 Кешегі белсенді кампания жоқ\n';

  // Тренд жолы
  const spendTrend = prevSpend > 0
    ? (totalSpend > prevSpend ? `📈 +${((totalSpend-prevSpend)/prevSpend*100).toFixed(0)}%` : `📉 -${((prevSpend-totalSpend)/prevSpend*100).toFixed(0)}%`)
    : '';
  const cplTrendStr = cplTrend > 0 ? `⬇️ CPL ${cplTrend}% арзандады` : cplTrend < 0 ? `⬆️ CPL ${Math.abs(cplTrend)}% өсті` : '';

  const msg =
    `📊 <b>SmartTarget AI · ${dateLabel}</b>\n` +
    `👤 ${u.name}\n` +
    (accWarningLine || '') +
    `\n💰 Расход: <b>$${totalSpend.toFixed(2)}</b>${spendTrend ? ' ' + spendTrend : ''}\n` +
    `💬 Заявок: <b>${totalConv}</b>${totalConv > 0 ? ` · CPL <b>$${cpl.toFixed(2)}</b>` : ''}${cplTrendStr ? ' · ' + cplTrendStr : ''}\n` +
    `👆 Кликтер: <b>${totalClicks}</b>\n\n` +
    campLines + '\n' +
    `🤖 AI 24/7 жұмыс жасауда — барлығы бақылауда\n` +
    `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Толық дашборд →</a>`;

  return { msg, totalSpend, totalClicks, totalConv, campCount: campData.length };
}

// ── Мерзімі өткен клиенттерді тексеру ──
async function checkSubscriptions() {
  const now = new Date();
  const warnThreshold = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 күн қалды

  // 1. Ескерту: 1 күн қалғандар (plan_expires_at 24 сағат ішінде)
  const toWarn = await pool.query(
    `SELECT * FROM users WHERE tg_chat_id IS NOT NULL
     AND plan_expires_at IS NOT NULL
     AND plan_expires_at BETWEEN NOW() AND $1
     AND (payment_warned_at IS NULL OR payment_warned_at < NOW() - INTERVAL '20 hours')`,
    [warnThreshold]
  );
  for (const u of toWarn.rows) {
    const hoursLeft = Math.round((new Date(u.plan_expires_at) - now) / 3600000);
    await tgSend(u.tg_chat_id,
      `⚠️ <b>Мерзімі аяқталуға жақын!</b>\n\n` +
      `Сіздің SmartTarget жазылымыңыз <b>${hoursLeft} сағат</b> ішінде аяқталады.\n\n` +
      `💳 Төлем жасамасаңыз — рекламаларыңыз автоматты түрде тоқтатылады.\n\n` +
      `Kaspi QR арқылы төлеңіз немесе маманмен байланысыңыз.`,
      { inline_keyboard: [[
        { text: '💳 Kaspi QR арқылы төлеу', url: 'https://pay.kaspi.kz/pay/pqtnvdax' },
        { text: '👩‍💼 Маманмен байланыс', url: `https://t.me/${process.env.ADMIN_TG_USERNAME || 'smarttarget_support'}` }
      ]]}
    );
    await pool.query('UPDATE users SET payment_warned_at = NOW() WHERE id = $1', [u.id]);
    console.log(`⚠️ Subscription warning sent: ${u.email}`);
  }

  // 2. Мерзімі өткендер — Meta кампанияларын өшіру
  const expired = await pool.query(
    `SELECT * FROM users WHERE plan_expires_at IS NOT NULL AND plan_expires_at < NOW() AND plan != 'suspended'`
  );
  for (const u of expired.rows) {
    // Meta кампанияларын PAUSED ету
    if (u.meta_token && u.meta_account_id) {
      try {
        const camps = await axios.get(`https://graph.facebook.com/v19.0/act_${u.meta_account_id}/campaigns`, {
          params: { access_token: u.meta_token, fields: 'id,status', limit: 50 }
        });
        for (const camp of (camps.data?.data || [])) {
          if (camp.status === 'ACTIVE') {
            await axios.post(`https://graph.facebook.com/v19.0/${camp.id}`, null, {
              params: { access_token: u.meta_token, status: 'PAUSED' }
            }).catch(() => {});
          }
        }
      } catch(e) { console.error(`Meta pause error for ${u.email}:`, e.message); }
    }
    // Пайдаланушыны suspended ету
    await pool.query("UPDATE users SET plan = 'suspended' WHERE id = $1", [u.id]);
    // Telegram хабарлама
    if (u.tg_chat_id) {
      await tgSend(u.tg_chat_id,
        `🔴 <b>Жазылым аяқталды</b>\n\n` +
        `Барлық рекламаларыңыз тоқтатылды.\n\n` +
        `Жазылымды жаңарту үшін Kaspi QR арқылы төлеңіз немесе маманмен байланысыңыз.`,
        { inline_keyboard: [[
          { text: '💳 Kaspi QR арқылы төлеу', url: 'https://pay.kaspi.kz/pay/pqtnvdax' },
          { text: '👩‍💼 Маманмен байланыс', url: `https://t.me/${process.env.ADMIN_TG_USERNAME || 'smarttarget_support'}` }
        ]]}
      );
    }
    // Админге хабарлама
    if (ADMIN_TG_CHAT_ID) {
      await tgSend(ADMIN_TG_CHAT_ID,
        `🔴 <b>Мерзімі өтті: ${u.name || u.email}</b>\n\nРекламалары тоқтатылды. Төлем растасаңыз — аккаунтын қалпына келтіріңіз.`,
        { inline_keyboard: [[{ text: '✅ Төлем расталды — қалпына келтіру', callback_data: `restore_sub_${u.id}` }]] }
      );
    }
    console.log(`🔴 Subscription expired + campaigns paused: ${u.email}`);
  }
}

async function scheduleSubscriptionCheck() {
  // Күніне 2 рет тексеру: 08:00 және 20:00 Алматы (03:00 және 15:00 UTC)
  const runCheck = async () => {
    try { await checkSubscriptions(); } catch(e) { console.error('Subscription check error:', e.message); }
  };
  await runCheck();
  setInterval(runCheck, 12 * 60 * 60 * 1000);
}

// Соңғы жіберілген күнді жадта сақтаймыз (сервер рестарт болса da дубль болмасын)
let lastReportDate = '';

async function sendAllDailyReports() {
  const dateLabel = new Date(Date.now() - 86400000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const todayKey = new Date().toISOString().slice(0, 10); // "2026-07-03"

  if (lastReportDate === todayKey) {
    console.log(`📅 Есеп бүгін жіберілді (${todayKey}), өткізіп жіберу`);
    return;
  }

  console.log(`📨 Күнделікті есептер жіберілуде (${dateLabel})...`);
  lastReportDate = todayKey;

  const clients = await pool.query(
    'SELECT * FROM users WHERE tg_chat_id IS NOT NULL AND meta_account_id IS NOT NULL'
  );

  const results = [];
  for (const u of clients.rows) {
    try {
      const report = await buildDailyReport(u);
      if (!report) { results.push({ name: u.name, status: '⏭ аккаунт жоқ' }); continue; }
      if (report.totalSpend === 0 && report.campCount === 0) {
        results.push({ name: u.name, status: '⏭ расход жоқ' }); continue;
      }
      await tgSend(u.tg_chat_id, report.msg);
      results.push({ name: u.name, status: `✅ жіберілді ($${report.totalSpend.toFixed(2)})` });
    } catch(e) {
      console.error(`Daily report error for ${u.email}:`, e.message);
      results.push({ name: u.name, status: `❌ қате: ${e.message.slice(0, 60)}` });
    }
  }

  if (ADMIN_TG_CHAT_ID) {
    const summary = results.length ? results.map(r => `${r.status} — ${r.name}`).join('\n') : 'Клиент жоқ';
    await tgSend(ADMIN_TG_CHAT_ID,
      `🤖 <b>SmartTarget — Есеп жіберу нәтижесі · ${dateLabel}</b>\n\n${summary}\n\nЖалпы: ${results.length} клиент`
    ).catch(() => {});
  }

  console.log(`✅ Күнделікті есептер аяқталды: ${results.length} клиент`);
}

async function scheduleDailyReports() {
  // Сағат сайын тексер: 03:00 UTC (= 08:00 Алматы UTC+5) болса — жібер
  const check = async () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    // 03:00–03:59 UTC аралығында жібер
    if (utcHour === 3) {
      await sendAllDailyReports().catch(e => console.error('Daily report error:', e.message));
    }
  };

  // Бірден бір рет тексер, содан сайын сағат сайын
  await check();
  setInterval(check, 60 * 60 * 1000); // сағат сайын
  console.log(`📅 Күнделікті есеп жоспарланды: сағат сайын тексеріледі (03:00 UTC = 08:00 Алматы)`);
}

// ── API: Рекламалық сурет жүктеу (Meta Ad Images) ──
app.post('/api/meta/upload-image', upload.single('image'), async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id || process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta аккаунт қосылмаған' });
  if (!req.file) return res.status(400).json({ error: 'Файл жоқ' });

  try {
    const form = new FormData();
    form.append('filename', req.file.originalname);
    form.append('bytes', req.file.buffer.toString('base64'));
    form.append('access_token', metaToken);

    const r = await axios.post(
      `https://graph.facebook.com/v19.0/act_${accountId}/adimages`,
      form,
      { headers: form.getHeaders() }
    );

    const images = r.data.images;
    const key = Object.keys(images)[0];
    const hash = images[key].hash;
    const url = images[key].url;

    // DB-де сақта — кейін creative жасауда пайдалану үшін
    await pool.query('UPDATE users SET settings = settings || $1 WHERE id = $2', [
      JSON.stringify({ adImageHash: hash, adImageUrl: url }), user.id
    ]);

    res.json({ ok: true, hash, url });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('upload-image error:', msg);
    res.status(400).json({ error: msg });
  }
});

// ── Meta: Видео жүктеу ──
app.post('/api/meta/upload-video', upload.single('video'), async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id || process.env.META_AD_ACCOUNT_ID;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta аккаунт қосылмаған' });
  if (!req.file) return res.status(400).json({ error: 'Файл жоқ' });

  try {
    const form = new FormData();
    form.append('source', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
    form.append('access_token', metaToken);

    const r = await axios.post(
      `https://graph.facebook.com/v19.0/act_${accountId}/advideos`,
      form,
      { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
    );

    res.json({ ok: true, video_id: r.data.id });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('upload-video error:', msg);
    res.status(400).json({ error: msg });
  }
});

// ── ADMIN: пайдаланушыға Meta аккаунт тағайындау ──
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'smarttarget_admin_2026';

// Settings жаңарту (page_id, image_hash т.б.)
app.post('/api/admin/set-settings', async (req, res) => {
  const { secret, email, settings } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const result = await pool.query(
    'UPDATE users SET settings = settings || $1 WHERE email=$2 RETURNING id,email,name,settings',
    [JSON.stringify(settings), email]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: result.rows[0] });
});

app.post('/api/admin/set-account', async (req, res) => {
  const { secret, email, account_id } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const sysToken = process.env.META_ACCESS_TOKEN;
  // Аккаунт атын алу
  let accName = account_id;
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/act_${account_id}`, {
      params: { access_token: sysToken, fields: 'id,name' }
    });
    accName = r.data.name;
  } catch(e) {}
  const result = await pool.query(
    'UPDATE users SET meta_token=$1, meta_account_id=$2, meta_account_name=$3 WHERE email=$4 RETURNING id,email,name',
    [sysToken, account_id, accName, email]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, user: result.rows[0], account_id, account_name: accName });
});

// Admin: барлық клиенттер тізімін қайтару (есеп логы үшін)
app.get('/api/admin/clients', async (req, res) => {
  const { secret } = req.query;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const r = await pool.query(
    'SELECT id, email, name, plan, meta_account_id, meta_account_name, tg_chat_id, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ clients: r.rows });
});

// Admin: тестовый есеп жіберу (бір клиентке)
app.post('/api/admin/send-report', async (req, res) => {
  const { secret, email } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (!u.tg_chat_id) return res.status(400).json({ error: 'Telegram байланыстырылмаған' });
  if (!u.meta_account_id) return res.status(400).json({ error: 'Meta аккаунт жоқ' });
  try {
    const report = await buildDailyReport(u);
    if (!report) return res.json({ ok: false, reason: 'аккаунт жоқ' });
    await tgSend(u.tg_chat_id, report.msg);
    res.json({ ok: true, msg: report.msg.slice(0, 200) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════
// ADMIN (token-based)
// ══════════════════════════════

// POST /api/admin/create-client — Жаңа клиент жасау (admin)
app.post('/api/admin/create-client', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const admin = await getUserBySession(token);
  if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Тек админ' });

  const { email, name, plan } = req.body;
  if (!email) return res.status(400).json({ error: 'Email міндетті' });

  // Кездейсоқ пароль жасау: 3 сөз + сан (есте сақтауға оңай)
  const words = ['Sky','Star','Gold','Fire','Wave','Moon','Sun','Peak','Bolt','Ace'];
  const w1 = words[Math.floor(Math.random()*words.length)];
  const w2 = words[Math.floor(Math.random()*words.length)];
  const num = Math.floor(Math.random()*900)+100;
  const password = `${w1}${w2}${num}`;

  const planName = plan || 'ai';
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  try {
    const hash = hashPassword(password);
    const r = await pool.query(
      'INSERT INTO users (email, name, password_hash, plan, plan_expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, plan',
      [email.toLowerCase().trim(), name || '', hash, planName, expires]
    );
    const newUser = r.rows[0];
    res.json({ ok: true, user: newUser, password, loginUrl: `${BASE_URL}/auth.html` });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Бұл email тіркелген' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/reset-password — Пароль қалпына келтіру
app.post('/api/admin/reset-password', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const admin = await getUserBySession(token);
  if (!admin || !admin.is_admin) return res.status(403).json({ error: 'Тек админ' });

  const { user_id } = req.body;
  const words = ['Sky','Star','Gold','Fire','Wave','Moon','Sun','Peak','Bolt','Ace'];
  const w1 = words[Math.floor(Math.random()*words.length)];
  const w2 = words[Math.floor(Math.random()*words.length)];
  const num = Math.floor(Math.random()*900)+100;
  const password = `${w1}${w2}${num}`;
  const hash = hashPassword(password);

  const r = await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING email, name', [hash, user_id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Пайдаланушы табылмады' });
  res.json({ ok: true, password, email: r.rows[0].email, name: r.rows[0].name });
});

// GET /api/admin/clients-auth - Admin: барлық клиенттерді көру (token auth)
app.get('/api/admin/clients-auth', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Тек админ' });
  const r = await pool.query(`
    SELECT id, email, name, plan, plan_expires_at, meta_account_name, meta_account_id,
           tg_chat_id, created_at, is_admin
    FROM users ORDER BY created_at DESC
  `);
  res.json({ clients: r.rows });
});

// POST /api/admin/set-admin - Пайдаланушыны админ ету
app.post('/api/admin/set-admin', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Тек админ' });
  const { user_id, is_admin } = req.body;
  await pool.query('UPDATE users SET is_admin=$1 WHERE id=$2', [is_admin, user_id]);
  res.json({ ok: true });
});

// POST /api/admin/set-plan - Клиентке тариф орнату
app.post('/api/admin/set-plan-auth', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user || !user.is_admin) return res.status(403).json({ error: 'Тек админ' });
  const { user_id, plan, days } = req.body;
  const expires = new Date(Date.now() + (days||30)*24*60*60*1000);
  await pool.query('UPDATE users SET plan=$1, plan_expires_at=$2 WHERE id=$3', [plan, expires, user_id]);
  res.json({ ok: true });
});

// ══════════════════════════════
// BILLING / CLOUDPAYMENTS
// ══════════════════════════════
const CP_PUBLIC_ID = process.env.CP_PUBLIC_ID || '';
const CP_API_SECRET = process.env.CP_API_SECRET || '';

const PLAN_AMOUNTS = {
  ai:     { amount: 49990,  currency: 'KZT', monthly: true },
  expert: { amount: 150000, currency: 'KZT', monthly: true },
  agency: { amount: 300000, currency: 'KZT', monthly: false }
};

// Публичный конфиг для фронтенда
app.get('/api/config', (req, res) => {
  res.json({ cpPublicId: CP_PUBLIC_ID });
});

// Создать заказ (получить параметры для виджета)
app.post('/api/billing/create-order', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { plan } = req.body;
  const planInfo = PLAN_AMOUNTS[plan];
  if (!planInfo) return res.status(400).json({ error: 'Жарамды тариф емес' });
  const orderId = `smt_${user.id}_${plan}_${Date.now()}`;
  res.json({
    publicId: CP_PUBLIC_ID,
    orderId,
    amount: planInfo.amount,
    currency: planInfo.currency,
    userId: user.id,
    email: user.email,
    name: user.name || ''
  });
});

// Подтвердить оплату (CloudPayments webhook)
app.post('/webhook/cloudpayments', express.urlencoded({ extended: true }), async (req, res) => {
  // Верификация HMAC от CloudPayments
  if (CP_API_SECRET) {
    const receivedHmac = req.headers['x-content-hmac'] || '';
    // CP считает HMAC от тела запроса
    const rawBody = new URLSearchParams(req.body).toString();
    const expectedHmac = crypto.createHmac('sha256', CP_API_SECRET)
      .update(rawBody).digest('base64');
    if (receivedHmac && receivedHmac !== expectedHmac) {
      console.log('CP HMAC mismatch');
      return res.json({ code: 13, message: 'Invalid HMAC' });
    }
  }

  const { Amount, AccountId, Data, Status, TransactionId, CardFirstSix, CardLastFour, CardType } = req.body;
  if (Status !== 'Completed') return res.json({ code: 0 }); // принять, не обрабатывать

  try {
    let data = {};
    try { data = typeof Data === 'string' ? JSON.parse(Data) : (Data || {}); } catch(e){}

    const { plan, userId } = data;
    if (!userId || !plan) return res.json({ code: 10, message: 'No user/plan data' });

    const planInfo = PLAN_AMOUNTS[plan];
    const planNames = { ai: 'AI Таргетолог', expert: 'Эксперт', agency: 'Премиум' };
    const expires = planInfo?.monthly ? new Date(Date.now() + 31 * 24 * 60 * 60 * 1000) : null;

    const updated = await pool.query(
      'UPDATE users SET plan=$1, plan_expires_at=$2, payment_warned_at=NULL WHERE id=$3 RETURNING *',
      [plan, expires, userId]
    );
    const u = updated.rows[0];

    console.log(`✅ CloudPayments: user ${userId} → plan ${plan}, txn ${TransactionId}`);

    // Telegram хабарлама пайдаланушыға
    if (u?.tg_chat_id) {
      const expiryStr = expires ? ` (${expires.toLocaleDateString('ru-RU')} дейін)` : ' (тұрақты)';
      await tgSend(u.tg_chat_id,
        `✅ <b>Төлем сәтті өтті!</b>\n\nТариф: <b>${planNames[plan] || plan}</b>${expiryStr}\nСумма: ${Number(Amount).toLocaleString('ru')} тг\nKарточка: ${CardType || ''} ****${CardLastFour || ''}\n\nСіздің SmartTarget AI аккаунтыңыз белсендірілді! 🎉`
      ).catch(()=>{});
    }

    // Telegram хабарлама админге
    const ADMIN_TG_ID = process.env.ADMIN_TG_CHAT_ID;
    if (ADMIN_TG_ID) {
      await tgSend(ADMIN_TG_ID,
        `💳 <b>Жаңа төлем!</b>\n\nПайдаланушы: ${u?.name || AccountId}\nEmail: ${AccountId}\nТариф: <b>${planNames[plan] || plan}</b>\nСумма: ${Number(Amount).toLocaleString('ru')} тг\nTxn: ${TransactionId}`
      ).catch(()=>{});
    }

    res.json({ code: 0 });
  } catch(e) {
    console.error('CP webhook error:', e);
    res.json({ code: 13, message: e.message });
  }
});

app.get('/api/billing/status', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const planLimits = {
    free: { maxCampaigns: 3, autopilot: true, studio: true },
    ai: { maxCampaigns: 10, autopilot: true, studio: true },
    expert: { maxCampaigns: 999, autopilot: true, studio: true },
    agency: { maxCampaigns: 999, autopilot: true, studio: true, isAgency: true }
  };
  res.json({
    plan: user.plan || 'free',
    expiresAt: user.plan_expires_at,
    limits: planLimits[user.plan || 'free'] || planLimits.free
  });
});

// Report data: нақты Meta деректері белгілі кезең үшін
app.get('/api/report-data', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { since, until } = req.query;
  if (!since || !until) return res.status(400).json({ error: 'since and until required' });

  const metaToken = user.meta_token || process.env.META_ACCESS_TOKEN;
  const accountId = user.meta_account_id;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta not configured' });

  const base = `https://graph.facebook.com/v19.0`;
  try {
    const [campInsRes, accInsRes] = await Promise.all([
      axios.get(`${base}/act_${accountId}/insights`, {
        params: {
          access_token: metaToken,
          fields: 'campaign_id,campaign_name,spend,clicks,inline_link_clicks,actions',
          time_range: JSON.stringify({ since, until }),
          level: 'campaign', limit: 50
        }
      }),
      axios.get(`${base}/act_${accountId}/insights`, {
        params: {
          access_token: metaToken,
          fields: 'spend,clicks,inline_link_clicks,actions',
          time_range: JSON.stringify({ since, until }),
          level: 'account'
        }
      })
    ]);

    const getConv = (actions=[]) => parseInt(
      actions.find(a=>a.action_type==='onsite_conversion.messaging_conversation_started_7d')?.value ||
      actions.find(a=>a.action_type==='onsite_conversion.messaging_first_reply')?.value ||
      actions.find(a=>a.action_type==='onsite_conversion.lead_grouped')?.value || 0
    );

    const accIns = accInsRes.data.data?.[0] || {};
    const campaigns = (campInsRes.data.data || []).map(c => ({
      campaign_name: c.campaign_name,
      spend: parseFloat(c.spend || 0),
      conversations: getConv(c.actions),
      clicks: parseInt(c.inline_link_clicks || c.clicks || 0)
    }));

    res.json({
      campaigns,
      totalSpend: parseFloat(accIns.spend || 0),
      totalLeads: getConv(accIns.actions),
      totalClicks: parseInt(accIns.inline_link_clicks || accIns.clicks || 0)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Meta billing: байланған картамен қарызды өтеу
app.post('/api/meta/pay-debt', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const metaToken = user.meta_token;
  const accountId = user.meta_account_id;
  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta байланмаған' });

  try {
    // Аккаунт жағдайын алу (қарыз сомасы, валюта)
    const accRes = await axios.get(`https://graph.facebook.com/v19.0/act_${accountId}`, {
      params: {
        fields: 'balance,amount_spent,account_status,currency,outstanding_balance',
        access_token: metaToken
      }
    });
    const acc = accRes.data;
    const currency = acc.currency || 'KZT';
    const outstanding = parseFloat(acc.outstanding_balance || 0) / 100;
    const balance = parseFloat(acc.balance || 0) / 100;

    // Meta API арқылы billing cycle trigger жасауға тырыс
    let triggered = false;
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/act_${accountId}/adsbillingcycles`,
        { access_token: metaToken }
      );
      triggered = true;
      console.log(`✅ Meta billing triggered for act_${accountId}`);
    } catch(trigErr) {
      // Кейбір аккаунттарда бұл API жұмыс жасамауы мүмкін — billing URL-ге redirect
      console.log(`Meta billing trigger failed: ${trigErr?.response?.data?.error?.message || trigErr.message}`);
    }

    // Meta Billing URL — тікелей төлем бетіне
    const billingUrl = `https://business.facebook.com/billing_hub/accounts/?act=${accountId}`;

    res.json({ ok: true, triggered, outstanding, balance, currency, billingUrl });
  } catch(e) {
    const errMsg = e?.response?.data?.error?.message || e.message;
    res.status(502).json({ error: errMsg });
  }
});

// Account warning — Telegram-ға жібер
app.post('/api/account-warning', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { warning, message } = req.body;
  if (user.tg_chat_id) {
    try {
      await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: user.tg_chat_id,
        text: `🚨 *АККАУНТ МӘСЕЛЕСІ*\n\n${message}\n\nMeta Billing: https://business.facebook.com/billing`,
        parse_mode: 'Markdown'
      });
    } catch(e) {}
  }
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await initDB();
  await setupWebhook();
  await setupBotCommands();
  await scheduleDailyReports();
  await scheduleSubscriptionCheck();
  if (MONITOR_ACCOUNTS.length) fetchAllAccountsStats().catch(console.error);
});
