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

// Map size: use 64x64 as requested (server-side authoritative bounds)
const MAP_WIDTH = 64;
const MAP_HEIGHT = 64;

// tiny HTTP server for Render health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DragonSpires server is running\n');
});

const wss = new WebSocket.Server({ server });

// Track logged-in sessions
// Map<ws, playerObj>
const clients = new Map();
// Map<username, ws>
const usernameToWs = new Map();

// DB helpers
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

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

// Broadcast to all currently logged-in clients
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const [ws] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Send chat to a ws (or broadcast if ws === null)
function sendChat(wsTarget, text) {
  const obj = JSON.stringify({ type: 'chat', text });
  if (!wsTarget) {
    for (const [ws] of clients.entries()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(obj);
    }
  } else {
    if (wsTarget.readyState === WebSocket.OPEN) {
      wsTarget.send(obj);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('New WS connection');

  // Will hold player's db record after successful login/signup
  let playerData = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // LOGIN
    if (msg.type === 'login') {
      try {
        const found = await loadPlayer(msg.username);
        if (!found) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'User not found' }));
          return;
        }
        const ok = await bcrypt.compare(msg.password, found.password);
        if (!ok) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'Invalid password' }));
          return;
        }

        // If existing active session for the username, notify it and close it
        const existingWs = usernameToWs.get(found.username);
        if (existingWs && existingWs !== ws) {
          try {
            // send chat message to old session
            existingWs.send(JSON.stringify({ type: 'chat', text: 'Disconnected: logged in from another game instance.' }));
          } catch (e) {}
          try { existingWs.close(); } catch (e) {}
        }

        // set as logged-in
        playerData = {
          id: found.id,
          username: found.username,
          map_id: found.map_id,
          pos_x: found.pos_x,
          pos_y: found.pos_y
        };
        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        // prepare list of currently logged-in players (exclude this one)
        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        ws.send(JSON.stringify({ type: 'login_success', player: playerData, players: others }));

        // announce to others
        broadcast({ type: 'player_joined', player: playerData });

      } catch (e) {
        console.error('Login error', e);
        ws.send(JSON.stringify({ type: 'login_error', message: 'Server error' }));
      }
    }

    // SIGNUP
    else if (msg.type === 'signup') {
      try {
        const existing = await loadPlayer(msg.username);
        if (existing) {
          ws.send(JSON.stringify({ type: 'signup_error', message: 'Username taken' }));
          return;
        }
        const created = await createPlayer(msg.username, msg.password);

        // disconnect old session if any (unlikely on signup)
        const existingWs = usernameToWs.get(created.username);
        if (existingWs && existingWs !== ws) {
          try { existingWs.send(JSON.stringify({ type: 'chat', text: 'Disconnected: logged in from another game instance.' })); } catch(e){}
          try { existingWs.close(); } catch(e){}
        }

        playerData = {
          id: created.id,
          username: created.username,
          map_id: created.map_id,
          pos_x: created.pos_x,
          pos_y: created.pos_y
        };
        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        ws.send(JSON.stringify({ type: 'signup_success', player: playerData, players: others }));
        broadcast({ type: 'player_joined', player: playerData });

      } catch (e) {
        console.error('Signup error', e);
        ws.send(JSON.stringify({ type: 'signup_error', message: 'Server error' }));
      }
    }

    // MOVE
    else if (msg.type === 'move') {
      // require logged in
      if (!playerData) return;
      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const newX = playerData.pos_x + dx;
      const newY = playerData.pos_y + dy;
      if (newX >= 0 && newX < MAP_WIDTH && newY >= 0 && newY < MAP_HEIGHT) {
        playerData.pos_x = newX;
        playerData.pos_y = newY;
        // persist best-effort
        updatePosition(playerData.id, newX, newY).catch(err => console.error('DB update pos failed', err));
        // broadcast authoritative update to logged-in clients
        broadcast({ type: 'player_moved', id: playerData.id, x: newX, y: newY });
      } else {
        // ignore moves out of bounds
      }
    }

    // (optional) future: handle chat messages sent by clients, etc.
  });

  ws.on('close', () => {
    // cleanup logged-in tracking
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

// Listen on 0.0.0.0 for Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
