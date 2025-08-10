require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- HTTP (health) ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DragonSpires server is running\n');
});

// --- WS ---
const wss = new WebSocket.Server({ server });

// Track sessions: ws -> playerId; username -> ws
const wsToPlayer = new Map();
const usernameToWs = new Map();

// Simple helpers
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj, exceptWs) {
  const str = JSON.stringify(obj);
  for (const ws of wsToPlayer.keys()) {
    if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}
async function getPlayerByUsername(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0] || null;
}
async function getPlayerById(id) {
  const r = await pool.query('SELECT * FROM players WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y,
      stamina, max_stamina, life, max_life, magic, max_magic, gold, weapon, armor, hands, role)
     VALUES ($1,$2,$3,$4,$5,  $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      username, hashed, 'lev01', 5, 5,
      100, 100, 100, 100, 30, 30, 0, '', '', '', 'player'
    ]
  );
  return r.rows[0];
}
async function updatePositionAndStamina(id, x, y, stamina) {
  await pool.query(
    'UPDATE players SET pos_x=$1,pos_y=$2,stamina=$3 WHERE id=$4',
    [x, y, stamina, id]
  );
}
async function updateVitals(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 1}`);
  const vals = keys.map(k => fields[k]);
  vals.push(id);
  await pool.query(`UPDATE players SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
}
async function listOnlinePlayers() {
  const ids = Array.from(wsToPlayer.values());
  if (!ids.length) return [];
  const r = await pool.query(`SELECT id,username,pos_x,pos_y FROM players WHERE id = ANY($1)`, [ids]);
  return r.rows;
}

// --- Map loading (Java-like) ---
const MW = 52, MH = 100;
const mapCache = new Map(); // key: 'lev01' -> { width,height,tilemap[x][y],itemmap[x][y] }

function decode2(a, b) {
  if (a == null || b == null) return 0;
  return ((a & 0xFF) << 8) | (b & 0xFF); // big-endian
}
function loadDsMap(mapId, floorCount, itemCount) {
  const key = String(mapId || 'lev01');
  if (mapCache.has(key)) return mapCache.get(key);

  const file = path.join(__dirname, 'maps', `${key}.dsmap`);
  const buf = fs.readFileSync(file);

  const pairsNeeded = MW * MH * 2; // tile + item blocks (each pair is 2 bytes)
  const bytesNeeded = pairsNeeded * 2;
  if (buf.length < bytesNeeded) {
    throw new Error(`${key}.dsmap too small: ${buf.length} < ${bytesNeeded}`);
  }

  const tilemap = Array.from({ length: MW }, () => new Array(MH).fill(0));
  const itemmap = Array.from({ length: MW }, () => new Array(MH).fill(0));

  let p = 0;
  // tiles
  for (let x = 0; x < MW; x++) {
    for (let y = 0; y < MH; y++) {
      let v = decode2(buf[p++], buf[p++]);
      if (v < 0 || v >= floorCount) v = 0;
      tilemap[x][y] = v; // x-major, matches Java
    }
  }
  // items
  for (let x = 0; x < MW; x++) {
    for (let y = 0; y < MH; y++) {
      let v = decode2(buf[p++], buf[p++]);
      if (v < 0 || v >= itemCount) v = 0;
      itemmap[x][y] = v;
    }
  }

  const out = { width: MW, height: MH, tilemap, itemmap };
  mapCache.set(key, out);
  return out;
}

// Counts (set these to your actual extracted totals)
const FLOOR_COUNT = 99;  // number of tiles in /assets/floor.png (0-based last index = FLOOR_COUNT-1)
const ITEM_COUNT = 512;

// --- Regen loops ---
setInterval(async () => {
  // stamina +10% max every 3s
  for (const [ws, pid] of wsToPlayer.entries()) {
    const p = await getPlayerById(pid);
    if (!p) continue;
    const inc = Math.max(1, Math.floor(p.max_stamina * 0.10));
    const ns = Math.min(p.max_stamina, (p.stamina || 0) + inc);
    if (ns !== p.stamina) {
      await updateVitals(p.id, { stamina: ns });
      send(ws, { type: 'vitals', stamina: ns });
    }
  }
}, 3000);

setInterval(async () => {
  // life +5% max every 5s
  for (const [ws, pid] of wsToPlayer.entries()) {
    const p = await getPlayerById(pid);
    if (!p) continue;
    const inc = Math.max(1, Math.floor(p.max_life * 0.05));
    const nv = Math.min(p.max_life, (p.life || 0) + inc);
    if (nv !== p.life) {
      await updateVitals(p.id, { life: nv });
      send(ws, { type: 'vitals', life: nv });
    }
  }
}, 5000);

setInterval(async () => {
  // magic +5 flat every 30s
  for (const [ws, pid] of wsToPlayer.entries()) {
    const p = await getPlayerById(pid);
    if (!p) continue;
    const inc = 5;
    const nm = Math.min(p.max_magic, (p.magic || 0) + inc);
    if (nm !== p.magic) {
      await updateVitals(p.id, { magic: nm });
      send(ws, { type: 'vitals', magic: nm });
    }
  }
}, 30000);

// --- WS handlers ---
wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'login') {
      const user = await getPlayerByUsername(msg.username);
      if (!user) return send(ws, { type: 'login_error', message: 'User not found' });
      const ok = await bcrypt.compare(msg.password, user.password);
      if (!ok) return send(ws, { type: 'login_error', message: 'Invalid password' });

      // single-session: kick any existing
      const prev = usernameToWs.get(user.username);
      if (prev && prev !== ws) {
        send(prev, { type: 'chat', text: 'Disconnected: logged in from another game instance.' });
        try { prev.close(); } catch {}
      }

      playerId = user.id;
      wsToPlayer.set(ws, playerId);
      usernameToWs.set(user.username, ws);

      // map by varchar id (e.g., "lev01")
      const map = loadDsMap(user.map_id || 'lev01', FLOOR_COUNT, ITEM_COUNT);

      const online = await listOnlinePlayers();
      send(ws, {
        type: 'login_success',
        player: user,
        players: online.filter(p => p.id !== user.id),
        map
      });
      broadcast({ type: 'player_joined', player: { id: user.id, username: user.username, pos_x: user.pos_x, pos_y: user.pos_y } }, ws);
      return;
    }

    if (msg.type === 'signup') {
      const exists = await getPlayerByUsername(msg.username);
      if (exists) return send(ws, { type: 'signup_error', message: 'Username taken' });

      const user = await createPlayer(msg.username, msg.password);
      playerId = user.id;
      wsToPlayer.set(ws, playerId);
      usernameToWs.set(user.username, ws);

      const map = loadDsMap('lev01', FLOOR_COUNT, ITEM_COUNT);
      const online = await listOnlinePlayers();

      send(ws, {
        type: 'signup_success',
        player: user,
        players: online.filter(p => p.id !== user.id),
        map
      });
      broadcast({ type: 'player_joined', player: { id: user.id, username: user.username, pos_x: user.pos_x, pos_y: user.pos_y } }, ws);
      return;
    }

    if (msg.type === 'move' && playerId) {
      const p = await getPlayerById(playerId);
      if (!p) return;
      // stamina gate (cost 1)
      if ((p.stamina || 0) <= 0) return; // can't move
      const nx = p.pos_x + (msg.dx | 0);
      const ny = p.pos_y + (msg.dy | 0);
      if (nx < 0 || nx >= MW || ny < 0 || ny >= MH) return;

      const newStam = Math.max(0, (p.stamina || 0) - 1);
      await updatePositionAndStamina(p.id, nx, ny, newStam);
      broadcast({ type: 'player_moved', id: p.id, x: nx, y: ny });
      send(ws, { type: 'vitals', stamina: newStam });
      return;
    }

    if (msg.type === 'chat' && playerId) {
      const p = await getPlayerById(playerId);
      if (!p) return;

      const text = String(msg.text || '');
      // basic validations
      const MAX = 200;
      if (!text || text.length > MAX) {
        return send(ws, { type: 'chat', text: '~ The game has rejected your message due to bad language.' });
      }
      // very naive SQL-ish filter
      const bad = /(union\s+select|insert\s+into|drop\s+table|;--|--|\/\*|\*\/)/i.test(text);
      if (bad) {
        return send(ws, { type: 'chat', text: '~ The game has rejected your message due to bad language.' });
      }

      // admin refresh: "-refresh PLAYER"
      if (/^-refresh\s+\S+/i.test(text)) {
        if ((p.role || '').toLowerCase() === 'admin') {
          const targetName = text.trim().split(/\s+/)[1];
          const tWs = usernameToWs.get(targetName);
          if (tWs) {
            const tRow = await getPlayerByUsername(targetName);
            if (tRow) {
              const fields = {
                stamina: tRow.max_stamina,
                life: tRow.max_life,
                magic: tRow.max_magic
              };
              await updateVitals(tRow.id, fields);
              send(tWs, { type: 'vitals', ...fields });
              send(ws, { type: 'chat', text: `~ Refreshed ${targetName}.` });
            }
          } else {
            send(ws, { type: 'chat', text: `~ Player ${targetName} is not online.` });
          }
        } else {
          send(ws, { type: 'chat', text: '~ You are not authorized to take that action.' });
        }
        return;
      }

      // normal broadcast
      const out = { type: 'chat', text: `${p.username}: ${text}` };
      broadcast(out);
      send(ws, out);
      return;
    }
  });

  ws.on('close', async () => {
    if (playerId) {
      const p = await getPlayerById(playerId).catch(() => null);
      if (p) broadcast({ type: 'player_left', id: p.id });
      wsToPlayer.delete(ws);
      if (p) {
        const cur = usernameToWs.get(p.username);
        if (cur === ws) usernameToWs.delete(p.username);
      }
    }
  });
});

// --- Listen ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});
