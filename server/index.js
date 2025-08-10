// server/index.js
require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---- Map registry (expand as you add more maps) ----
const MAPS = {
  1: { width: 52, height: 100 },
  // 2: { width: 52, height: 100 }, // etc.
};

function getMapSize(mapId) {
  const m = MAPS[mapId] || MAPS[1];
  return { w: m.width, h: m.height };
}

// ---- Chat guard / limits (unchanged) ----
const MAX_CHAT_LEN = 200;
const sqlLikePattern = /(select|insert|update|delete|drop|alter|truncate|merge|exec|union|;|--|\/\*|\*\/|xp_)/i;
const looksMalicious = (t) =>
  !t || typeof t !== 'string' || t.length > MAX_CHAT_LEN || sqlLikePattern.test(t);

// ---- HTTP (Render health) ----
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('DragonSpires server is running\n');
});

// ---- WebSocket ----
const wss = new WebSocket.Server({ server });

const clients = new Map();      // Map<ws, playerData>
const usernameToWs = new Map(); // Map<username, ws>

// ---- DB helpers ----
async function loadPlayer(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0];
}
async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y)
     VALUES ($1, $2, 1, 5, 5) RETURNING *`,
    [username, hashed]
  );
  return r.rows[0];
}
async function updatePosition(id, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, id]);
}
async function updateStatsInDb(id, fields) {
  const sets = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=$${i++}`); vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE players SET ${sets.join(', ')} WHERE id=$${i}`, vals);
}

// ---- Messaging ----
const send = (ws, obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// ---- WebSocket events ----
wss.on('connection', (ws) => {
  let player = null;

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // LOGIN
    if (msg.type === 'login') {
      try {
        const row = await loadPlayer(msg.username);
        if (!row) return send(ws, { type: 'login_error', message: 'User not found' });
        const ok = await bcrypt.compare(msg.password, row.password);
        if (!ok) return send(ws, { type: 'login_error', message: 'Invalid password' });

        const prev = usernameToWs.get(row.username);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { prev.close(); } catch {}
        }

        player = {
          id: row.id,
          username: row.username,
          map_id: row.map_id || 1,
          pos_x: row.pos_x, pos_y: row.pos_y,
          stamina: row.stamina ?? 10, max_stamina: row.max_stamina ?? 10,
          life: row.life ?? 20, max_life: row.max_life ?? 20,
          magic: row.magic ?? 0, max_magic: row.max_magic ?? 0,
          gold: row.gold ?? 0, weapon: row.weapon ?? '', armor: row.armor ?? '', hands: row.hands ?? ''
        };

        clients.set(ws, player);
        usernameToWs.set(player.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== player.id);
        const { w, h } = getMapSize(player.map_id);

        send(ws, { type: 'login_success', player, players: others, map: { width: w, height: h, map_id: player.map_id } });
        broadcast({ type: 'player_joined', player });
      } catch (e) {
        console.error('login error', e);
        send(ws, { type: 'login_error', message: 'Server error' });
      }
      return;
    }

    // SIGNUP
    if (msg.type === 'signup') {
      try {
        const exists = await loadPlayer(msg.username);
        if (exists) return send(ws, { type: 'signup_error', message: 'Username taken' });

        const row = await createPlayer(msg.username, msg.password);

        const prev = usernameToWs.get(row.username);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { prev.close(); } catch {}
        }

        player = {
          id: row.id,
          username: row.username,
          map_id: row.map_id || 1,
          pos_x: row.pos_x, pos_y: row.pos_y,
          stamina: row.stamina ?? 10, max_stamina: row.max_stamina ?? 10,
          life: row.life ?? 20, max_life: row.max_life ?? 20,
          magic: row.magic ?? 0, max_magic: row.max_magic ?? 0,
          gold: row.gold ?? 0, weapon: row.weapon ?? '', armor: row.armor ?? '', hands: row.hands ?? ''
        };

        clients.set(ws, player);
        usernameToWs.set(player.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== player.id);
        const { w, h } = getMapSize(player.map_id);

        send(ws, { type: 'signup_success', player, players: others, map: { width: w, height: h, map_id: player.map_id } });
        broadcast({ type: 'player_joined', player });
      } catch (e) {
        console.error('signup error', e);
        send(ws, { type: 'signup_error', message: 'Server error' });
      }
      return;
    }

    // MOVE
    if (msg.type === 'move') {
      if (!player) return;

      if ((player.stamina ?? 0) <= 0) {
        send(ws, { type: 'stats_update', id: player.id, stamina: player.stamina });
        return;
      }

      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const nx = player.pos_x + dx;
      const ny = player.pos_y + dy;
      const { w, h } = getMapSize(player.map_id);

      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        // stamina cost 1 per move
        player.stamina = Math.max(0, (player.stamina ?? 0) - 1);
        player.pos_x = nx; player.pos_y = ny;

        Promise.allSettled([
          updateStatsInDb(player.id, { stamina: player.stamina }),
          updatePosition(player.id, nx, ny)
        ]).catch(() => {});

        broadcast({ type: 'player_moved', id: player.id, x: nx, y: ny });
        send(ws, { type: 'stats_update', id: player.id, stamina: player.stamina });
      }
      return;
    }

    // CHAT
    if (msg.type === 'chat') {
      if (!player || typeof msg.text !== 'string') return;
      const t = msg.text.trim();
      if (looksMalicious(t)) return send(ws, { type: 'chat_error' });
      broadcast({ type: 'chat', text: `${player.username}: ${t}` });
      return;
    }
  });

  ws.on('close', () => {
    if (player) {
      clients.delete(ws);
      usernameToWs.delete(player.username);
      broadcast({ type: 'player_left', id: player.id });
    }
  });

  ws.on('error', (e) => console.warn('WS error', e));
});

// ---- Regeneration loops (unchanged) ----
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

setInterval(async () => {
  const ups = [];
  for (const [ws, p] of clients) {
    const inc = Math.floor((p.max_stamina ?? 0) * 0.10);
    const next = clamp((p.stamina ?? 0) + inc, 0, p.max_stamina ?? 0);
    if (next !== p.stamina) {
      p.stamina = next;
      ups.push({ id: p.id, stamina: p.stamina });
      send(ws, { type: 'stats_update', id: p.id, stamina: p.stamina });
    }
  }
  for (const u of ups) try { await updateStatsInDb(u.id, { stamina: u.stamina }); } catch {}
}, 3000);

setInterval(async () => {
  const ups = [];
  for (const [ws, p] of clients) {
    const inc = Math.max(1, Math.floor((p.max_life ?? 0) * 0.05));
    const next = clamp((p.life ?? 0) + inc, 0, p.max_life ?? 0);
    if (next !== p.life) {
      p.life = next;
      ups.push({ id: p.id, life: p.life });
      send(ws, { type: 'stats_update', id: p.id, life: p.life });
    }
  }
  for (const u of ups) try { await updateStatsInDb(u.id, { life: u.life }); } catch {}
}, 5000);

setInterval(async () => {
  const ups = [];
  for (const [ws, p] of clients) {
    const next = clamp((p.magic ?? 0) + 5, 0, p.max_magic ?? 0);
    if (next !== p.magic) {
      p.magic = next;
      ups.push({ id: p.id, magic: p.magic });
      send(ws, { type: 'stats_update', id: p.id, magic: p.magic });
    }
  }
  for (const u of ups) try { await updateStatsInDb(u.id, { magic: u.magic }); } catch {}
}, 30000);

// ---- Start ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
