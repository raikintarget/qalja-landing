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
async function getMetaData(token, accountId) {
  const [campsRes, insRes, accRes, adsetsRes, campInsRes] = await Promise.all([
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/campaigns`, {
      params: { access_token: token, fields: 'id,name,status,objective,daily_budget', limit: 20 }
    }),
    axios.get(`https://graph.facebook.com/v19.0/act_${accountId}/insights`, {
      params: { access_token: token, fields: 'impressions,clicks,spend,cpc,ctr,inline_link_clicks,actions', date_preset: 'yesterday', level: 'account' }
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
        date_preset: 'yesterday',
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
    await tgAnswer(cb.id);

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
  const [campInsRes, accInsRes] = await Promise.all([
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
    }).catch(() => ({ data: { data: [] } }))
  ]);

  const campData = campInsRes.data.data || [];
  const accIns = accInsRes.data.data?.[0] || {};

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

  let campLines = '';
  if (campData.length) {
    campLines = campData.map(c => {
      const sp = parseFloat(c.spend || 0).toFixed(2);
      const cl = parseInt(c.inline_link_clicks || c.clicks || 0);
      const conv = getConv(c.actions);
      return `  • <b>${c.campaign_name}</b>\n    💸 $${sp} · 👆 ${cl} клик${conv > 0 ? ` · 💬 ${conv} перепис.` : ''}`;
    }).join('\n');
  } else {
    campLines = '  Кешегі расход жоқ';
  }

  const dateLabel = yesterday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  const msg =
    `📊 <b>Күнделікті есеп · ${dateLabel}</b>\n` +
    `👤 ${u.name} · ${u.meta_account_name || accountId}\n\n` +
    `💸 Жиынтық расход: <b>$${totalSpend.toFixed(2)}</b>\n` +
    `👆 Кликтер: <b>${totalClicks}</b>\n` +
    (totalConv > 0 ? `💬 Хат алмасу: <b>${totalConv}</b>\n` : '') +
    `\n${campLines}\n\n` +
    `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`;

  return { msg, totalSpend, totalClicks, totalConv, campCount: campData.length };
}

async function scheduleDailyReports() {
  const now = new Date();
  // 03:00 UTC = 08:00 Алматы (UTC+5)
  const next = new Date();
  next.setUTCHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  console.log(`📅 Күнделікті есеп жоспарланды: ${next.toISOString()}`);

  setTimeout(async () => {
    const sendAll = async () => {
      const dateLabel = new Date(Date.now() - 86400000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      console.log(`📨 Күнделікті есептер жіберілуде (${dateLabel})...`);

      // tg_chat_id бар барлық клиенттерге жіберу (meta_token жоқта да — system user токенімен)
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

      // Супер-админге жалпы нәтиже жіберу
      if (ADMIN_TG_CHAT_ID) {
        const summary = results.length
          ? results.map(r => `${r.status} — ${r.name}`).join('\n')
          : 'Клиент жоқ';
        await tgSend(ADMIN_TG_CHAT_ID,
          `🤖 <b>SmartTarget — Есеп жіберу нәтижесі · ${dateLabel}</b>\n\n${summary}\n\nЖалпы: ${results.length} клиент`
        ).catch(() => {});
      }

      console.log(`✅ Күнделікті есептер аяқталды: ${results.length} клиент`);
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

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await initDB();
  await setupWebhook();
  await setupBotCommands();
  await scheduleDailyReports();
});
