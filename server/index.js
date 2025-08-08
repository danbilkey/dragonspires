// server/index.js
// Basic Node.js WebSocket authoritative server for isometric RPG

require('dotenv').config();
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// Database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

let clients = new Map(); // Map<ws, playerId>

// Broadcast helper
function broadcast(data) {
    const str = JSON.stringify(data);
    for (let ws of clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(str);
        }
    }
}

// Load player data
async function loadPlayer(username) {
    const result = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
    return result.rows[0];
}

// Create new player
async function createPlayer(username, password) {
    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
        `INSERT INTO players (username, password, map_id, pos_x, pos_y)
         VALUES ($1, $2, 1, 5, 5) RETURNING *`,
        [username, hashed]
    );
    return result.rows[0];
}

// Update player position in DB
async function updatePosition(playerId, x, y) {
    await pool.query(
        `UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3`,
        [x, y, playerId]
    );
}

wss.on('connection', (ws) => {
    console.log("New connection");

    let playerData = null;

    ws.on('message', async (msg) => {
        let data;
        try { data = JSON.parse(msg); }
        catch { return; }

        // Handle login
        if (data.type === 'login') {
            const player = await loadPlayer(data.username);
            if (!player) {
                ws.send(JSON.stringify({ type: 'login_error', message: 'User not found' }));
                return;
            }
            const match = await bcrypt.compare(data.password, player.password);
            if (match) {
                playerData = player;
                clients.set(ws, player.id);
                ws.send(JSON.stringify({ type: 'login_success', player }));
                broadcast({ type: 'player_joined', player });
            } else {
                ws.send(JSON.stringify({ type: 'login_error', message: 'Invalid password' }));
            }
        }

        // Handle signup
        else if (data.type === 'signup') {
            const existing = await loadPlayer(data.username);
            if (existing) {
                ws.send(JSON.stringify({ type: 'signup_error', message: 'Username taken' }));
                return;
            }
            const player = await createPlayer(data.username, data.password);
            playerData = player;
            clients.set(ws, player.id);
            ws.send(JSON.stringify({ type: 'signup_success', player }));
            broadcast({ type: 'player_joined', player });
        }

        // Handle movement
        else if (data.type === 'move' && playerData) {
            playerData.pos_x += data.dx;
            playerData.pos_y += data.dy;
            await updatePosition(playerData.id, playerData.pos_x, playerData.pos_y);
            broadcast({ type: 'player_moved', id: playerData.id, x: playerData.pos_x, y: playerData.pos_y });
        }
    });

    ws.on('close', () => {
        if (playerData) {
            broadcast({ type: 'player_left', id: playerData.id });
            clients.delete(ws);
        }
    });
});

console.log("Server running...");
