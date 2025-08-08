require('dotenv').config();
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const http = require('http');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Simple map dimensions (adjust to your actual map size)
const map = {
    width: 64,
    height: 64
};

// HTTP server just for Render health checks + a friendly page
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('DragonSpires server is running\n');
});

// WebSocket server (attach to HTTP server)
const wss = new WebSocket.Server({ server });

let clients = new Map();

function broadcast(data) {
    const str = JSON.stringify(data);
    for (let ws of clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(str);
        }
    }
}

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
    await pool.query(
        `UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3`,
        [x, y, playerId]
    );
}

async function getAllPlayers() {
    const res = await pool.query(
        'SELECT id, username, map_id, pos_x, pos_y FROM players'
    );
    return res.rows;
}

async function sendLoginSuccess(ws, player) {
    const allPlayers = await getAllPlayers();

    ws.send(JSON.stringify({
        type: 'login_success',
        player,
        players: allPlayers.filter(p => p.id !== player.id)
    }));

    // Now broadcast to others that this player joined
    broadcast({
        type: 'player_joined',
        player
    });
}

wss.on('connection', (ws) => {
    console.log("New connection");
    let playerData = null;

    ws.on('message', async (msg) => {
        let data;
        try {
            data = JSON.parse(msg);
        } catch {
            return;
        }

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
                await sendLoginSuccess(ws, player);
            } else {
                ws.send(JSON.stringify({ type: 'login_error', message: 'Invalid password' }));
            }
        }
        else if (data.type === 'signup') {
            const existing = await loadPlayer(data.username);
            if (existing) {
                ws.send(JSON.stringify({ type: 'signup_error', message: 'Username taken' }));
                return;
            }
            const player = await createPlayer(data.username, data.password);
            playerData = player;
            clients.set(ws, player.id);
            await sendLoginSuccess(ws, player);
        }
        else if (data.type === 'move' && playerData) {
            const newX = playerData.pos_x + data.dx;
            const newY = playerData.pos_y + data.dy;

            // Bounds check
            if (newX >= 0 && newX < map.width && newY >= 0 && newY < map.height) {
                playerData.pos_x = newX;
                playerData.pos_y = newY;
                await updatePosition(playerData.id, newX, newY);
                broadcast({
                    type: 'player_moved',
                    id: playerData.id,
                    x: newX,
                    y: newY
                });
            } else {
                // Optionally send error or ignore
                console.log(`Move blocked for player ${playerData.username}: (${newX}, ${newY}) out of bounds`);
            }
        }
    });

    ws.on('close', () => {
        if (playerData) {
            broadcast({ type: 'player_left', id: playerData.id });
            clients.delete(ws);
        }
    });
});

// IMPORTANT: Listen on 0.0.0.0 for Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
