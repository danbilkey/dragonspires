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

const MAP_WIDTH = 64;
const MAP_HEIGHT = 64;

const MAX_CHAT_LEN = 200;
const sqlLikePattern = /(select|insert|update|delete|drop|alter|truncate|merge|exec|union|;|--|\/\*|\*\/|xp_)/i;
function looksMalicious(text) {
  if (!text || typeof text !== 'string') return true;
  if (text.length > MAX_CHAT_LEN) return true;
  return sqlLikePattern.test(text);
}

// Animation constants
const ANIMATION_NAMES = [
  'down_walk_1', 'down', 'down_walk_2', 'down_attack_1', 'down_attack_2',
  'right_walk_1', 'right', 'right_walk_2', 'right_attack_1', 'right_attack_2',
  'left_walk_1', 'left', 'left_walk_2', 'left_attack_1', 'left_attack_2',
  'up_walk_1', 'up', 'up_walk_2', 'up_attack_1', 'up_attack_2',
  'stand', 'sit'
];

const DIRECTION_IDLE = {
  down: 1,   // down
  right: 6,  // right
  left: 11,  // left
  up: 16     // up
};

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('DragonSpires server is running\n');
});
const wss = new WebSocket.Server({ server });

const clients = new Map();      // Map<ws, playerData>
const usernameToWs = new Map(); // Map<username, ws>

async function loadPlayer(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0];
}

async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y, direction, is_moving, is_attacking, animation_frame)
     VALUES ($1, $2, 1, 5, 5, $3, $4, $5, $6) RETURNING *`,
    [username, hashed, 'down', false, false, DIRECTION_IDLE.down]
  );
  return r.rows[0];
}

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

async function updateAnimationState(playerId, direction, isMoving, isAttacking, animationFrame) {
  await pool.query(
    'UPDATE players SET direction=$1, is_moving=$2, is_attacking=$3, animation_frame=$4 WHERE id=$5',
    [direction, isMoving, isAttacking, animationFrame, playerId]
  );
}

async function updateStatsInDb(id, fields) {
  const cols = [], vals = [];
  let idx = 1;
  for (const [k,v] of Object.entries(fields)) { 
    cols.push(`${k}=$${idx++}`); 
    vals.push(v); 
  }
  vals.push(id);
  if (!cols.length) return;
  const sql = `UPDATE players SET ${cols.join(', ')} WHERE id=$${idx}`;
  await pool.query(sql, vals);
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Initialize database with animation columns if they don't exist
async function initializeDatabase() {
  try {
    // Add animation columns to players table if they don't exist
    await pool.query(`
      ALTER TABLE players 
      ADD COLUMN IF NOT EXISTS direction VARCHAR(10) DEFAULT 'down',
      ADD COLUMN IF NOT EXISTS is_moving BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_attacking BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS animation_frame INTEGER DEFAULT 1
    `);
    console.log('Database animation columns initialized');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Initialize database on startup
initializeDatabase();

wss.on('connection', (ws) => {
  let playerData = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'login') {
      try {
        const found = await loadPlayer(msg.username);
        if (!found) return send(ws, { type: 'login_error', message: 'User not found' });

        const ok = await bcrypt.compare(msg.password, found.password);
        if (!ok) return send(ws, { type: 'login_error', message: 'Invalid password' });

        // single-session: kick prior
        const prev = usernameToWs.get(found.username);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { prev.close(); } catch {}
        }

        playerData = {
          id: found.id,
          username: found.username,
          map_id: found.map_id,
          pos_x: found.pos_x,
          pos_y: found.pos_y,
          stamina: found.stamina ?? 10,
          max_stamina: found.max_stamina ?? 10,
          life: found.life ?? 20,
          max_life: found.max_life ?? 20,
          magic: found.magic ?? 0,
          max_magic: found.max_magic ?? 0,
          gold: found.gold ?? 0,
          weapon: found.weapon ?? '',
          armor: found.armor ?? '',
          hands: found.hands ?? '',
          direction: found.direction ?? 'down',
          isMoving: found.is_moving ?? false,
          isAttacking: found.is_attacking ?? false,
          animationFrame: found.animation_frame ?? DIRECTION_IDLE.down
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

    else if (msg.type === 'signup') {
      try {
        const existing = await loadPlayer(msg.username);
        if (existing) return send(ws, { type: 'signup_error', message: 'Username taken' });

        const created = await createPlayer(msg.username, msg.password);

        const prev = usernameToWs.get(created.username);
        if (prev && prev !== ws) {
          try { send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
          try { prev.close(); } catch {}
        }

        playerData = {
          id: created.id,
          username: created.username,
          map_id: created.map_id,
          pos_x: created.pos_x,
          pos_y: created.pos_y,
          stamina: created.stamina ?? 10,
          max_stamina: created.max_stamina ?? 10,
          life: created.life ?? 20,
          max_life: created.max_life ?? 20,
          magic: created.magic ?? 0,
          max_magic: created.max_magic ?? 0,
          gold: created.gold ?? 0,
          weapon: created.weapon ?? '',
          armor: created.armor ?? '',
          hands: created.hands ?? '',
          direction: created.direction ?? 'down',
          isMoving: created.is_moving ?? false,
          isAttacking: created.is_attacking ?? false,
          animationFrame: created.animation_frame ?? DIRECTION_IDLE.down
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

    else if (msg.type === 'move') {
      if (!playerData) return;

      // stamina gate
      if ((playerData.stamina ?? 0) <= 0) {
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        return;
      }

      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const nx = playerData.pos_x + dx;
      const ny = playerData.pos_y + dy;

      if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT) {
        // Decrement stamina by **1**
        playerData.stamina = Math.max(0, (playerData.stamina ?? 0) - 1);
        playerData.pos_x = nx;
        playerData.pos_y = ny;

        // Update animation state
        if (msg.direction) {
          playerData.direction = msg.direction;
        }
        if (typeof msg.isMoving === 'boolean') {
          playerData.isMoving = msg.isMoving;
        }
        if (typeof msg.animationFrame === 'number') {
          playerData.animationFrame = msg.animationFrame;
        }

        // Save to database
        Promise.allSettled([
          updateStatsInDb(playerData.id, { stamina: playerData.stamina }),
          updatePosition(playerData.id, nx, ny),
          updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, playerData.isAttacking, playerData.animationFrame)
        ]).catch(()=>{});

        broadcast({ 
          type: 'player_moved', 
          id: playerData.id, 
          x: nx, 
          y: ny, 
          direction: playerData.direction,
          isMoving: playerData.isMoving,
          animationFrame: playerData.animationFrame
        });
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
      }
    }

    else if (msg.type === 'animation_update') {
      if (!playerData) return;

      // Update animation state
      if (msg.direction) {
        playerData.direction = msg.direction;
      }
      if (typeof msg.isMoving === 'boolean') {
        playerData.isMoving = msg.isMoving;
      }
      if (typeof msg.isAttacking === 'boolean') {
        playerData.isAttacking = msg.isAttacking;
      }
      if (typeof msg.animationFrame === 'number') {
        playerData.animationFrame = msg.animationFrame;
      }

      // Save animation state to database
      updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, playerData.isAttacking, playerData.animationFrame)
        .catch(err => console.error('Animation update DB error:', err));

      // Broadcast animation update to all clients
      broadcast({
        type: 'animation_update',
        id: playerData.id,
        direction: playerData.direction,
        isMoving: playerData.isMoving,
        isAttacking: playerData.isAttacking,
        animationFrame: playerData.animationFrame
      });
    }

    else if (msg.type === 'chat') {
      if (!playerData || typeof msg.text !== 'string') return;
      const t = msg.text.trim();
      if (looksMalicious(t)) return send(ws, { type: 'chat_error' });
      broadcast({ type: 'chat', text: `${playerData.username}: ${t}` });
    }
  });

  ws.on('close', () => {
    if (playerData) {
      clients.delete(ws);
      usernameToWs.delete(playerData.username);
      broadcast({ type: 'player_left', id: playerData.id });
    }
  });

  ws.on('error', (err) => console.warn('WS error', err));
});

// ---------- Regeneration Loops ----------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Every 3s: stamina +10% max
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const inc = Math.floor((p.max_stamina ?? 0) * 0.10);
    const next = clamp((p.stamina ?? 0) + inc, 0, p.max_stamina ?? 0);
    if (next !== p.stamina) {
      p.stamina = next;
      updates.push({ id: p.id, stamina: p.stamina });
      send(ws, { type: 'stats_update', id: p.id, stamina: p.stamina });
    }
  }
  for (const u of updates) {
    try { await updateStatsInDb(u.id, { stamina: u.stamina }); } catch(e){ console.error('stam regen db', e); }
  }
}, 3000);

// Every 5s: life +5% max (min +1)
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const inc = Math.max(1, Math.floor((p.max_life ?? 0) * 0.05));
    const next = clamp((p.life ?? 0) + inc, 0, p.max_life ?? 0);
    if (next !== p.life) {
      p.life = next;
      updates.push({ id: p.id, life: p.life });
      send(ws, { type: 'stats_update', id: p.id, life: p.life });
    }
  }
  for (const u of updates) {
    try { await updateStatsInDb(u.id, { life: u.life }); } catch(e){ console.error('life regen db', e); }
  }
}, 5000);

// Every 30s: magic +5 flat
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const next = clamp((p.magic ?? 0) + 5, 0, p.max_magic ?? 0);
    if (next !== p.magic) {
      p.magic = next;
      updates.push({ id: p.id, magic: p.magic });
      send(ws, { type: 'stats_update', id: p.id, magic: p.magic });
    }
  }
  for (const u of updates) {
    try { await updateStatsInDb(u.id, { magic: u.magic }); } catch(e){ console.error('magic regen db', e); }
  }
}, 30000);

// Auto-stop attacking animation after 1 second of inactivity
setInterval(async () => {
  const now = Date.now();
  for (const [ws, p] of clients.entries()) {
    if (p.isAttacking && p.lastAttackTime && (now - p.lastAttackTime) > 1000) {
      p.isAttacking = false;
      p.animationFrame = DIRECTION_IDLE[p.direction] || DIRECTION_IDLE.down;
      
      // Update database
      updateAnimationState(p.id, p.direction, p.isMoving, false, p.animationFrame)
        .catch(err => console.error('Auto-stop attack DB error:', err));
      
      // Broadcast the change
      broadcast({
        type: 'animation_update',
        id: p.id,
        direction: p.direction,
        isMoving: p.isMoving,
        isAttacking: false,
        animationFrame: p.animationFrame
      });
    }
  }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
