require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { DatabaseSync } = require('node:sqlite');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Database ─────────────────────────────────────────────
// On Railway use volume mount path, locally use __dirname
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.db')
  : path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  -- Сотрудники (люди за компьютером)
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,       -- браузерный fingerprint или UUID, генерируется расширением
    name TEXT,                 -- имя сотрудника (настраивается в popup)
    is_online INTEGER DEFAULT 0,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Профили девушек (аккаунты на сайте)
  CREATE TABLE IF NOT EXISTS profiles (
    ulid TEXT PRIMARY KEY,     -- ulid_id девушки с сайта
    name TEXT,
    photo TEXT,
    worker_id TEXT,            -- какой сотрудник сейчас работает с этим профилем
    is_active INTEGER DEFAULT 1,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Диалоги (привязаны к профилю девушки)
  CREATE TABLE IF NOT EXISTS dialogs (
    id INTEGER,
    profile_ulid TEXT,         -- ulid девушки
    worker_id TEXT,            -- сотрудник который работает
    contact_ulid TEXT,
    contact_name TEXT,
    contact_country TEXT,
    contact_credits TEXT,
    contact_is_online INTEGER DEFAULT 0,
    last_message_body TEXT,
    last_message_at TEXT,
    last_message_incoming INTEGER DEFAULT 0,
    unread_count INTEGER DEFAULT 0,
    contact_unread_count INTEGER DEFAULT 0,
    is_saved INTEGER DEFAULT 0,
    ai_score INTEGER DEFAULT NULL,
    ai_comment TEXT DEFAULT NULL,
    ai_tips TEXT DEFAULT NULL,
    ai_analyzed_at TEXT DEFAULT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (id, profile_ulid)
  );

  -- Сообщения
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    dialog_id INTEGER,
    profile_ulid TEXT,
    worker_id TEXT,
    contact_ulid TEXT,
    is_incoming INTEGER,
    body TEXT,
    type INTEGER,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Письма
  CREATE TABLE IF NOT EXISTS mails (
    id INTEGER PRIMARY KEY,
    profile_ulid TEXT,
    worker_id TEXT,
    contact_ulid TEXT,
    contact_name TEXT,
    subject TEXT,
    body TEXT,
    is_incoming INTEGER,
    is_read INTEGER DEFAULT 0,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Алерты
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT,
    profile_ulid TEXT,
    profile_name TEXT,
    contact_ulid TEXT,
    contact_name TEXT,
    type TEXT,
    message TEXT,
    severity TEXT DEFAULT 'medium',
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- События
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT,
    profile_ulid TEXT,
    type TEXT,
    payload TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Anthropic Claude AI ──────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
});
const aiQueue = [];
let aiProcessing = false;

async function analyzeDialogWithAI(dialogId, profileUlid, profileName, contactName, messages) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') {
    return { score: null, comment: 'Claude API key not configured', tips: [] };
  }
  try {
    const msgText = messages.slice(-30).map(m =>
      `${m.is_incoming ? contactName : profileName}: ${m.body}`
    ).join('\n');

    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: `You are a quality control manager for a dating platform. Operators (women) chat with male clients.
Analyze the conversation quality and return ONLY a valid JSON object with these fields:
- score: number 0-100 (quality score)
- comment: short summary in English (1-2 sentences)  
- tips: array of 2-3 specific improvement tips in English
- issues: array of detected problem types (e.g. "template_message", "too_short", "slow_response", "no_engagement", "generic")

Score criteria:
90-100: Excellent engagement, personalized, flirty, keeps conversation flowing
70-89: Good quality, mostly personalized
50-69: Average, some templates, could be more engaging
30-49: Poor quality, many templates, short replies
0-29: Very poor, ignored messages or completely generic

Return ONLY valid JSON, no other text.`,
      messages: [
        { role: 'user', content: `Analyze this conversation between operator "${profileName}" and client "${contactName}" (last 30 messages):\n\n${msgText}` }
      ]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    return { score: result.score || 50, comment: result.comment || '', tips: result.tips || [], issues: result.issues || [] };
  } catch (e) {
    console.error('Claude AI error:', e.message);
    return { score: null, comment: 'AI error: ' + e.message, tips: [] };
  }
}

async function processAIQueue() {
  if (aiProcessing || aiQueue.length === 0) return;
  aiProcessing = true;
  const item = aiQueue.shift();
  try {
    const result = await analyzeDialogWithAI(item.dialogId, item.profileUlid, item.profileName, item.contactName, item.messages);
    if (result.score !== null) {
      db.prepare(`UPDATE dialogs SET ai_score=?, ai_comment=?, ai_tips=?, ai_analyzed_at=datetime('now') WHERE id=? AND profile_ulid=?`)
        .run(result.score, result.comment, JSON.stringify(result.tips), item.dialogId, item.profileUlid);
      broadcastToAdmins({ type: 'ai_score_updated', dialogId: item.dialogId, profileUlid: item.profileUlid, workerId: item.workerId, ...result });
      // Send tips to the worker's extension
      broadcastToWorker(item.workerId, {
        type: 'ai_tips',
        profileName: item.profileName,
        profileUlid: item.profileUlid,
        contactName: item.contactName,
        contactUlid: item.contactUlid,
        score: result.score,
        tips: result.tips,
        comment: result.comment
      });
    }
  } catch(e) { console.error('processAIQueue error:', e.message); }
  aiProcessing = false;
  setTimeout(processAIQueue, 1500);
}

function queueAIAnalysis(dialogId, profileUlid, profileName, workerId, contactUlid, contactName, messages) {
  const exists = aiQueue.find(i => i.dialogId === dialogId && i.profileUlid === profileUlid);
  if (!exists) aiQueue.push({ dialogId, profileUlid, profileName, workerId, contactUlid, contactName, messages });
  processAIQueue();
}

// ─── WebSocket ────────────────────────────────────────────
const adminClients = new Set();
const workerClients = new Map(); // workerId -> Set of ws

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth_admin') {
        if (msg.secret === process.env.ADMIN_SECRET) {
          ws.role = 'admin';
          adminClients.add(ws);
          ws.send(JSON.stringify({ type: 'auth_ok', role: 'admin' }));
          ws.send(JSON.stringify({ type: 'initial_data', data: getFullState() }));
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
        }
      } else if (msg.type === 'auth_worker') {
        ws.role = 'worker';
        ws.workerId = msg.workerId;
        if (!workerClients.has(msg.workerId)) workerClients.set(msg.workerId, new Set());
        workerClients.get(msg.workerId).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok', role: 'worker' }));
      }
    } catch(e) {}
  });
  ws.on('close', () => {
    adminClients.delete(ws);
    if (ws.workerId && workerClients.has(ws.workerId)) {
      workerClients.get(ws.workerId).delete(ws);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  adminClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function broadcastToWorker(workerId, data) {
  const clients = workerClients.get(workerId);
  if (!clients) return;
  const msg = JSON.stringify(data);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ─── Full state ───────────────────────────────────────────
function getFullState() {
  const workers = db.prepare('SELECT * FROM workers ORDER BY is_online DESC, last_seen DESC').all();
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  const dialogs = db.prepare('SELECT * FROM dialogs ORDER BY last_message_at DESC').all();
  const alerts = db.prepare("SELECT * FROM alerts WHERE is_read=0 ORDER BY created_at DESC LIMIT 100").all();
  const mailStats = db.prepare(`
    SELECT profile_ulid, worker_id, COUNT(*) as total,
    SUM(CASE WHEN is_incoming=1 AND is_read=0 THEN 1 ELSE 0 END) as unread_incoming
    FROM mails GROUP BY profile_ulid
  `).all();
  // Worker stats
  const workerStats = workers.map(w => {
    const wProfiles = profiles.filter(p => p.worker_id === w.id);
    const wDialogs = dialogs.filter(d => d.worker_id === w.id);
    const onlineDialogs = wDialogs.filter(d => d.contact_is_online);
    const scored = wDialogs.filter(d => d.ai_score !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a,d) => a + d.ai_score, 0) / scored.length) : null;
    return { ...w, profileCount: wProfiles.length, dialogCount: wDialogs.length, onlineCount: onlineDialogs.length, avgScore };
  });
  return { workers: workerStats, profiles, dialogs, alerts, mailStats };
}

// ─── Alert system ─────────────────────────────────────────
function createAlert(workerId, profileUlid, profileName, contactUlid, contactName, type, message, severity) {
  db.prepare('INSERT INTO alerts (worker_id, profile_ulid, profile_name, contact_ulid, contact_name, type, message, severity) VALUES (?,?,?,?,?,?,?,?)')
    .run(workerId, profileUlid, profileName, contactUlid, contactName, type, message, severity || 'medium');
  const alert = { workerId, profileUlid, profileName, contactUlid, contactName, type, message, severity, created_at: new Date().toISOString() };
  broadcastToAdmins({ type: 'new_alert', alert });
  broadcastToWorker(workerId, { type: 'notification', ...alert });
}

setInterval(() => {
  const dialogs = db.prepare('SELECT * FROM dialogs WHERE last_message_incoming=1').all();
  const now = new Date();
  dialogs.forEach(d => {
    if (!d.last_message_at || !d.worker_id) return;
    const mins = (now - new Date(d.last_message_at)) / 60000;
    // Get profile name
    const profile = db.prepare('SELECT name FROM profiles WHERE ulid=?').get(d.profile_ulid);
    const profileName = profile ? profile.name : '?';
    if (d.contact_is_online && mins > 5) {
      const recent = db.prepare(`SELECT id FROM alerts WHERE worker_id=? AND profile_ulid=? AND contact_ulid=? AND type='online_waiting' AND created_at > datetime('now', '-10 minutes')`).get(d.worker_id, d.profile_ulid, d.contact_ulid);
      if (!recent) createAlert(d.worker_id, d.profile_ulid, profileName, d.contact_ulid, d.contact_name, 'online_waiting', `🟢 [${profileName}] ${d.contact_name} is ONLINE and waiting ${Math.round(mins)}min — reply NOW!`, 'high');
    } else if (mins > 30 && !d.contact_is_online) {
      const recent = db.prepare(`SELECT id FROM alerts WHERE worker_id=? AND profile_ulid=? AND contact_ulid=? AND type='slow_response' AND created_at > datetime('now', '-60 minutes')`).get(d.worker_id, d.profile_ulid, d.contact_ulid);
      if (!recent) createAlert(d.worker_id, d.profile_ulid, profileName, d.contact_ulid, d.contact_name, 'slow_response', `⚠️ [${profileName}] ${d.contact_name} waiting ${Math.round(mins)}min without reply`, 'medium');
    }
  });
}, 120000);

// ─── API Routes ───────────────────────────────────────────

// Extension: full sync (called every 30s per profile)
// workerId = сотрудник, profiles = массив всех профилей и их диалогов
app.post('/api/sync', (req, res) => {
  const { workerId, workerName, profiles, mails } = req.body;
  if (!workerId) return res.status(400).json({ error: 'workerId required' });

  // Upsert worker
  db.prepare(`INSERT INTO workers (id, name, is_online, last_seen) VALUES (?,?,1,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_online=1, last_seen=excluded.last_seen`)
    .run(workerId, workerName || 'Worker');

  const updatedDialogs = [];

  if (profiles && profiles.length) {
    profiles.forEach(profile => {
      const profileUlid = profile.ulid;
      if (!profileUlid) return;

      // Upsert profile → worker mapping
      db.prepare(`INSERT INTO profiles (ulid, name, photo, worker_id, last_seen) VALUES (?,?,?,?,datetime('now'))
        ON CONFLICT(ulid) DO UPDATE SET name=excluded.name, photo=excluded.photo, worker_id=excluded.worker_id, last_seen=excluded.last_seen`)
        .run(profileUlid, profile.name || '', profile.photo || '', workerId);

      // Upsert dialogs for this profile
      (profile.dialogs || []).forEach(d => {
        const contact = d.contact || {};
        db.prepare(`INSERT INTO dialogs
          (id, profile_ulid, worker_id, contact_ulid, contact_name, contact_country, contact_credits, contact_is_online,
           last_message_body, last_message_at, last_message_incoming, unread_count, contact_unread_count, is_saved, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
          ON CONFLICT(id, profile_ulid) DO UPDATE SET
            worker_id=excluded.worker_id,
            contact_is_online=excluded.contact_is_online,
            last_message_body=excluded.last_message_body,
            last_message_at=excluded.last_message_at,
            last_message_incoming=excluded.last_message_incoming,
            unread_count=excluded.unread_count,
            contact_unread_count=excluded.contact_unread_count,
            is_saved=excluded.is_saved,
            updated_at=datetime('now')`)
          .run(d.id, profileUlid, workerId, contact.ulid_id || '', contact.name || '',
            contact.country ? contact.country.name : '',
            contact.credits ? contact.credits.spend : '',
            contact.is_online ? 1 : 0,
            d.last_message_body || '', d.last_message_sent_at || '',
            d.is_last_message_incoming ? 1 : 0,
            d.unread_count || 0, d.contact_unread_count || 0, d.is_saved ? 1 : 0);
        updatedDialogs.push({ ...d, profile_ulid: profileUlid, worker_id: workerId });
      });

      // Queue AI analysis for top dialogs of this profile
      (profile.dialogs || []).slice(0, 3).forEach(d => {
        const msgs = db.prepare('SELECT * FROM messages WHERE profile_ulid=? AND contact_ulid=? ORDER BY sent_at DESC LIMIT 30')
          .all(profileUlid, d.contact && d.contact.ulid_id);
        if (msgs.length >= 3) {
          const row = db.prepare('SELECT ai_analyzed_at FROM dialogs WHERE id=? AND profile_ulid=?').get(d.id, profileUlid);
          const shouldAnalyze = !row || !row.ai_analyzed_at || (new Date() - new Date(row.ai_analyzed_at)) > 300000;
          if (shouldAnalyze) {
            queueAIAnalysis(d.id, profileUlid, profile.name, workerId, d.contact && d.contact.ulid_id, d.contact && d.contact.name, msgs.reverse());
          }
        }
      });
    });
  }

  // Mails
  if (mails && mails.length) {
    mails.forEach(m => {
      db.prepare(`INSERT OR IGNORE INTO mails (id, profile_ulid, worker_id, contact_ulid, contact_name, subject, body, is_incoming, is_read, sent_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(m.id, m.profile_ulid || '', workerId, m.contact_ulid || '', m.contact_name || '', m.subject || '', m.body || '', m.is_incoming ? 1 : 0, m.is_read ? 1 : 0, m.sent_at || '');
    });
  }

  broadcastToAdmins({ type: 'sync_update', workerId, workerName, dialogs: updatedDialogs });
  res.json({ ok: true, queued: aiQueue.length });
});

// Extension: send messages for a specific profile+contact
app.post('/api/messages', (req, res) => {
  const { workerId, profileUlid, contactUlid, messages } = req.body;
  if (!workerId || !profileUlid || !messages) return res.status(400).json({ error: 'Missing fields' });
  messages.forEach(m => {
    db.prepare(`INSERT OR IGNORE INTO messages (id, dialog_id, profile_ulid, worker_id, contact_ulid, is_incoming, body, type, sent_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(String(m.id), m.request_id || 0, profileUlid, workerId, contactUlid, m.is_incoming ? 1 : 0, m.body || '', m.type || 1, m.sent_at || '');
  });
  const allMsgs = db.prepare('SELECT * FROM messages WHERE profile_ulid=? AND contact_ulid=? ORDER BY sent_at ASC LIMIT 30').all(profileUlid, contactUlid);
  if (allMsgs.length >= 5) {
    const dialog = db.prepare('SELECT id, contact_name FROM dialogs WHERE profile_ulid=? AND contact_ulid=? LIMIT 1').get(profileUlid, contactUlid);
    const profile = db.prepare('SELECT name FROM profiles WHERE ulid=?').get(profileUlid);
    if (dialog) queueAIAnalysis(dialog.id, profileUlid, profile ? profile.name : '?', workerId, contactUlid, dialog.contact_name, allMsgs);
  }
  res.json({ ok: true });
});

app.post('/api/event', (req, res) => {
  const { workerId, profileUlid, type, payload } = req.body;
  db.prepare('INSERT INTO events (worker_id, profile_ulid, type, payload) VALUES (?,?,?,?)').run(workerId, profileUlid || '', type, JSON.stringify(payload || {}));
  broadcastToAdmins({ type: 'worker_event', workerId, profileUlid, eventType: type, payload });
  res.json({ ok: true });
});

app.post('/api/offline', (req, res) => {
  const { workerId } = req.body;
  db.prepare("UPDATE workers SET is_online=0, last_seen=datetime('now') WHERE id=?").run(workerId);
  broadcastToAdmins({ type: 'worker_offline', workerId });
  res.json({ ok: true });
});

// ─── Admin API ────────────────────────────────────────────
function checkAdmin(req, res) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' }); return false;
  }
  return true;
}

app.get('/api/admin/state', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(getFullState());
});

app.get('/api/admin/messages/:profileUlid/:contactUlid', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const msgs = db.prepare('SELECT * FROM messages WHERE profile_ulid=? AND contact_ulid=? ORDER BY sent_at ASC LIMIT 100')
    .all(req.params.profileUlid, req.params.contactUlid);
  res.json(msgs);
});

app.get('/api/admin/mails', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const workerId = req.query.worker_id;
  const profileUlid = req.query.profile_ulid;
  let query = 'SELECT * FROM mails';
  const params = [];
  const conditions = [];
  if (workerId) { conditions.push('worker_id=?'); params.push(workerId); }
  if (profileUlid) { conditions.push('profile_ulid=?'); params.push(profileUlid); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY sent_at DESC LIMIT 300';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/admin/alerts', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 500').all());
});

app.post('/api/admin/alerts/read', (req, res) => {
  if (!checkAdmin(req, res)) return;
  db.prepare('UPDATE alerts SET is_read=1').run();
  res.json({ ok: true });
});

app.post('/api/admin/analyze', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { dialogId, profileUlid } = req.body;
  const dialog = db.prepare('SELECT * FROM dialogs WHERE id=? AND profile_ulid=?').get(dialogId, profileUlid);
  if (!dialog) return res.status(404).json({ error: 'Dialog not found' });
  const profile = db.prepare('SELECT name FROM profiles WHERE ulid=?').get(profileUlid);
  const msgs = db.prepare('SELECT * FROM messages WHERE profile_ulid=? AND contact_ulid=? ORDER BY sent_at ASC LIMIT 30')
    .all(profileUlid, dialog.contact_ulid);
  queueAIAnalysis(dialogId, profileUlid, profile ? profile.name : '?', dialog.worker_id, dialog.contact_ulid, dialog.contact_name, msgs);
  res.json({ ok: true, queued: aiQueue.length });
});

app.use('/panel', express.static(path.join(__dirname, 'panel')));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime(), aiQueue: aiQueue.length }));

// ─── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🚀 Chatshouse Admin Backend running on port ${PORT}`);
  console.log(`📊 Admin Panel: http://localhost:${PORT}/panel`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`🔑 Admin Secret: ${process.env.ADMIN_SECRET}`);
  console.log(`🤖 Claude AI: ${process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here' ? `Configured ✓ (${process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001'})` : 'NOT configured'}\n`);
});
