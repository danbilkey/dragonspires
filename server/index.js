// server/index.js
require('dotenv').config();
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const http = require('http');

// DB pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Map dimensions (matches your map.json 10x10)
const MAP_WIDTH = 64;
const MAP_HEIGHT = 64;

// tiny HTTP server for Render health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DragonSpires server is running\n');
});

const wss = new WebSocket.Server({ server });

// Track logged-in players and their sockets
// clients: Map<ws, player> where player is { id, username, pos_x, pos_y, map_id }
// usernameToWs: Map<username, ws>
const clients = new Map();
const usernameToWs = new Map();

async function loadPlayer(username) {
  const result = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return result.rows[0];
}

async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y)
     VALUES ($1, $2, 1, 5, 5) RETURNING *`,
    [username, hashed]
  );
  return result.rows[0];
}

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

// helper: broadcast only to logged-in clients
function broadcast(data) {
  const str = JSON.stringify(data);
  for (const [ws, player] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

// helper: send a chat message to a specific ws (or broadcast if ws === null)
function sendChat(wsTarget, text) {
  const payload = JSON.stringify({ type: 'chat', text });
  if (wsTarget) {
    if (wsTarget.readyState === WebSocket.OPEN) wsTarget.send(payload);
  } else {
    // broadcast
    for (const [ws] of clients.entries()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

// When a new client connects
wss.on('connection', (ws) => {
  console.log('New connection');

  // We'll set playerData when they login/signup successfully
  let playerData = null;

  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // LOGIN
    if (data.type === 'login') {
      try {
        const found = await loadPlayer(data.username);
        if (!found) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'User not found' }));
          return;
        }
        const match = await bcrypt.compare(data.password, found.password);
        if (!match) {
          ws.send(JSON.stringify({ type: 'login_error', message: 'Invalid password' }));
          return;
        }

        // If someone else is logged in with this username, disconnect them first
        const existingWs = usernameToWs.get(found.username);
        if (existingWs && existingWs !== ws) {
          // notify the old connection (chat) then close it
          try {
            existingWs.send(JSON.stringify({ type: 'chat', text: 'Disconnected: logged in from another game instance.' }));
          } catch (e) { /* ignore */ }
          try { existingWs.close(); } catch (e) { /* ignore */ }
          // fall through and allow new login
        }

        // Mark this ws as logged in
        playerData = {
          id: found.id,
          username: found.username,
          map_id: found.map_id,
          pos_x: found.pos_x,
          pos_y: found.pos_y
        };
        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        // Prepare list of currently logged-in players (exclude the newly logged in player)
        const otherPlayers = Array.from(clients.values()).filter(p => p.id !== playerData.id);

        // send login_success with players list
        ws.send(JSON.stringify({ type: 'login_success', player: playerData, players: otherPlayers }));

        // broadcast to other logged-in clients that a player joined
        broadcast({ type: 'player_joined', player: playerData });

      } catch (err) {
        console.error("Login error", err);
        ws.send(JSON.stringify({ type: 'login_error', message: 'Server error' }));
      }
    }

    // SIGNUP
    else if (data.type === 'signup') {
      try {
        const existing = await loadPlayer(data.username);
        if (existing) {
          ws.send(JSON.stringify({ type: 'signup_error', message: 'Username taken' }));
          return;
        }
        const newPlayer = await createPlayer(data.username, data.password);

        // if someone was logged in with this username (unlikely on create) disconnect them
        const existingWs = usernameToWs.get(newPlayer.username);
        if (existingWs && existingWs !== ws) {
          try {
            existingWs.send(JSON.stringify({ type: 'chat', text: 'Disconnected: logged in from another game instance.' }));
          } catch (e) {}
          try { existingWs.close(); } catch (e) {}
        }

        playerData = {
          id: newPlayer.id,
          username: newPlayer.username,
          map_id: newPlayer.map_id,
          pos_x: newPlayer.pos_x,
          pos_y: newPlayer.pos_y
        };
        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const otherPlayers = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        ws.send(JSON.stringify({ type: 'signup_success', player: playerData, players: otherPlayers }));

        broadcast({ type: 'player_joined', player: playerData });
      } catch (err) {
        console.error("Signup error", err);
        ws.send(JSON.stringify({ type: 'signup_error', message: 'Server error' }));
      }
    }

    // MOVE
    else if (data.type === 'move') {
      if (!playerData) return;
      // validate dx/dy are numbers
      const dx = Number(data.dx) || 0;
      const dy = Number(data.dy) || 0;
      const newX = playerData.pos_x + dx;
      const newY = playerData.pos_y + dy;
      // bounds check against MAP_WIDTH/MAP_HEIGHT
      if (newX >= 0 && newX < MAP_WIDTH && newY >= 0 && newY < MAP_HEIGHT) {
        playerData.pos_x = newX;
        playerData.pos_y = newY;
        // persist to DB (best-effort, don't block)
        updatePosition(playerData.id, newX, newY).catch(err => console.error("Failed to update DB pos", err));
        // broadcast to other logged-in clients
        broadcast({ type: 'player_moved', id: playerData.id, x: newX, y: newY });
      } else {
        // ignore invalid moves
      }
    }

    // You can add more message handling (chat sending by player, NPC interactions, etc.)
  });

  ws.on('close', () => {
    // cleanup if this ws was a logged-in player
    if (playerData) {
      clients.delete(ws);
      usernameToWs.delete(playerData.username);
      // broadcast player_left to remaining logged-in clients
      broadcast({ type: 'player_left', id: playerData.id });
    }
  });

  ws.on('error', (err) => {
    console.warn('WS error on connection:', err);
  });
});

// listen on 0.0.0.0 for Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
});
