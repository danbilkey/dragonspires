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

// Map size (authoritative bounds)
const MAP_WIDTH = 64;
const MAP_HEIGHT = 64;

// Chat limits / filters
const MAX_CHAT_LEN = 200; // reasonable anti-spam cap
const sqlLikePattern = /(select|insert|update|delete|drop|alter|truncate|merge|exec|union|;|--|\/\*|\*\/|xp_)/i;
function looksMalicious(text) {
  if (!text || typeof text !== 'string') return true;
  if (text.length > MAX_CHAT_LEN) return true;
  return sqlLikePattern.test(text);
}

// HTTP health check
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DragonSpires server is running\n');
});

const wss = new WebSocket.Server({ server });

// Active sessions
const clients = new Map();      // Map<ws, player>
const usernameToWs = new Map(); // Map<username, ws>

// DB helpers
async function loadPlayer(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0];
}

async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  // relying on DB defaults for new stats columns
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y)
     VALUES ($1, $2, 1, 5, 5) RETURNING *`,
    [username, hashed]
  );
  return r.rows[0];
}

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

// Messaging helpers
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  let playerData = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // LOGIN
    if (msg.type === 'login') {
      try {
        const found = await loadPlayer(msg.username);
        if (!found) return send(ws, { type: 'login_error', message: 'User not found' });

        const ok = await bcrypt.compare(msg.password, found.password);
        if (!ok) return send(ws, { type: 'login_error', message: 'Invalid password' });

        // Kick previous session if any
        const existingWs = usernameToWs.get(found.username);
        if (existingWs && existingWs !== ws) {
          try { send(existingWs, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { existingWs.close(); } catch {}
        }

        // Prepare playerData with extended fields
        playerData = {
          id: found.id,
          username: found.username,
          map_id: found.map_id,
          pos_x: found.pos_x,
          pos_y: found.pos_y,
          stamina: found.stamina,
          max_stamina: found.max_stamina,
          life: found.life,
          max_life: found.max_life,
          magic: found.magic,
          max_magic: found.max_magic,
          gold: found.gold,
          weapon: found.weapon,
          armor: found.armor,
          hands: found.hands,
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        send(ws, { type: 'login_success', player: playerData, players: others });

        broadcast({ type: 'player_joined', player: playerData });
      } catch (e) {
        console.error('Login error', e);
        send(ws, { type: 'login_error', message: 'Server error' });
      }
    }

    // SIGNUP
    else if (msg.type === 'signup') {
      try {
        const existing = await loadPlayer(msg.username);
        if (existing) return send(ws, { type: 'signup_error', message: 'Username taken' });

        const created = await createPlayer(msg.username, msg.password);

        // if some old session (unlikely)
        const existingWs = usernameToWs.get(created.username);
        if (existingWs && existingWs !== ws) {
          try { send(existingWs, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { existingWs.close(); } catch {}
        }

        playerData = {
          id: created.id,
          username: created.username,
          map_id: created.map_id,
          pos_x: created.pos_x,
          pos_y: created.pos_y,
          stamina: created.stamina,
          max_stamina: created.max_stamina,
          life: created.life,
          max_life: created.max_life,
          magic: created.magic,
          max_magic: created.max_magic,
          gold: created.gold,
          weapon: created.weapon,
          armor: created.armor,
          hands: created.hands,
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        send(ws, { type: 'signup_success', player: playerData, players: others });

        broadcast({ type: 'player_joined', player: playerData });
      } catch (e) {
        console.error('Signup error', e);
        send(ws, { type: 'signup_error', message: 'Server error' });
      }
    }

    // MOVE
    else if (msg.type === 'move') {
      if (!playerData) return;
      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const newX = playerData.pos_x + dx;
      const newY = playerData.pos_y + dy;
      if (newX >= 0 && newX < MAP_WIDTH && newY >= 0 && newY < MAP_HEIGHT) {
        playerData.pos_x = newX;
        playerData.pos_y = newY;
        updatePosition(playerData.id, newX, newY).catch(err => console.error('DB update pos failed', err));
        broadcast({ type: 'player_moved', id: playerData.id, x: newX, y: newY });
      }
    }

    // CHAT
    else if (msg.type === 'chat') {
      if (!playerData || typeof msg.text !== 'string') return;
      const text = msg.text.trim();
      if (looksMalicious(text)) {
        return send(ws, { type: 'chat_error' });
      }
      const line = `${playerData.username}: ${text}`;
      broadcast({ type: 'chat', text: line });
    }
  });

  ws.on('close', () => {
    if (playerData) {
      clients.delete(ws);
      usernameToWs.delete(playerData.username);
      broadcast({ type: 'player_left', id: playerData.id });
    }
  });

  ws.on('error', (err) => {
    console.warn('WS error', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
