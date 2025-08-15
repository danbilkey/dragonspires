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

// Attack animation pairs
const ATTACK_SEQUENCES = {
  down: [3, 4],   // down_attack_1, down_attack_2
  right: [8, 9],  // right_attack_1, right_attack_2
  left: [13, 14], // left_attack_1, left_attack_2
  up: [18, 19]    // up_attack_1, up_attack_2
};

// Movement animation sequence: walk_1 -> walk_2 -> idle
const MOVEMENT_SEQUENCE = ['walk_1', 'walk_2', 'idle'];

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('DragonSpires server is running\n');
});
const wss = new WebSocket.Server({ server });

const clients = new Map();      // Map<ws, playerData>
const usernameToWs = new Map(); // Map<username, ws>
const attackTimeouts = new Map(); // Map<playerId, timeoutId> for attack timeouts
const playerAttackIndex = new Map(); // Map<playerId, attackIndex> for alternating attacks

// In-memory item storage
let mapItems = {}; // { "x,y": itemId }

// Item details for server-side collision checking
let itemDetails = [];
let itemDetailsReady = false;

// Floor collision data
let floorCollision = [];
let floorCollisionReady = false;

// Load floor collision data on server startup
async function loadFloorCollision() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Try multiple possible paths for floorcollision.json
    const possiblePaths = [
      path.join(__dirname, 'assets', 'floorcollision.json'),
      path.join(__dirname, '..', 'assets', 'floorcollision.json'),
      path.join(__dirname, '..', 'client', 'assets', 'floorcollision.json'),
      path.join(__dirname, '..', '..', 'assets', 'floorcollision.json'),
      path.join(__dirname, '..', '..', 'client', 'assets', 'floorcollision.json'),
      path.join(process.cwd(), 'assets', 'floorcollision.json'),
      path.join(process.cwd(), 'client', 'assets', 'floorcollision.json'),
      path.join(process.cwd(), 'server', 'assets', 'floorcollision.json')
    ];
    
    let data = null;
    let usedPath = null;
    
    for (const collisionPath of possiblePaths) {
      try {
        data = await fs.readFile(collisionPath, 'utf8');
        usedPath = collisionPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.error('Could not find floorcollision.json in any of the expected paths:', possiblePaths);
      floorCollisionReady = true; // Don't block server startup
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && Array.isArray(parsed.floor)) {
      floorCollision = parsed.floor;
      floorCollisionReady = true;
      console.log(`Server loaded floor collision data: ${floorCollision.length} tiles from: ${usedPath}`);
    }
  } catch (error) {
    console.error('Failed to load floor collision data:', error);
    floorCollisionReady = true; // Don't block server startup
  }
}

function hasFloorCollision(x, y) {
  if (!floorCollisionReady || !floorCollision || !serverMapSpec || 
      x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) {
    return false; // No collision data, no map spec, or out of bounds
  }
  
  // Get the floor tile ID at this position
  const tileId = (serverMapSpec.tiles && serverMapSpec.tiles[y] && 
                  typeof serverMapSpec.tiles[y][x] !== 'undefined') 
                  ? serverMapSpec.tiles[y][x] : 0;
  
  // If no tile (ID 0) or tile ID is out of range, no collision
  if (tileId <= 0 || tileId > floorCollision.length) {
    return false;
  }
  
  // Look up collision for this tile ID (convert to 0-based index)
  return floorCollision[tileId - 1] === true || floorCollision[tileId - 1] === "true";
}

function isPlayerAtPosition(x, y, excludePlayerId = null) {
  for (const [ws, playerData] of clients.entries()) {
    if (excludePlayerId && playerData.id === excludePlayerId) continue;
    if (playerData.pos_x === x && playerData.pos_y === y) {
      return true;
    }
  }
  return false;
}

// Load item details on server startup
async function loadItemDetails() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Try multiple possible paths for itemdetails.json
    const possiblePaths = [
      path.join(__dirname, 'assets', 'itemdetails.json'),
      path.join(__dirname, '..', 'assets', 'itemdetails.json'),
      path.join(__dirname, '..', 'client', 'assets', 'itemdetails.json'),
      path.join(__dirname, '..', '..', 'assets', 'itemdetails.json'),
      path.join(__dirname, '..', '..', 'client', 'assets', 'itemdetails.json'),
      path.join(__dirname, '..', '..', 'server', 'assets', 'itemdetails.json'), // For Render structure
      path.join(process.cwd(), 'assets', 'itemdetails.json'),
      path.join(process.cwd(), 'client', 'assets', 'itemdetails.json'),
      path.join(process.cwd(), 'server', 'assets', 'itemdetails.json'),
      // Additional paths for potential Render deployment structure
      path.join(process.cwd(), 'src', 'server', 'assets', 'itemdetails.json'),
      path.join(process.cwd(), 'src', 'assets', 'itemdetails.json'),
      path.join(process.cwd(), 'src', 'client', 'assets', 'itemdetails.json')
    ];
    
    let data = null;
    let usedPath = null;
    
    // Debug: log all paths being tried
    console.log('Searching for itemdetails.json in these paths:');
    for (const itemDetailsPath of possiblePaths) {
      console.log(`  Trying: ${itemDetailsPath}`);
      try {
        data = await fs.readFile(itemDetailsPath, 'utf8');
        usedPath = itemDetailsPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.error('Could not find itemdetails.json in any of the expected paths');
      console.log('Current working directory:', process.cwd());
      console.log('__dirname:', __dirname);
      itemDetailsReady = true; // Don't block server startup
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && Array.isArray(parsed.items)) {
      itemDetails = parsed.items.map((item, index) => ({
        id: index + 1,
        name: item[0],
        collision: item[1] === "true",
        type: item[2],
        statMin: parseInt(item[3]) || 0,
        statMax: parseInt(item[4]) || 0,
        description: item[5]
      }));
      itemDetailsReady = true;
      console.log(`Server loaded ${itemDetails.length} item details from: ${usedPath}`);
    }
  } catch (error) {
    console.error('Failed to load server item details:', error);
    itemDetailsReady = true; // Don't block server startup
  }
}

function getItemDetails(itemId) {
  if (!itemDetailsReady || !itemDetails || itemId < 1 || itemId > itemDetails.length) {
    return null;
  }
  return itemDetails[itemId - 1];
}

function getItemAtPosition(x, y, mapSpec) {
  // Check both map items and placed items
  const mapItem = (mapSpec && mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined') 
    ? mapSpec.items[y][x] : 0;
  const placedItem = mapItems[`${x},${y}`];
  
  // If there's a placed item entry (but not -1 which means "picked up"), it overrides the map item
  if (placedItem !== undefined && placedItem !== -1) {
    return placedItem;
  }
  
  // If placedItem is -1, it means the map item was picked up, so return 0
  if (placedItem === -1) {
    return 0;
  }
  
  // Otherwise return the map item
  return mapItem;
}

// We need to load the map spec on server for proper item detection
let serverMapSpec = null;

async function loadMapSpec() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    // Try multiple possible paths for map.json including /maps/ directory
    const possiblePaths = [
      path.join(__dirname, '..', 'maps', 'map.json'),
      path.join(__dirname, 'maps', 'map.json'),
      path.join(__dirname, '..', '..', 'maps', 'map.json'),
      path.join(process.cwd(), 'maps', 'map.json'),
      path.join(__dirname, '..', 'map.json'),
      path.join(__dirname, 'map.json'),
      path.join(__dirname, '..', '..', 'map.json'),
      path.join(process.cwd(), 'map.json')
    ];
    
    let data = null;
    let usedPath = null;
    
    for (const mapPath of possiblePaths) {
      try {
        data = await fs.readFile(mapPath, 'utf8');
        usedPath = mapPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.error('Could not find map.json in any of the expected paths:', possiblePaths);
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && parsed.width && parsed.height) {
      serverMapSpec = {
        width: parsed.width,
        height: parsed.height,
        tiles: Array.isArray(parsed.tiles) ? parsed.tiles : (Array.isArray(parsed.tilemap) ? parsed.tilemap : []),
        items: Array.isArray(parsed.items) ? parsed.items : []
      };
      console.log(`Server loaded map spec from: ${usedPath}`);
      console.log(`Map dimensions: ${serverMapSpec.width}x${serverMapSpec.height}`);
      console.log(`Map has ${serverMapSpec.items.length} item rows`);
      if (serverMapSpec.items.length > 0) {
        console.log(`Sample items row 0:`, serverMapSpec.items[0]);
      }
    }
  } catch (error) {
    console.error('Failed to load map spec on server:', error);
  }
}

async function loadPlayer(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0];
}

async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y, direction, is_moving, is_attacking, animation_frame, movement_sequence_index)
     VALUES ($1, $2, 1, 5, 5, $3, $4, $5, $6, $7) RETURNING *`,
    [username, hashed, 'down', false, false, DIRECTION_IDLE.down, 0]
  );
  return r.rows[0];
}

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

async function updateAnimationState(playerId, direction, isMoving, isAttacking, animationFrame, movementSequenceIndex) {
  await pool.query(
    'UPDATE players SET direction=$1, is_moving=$2, is_attacking=$3, animation_frame=$4, movement_sequence_index=$5 WHERE id=$6',
    [direction, isMoving, isAttacking, animationFrame, movementSequenceIndex, playerId]
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

async function saveItemToDatabase(x, y, itemId) {
  try {
    await pool.query(
      'INSERT INTO map_items (x, y, item_id) VALUES ($1, $2, $3) ON CONFLICT (x, y) DO UPDATE SET item_id = $3',
      [x, y, itemId]
    );
  } catch (error) {
    console.error('Error saving item to database:', error);
  }
}

async function loadItemsFromDatabase() {
  try {
    const result = await pool.query('SELECT x, y, item_id FROM map_items');
    const items = {};
    result.rows.forEach(row => {
      // Include all entries, including -1 (picked up map items)
      items[`${row.x},${row.y}`] = row.item_id;
    });
    return items;
  } catch (error) {
    console.error('Error loading items from database:', error);
    return {};
  }
}

// Function to clear all map items from database and memory
async function clearAllMapItems() {
  try {
    await pool.query('DELETE FROM map_items');
    mapItems = {}; // Clear in-memory items
    console.log('All map items cleared from database and memory');
    return true;
  } catch (error) {
    console.error('Error clearing map items:', error);
    return false;
  }
}

// Function to reload map and item data
async function reloadGameData() {
  try {
    // Reload map specification
    await loadMapSpec();
    
    // Reload item details
    await loadItemDetails();
    
    // Reload floor collision data
    await loadFloorCollision();
    
    // Reload items from database (should be empty after reset)
    mapItems = await loadItemsFromDatabase();
    
    console.log('Game data reloaded successfully');
    return true;
  } catch (error) {
    console.error('Error reloading game data:', error);
    return false;
  }
}

// Function to get current online players
function getOnlinePlayersList() {
  const playerNames = [];
  for (const [ws, playerData] of clients.entries()) {
    if (playerData && playerData.username) {
      playerNames.push(playerData.username);
    }
  }
  return playerNames.sort(); // Sort alphabetically
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

// Get animation frame based on direction and movement sequence
function getMovementAnimationFrame(direction, sequenceIndex) {
  const sequenceType = MOVEMENT_SEQUENCE[sequenceIndex];
  if (sequenceType === 'idle') {
    return DIRECTION_IDLE[direction] || DIRECTION_IDLE.down;
  } else {
    // walk_1 or walk_2
    const walkIndex = sequenceType === 'walk_1' ? 0 : 2;
    const directionOffsets = {
      down: 0,
      right: 5,
      left: 10,
      up: 15
    };
    return (directionOffsets[direction] || 0) + walkIndex;
  }
}

// Get adjacent position based on direction
function getAdjacentPosition(x, y, direction) {
  switch (direction) {
    case 'up': return { x, y: y - 1 };
    case 'down': return { x, y: y + 1 };
    case 'left': return { x: x - 1, y };
    case 'right': return { x: x + 1, y };
    default: return { x, y };
  }
}

// Check if movement to position is allowed
function canMoveTo(x, y, excludePlayerId = null) {
  // Check map bounds
  if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
    return false;
  }
  
  // Check floor collision
  if (hasFloorCollision(x, y)) {
    return false;
  }
  
  // Check item collision
  const targetItemId = getItemAtPosition(x, y, serverMapSpec);
  const targetItemDetails = getItemDetails(targetItemId);
  if (targetItemDetails && targetItemDetails.collision) {
    return false;
  }
  
  // Check player collision
  if (isPlayerAtPosition(x, y, excludePlayerId)) {
    return false;
  }
  
  return true;
}

// Start attack animation for a player
function startAttackAnimation(playerData, ws) {
  // Clear any existing attack timeout
  const existingTimeout = attackTimeouts.get(playerData.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set attacking state
  playerData.isAttacking = true;
  
  // Get current attack index for this player and alternate it
  let currentIndex = playerAttackIndex.get(playerData.id);
  if (currentIndex === undefined) {
    // First attack starts with index 0
    currentIndex = 0;
  } else {
    // Alternate between 0 and 1
    currentIndex = currentIndex === 0 ? 1 : 0;
  }
  playerAttackIndex.set(playerData.id, currentIndex);
  
  // Get attack animation frame based on alternating index
  const attackSeq = ATTACK_SEQUENCES[playerData.direction] || ATTACK_SEQUENCES.down;
  playerData.animationFrame = attackSeq[currentIndex];
  
  // Update database
  updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, true, playerData.animationFrame, playerData.movementSequenceIndex)
    .catch(err => console.error('Attack start DB error:', err));

  // Broadcast attack start
  broadcast({
    type: 'animation_update',
    id: playerData.id,
    direction: playerData.direction,
    isMoving: playerData.isMoving,
    isAttacking: true,
    animationFrame: playerData.animationFrame,
    movementSequenceIndex: playerData.movementSequenceIndex
  });

  // Set timeout to stop attack after 1 second
  const timeoutId = setTimeout(() => {
    stopAttackAnimation(playerData, ws);
    attackTimeouts.delete(playerData.id);
  }, 1000);
  
  attackTimeouts.set(playerData.id, timeoutId);
}

// Stop attack animation for a player
function stopAttackAnimation(playerData, ws) {
  if (!playerData.isAttacking) return;
  
  // Clear timeout if it exists
  const existingTimeout = attackTimeouts.get(playerData.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    attackTimeouts.delete(playerData.id);
  }

  // Set back to idle animation for current direction
  playerData.isAttacking = false;
  playerData.animationFrame = DIRECTION_IDLE[playerData.direction] || DIRECTION_IDLE.down;
  
  // Update database
  updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, false, playerData.animationFrame, playerData.movementSequenceIndex)
    .catch(err => console.error('Attack stop DB error:', err));

  // Broadcast attack stop
  broadcast({
    type: 'animation_update',
    id: playerData.id,
    direction: playerData.direction,
    isMoving: playerData.isMoving,
    isAttacking: false,
    animationFrame: playerData.animationFrame,
    movementSequenceIndex: playerData.movementSequenceIndex
  });
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
      ADD COLUMN IF NOT EXISTS animation_frame INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS movement_sequence_index INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'player'
    `);

    // Create map_items table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS map_items (
        x INTEGER,
        y INTEGER,
        item_id INTEGER,
        PRIMARY KEY (x, y)
      )
    `);

    console.log('Database animation columns and map_items table initialized');
    
    // Load existing items
    mapItems = await loadItemsFromDatabase();
    console.log(`Loaded ${Object.keys(mapItems).length} items from database`);
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Initialize database on startup
initializeDatabase();
loadItemDetails();
loadMapSpec();
loadFloorCollision();

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
          weapon: found.weapon ?? 0,
          armor: found.armor ?? 0,
          hands: found.hands ?? 0,
          direction: found.direction ?? 'down',
          isMoving: found.is_moving ?? false,
          isAttacking: found.is_attacking ?? false,
          animationFrame: found.animation_frame ?? DIRECTION_IDLE.down,
          movementSequenceIndex: found.movement_sequence_index ?? 0,
          role: found.role ?? 'player'
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        send(ws, { type: 'login_success', player: playerData, players: others, items: mapItems });
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
          weapon: created.weapon ?? 0,
          armor: created.armor ?? 0,
          hands: created.hands ?? 0,
          direction: created.direction ?? 'down',
          isMoving: created.is_moving ?? false,
          isAttacking: created.is_attacking ?? false,
          animationFrame: created.animation_frame ?? DIRECTION_IDLE.down,
          movementSequenceIndex: created.movement_sequence_index ?? 0,
          role: created.role ?? 'player'
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        send(ws, { type: 'signup_success', player: playerData, players: others, items: mapItems });
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

      // Cancel any attack animation when moving
      if (playerData.isAttacking) {
        stopAttackAnimation(playerData, ws);
      }

      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const nx = playerData.pos_x + dx;
      const ny = playerData.pos_y + dy;

      // Use the new collision checking function
      if (canMoveTo(nx, ny, playerData.id)) {
        // Decrement stamina by **1**
        playerData.stamina = Math.max(0, (playerData.stamina ?? 0) - 1);
        playerData.pos_x = nx;
        playerData.pos_y = ny;

        // IMMEDIATELY update direction for consistent state
        if (msg.direction) {
          playerData.direction = msg.direction;
        }

        // Advance movement sequence index
        playerData.movementSequenceIndex = (playerData.movementSequenceIndex + 1) % MOVEMENT_SEQUENCE.length;

        // Calculate animation frame based on movement sequence
        playerData.animationFrame = getMovementAnimationFrame(playerData.direction, playerData.movementSequenceIndex);
        playerData.isMoving = true;
        playerData.isAttacking = false; // Ensure attack state is cleared

        // Save to database immediately
        Promise.allSettled([
          updateStatsInDb(playerData.id, { stamina: playerData.stamina }),
          updatePosition(playerData.id, nx, ny),
          updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, playerData.isAttacking, playerData.animationFrame, playerData.movementSequenceIndex)
        ]).catch(()=>{});

        // Broadcast the updated state immediately
        broadcast({ 
          type: 'player_moved', 
          id: playerData.id, 
          x: nx, 
          y: ny, 
          direction: playerData.direction,
          isMoving: playerData.isMoving,
          isAttacking: playerData.isAttacking,
          animationFrame: playerData.animationFrame,
          movementSequenceIndex: playerData.movementSequenceIndex
        });
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
      }
    }

    else if (msg.type === 'rotate') {
      if (!playerData) return;
      
      // Update direction without moving
      if (msg.direction) {
        playerData.direction = msg.direction;
        playerData.isAttacking = false;
        playerData.isMoving = false;
        playerData.animationFrame = DIRECTION_IDLE[playerData.direction] || DIRECTION_IDLE.down;
        
        // Update database
        updateAnimationState(playerData.id, playerData.direction, false, false, playerData.animationFrame, playerData.movementSequenceIndex)
          .catch(err => console.error('Rotation DB error:', err));
        
        // Broadcast rotation to all clients
        broadcast({
          type: 'animation_update',
          id: playerData.id,
          direction: playerData.direction,
          isMoving: false,
          isAttacking: false,
          animationFrame: playerData.animationFrame,
          movementSequenceIndex: playerData.movementSequenceIndex
        });
      }
    }

    else if (msg.type === 'attack') {
      if (!playerData) return;
      
      console.log(`Attack attempt by ${playerData.username}: stamina ${playerData.stamina ?? 0}/10`);
      
      // Check stamina requirement (at least 10)
      if ((playerData.stamina ?? 0) < 10) {
        console.log(`Attack blocked for player ${playerData.username}: insufficient stamina (${playerData.stamina ?? 0}/10)`);
        // Send stamina update to client to sync any discrepancy
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        return;
      }
      
      // Reduce stamina by 10
      const oldStamina = playerData.stamina ?? 0;
      playerData.stamina = Math.max(0, oldStamina - 10);
      console.log(`Attack stamina: ${oldStamina} -> ${playerData.stamina}`);
      
      // Update direction if provided
      if (msg.direction) {
        playerData.direction = msg.direction;
      }
      
      // Start attack animation (this will handle alternating)
      startAttackAnimation(playerData, ws);
      
      // Update stamina in database and send to client
      updateStatsInDb(playerData.id, { stamina: playerData.stamina })
        .then(() => {
          console.log(`Stamina updated in database for ${playerData.username}: ${playerData.stamina}`);
        })
        .catch(err => console.error('Error updating stamina after attack:', err));
      
      send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
      console.log(`Sent stamina update to client: ${playerData.stamina}`);
    }

    else if (msg.type === 'stop_attack') {
      if (!playerData) return;
      
      // Stop attack animation
      stopAttackAnimation(playerData, ws);
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
      if (typeof msg.movementSequenceIndex === 'number') {
        playerData.movementSequenceIndex = msg.movementSequenceIndex;
      }

      // Save animation state to database
      updateAnimationState(playerData.id, playerData.direction, playerData.isMoving, playerData.isAttacking, playerData.animationFrame, playerData.movementSequenceIndex)
        .catch(err => console.error('Animation update DB error:', err));

      // Broadcast animation update to all clients
      broadcast({
        type: 'animation_update',
        id: playerData.id,
        direction: playerData.direction,
        isMoving: playerData.isMoving,
        isAttacking: playerData.isAttacking,
        animationFrame: playerData.animationFrame,
        movementSequenceIndex: playerData.movementSequenceIndex
      });
    }

    else if (msg.type === 'pickup_item') {
      if (!playerData) return;
      
      const { x, y, itemId } = msg;
      
      // Special case: itemId=0 means player wants to drop their hands item
      if (itemId === 0) {
        const handsItem = playerData.hands || 0;
        if (handsItem === 0) return;
        
        playerData.hands = 0;
        const key = `${x},${y}`;
        mapItems[key] = handsItem;
        saveItemToDatabase(x, y, handsItem);
        
        updateStatsInDb(playerData.id, { hands: playerData.hands })
          .catch(err => console.error('Error updating player hands:', err));
        
        broadcast({
          type: 'item_placed',
          x: x,
          y: y,
          itemId: handsItem
        });
        
        broadcast({
          type: 'player_equipment_update',
          id: playerData.id,
          hands: playerData.hands
        });
        
        return;
      }
      
      // Verify item exists
      const actualItemId = getItemAtPosition(x, y, serverMapSpec);
      if (actualItemId !== itemId) {
        console.log(`ERROR: Item mismatch! Expected ${itemId}, found ${actualItemId}`);
        return;
      }
      
      // Verify item is pickupable
      const itemDetails = getItemDetails(itemId);
      if (!itemDetails) {
        console.log(`ERROR: No item details for item ${itemId}`);
        return;
      }
      
      const pickupableTypes = ["weapon", "armor", "useable", "consumable", "buff", "garbage"];
      if (!pickupableTypes.includes(itemDetails.type)) {
        console.log(`ERROR: Item ${itemId} type '${itemDetails.type}' not pickupable`);
        return;
      }
      
      // Pick up the item
      const oldHands = playerData.hands || 0;
      playerData.hands = itemId;
      
      const key = `${x},${y}`;
      
      // Mark as picked up with -1 (this should make it disappear)
      mapItems[key] = -1;
      saveItemToDatabase(x, y, -1);
      
      // Update player
      updateStatsInDb(playerData.id, { hands: playerData.hands })
        .catch(err => console.error('Error updating player hands:', err));
      
      // Broadcast that this position now has -1 (picked up)
      broadcast({
        type: 'item_placed',
        x: x,
        y: y,
        itemId: -1
      });
      
      broadcast({
        type: 'player_equipment_update',
        id: playerData.id,
        hands: playerData.hands
      });
    }

    else if (msg.type === 'equip_weapon') {
      if (!playerData) return;
      
      const handsItem = playerData.hands || 0;
      const weaponItem = playerData.weapon || 0;
      
      // Case 1: Has weapon item in hands, exchange with weapon slot
      if (handsItem > 0) {
        const handsItemDetails = getItemDetails(handsItem);
        if (!handsItemDetails || handsItemDetails.type !== 'weapon') return;
        
        // Exchange weapon and hands
        playerData.weapon = handsItem;
        playerData.hands = weaponItem;
      }
      // Case 2: No item in hands but has weapon equipped, unequip to hands
      else if (handsItem === 0 && weaponItem > 0) {
        playerData.hands = weaponItem;
        playerData.weapon = 0;
      }
      // Case 3: Nothing to do (no weapon in hands or weapon slot)
      else {
        return;
      }
      
      // Update database
      updateStatsInDb(playerData.id, { weapon: playerData.weapon, hands: playerData.hands })
        .catch(err => console.error('Error updating player equipment:', err));
      
      // Broadcast equipment update
      broadcast({
        type: 'player_equipment_update',
        id: playerData.id,
        weapon: playerData.weapon,
        hands: playerData.hands
      });
    }

    else if (msg.type === 'equip_armor') {
      if (!playerData) return;
      
      const handsItem = playerData.hands || 0;
      const armorItem = playerData.armor || 0;
      
      // Case 1: Has armor item in hands, exchange with armor slot
      if (handsItem > 0) {
        const handsItemDetails = getItemDetails(handsItem);
        if (!handsItemDetails || handsItemDetails.type !== 'armor') return;
        
        // Exchange armor and hands
        playerData.armor = handsItem;
        playerData.hands = armorItem;
      }
      // Case 2: No item in hands but has armor equipped, unequip to hands
      else if (handsItem === 0 && armorItem > 0) {
        playerData.hands = armorItem;
        playerData.armor = 0;
      }
      // Case 3: Nothing to do (no armor in hands or armor slot)
      else {
        return;
      }
      
      // Update database
      updateStatsInDb(playerData.id, { armor: playerData.armor, hands: playerData.hands })
        .catch(err => console.error('Error updating player equipment:', err));
      
      // Broadcast equipment update
      broadcast({
        type: 'player_equipment_update',
        id: playerData.id,
        armor: playerData.armor,
        hands: playerData.hands
      });
    }

    else if (msg.type === 'chat') {
      if (!playerData || typeof msg.text !== 'string') return;
      const t = msg.text.trim();
      if (looksMalicious(t)) return send(ws, { type: 'chat_error' });

      // Check for -resetserver admin command
      if (t.toLowerCase() === '-resetserver') {
        // Validate admin role
        if (playerData.role !== 'admin') {
          // Do nothing for non-admin users (silent ignore)
          return;
        }

        send(ws, { type: 'chat', text: '~ Resetting server, clearing all items...' });
        
        try {
          // Clear all map items
          const itemsClearSuccess = await clearAllMapItems();
          if (!itemsClearSuccess) {
            send(ws, { type: 'chat', text: '~ Error: Failed to clear map items.' });
            return;
          }

          // Reload all game data
          const reloadSuccess = await reloadGameData();
          if (!reloadSuccess) {
            send(ws, { type: 'chat', text: '~ Error: Failed to reload game data.' });
            return;
          }

          // Broadcast the reset to all players
          broadcast({
            type: 'server_reset',
            items: mapItems, // Should be empty object after reset
            message: 'Server has been reset by an administrator.'
          });

          // Send confirmation to admin
          send(ws, { type: 'chat', text: '~ Server reset completed successfully.' });
          
        } catch (error) {
          console.error('Error during server reset:', error);
          send(ws, { type: 'chat', text: '~ Error: Server reset failed.' });
        }
        return;
      }

      // Check for -players command (available to all players)
      if (t.toLowerCase() === '-players') {
        const onlinePlayers = getOnlinePlayersList();
        const playerCount = onlinePlayers.length;
        
        // Format the response
        const playerListText = onlinePlayers.join(', ');
        const response1 = '[*] DragonSpires - Players Currently Online [*]';
        const response2 = playerListText;
        const response3 = `Total Players: ${playerCount}`;
        
        // Send the formatted response to the requesting player
        send(ws, { type: 'chat', text: response1 });
        send(ws, { type: 'chat', text: response2 });
        send(ws, { type: 'chat', text: response3 });
        return;
      }

      // Check for existing admin placeitem command
      const placeItemMatch = t.match(/^-placeitem\s+(\d+)$/i);
      if (placeItemMatch) {
        // Validate admin role
        if (playerData.role !== 'admin') {
          // Do nothing for non-admin users
          return;
        }

        const itemId = parseInt(placeItemMatch[1]);
        if (itemId < 0 || itemId > 999) return; // Basic validation

        // Get adjacent position based on player's facing direction
        const adjacentPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
        
        // Check bounds
        if (adjacentPos.x < 0 || adjacentPos.x >= MAP_WIDTH || adjacentPos.y < 0 || adjacentPos.y >= MAP_HEIGHT) {
          send(ws, { type: 'chat', text: '~ Cannot place item outside map bounds.' });
          return;
        }

        // Update item in memory and database
        const key = `${adjacentPos.x},${adjacentPos.y}`;
        if (itemId === 0) {
          delete mapItems[key];
          // Remove from database
          pool.query('DELETE FROM map_items WHERE x=$1 AND y=$2', [adjacentPos.x, adjacentPos.y])
            .catch(err => console.error('Error removing item from database:', err));
        } else {
          mapItems[key] = itemId;
          // Save to database
          saveItemToDatabase(adjacentPos.x, adjacentPos.y, itemId);
        }

        // Broadcast item update to all clients
        broadcast({
          type: 'item_placed',
          x: adjacentPos.x,
          y: adjacentPos.y,
          itemId: itemId
        });

        send(ws, { 
          type: 'chat', 
          text: itemId === 0 
            ? `~ Item removed from (${adjacentPos.x}, ${adjacentPos.y})`
            : `~ Item ${itemId} placed at (${adjacentPos.x}, ${adjacentPos.y})`
        });
        return;
      }

      // Regular chat message
      broadcast({ type: 'chat', text: `${playerData.username}: ${t}` });
    }
  });

  ws.on('close', () => {
    if (playerData) {
      // Clear any pending attack timeout
      const attackTimeout = attackTimeouts.get(playerData.id);
      if (attackTimeout) {
        clearTimeout(attackTimeout);
        attackTimeouts.delete(playerData.id);
      }
      
      
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
