const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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

// ── Telegram хабар жіберу ──
async function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML'
    });
  } catch(e) { console.error('TG error:', e.message); }
}

// ── Meta API ──
async function getMetaData(token, accountId) {
  const [campsRes, insRes, accRes, adsetsRes, campInsRes] = await Promise.all([
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/campaigns`, {
      params: { access_token: token, fields: 'id,name,status,objective,daily_budget', limit: 20 }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr,inline_link_clicks,actions', date_preset: 'last_30d', level: 'account' }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}`, {
      params: { access_token: token, fields: 'id,name,currency,amount_spent' }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/adsets`, {
      params: { access_token: token, fields: 'id,name,campaign_id,daily_budget,status', limit: 50 }
    }).catch(() => ({ data: { data: [] } })),
    // Campaign-level insights: spend, clicks, actions (conversations) last 30 days
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: {
        access_token: token,
        fields: 'campaign_id,campaign_name,spend,clicks,impressions,inline_link_clicks,actions',
        date_preset: 'last_30d',
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

  // Build campaign-level insights map
  const campInsights = {};
  for (const ci of (campInsRes.data.data || [])) {
    // Extract conversations from actions array
    const actions = ci.actions || [];
    const conversations = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value
      || actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value
      || actions.find(a => a.action_type === 'onsite_conversion.lead_grouped')?.value
      || 0;
    campInsights[ci.campaign_id] = { ...ci, conversations: parseInt(conversations) };
  }

  const campaigns = (campsRes.data.data || []).map(c => ({
    ...c,
    daily_budget: c.daily_budget || budgetByCampaign[c.id] || 0,
    spend: parseFloat(campInsights[c.id]?.spend || 0),
    clicks: parseInt(campInsights[c.id]?.clicks || 0),
    impressions: parseInt(campInsights[c.id]?.impressions || 0),
    conversations: campInsights[c.id]?.conversations || 0,
    link_clicks: parseInt(campInsights[c.id]?.inline_link_clicks || 0),
  }));

  return {
    campaigns,
    insights: insRes.data.data?.[0] || {},
    account: accRes.data
  };
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
    const r = await pool.query(
      'INSERT INTO users (email, name, password_hash, plan) VALUES ($1, $2, $3, $4) RETURNING id, email, name, plan',
      [email.toLowerCase(), name || '', hash, plan || 'free']
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

// Профиль
app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUserBySession(token);
  if (!user) return res.status(401).json({ error: 'Invalid session' });
  res.json({ id: user.id, email: user.email, name: user.name, plan: user.plan,
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
    }
  }

  if (!metaToken || !accountId) return res.status(400).json({ error: 'Meta not configured' });

  try {
    const data = await getMetaData(metaToken, accountId);
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
// TELEGRAM БОТ
// ══════════════════════════════

app.post(`/tg/${TG_TOKEN}`, async (req, res) => {
  const msg = req.body?.message;
  if (!msg) return res.sendStatus(200);

  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Пайдаланушыны chat_id бойынша тап
  const userRow = await pool.query('SELECT * FROM users WHERE tg_chat_id = $1', [chatId]);
  const user = userRow.rows[0] || null;

  if (text.startsWith('/start')) {
    const startCode = text.split(' ')[1]?.trim().toUpperCase();

    if (startCode) {
      // Deep link арқылы келді — кодты автоматты тексер
      const linkRow = await pool.query('SELECT * FROM tg_link_tokens WHERE token = $1', [startCode]);
      if (linkRow.rows.length) {
        const userId = linkRow.rows[0].user_id;
        await pool.query('UPDATE users SET tg_chat_id = $1 WHERE id = $2', [chatId, userId]);
        await pool.query('DELETE FROM tg_link_tokens WHERE token = $1', [startCode]);
        const linkedUser = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
        await tgSend(chatId,
          `✅ <b>Байланысты!</b>\n\n` +
          `👤 ${linkedUser.rows[0]?.name || 'Клиент'}\n\n` +
          `Енді күн сайын рекламаңыздың нәтижесін жіберіп тұрамын.\n\n` +
          `📊 /report — статистика\n` +
          `ℹ️ /status — күй тексеру`
        );
        return res.sendStatus(200);
      }
    }

    // Жай /start — қош келдің хабары
    await tgSend(chatId,
      `👋 <b>SmartTarget AI</b>\n\n` +
      `Мен сіздің AI-таргетологыңызбын.\n\n` +
      `📊 Күн сайын рекламаңыздың нәтижесін жіберіп тұрамын.\n\n` +
      `Платформаға кіріп, Telegram-ды байланыстырыңыз:\n` +
      `👉 <a href="${BASE_URL}/ai-targetolog-onboarding.html">SmartTarget AI →</a>`
    );

  } else if (text.startsWith('/link ')) {
    // Пайдаланушы платформадан алған 4 таңбалы кодын жібереді
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
      `✅ <b>Байланысты!</b>\n\n` +
      `👤 ${linkedUser.rows[0]?.name || 'Клиент'}\n\n` +
      `📊 /report — статистика алу\n` +
      `ℹ️ /status — күй тексеру`
    );

  } else if (text === '/report') {
    if (!user) return tgSend(chatId, '⚠️ Алдымен платформаға кіріп Telegram-ды байланыстырыңыз.');
    if (!user.meta_token) return tgSend(chatId, '⚠️ Meta Ads байланыстырылмаған. Платформада орнатыңыз.');
    await tgSend(chatId, '⏳ Деректер жүктелуде...');
    try {
      const { campaigns, insights: i } = await getMetaData(user.meta_token, user.meta_account_id);
      const active = campaigns.filter(c => c.status === 'ACTIVE');
      const campLines = active.length
        ? active.map(c => `  • ${c.name}`).join('\n')
        : '  Активті кампания жоқ';
      await tgSend(chatId,
        `📊 <b>Күнделікті есеп</b>\n` +
        `👤 ${user.name} · ${user.meta_account_name}\n\n` +
        `💰 Шығын бүгін: <b>$${parseFloat(i.spend||0).toFixed(2)}</b>\n` +
        `👆 Клик: <b>${i.clicks||0}</b>\n` +
        `👁 Көрсету: <b>${parseInt(i.impressions||0).toLocaleString()}</b>\n` +
        `💵 CPC: <b>$${parseFloat(i.cpc||0).toFixed(2)}</b>\n` +
        `📈 CTR: <b>${parseFloat(i.ctr||0).toFixed(2)}%</b>\n\n` +
        `▶️ Активті кампания (${active.length}):\n${campLines}\n\n` +
        `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`
      );
    } catch(e) { await tgSend(chatId, '❌ Қате: ' + e.message); }

  } else if (text === '/status') {
    await tgSend(chatId,
      `🟢 <b>SmartTarget AI</b>\n\n` +
      `Аккаунт: ${user ? '✅ ' + user.name : '❌ Байланыстырылмаған'}\n` +
      `Meta Ads: ${user?.meta_token ? '✅ ' + user.meta_account_name : '❌ Жоқ'}\n` +
      `Сервер: ✅ Онлайн`
    );

  } else if (text === '/help') {
    await tgSend(chatId,
      `📋 <b>Командалар:</b>\n\n` +
      `/link КОД — платформамен байланыстыру\n` +
      `/report — бүгінгі статистика\n` +
      `/status — байланыс күйі\n` +
      `/help — көмек`
    );
  } else {
    await tgSend(chatId, `❓ /help деп жазыңыз.`);
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
      }
    });
    res.json({ text: r.data.content[0].text });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
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

  const { name, objective = 'OUTCOME_ENGAGEMENT', daily_budget, dest, wa_phone, page_id, ig_account_id, geo_cities, age_min = 18, age_max = 65, gender = 0, ad_text, ad_headline, image_hash, wa_template, geo } = req.body;

  if (!name || !daily_budget) return res.status(400).json({ error: 'name және daily_budget міндетті' });

  const base = `https://graph.facebook.com/v19.0`;

  try {
    // 1. Кампания
    const campR = await axios.post(`${base}/act_${accountId}/campaigns`, {
      name,
      objective,
      status: 'PAUSED',
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
      access_token: metaToken
    });
    const campaignId = campR.data.id;

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

    // destination type
    let destinationType = 'WHATSAPP';
    if (dest === 'direct') destinationType = 'INSTAGRAM_DIRECT';
    if (dest === 'traffic') destinationType = 'WEBSITE';

    const targeting = {
      age_min, age_max,
      genders: gender === 0 ? [1, 2] : [gender],
      geo_locations: geoLocations,
      targeting_automation: { advantage_audience: 0 }
    };

    let optimizationGoal = 'CONVERSATIONS';
    if (dest === 'traffic') optimizationGoal = 'LINK_CLICKS';

    const adsetBody = {
      name: `${name} — Ad Set`,
      campaign_id: campaignId,
      daily_budget: Math.round(daily_budget * 100), // центтерде
      billing_event: 'IMPRESSIONS',
      optimization_goal: optimizationGoal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      status: 'PAUSED',
      targeting,
      destination_type: destinationType,
      access_token: metaToken
    };
    // WhatsApp/Direct үшін page_id міндетті
    if (page_id && dest !== 'traffic') {
      adsetBody.promoted_object = { page_id };
    }

    const adsetR = await axios.post(`${base}/act_${accountId}/adsets`, adsetBody);
    const adsetId = adsetR.data.id;

    // 3. Ad Creative (тек page_id болса)
    let adId = null;
    if (page_id && (ad_text || ad_headline)) {
      const linkData = {
        message: ad_text || '',
        name: ad_headline || name,
        call_to_action: dest === 'wa'
          ? { type: 'WHATSAPP_MESSAGE', value: {
              app_destination: 'WHATSAPP',
              ...(wa_phone ? { whatsapp_number: wa_phone.replace(/\D/g,'') } : {}),
              ...(wa_template ? { link: `https://wa.me/?text=${encodeURIComponent(wa_template)}` } : {})
            }}
          : { type: 'LEARN_MORE' }
      };
      // Сурет бар болса қос
      if (image_hash) linkData.image_hash = image_hash;

      const creativeBody = {
        name: `${name} — Creative`,
        object_story_spec: { page_id, link_data: linkData },
        access_token: metaToken
      };
      const creR = await axios.post(`${base}/act_${accountId}/adcreatives`, creativeBody);
      const creativeId = creR.data.id;

      // 4. Ad
      const adR = await axios.post(`${base}/act_${accountId}/ads`, {
        name: `${name} — Ad`,
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: metaToken
      });
      adId = adR.data.id;
    }

    res.json({ ok: true, campaign_id: campaignId, adset_id: adsetId, ad_id: adId });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('create-campaign error:', msg);
    res.status(400).json({ error: msg });
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
      url: `${BASE_URL}/tg/${TG_TOKEN}`
    });
    console.log('✅ Telegram webhook орнатылды');
  } catch(e) { console.error('Webhook error:', e.message); }
}

// ── Күн сайын есеп ──
async function scheduleDailyReports() {
  const now = new Date();
  const next = new Date();
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    const sendAll = async () => {
      const clients = await pool.query('SELECT chat_id FROM users WHERE tg_chat_id IS NOT NULL AND meta_token IS NOT NULL');
      for (const row of clients.rows) {
        const r = await pool.query('SELECT * FROM users WHERE tg_chat_id = $1', [row.tg_chat_id]);
        const u = r.rows[0];
        if (!u) continue;
        try {
          const { campaigns, insights: i } = await getMetaData(u.meta_token, u.meta_account_id);
          const active = campaigns.filter(c => c.status === 'ACTIVE');
          if (!active.length) continue; // активті кампания жоқ болса хабар жібермейміз
          const campLines = active.map(c => `  • ${c.name}`).join('\n');
          await tgSend(u.tg_chat_id,
            `📊 <b>Күнделікті есеп</b>\n👤 ${u.name}\n\n` +
            `💰 $${parseFloat(i.spend||0).toFixed(2)} · 👆 ${i.clicks||0} клик\n\n` +
            `▶️ Активті кампания (${active.length}):\n${campLines}\n\n` +
            `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`
          );
        } catch(e) { console.error('Daily report error:', e.message); }
      }
    };
    await sendAll();
    setInterval(sendAll, 24 * 60 * 60 * 1000);
  }, next - now);
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

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await initDB();
  await setupWebhook();
  await scheduleDailyReports();
});
