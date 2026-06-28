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
      created_at TIMESTAMP DEFAULT NOW()
    );
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
    tg_connected: !!user.tg_chat_id });
});

// Шығу
app.post('/api/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
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
// FACEBOOK OAUTH
// ══════════════════════════════

// OAuth старт — session токенін state-ке қосамыз
app.get('/auth/facebook', async (req, res) => {
  const sessionToken = req.query.session || '';
  // state = sessionToken:randomBytes (кейін callback-та парсиламыз)
  const rand = crypto.randomBytes(8).toString('hex');
  const state = sessionToken ? `${sessionToken}:${rand}` : rand;

  // State-ті DB-ге сақта
  await pool.query(
    'INSERT INTO tg_link_tokens (token, user_id) VALUES ($1, $2) ON CONFLICT (token) DO NOTHING',
    [state, null]
  );

  const scope = 'ads_management,ads_read,business_management';
  const url = `https://www.facebook.com/v19.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${scope}&state=${encodeURIComponent(state)}&response_type=code`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;
  if (error) return res.redirect('/ai-targetolog-onboarding.html?error=access_denied');

  try {
    const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
      params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: REDIRECT_URI, code }
    });
    const { access_token } = tokenRes.data;

    const [adsRes] = await Promise.all([
      axios.get('https://graph.facebook.com/v19.0/me/adaccounts', {
        params: { access_token, fields: 'id,name,account_status', limit: 10 }
      })
    ]);

    const adAccount = adsRes.data.data?.[0];
    const accountId = adAccount?.id?.replace('act_', '');
    const state = decodeURIComponent(rawState || '');

    // State-тен session токенін алу: "sessionToken:rand" форматы
    const sessionToken = state.includes(':') ? state.split(':')[0] : null;

    if (sessionToken) {
      // Веб арқылы — session-дан user табып, DB-ге сақтаймыз
      const user = await getUserBySession(sessionToken);
      if (user) {
        await pool.query(
          'UPDATE users SET meta_token=$1, meta_account_id=$2, meta_account_name=$3 WHERE id=$4',
          [access_token, accountId, adAccount?.name, user.id]
        );
        // Telegram-ға хабар
        if (user.tg_chat_id) {
          await tgSend(user.tg_chat_id,
            `✅ <b>Facebook Ads байланысты!</b>\n📊 Аккаунт: ${adAccount?.name}\n\n/report деп жазыңыз!`
          );
        }
        // Дашбордқа redirect — байланысты деген белгімен
        return res.redirect('/ai-targetolog-app.html?fb_connected=1');
      }
    }

    // Тіркелмеген пайдаланушы үшін — деректерді URL-ге қосып жіберу
    const payload = encodeURIComponent(JSON.stringify({
      token: access_token, adAccounts: adsRes.data.data || []
    }));
    res.redirect(`/ai-targetolog-onboarding.html?meta=${payload}`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/ai-targetolog-onboarding.html?error=oauth_failed');
  }
});

// ── Партнерский доступ — клиент Business Manager ID береді ──
app.post('/api/connect/partner', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  const { bm_id } = req.body;
  if (!sessionToken || !bm_id) return res.status(400).json({ error: 'Missing params' });

  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // System User токенімізбен клиенттің BM-ін тексер
  const sysToken = process.env.META_ACCESS_TOKEN;
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${bm_id}/owned_ad_accounts`, {
      params: { access_token: sysToken, fields: 'id,name,account_status', limit: 5 }
    });
    const accounts = r.data.data || [];
    if (!accounts.length) {
      return res.status(400).json({ error: 'Аккаунт табылмады. Партнер доступ дұрыс берілді ме?' });
    }
    const acc = accounts[0];
    const accountId = acc.id.replace('act_', '');
    await pool.query(
      'UPDATE users SET meta_token=$1, meta_account_id=$2, meta_account_name=$3 WHERE id=$4',
      [sysToken, accountId, acc.name, user.id]
    );
    res.json({ ok: true, account: acc.name, account_id: accountId });
  } catch(e) {
    res.status(400).json({ error: 'Партнер доступ жоқ немесе BM ID дұрыс емес' });
  }
});

// ── Инстаграм/Facebook жоқ — мәліметтерді сақта ──
app.post('/api/connect/manual', async (req, res) => {
  const sessionToken = req.headers.authorization?.replace('Bearer ', '');
  const { ig_login, wa_phone, notes } = req.body;
  if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });

  const user = await getUserBySession(sessionToken);
  if (!user) return res.status(401).json({ error: 'Invalid session' });

  // Мәліметтерді сақта — менеджер байланысады
  await pool.query(
    'UPDATE users SET meta_account_name=$1 WHERE id=$2',
    [`MANUAL:${ig_login || ''}:${wa_phone || ''}`, user.id]
  );

  // Adminге хабар (болашақта Telegram-ға жіберіледі)
  console.log(`📥 Жаңа клиент (қолмен): ${user.name} | IG: ${ig_login} | WA: ${wa_phone}`);

  res.json({ ok: true, message: 'Менеджер 1-2 сағат ішінде байланысады' });
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

  if (text === '/start') {
    await tgSend(chatId,
      `👋 <b>SmartTarget AI</b>\n\n` +
      `Мен сіздің AI-таргетологыңызбын.\n\n` +
      `📊 Күн сайын рекламаңыздың нәтижесін жіберіп тұрамын.\n\n` +
      `Бастау үшін платформаға кіріп, Telegram-ды байланыстырыңыз:\n` +
      `👉 <a href="${BASE_URL}/ai-targetolog-app.html">SmartTarget AI →</a>\n\n` +
      `Немесе кодыңызды жіберіңіз: /link XXXX`
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
      const active = campaigns.filter(c => c.status === 'ACTIVE').length;
      await tgSend(chatId,
        `📊 <b>Күнделікті есеп</b>\n` +
        `👤 ${user.name} · ${user.meta_account_name}\n\n` +
        `💰 Шығын бүгін: <b>$${parseFloat(i.spend||0).toFixed(2)}</b>\n` +
        `👆 Клик: <b>${i.clicks||0}</b>\n` +
        `👁 Көрсету: <b>${parseInt(i.impressions||0).toLocaleString()}</b>\n` +
        `💵 CPC: <b>$${parseFloat(i.cpc||0).toFixed(2)}</b>\n` +
        `📈 CTR: <b>${parseFloat(i.ctr||0).toFixed(2)}%</b>\n\n` +
        `📋 Кампания: ${campaigns.length} (${active} активті)\n\n` +
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
          const active = campaigns.filter(c => c.status === 'ACTIVE').length;
          await tgSend(u.tg_chat_id,
            `📊 <b>Күнделікті есеп</b>\n👤 ${u.name}\n\n` +
            `💰 $${parseFloat(i.spend||0).toFixed(2)} · 👆 ${i.clicks||0} клик · 📋 ${active} активті кампания\n\n` +
            `🔗 <a href="${BASE_URL}/ai-targetolog-app.html">Дашборд →</a>`
          );
        } catch(e) { console.error('Daily report error:', e.message); }
      }
    };
    await sendAll();
    setInterval(sendAll, 24 * 60 * 60 * 1000);
  }, next - now);
}

app.listen(PORT, async () => {
  console.log(`SmartTarget AI server running on port ${PORT}`);
  await initDB();
  await setupWebhook();
  await scheduleDailyReports();
});
