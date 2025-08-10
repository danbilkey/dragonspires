// server.js
// Postgres-backed server using the existing `players` table.
// Features: signup/login (bcrypt), single-session per user, online-players only,
// 52x100 (from map{map_id}.json) movement bounds, move stamina cost=1,
// regen timers, chat with -refresh PLAYER (admin only).

require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

// ---------- DB (Postgres) ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helpers
async function getPlayerByUsername(username) {
  const r = await pool.query(`SELECT * FROM players WHERE username=$1`, [username]);
  return r.rows[0] || null;
}
async function createPlayer({ username, password }) {
  const hashed = await bcrypt.hash(password, 10);
  // Defaults; make sure these columns exist in your `players` table.
  const r = await pool.query(
    `INSERT INTO players
      (username, password, role, map_id, pos_x, pos_y,
       stamina, max_stamina, life, max_life, magic, max_magic,
       gold, weapon, armor, hands)
     VALUES ($1,$2,COALESCE($3,'user'),COALESCE($4,1),COALESCE($5,26),COALESCE($6,50),
             COALESCE($7,100),COALESCE($8,100),COALESCE($9,100),COALESCE($10,100),
             COALESCE($11,30),COALESCE($12,30),COALESCE($13,0),
             COALESCE($14,''),COALESCE($15,''),COALESCE($16,''))
     RETURNING *`,
    [username, hashed, 'user', 1, 26, 50, 100, 100, 100, 100, 30, 30, 0, '', '', '']
  );
  return r.rows[0];
}
async function updatePlayerFields(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=$${i+2}`).join(', ');
  const vals = keys.map(k => fields[k]);
  await pool.query(`UPDATE players SET ${set} WHERE id=$1`, [id, ...vals]);
}

// ---------- Map bounds via map{map_id}.json ----------
const mapCache = new Map(); // map_id -> {width,height}
function getMapDims(map_id = 1) {
  if (mapCache.has(map_id)) return mapCache.get(map_id);
  try {
    const file = path.join(__dirname, `map${map_id}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const m = JSON.parse(raw);
    const dims = { width: Number(m.width) || 52, height: Number(m.height) || 100 };
    mapCache.set(map_id, dims);
    return dims;
  } catch {
    const dims = { width: 52, height: 100 };
    mapCache.set(map_id, dims);
    return dims;
  }
}

// ---------- HTTP + WS ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('DragonSpires server is running\n');
});
const wss = new WebSocket.Server({ server });

// Online state
const clients = new Map();        // ws -> session
const byUsername = new Map();     // username -> ws

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, exceptWs = null) {
  const s = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(s);
  });
}
function sanitizePlayer(p) {
  return {
    id: p.id, username: p.username,
    map_id: p.map_id, pos_x: p.pos_x, pos_y: p.pos_y,
    stamina: p.stamina, max_stamina: p.max_stamina,
    life: p.life, max_life: p.max_life,
    magic: p.magic, max_magic: p.max_magic,
    gold: p.gold, weapon: p.weapon, armor: p.armor, hands: p.hands,
    role: p.role
  };
}
function onlineList(exceptUsername) {
  const arr = [];
  for (const [ws, p] of clients.entries()) {
    if (p.username !== exceptUsername) {
      arr.push({ id: p.id, username: p.username, pos_x: p.pos_x, pos_y: p.pos_y });
    }
  }
  return arr;
}

// Chat validation
const CHAT_MAX = 200;
const BAD_RE = /(--|;|\/\*|\*\/|\b(drop|delete|insert|update|select|union|alter|create|grant)\b)/i;

// ---------- Regen ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function statsPacket(p) {
  return {
    type: 'stats_update',
    stats: {
      stamina: p.stamina, max_stamina: p.max_stamina,
      life: p.life, max_life: p.max_life,
      magic: p.magic, max_magic: p.max_magic,
      gold: p.gold, weapon: p.weapon, armor: p.armor, hands: p.hands
    }
  };
}
setInterval(async () => {
  for (const [ws, p] of clients.entries()) {
    const inc = Math.max(1, Math.floor((p.max_stamina || 0) * 0.10));
    const before = p.stamina || 0;
    p.stamina = clamp(before + inc, 0, p.max_stamina || before);
    if (p.stamina !== before) {
      send(ws, statsPacket(p));
      await updatePlayerFields(p.id, { stamina: p.stamina });
    }
  }
}, 3000);
setInterval(async () => {
  for (const [ws, p] of clients.entries()) {
    const inc = Math.max(1, Math.floor((p.max_life || 0) * 0.05));
    const before = p.life || 0;
    p.life = clamp(before + inc, 0, p.max_life || before);
    if (p.life !== before) {
      send(ws, statsPacket(p));
      await updatePlayerFields(p.id, { life: p.life });
    }
  }
}, 5000);
setInterval(async () => {
  for (const [ws, p] of clients.entries()) {
    const before = p.magic || 0;
    p.magic = clamp(before + 5, 0, p.max_magic || before);
    if (p.magic !== before) {
      send(ws, statsPacket(p));
      await updatePlayerFields(p.id, { magic: p.magic });
    }
  }
}, 30000);

// ---------- WS handlers ----------
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const me = clients.get(ws);

    // --- SIGNUP ---
    if (msg.type === 'signup') {
      const { username, password } = msg;
      if (!username || !password) { send(ws, { type: 'signup_error', message: 'Missing fields' }); return; }
      try {
        const existing = await getPlayerByUsername(username);
        if (existing) { send(ws, { type: 'signup_error', message: 'Username taken' }); return; }
        const row = await createPlayer({ username, password });
        const p = sanitizePlayer(row);

        // attach session
        clients.set(ws, p);
        byUsername.set(p.username, ws);

        send(ws, { type: 'signup_success', player: p, players: onlineList(p.username) });
        broadcast({ type: 'player_joined', player: { id: p.id, username: p.username, pos_x: p.pos_x, pos_y: p.pos_y } }, ws);
      } catch (e) {
        console.error('signup', e);
        send(ws, { type: 'signup_error', message: 'Signup failed' });
      }
      return;
    }

    // --- LOGIN ---
    if (msg.type === 'login') {
      const { username, password } = msg;
      if (!username || !password) { send(ws, { type: 'login_error', message: 'Missing fields' }); return; }

      try {
        const row = await getPlayerByUsername(username);
        if (!row) { send(ws, { type: 'login_error', message: 'Invalid credentials' }); return; }

        // Support hashed or legacy plaintext
        const stored = row.password || '';
        let ok = false;
        if (stored.startsWith('$2')) {
          try { ok = await bcrypt.compare(password, stored); } catch { ok = false; }
        } else {
          ok = stored === password;
        }
        if (!ok) { send(ws, { type: 'login_error', message: 'Invalid credentials' }); return; }

        // Kick previous session (if any)
        const prev = byUsername.get(username);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { prev.close(); } catch {}
        }

        const p = sanitizePlayer(row);
        clients.set(ws, p);
        byUsername.set(p.username, ws);

        send(ws, { type: 'login_success', player: p, players: onlineList(p.username) });
        broadcast({ type: 'player_joined', player: { id: p.id, username: p.username, pos_x: p.pos_x, pos_y: p.pos_y } }, ws);
      } catch (e) {
        console.error('login', e);
        send(ws, { type: 'login_error', message: 'Login failed' });
      }
      return;
    }

    // From here on, must be authenticated
    if (!me) return;

    // --- MOVE ---
    if (msg.type === 'move') {
      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;

      // stamina gate
      if ((me.stamina || 0) <= 0) {
        send(ws, statsPacket(me));
        return;
      }

      const { width, height } = getMapDims(me.map_id || 1);
      const nx = me.pos_x + dx, ny = me.pos_y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;

      me.pos_x = nx; me.pos_y = ny;
      me.stamina = Math.max(0, (me.stamina || 0) - 1);

      // persist pos + stamina
      try { await updatePlayerFields(me.id, { pos_x: me.pos_x, pos_y: me.pos_y, stamina: me.stamina }); } catch {}

      // echo to mover + others
      send(ws, { type: 'player_moved', id: me.id, username: me.username, x: me.pos_x, y: me.pos_y });
      send(ws, statsPacket(me));
      broadcast({ type: 'player_moved', id: me.id, username: me.username, x: me.pos_x, y: me.pos_y }, ws);
      return;
    }

    // --- CHAT ---
    if (msg.type === 'chat' && typeof msg.text === 'string') {
      const text = msg.text.trim();

      // admin -refresh PLAYER
      if (text.toLowerCase().startsWith('-refresh ')) {
        if ((me.role || '').toLowerCase() !== 'admin') {
          send(ws, { type: 'chat', text: '~ You are not authorized to take that action.' });
          return;
        }
        const targetName = text.slice(9).trim();
        const tWs = byUsername.get(targetName);
        if (!tWs) { send(ws, { type: 'chat', text: `~ Could not find player "${targetName}" online.` }); return; }
        const tp = clients.get(tWs);
        if (!tp) { send(ws, { type: 'chat', text: `~ Could not find player "${targetName}" online.` }); return; }

        tp.stamina = tp.max_stamina;
        tp.life = tp.max_life;
        tp.magic = tp.max_magic;
        try { await updatePlayerFields(tp.id, { stamina: tp.stamina, life: tp.life, magic: tp.magic }); } catch {}

        send(tWs, statsPacket(tp));
        send(ws, { type: 'chat', text: `~ Refreshed ${tp.username}.` });
        return;
      }

      if (!text || text.length > CHAT_MAX || BAD_RE.test(text)) {
        send(ws, { type: 'chat', text: '~ The game has rejected your message due to bad language.' });
        return;
      }

      broadcast({ type: 'chat', text: `${me.username}: ${text}` });
      return;
    }
  });

  ws.on('close', async () => {
    const p = clients.get(ws);
    if (!p) return;
    clients.delete(ws);
    if (byUsername.get(p.username) === ws) byUsername.delete(p.username);

    // persist last-known position/stats (best-effort)
    try { await updatePlayerFields(p.id, {
      pos_x: p.pos_x, pos_y: p.pos_y,
      stamina: p.stamina, life: p.life, magic: p.magic
    }); } catch {}

    broadcast({ type: 'player_left', id: p.id });
  });
});

// ---- Listen on 0.0.0.0 for Render ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
