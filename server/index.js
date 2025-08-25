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

// Direction and step to animation frame mapping
function getAnimationFrameFromDirectionAndStep(direction, step) {
  const directionMappings = {
    down: { 1: 0, 2: 1, 3: 2 },     // down_walk_1, down, down_walk_2
    right: { 1: 5, 2: 6, 3: 7 },    // right_walk_1, right, right_walk_2
    left: { 1: 10, 2: 11, 3: 12 },  // left_walk_1, left, left_walk_2
    up: { 1: 15, 2: 16, 3: 17 }     // up_walk_1, up, up_walk_2
  };
  
  return directionMappings[direction]?.[step] || directionMappings.down[2]; // Default to "down" idle
}

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

// Active spells storage
let spells = {}; // { id: spellData }
let spellIdCounter = 1;

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

function hasFloorCollision(x, y, mapSpec = null) {
  if (!floorCollisionReady || !floorCollision || !mapSpec || 
      x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) {
    return false; // No collision data, no map spec, or out of bounds
  }
  
  // Get the floor tile ID at this position
  const tileId = (mapSpec.tiles && mapSpec.tiles[y] && 
                  typeof mapSpec.tiles[y][x] !== 'undefined') 
                  ? mapSpec.tiles[y][x] : 0;
  
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
    
    // Load itemdetails.json from the correct server path
    const itemDetailsPath = path.join(__dirname, 'assets', 'itemdetails.json');
    
    console.log(`Loading itemdetails.json from: ${itemDetailsPath}`);
    
    const data = await fs.readFile(itemDetailsPath, 'utf8');
    const parsed = JSON.parse(data);
    
    if (parsed && Array.isArray(parsed.items)) {
      itemDetails = parsed.items.map((item, index) => ({
        id: index + 1,
        name: item[0],
        collision: item[1] === "true",
        type: item[2],
        statMin: parseInt(item[3]) || 0,
        statMax: parseInt(item[4]) || 0,
        description: item[5],
        statEffected: item[6] || null,     // New field: STAT_EFFECTED
        useMessage: item[7] || null        // New field: USE_MESSAGE
      }));
      itemDetailsReady = true;
      console.log(`Server loaded ${itemDetails.length} item details from: ${itemDetailsPath}`);
      console.log(`Sample item with new fields:`, {
        name: itemDetails[0]?.name,
        statEffected: itemDetails[0]?.statEffected,
        useMessage: itemDetails[0]?.useMessage
      });
    } else {
      throw new Error('Invalid itemdetails.json structure - missing items array');
    }
  } catch (error) {
    console.error('Failed to load server item details:', error);
    console.log('Current working directory:', process.cwd());
    console.log('__dirname:', __dirname);
    itemDetailsReady = true; // Don't block server startup
  }
}

function getItemDetails(itemId) {
  if (!itemDetailsReady || !itemDetails || itemId < 1 || itemId > itemDetails.length) {
    return null;
  }
  return itemDetails[itemId - 1];
}

// ---------- SPELL SYSTEM ----------

// Create a fire pillar spell
function createFirePillar(casterPlayerId, startX, startY, direction, mapId) {
  const spellId = spellIdCounter++;
  
  const spell = {
    id: spellId,
    type: 'fire_pillar',
    casterPlayerId: casterPlayerId,
    mapId: mapId,
    direction: direction,
    currentX: startX,
    currentY: startY,
    startX: startX,
    startY: startY,
    tilesMoved: 0,
    maxTiles: 3,
    itemId: 289, // Renders as item 289
    createdAt: Date.now()
  };
  
  spells[spellId] = spell;
  
  // Broadcast spell creation to all players on the same map
  broadcastToMap(mapId, {
    type: 'spell_created',
    spell: spell
  });
  
  console.log(`Fire pillar spell ${spellId} created at (${startX}, ${startY}) facing ${direction}`);
  
  // Check for collision at starting position first
  setTimeout(async () => {
    const startingCollision = await checkSpellCollision(spell, startX, startY);
    if (startingCollision) {
      // Handle collision at starting position
      await handleSpellCollision(spell, startingCollision);
      // End spell after 1 second delay for collision
      setTimeout(() => endSpell(spellId), 1000);
    } else {
      // No collision at start, begin normal movement
      scheduleSpellMovement(spellId);
    }
  }, 0);
  
  return spellId;
}

// Move spell forward and handle collisions
async function moveSpell(spellId) {
  const spell = spells[spellId];
  if (!spell) return;
  
  // Calculate next position
  const nextPos = getAdjacentPosition(spell.currentX, spell.currentY, spell.direction);
  
  // Check map bounds
  if (nextPos.x < 0 || nextPos.x >= MAP_WIDTH || nextPos.y < 0 || nextPos.y >= MAP_HEIGHT) {
    console.log(`Spell ${spellId} hit map boundary, ending`);
    endSpell(spellId);
    return;
  }
  
  // Check for collisions
  const collision = await checkSpellCollision(spell, nextPos.x, nextPos.y);
  
  if (collision) {
    // Move to collision tile first
    spell.currentX = nextPos.x;
    spell.currentY = nextPos.y;
    spell.tilesMoved++;
    
    // Broadcast spell movement
    broadcastToMap(spell.mapId, {
      type: 'spell_moved',
      spellId: spellId,
      x: nextPos.x,
      y: nextPos.y
    });
    
    // Handle collision effects
    await handleSpellCollision(spell, collision);
    
    // End spell after 1 second delay for collision
    setTimeout(() => endSpell(spellId), 1000);
    return;
  }
  
  // Move to next position
  spell.currentX = nextPos.x;
  spell.currentY = nextPos.y;
  spell.tilesMoved++;
  
  // Broadcast spell movement
  broadcastToMap(spell.mapId, {
    type: 'spell_moved',
    spellId: spellId,
    x: nextPos.x,
    y: nextPos.y
  });
  
  console.log(`Spell ${spellId} moved to (${nextPos.x}, ${nextPos.y}), tiles moved: ${spell.tilesMoved}`);
  
  // Check if reached maximum distance
  if (spell.tilesMoved >= spell.maxTiles) {
    // End spell after 1 second delay at final position
    setTimeout(() => endSpell(spellId), 1000);
  } else {
    // Schedule next movement
    scheduleSpellMovement(spellId);
  }
}

// Schedule spell movement after 0.2 seconds
function scheduleSpellMovement(spellId) {
  setTimeout(() => moveSpell(spellId), 200);
}



// Check for spell collisions
async function checkSpellCollision(spell, x, y) {
  // Check for players
  for (const [ws, playerData] of clients.entries()) {
    if (playerData.map_id === spell.mapId && playerData.pos_x === x && playerData.pos_y === y) {
      return { type: 'player', data: playerData };
    }
  }
  
  // Check for enemies
  for (const [enemyId, enemy] of Object.entries(enemies)) {
    if (Number(enemy.map_id) === Number(spell.mapId) && enemy.pos_x === x && enemy.pos_y === y && !enemy.is_dead) {
      return { type: 'enemy', data: enemy };
    }
  }
  
  // Check for collidable floor tiles and items
  const mapSpec = getMapSpec(spell.mapId);
  if (hasFloorCollision(x, y, mapSpec)) {
    return { type: 'floor', data: { x, y } };
  }
  
  // Check for collidable items
  const itemId = getItemAtPosition(x, y, mapSpec, spell.mapId);
  if (itemId > 0) {
    const itemDetails = getItemDetails(itemId);
    if (itemDetails && itemDetails.collision) {
      return { type: 'item', data: { itemId, itemDetails } };
    }
  }
  
  return null;
}

// Handle spell collision effects
async function handleSpellCollision(spell, collision) {
  console.log(`Spell ${spell.id} collided with ${collision.type}`);
  
  if (collision.type === 'enemy') {
    // Deal 5 damage to enemy
    const enemy = collision.data;
    enemy.hp = Math.max(0, (enemy.hp || enemy.max_hp || 0) - 5);
    
    console.log(`Fire pillar deals 5 damage to enemy ${enemy.id}, HP: ${enemy.hp}`);
    
    // Update enemy HP in database
    try {
      await pool.query('UPDATE enemies SET hp = $1 WHERE id = $2', [enemy.hp, enemy.id]);
    } catch (err) {
      console.error('Error updating enemy HP in database:', err);
    }
    
    // Get enemy name from enemy details
    const enemyDetailsData = getEnemyDetails(enemy.enemy_type);
    const enemyName = enemyDetailsData ? enemyDetailsData.name : `Enemy ${enemy.enemy_type}`;
    
    // Find the caster player and send them a damage message
    for (const [ws, playerData] of clients.entries()) {
      if (playerData.id === spell.casterPlayerId) {
        send(ws, {
          type: 'chat',
          text: `Your Fire Pillar spell deals 5 damage to ${enemyName}!`,
          color: 'purple'
        });
        break;
      }
    }
    
    // Check if enemy died
    if (enemy.hp <= 0) {
      // Send death message to caster before handling death
      for (const [ws, playerData] of clients.entries()) {
        if (playerData.id === spell.casterPlayerId) {
          send(ws, {
            type: 'chat',
            text: `You have slain ${enemyName}!`,
            color: 'red'
          });
          break;
        }
      }
      await handleEnemyDeath(enemy, null); // No attacking player for spell kills
    }
  }
  // Players and items just stop the spell without additional effects
}

// Remove spell from game
function endSpell(spellId) {
  const spell = spells[spellId];
  if (!spell) return;
  
  console.log(`Ending spell ${spellId}`);
  
  // Broadcast spell removal
  broadcastToMap(spell.mapId, {
    type: 'spell_removed',
    spellId: spellId
  });
  
  // Remove from memory
  delete spells[spellId];
}

// Broadcast message to all players on a specific map
function broadcastToMap(mapId, message) {
  for (const [ws, playerData] of clients.entries()) {
    if (playerData.map_id === mapId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

// Electrocute effects system
let electrocuteEffects = {}; // Store active electrocute effects

function createElectrocuteEffect(effectId, x, y, mapId) {
  // Create electrocute effect
  const effect = {
    id: effectId,
    x: x,
    y: y,
    mapId: mapId,
    startTime: Date.now()
  };
  
  electrocuteEffects[effectId] = effect;
  
  console.log(`Created electrocute effect ${effectId} at (${x}, ${y}) on map ${mapId}`);
  
  // Broadcast electrocute effect creation to all clients on the map
  broadcastToMap(mapId, {
    type: 'electrocute_created',
    effectId: effectId,
    x: x,
    y: y
  });
  
  // Schedule removal after 1 second
  setTimeout(() => {
    removeElectrocuteEffect(effectId);
  }, 1000);
}

function removeElectrocuteEffect(effectId) {
  const effect = electrocuteEffects[effectId];
  if (!effect) return;
  
  console.log(`Removing electrocute effect ${effectId}`);
  
  // Broadcast electrocute effect removal
  broadcastToMap(effect.mapId, {
    type: 'electrocute_removed',
    effectId: effectId
  });
  
  // Remove from memory
  delete electrocuteEffects[effectId];
}

// Healing effects system
let healingEffects = {}; // Store active healing effects

function createHealingEffect(effectId, x, y, mapId) {
  // Create healing effect
  const effect = {
    id: effectId,
    x: x,
    y: y,
    mapId: mapId,
    startTime: Date.now()
  };
  
  healingEffects[effectId] = effect;
  
  console.log(`Created healing effect ${effectId} at (${x}, ${y}) on map ${mapId}`);
  
  // Broadcast healing effect creation to all clients on the map
  broadcastToMap(mapId, {
    type: 'healing_created',
    effectId: effectId,
    x: x,
    y: y
  });
  
  // Schedule removal after 1 second
  setTimeout(() => {
    removeHealingEffect(effectId);
  }, 1000);
}

function removeHealingEffect(effectId) {
  const effect = healingEffects[effectId];
  if (!effect) return;
  
  console.log(`Removing healing effect ${effectId}`);
  
  // Broadcast healing effect removal
  broadcastToMap(effect.mapId, {
    type: 'healing_removed',
    effectId: effectId
  });
  
  // Remove from memory
  delete healingEffects[effectId];
}

// Silver Mist effects system
let silverMistEffects = {}; // Store active silver mist effects

function createSilverMistEffect(effectId, x, y, mapId) {
  // Create silver mist effect
  const effect = {
    id: effectId,
    x: x,
    y: y,
    mapId: mapId,
    startTime: Date.now()
  };
  
  silverMistEffects[effectId] = effect;
  
  console.log(`Created silver mist effect ${effectId} at (${x}, ${y}) on map ${mapId}`);
  
  // Broadcast silver mist effect creation to all clients on the map
  broadcastToMap(mapId, {
    type: 'silver_mist_created',
    effectId: effectId,
    x: x,
    y: y
  });
  
  // Schedule removal after 1 second
  setTimeout(() => {
    removeSilverMistEffect(effectId);
  }, 1000);
}

function removeSilverMistEffect(effectId) {
  const effect = silverMistEffects[effectId];
  if (!effect) return;
  
  console.log(`Removing silver mist effect ${effectId}`);
  
  // Broadcast silver mist effect removal
  broadcastToMap(effect.mapId, {
    type: 'silver_mist_removed',
    effectId: effectId
  });
  
  // Remove from memory
  delete silverMistEffects[effectId];
}

// Enemy details loading and management
let enemyDetails = [];
let enemyDetailsReady = false;

async function loadEnemyDetails() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    
    const possiblePaths = [
      path.join(__dirname, 'assets', 'enemiesdetails.json'),
      path.join(__dirname, '..', 'assets', 'enemiesdetails.json'),
      path.join(__dirname, '..', 'client', 'assets', 'enemiesdetails.json'),
      path.join(__dirname, '..', 'server', 'assets', 'enemiesdetails.json'),
      path.join(process.cwd(), 'assets', 'enemiesdetails.json'),
      path.join(process.cwd(), 'client', 'assets', 'enemiesdetails.json'),
      path.join(process.cwd(), 'server', 'assets', 'enemiesdetails.json'),
      // Additional paths for potential Render deployment structure
      path.join(process.cwd(), 'src', 'server', 'assets', 'enemiesdetails.json'),
      path.join(process.cwd(), 'src', 'assets', 'enemiesdetails.json'),
      path.join(process.cwd(), 'src', 'client', 'assets', 'enemiesdetails.json')
    ];
    
    let data = null;
    let usedPath = null;
    
    for (const enemyDetailsPath of possiblePaths) {
      try {
        data = await fs.readFile(enemyDetailsPath, 'utf8');
        usedPath = enemyDetailsPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.error('Could not find enemiesdetails.json in any of the expected paths');
      enemyDetailsReady = true; // Don't block server startup
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && Array.isArray(parsed)) {
      enemyDetails = parsed.map((enemy, index) => ({
        id: index + 1,
        name: enemy.name,
        attack_text: enemy.attack_text,
        drop_item: enemy.drop_item,
        drop_chance: enemy.drop_chance,
        drop_gold_min: enemy.drop_gold_min,
        drop_gold_max: enemy.drop_gold_max,
        hp: enemy.hp,
        move_delay: enemy.move_delay,
        attack_min: enemy.attack_min,
        attack_max: enemy.attack_max,
        defense_min: enemy.defense_min,
        defense_max: enemy.defense_max,
        projectile: enemy.projectile,
        spell_item_id: enemy.spell_item_id,
        spell_distance: enemy.spell_distance,
        enemy_image_up_1: enemy.enemy_image_up_1,
        enemy_image_up_2: enemy.enemy_image_up_2,
        enemy_image_right_1: enemy.enemy_image_right_1,
        enemy_image_right_2: enemy.enemy_image_right_2,
        enemy_image_down_1: enemy.enemy_image_down_1,
        enemy_image_down_2: enemy.enemy_image_down_2,
        enemy_image_left_1: enemy.enemy_image_left_1,
        enemy_image_left_2: enemy.enemy_image_left_2
      }));
      enemyDetailsReady = true;
      console.log(`Server loaded ${enemyDetails.length} enemy details from: ${usedPath}`);
    }
  } catch (error) {
    console.error('Failed to load server enemy details:', error);
    enemyDetailsReady = true; // Don't block server startup
  }
}

function getEnemyDetails(enemyType) {
  if (!enemyDetailsReady || !enemyDetails || enemyType < 1 || enemyType > enemyDetails.length) {
    return null;
  }
  return enemyDetails[enemyType - 1];
}

// NPC details loading and management
let npcDetails = [];
let npcDetailsReady = false;

async function loadNPCDetails() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    
    const possiblePaths = [
      path.join(__dirname, 'assets', 'npcdetails.json'),
      path.join(__dirname, '..', 'assets', 'npcdetails.json'),
      path.join(__dirname, '..', 'client', 'assets', 'npcdetails.json'),
      path.join(__dirname, '..', 'server', 'assets', 'npcdetails.json'),
      path.join(process.cwd(), 'assets', 'npcdetails.json'),
      path.join(process.cwd(), 'client', 'assets', 'npcdetails.json'),
      path.join(process.cwd(), 'server', 'assets', 'npcdetails.json'),
      // Additional paths for potential Render deployment structure
      path.join(process.cwd(), 'src', 'server', 'assets', 'npcdetails.json'),
      path.join(process.cwd(), 'src', 'assets', 'npcdetails.json'),
      path.join(process.cwd(), 'src', 'client', 'assets', 'npcdetails.json')
    ];
    
    let data = null;
    let usedPath = null;
    
    for (const npcDetailsPath of possiblePaths) {
      try {
        data = await fs.readFile(npcDetailsPath, 'utf8');
        usedPath = npcDetailsPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.error('Could not find npcdetails.json in any of the expected paths');
      npcDetailsReady = true; // Don't block server startup
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && Array.isArray(parsed.npc)) {
      npcDetails = parsed.npc.map((npc, index) => ({
        id: index + 1,
        name: npc.name,
        description: npc.description,
        item_number: npc.item_number,
        shop: npc.shop === "true",
        quest_giver: npc.quest_giver === "true",
        quest_complete: npc.quest_complete === "true",
        quest_item_required: npc.quest_item_required,
        quest_item_reward: npc.quest_item_reward,
        speaker: npc.speaker === "true",
        speaker_phrase_1: npc.speaker_phrase_1,
        speaker_phrase_2: npc.speaker_phrase_2,
        speaker_phrase_3: npc.speaker_phrase_3,
        speaker_phrase_4: npc.speaker_phrase_4,
        question_1: npc.question_1,
        question_2: npc.question_2,
        question_3: npc.question_3,
        question_4: npc.question_4,
        response_1: npc.response_1,
        response_2: npc.response_2,
        response_3: npc.response_3,
        response_4: npc.response_4,
        buy_item_1: npc.buy_item_1,
        buy_item_2: npc.buy_item_2,
        buy_item_3: npc.buy_item_3,
        buy_item_4: npc.buy_item_4,
        buy_price_1: npc.buy_price_1,
        buy_price_2: npc.buy_price_2,
        buy_price_3: npc.buy_price_3,
        buy_price_4: npc.buy_price_4,
        sell_item_1: npc.sell_item_1,
        sell_item_2: npc.sell_item_2,
        sell_item_3: npc.sell_item_3,
        sell_item_4: npc.sell_item_4,
        sell_price_1: npc.sell_price_1,
        sell_price_2: npc.sell_price_2,
        sell_price_3: npc.sell_price_3,
        sell_price_4: npc.sell_price_4
      }));
    } else {
      console.error('Invalid npcdetails.json format');
      npcDetailsReady = true;
      return;
    }
  } catch (error) {
    console.error('Error loading NPC details:', error);
    npcDetailsReady = true;
    return;
  }
  
  npcDetailsReady = true;
  console.log(`Server loaded ${npcDetails.length} NPC details from: ${usedPath}`);
}

function getNPCDetails(npcType) {
  if (!npcDetailsReady || !npcDetails || npcType < 1 || npcType > npcDetails.length) {
    return null;
  }
  return npcDetails[npcType - 1];
}

function getRandomItemByTypes(types) {
  if (!itemDetailsReady || !itemDetails) return 0;
  
  const matchingItems = itemDetails.filter(item => types.includes(item.type));
  if (matchingItems.length === 0) return 0;
  
  const randomItem = matchingItems[Math.floor(Math.random() * matchingItems.length)];
  return randomItem.id;
}

function getItemAtPosition(x, y, mapSpec, mapId = 1) {
  // Check both map items and placed items
  const mapItem = (mapSpec && mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined') 
    ? mapSpec.items[y][x] : 0;
  const placedItem = mapItems[`${x},${y}`]; // For now, still use old format for backwards compatibility
  
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

// Separate function to get the natural map item (ignoring picked up status)
function getNaturalMapItem(x, y, mapSpec) {
  return (mapSpec && mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined') 
    ? mapSpec.items[y][x] : 0;
}

// Multi-map system
let serverMaps = {}; // { mapId: mapSpec }
let serverMapData = {}; // { mapId: mapData }

async function loadAllMaps() {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    
    // Try to load maps 1-4
    for (let mapId = 1; mapId <= 4; mapId++) {
      await loadSingleMap(mapId);
      await loadSingleMapData(mapId);
    }
    
    console.log(`Server loaded ${Object.keys(serverMaps).length} maps`);
  } catch (error) {
    console.error('Failed to load maps on server:', error);
  }
}

async function loadSingleMap(mapId) {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    const mapFileName = `map${mapId}.json`;
    
    // Try multiple possible paths for map files
    const possiblePaths = [
      path.join(__dirname, '..', 'maps', mapFileName),
      path.join(__dirname, 'maps', mapFileName),
      path.join(__dirname, '..', '..', 'maps', mapFileName),
      path.join(process.cwd(), 'maps', mapFileName),
      path.join(__dirname, '..', 'server', 'maps', mapFileName),
      path.join(process.cwd(), 'server', 'maps', mapFileName)
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
      console.log(`Could not find ${mapFileName} in any of the expected paths`);
      return;
    }
    
    const parsed = JSON.parse(data);
    
    if (parsed && parsed.width && parsed.height) {
      serverMaps[mapId] = {
        width: parsed.width,
        height: parsed.height,
        tiles: Array.isArray(parsed.tiles) ? parsed.tiles : (Array.isArray(parsed.tilemap) ? parsed.tilemap : []),
        items: Array.isArray(parsed.items) ? parsed.items : []
      };
      console.log(`Server loaded map ${mapId} from: ${usedPath}`);
      console.log(`Map ${mapId} dimensions: ${serverMaps[mapId].width}x${serverMaps[mapId].height}`);
    }
  } catch (error) {
    console.error(`Failed to load map ${mapId}:`, error);
  }
}

async function loadSingleMapData(mapId) {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    const mapDataFileName = `map${mapId}data.json`;
    
    // Try multiple possible paths for map data files
    const possiblePaths = [
      path.join(__dirname, '..', 'maps', mapDataFileName),
      path.join(__dirname, 'maps', mapDataFileName),
      path.join(__dirname, '..', '..', 'maps', mapDataFileName),
      path.join(process.cwd(), 'maps', mapDataFileName),
      path.join(__dirname, '..', 'server', 'maps', mapDataFileName),
      path.join(process.cwd(), 'server', 'maps', mapDataFileName)
    ];
    
    let data = null;
    let usedPath = null;
    
    for (const mapDataPath of possiblePaths) {
      try {
        data = await fs.readFile(mapDataPath, 'utf8');
        usedPath = mapDataPath;
        break;
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!data) {
      console.log(`Could not find ${mapDataFileName} (optional)`);
      return;
    }
    
    try {
      const parsed = JSON.parse(data);
      serverMapData[mapId] = parsed;
      console.log(`Server loaded map ${mapId} data from: ${usedPath}`);
    } catch (parseError) {
      console.error(`JSON parse error in ${mapDataFileName}:`, parseError.message);
      console.error(`File content length: ${data.length} characters`);
      console.error(`Content around error position:`, data.substring(Math.max(0, 748 - 50), 748 + 50));
      // Still set empty data so server doesn't crash
      serverMapData[mapId] = {};
    }
  } catch (error) {
    console.error(`Failed to load map ${mapId} data:`, error);
  }
}

// Helper function to get map spec by ID (backwards compatibility)
function getMapSpec(mapId) {
  return serverMaps[mapId] || null;
}

// Helper function to get map data by ID
function getMapData(mapId) {
  return serverMapData[mapId] || null;
}

// SQL injection safe: uses parameterized query with $1 placeholder
async function loadPlayer(username) {
  const r = await pool.query('SELECT * FROM players WHERE username=$1', [username]);
  return r.rows[0];
}

// SQL injection safe: uses parameterized query with $1, $2, etc. placeholders
async function createPlayer(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO players (username, password, map_id, pos_x, pos_y, direction, step, is_moving, is_attacking, is_picking_up, animation_frame, movement_sequence_index)
     VALUES ($1, $2, 1, 33, 27, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [username, hashed, 'down', 2, false, false, false, DIRECTION_IDLE.down, 0]
  );
  
  // Initialize empty inventory for new player
  const playerId = r.rows[0].id;
  await initializePlayerInventory(playerId);
  
  return r.rows[0];
}

async function updatePosition(playerId, x, y) {
  await pool.query('UPDATE players SET pos_x=$1, pos_y=$2 WHERE id=$3', [x, y, playerId]);
}

async function updateAnimationState(playerId, direction, isMoving, isAttacking, animationFrame, movementSequenceIndex, isPickingUp = false) {
  await pool.query(
    'UPDATE players SET direction=$1, is_moving=$2, is_attacking=$3, is_picking_up=$4, animation_frame=$5, movement_sequence_index=$6 WHERE id=$7',
    [direction, isMoving, isAttacking, isPickingUp, animationFrame, movementSequenceIndex, playerId]
  );
}

async function updateDirectionAndStep(playerId, direction, step) {
  await pool.query(
    'UPDATE players SET direction=$1, step=$2 WHERE id=$3',
    [direction, step, playerId]
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

async function saveItemToDatabase(x, y, itemId, mapId = 1) {
  try {
    await pool.query(
      'INSERT INTO map_items (x, y, map_id, item_id) VALUES ($1, $2, $3, $4) ON CONFLICT (x, y, map_id) DO UPDATE SET item_id = $4',
      [x, y, mapId, itemId]
    );
    
    // Update in-memory mapItems for item pickup
    const key = `${x},${y}`;
    if (itemId === 0) {
      delete mapItems[key];
    } else {
      mapItems[key] = itemId;
    }
  } catch (error) {
    console.error('Error saving item to database:', error);
  }
}

async function loadItemsFromDatabase(mapId = null) {
  try {
    let query = 'SELECT x, y, map_id, item_id FROM map_items';
    let params = [];
    
    if (mapId !== null) {
      query += ' WHERE map_id = $1';
      params = [mapId];
    }
    
    const result = await pool.query(query, params);
    const items = {};
    result.rows.forEach(row => {
      // Include all entries, including -1 (picked up map items)
      // Key format: "x,y" for single map or "mapId:x,y" for multi-map
      const key = mapId !== null ? `${row.x},${row.y}` : `${row.map_id}:${row.x},${row.y}`;
      items[key] = row.item_id;
    });
    return items;
  } catch (error) {
    console.error('Error loading items from database:', error);
    return {};
  }
}

// Inventory management functions
async function initializePlayerInventory(playerId) {
  try {
    // Create 16 empty slots for new player
    const insertPromises = [];
    for (let slot = 1; slot <= 16; slot++) {
      insertPromises.push(
        pool.query(
          'INSERT INTO player_inventory (player_id, slot_number, item_id) VALUES ($1, $2, $3)',
          [playerId, slot, 0]
        )
      );
    }
    await Promise.all(insertPromises);
    console.log(`Initialized inventory for player ${playerId}`);
  } catch (error) {
    console.error('Error initializing player inventory:', error);
  }
}

async function loadPlayerInventory(playerId) {
  try {
    const result = await pool.query(
      'SELECT slot_number, item_id FROM player_inventory WHERE player_id = $1 ORDER BY slot_number',
      [playerId]
    );
    
    // Convert to object with slot numbers as keys
    const inventory = {};
    result.rows.forEach(row => {
      inventory[row.slot_number] = row.item_id;
    });
    
    // Ensure all 16 slots exist
    for (let slot = 1; slot <= 16; slot++) {
      if (!(slot in inventory)) {
        inventory[slot] = 0;
      }
    }
    
    return inventory;
  } catch (error) {
    console.error('Error loading player inventory:', error);
    return {};
  }
}

async function updateInventorySlot(playerId, slotNumber, itemId) {
  try {
    await pool.query(
      'INSERT INTO player_inventory (player_id, slot_number, item_id) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (player_id, slot_number) DO UPDATE SET item_id = $3',
      [playerId, slotNumber, itemId]
    );
  } catch (error) {
    console.error('Error updating inventory slot:', error);
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
    // Reload all maps
    await loadAllMaps();
    
    // Reload item details
    await loadItemDetails();
    
    // Reload NPC details
    await loadNPCDetails();
    
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

// Async function to log chat messages (non-blocking)
async function logChatMessage(playerId, username, messageType, message, mapId = null) {
  try {
    await pool.query(
      'INSERT INTO chat_log (player_id, username, message_type, message, map_id) VALUES ($1, $2, $3, $4, $5)',
      [playerId, username, messageType, message, mapId]
    );
  } catch (error) {
    // Silently fail - chat logging is non-critical
    console.error('Chat logging error (non-critical):', error);
  }
}

// Function to clear all map containers and reload from map data
async function reloadMapContainers() {
  try {
    // Clear existing containers
    await pool.query('DELETE FROM map_containers');
    console.log('Cleared all map containers');
    
    // Reload containers from all map data files
    for (let mapId = 1; mapId <= 4; mapId++) {
      const mapData = getMapData(mapId);
      if (mapData && mapData.holders) {
        for (const holder of mapData.holders) {
          const [x, y] = holder.coordinates.split(',').map(Number);
          const itemId = holder.item;
          
          await pool.query(
            'INSERT INTO map_containers (x, y, map_id, item_id) VALUES ($1, $2, $3, $4)',
            [x, y, mapId, itemId]
          );
        }
        console.log(`Loaded ${mapData.holders.length} containers for map ${mapId}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error reloading map containers:', error);
    return false;
  }
}

// Function to get container item at position
async function getContainerItem(x, y, mapId) {
  try {
    const result = await pool.query(
      'SELECT item_id FROM map_containers WHERE x = $1 AND y = $2 AND map_id = $3',
      [x, y, mapId]
    );
    return result.rows[0] ? result.rows[0].item_id : null;
  } catch (error) {
    console.error('Error getting container item:', error);
    return null;
  }
}

// Function to update container item
async function updateContainerItem(x, y, mapId, itemId) {
  try {
    await pool.query(
      'UPDATE map_containers SET item_id = $1 WHERE x = $2 AND y = $3 AND map_id = $4',
      [itemId, x, y, mapId]
    );
    return true;
  } catch (error) {
    console.error('Error updating container item:', error);
    return false;
  }
}

// Enemy management functions
let enemies = {}; // Store enemies in memory by ID for quick access

// Function to clear all enemies and reload from map data
async function reloadEnemies() {
  try {
    // Clear existing enemies
    await pool.query('DELETE FROM enemies');
    enemies = {};
    console.log('Cleared all enemies');
    
    // Reload enemies from all map data files
    for (let mapId = 1; mapId <= 4; mapId++) {
      const mapData = getMapData(mapId);
      if (mapData && mapData.enemies) {
        for (const enemy of mapData.enemies) {
          const [spawnX, spawnY] = enemy.coordinates.split(',').map(Number);
          const enemyType = enemy.type;
          const enemyDetails = getEnemyDetails(enemyType);
          
          if (enemyDetails) {
            const result = await pool.query(
              `INSERT INTO enemies (enemy_type, map_id, pos_x, pos_y, spawn_x, spawn_y, hp, direction, step, is_admin_spawned) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              [enemyType, mapId, spawnX, spawnY, spawnX, spawnY, enemyDetails.hp, 'down', 1, false]
            );
            
            const enemyId = result.rows[0].id;
            enemies[enemyId] = {
              id: enemyId,
              enemy_type: enemyType,
              map_id: mapId,
              pos_x: spawnX,
              pos_y: spawnY,
              spawn_x: spawnX,
              spawn_y: spawnY,
              hp: enemyDetails.hp,
              max_hp: enemyDetails.hp,
              direction: 'down',
              step: 1,
              last_move_time: Date.now(),
              is_dead: false,
              respawn_time: null,
              is_admin_spawned: false,
              details: enemyDetails
            };

          }
        }
        console.log(`Loaded ${mapData.enemies.length} enemies for map ${mapId}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error reloading enemies:', error);
    return false;
  }
}

// Function to spawn a single enemy (for admin commands)
async function spawnEnemy(enemyType, mapId, x, y, isAdminSpawned = false) {
  try {
    const enemyDetails = getEnemyDetails(enemyType);
    if (!enemyDetails) {
      return null;
    }
    
    const result = await pool.query(
      `INSERT INTO enemies (enemy_type, map_id, pos_x, pos_y, spawn_x, spawn_y, hp, direction, step, is_admin_spawned) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [enemyType, mapId, x, y, x, y, enemyDetails.hp, 'down', 1, isAdminSpawned]
    );
    
    const enemyId = result.rows[0].id;
    enemies[enemyId] = {
      id: enemyId,
      enemy_type: enemyType,
      map_id: mapId,
      pos_x: x,
      pos_y: y,
      spawn_x: x,
      spawn_y: y,
      hp: enemyDetails.hp,
      max_hp: enemyDetails.hp,
      direction: 'down',
      step: 1,
      last_move_time: Date.now(),
      is_dead: false,
      respawn_time: null,
      is_admin_spawned: isAdminSpawned,
      details: enemyDetails
    };
    
    return enemies[enemyId];
  } catch (error) {
    console.error('Error spawning enemy:', error);
    return null;
  }
}

// Function to load enemies from database on server startup
async function loadEnemiesFromDatabase() {
  try {
    const result = await pool.query('SELECT * FROM enemies');
    enemies = {};
    
    for (const row of result.rows) {
      const enemyDetails = getEnemyDetails(row.enemy_type);
      if (enemyDetails) {
        enemies[row.id] = {
          id: row.id,
          enemy_type: row.enemy_type,
          map_id: row.map_id,
          pos_x: row.pos_x,
          pos_y: row.pos_y,
          spawn_x: row.spawn_x,
          spawn_y: row.spawn_y,
          hp: row.hp,
          max_hp: enemyDetails.hp,
          direction: row.direction,
          step: row.step,
          last_move_time: new Date(row.last_move_time).getTime(),
          is_dead: row.is_dead,
          respawn_time: row.respawn_time ? new Date(row.respawn_time).getTime() : null,
          is_admin_spawned: row.is_admin_spawned,
          details: enemyDetails
        };
      }
    }
    
    console.log(`Loaded ${Object.keys(enemies).length} enemies from database`);
    return true;
  } catch (error) {
    console.error('Error loading enemies from database:', error);
    return false;
  }
}

// Function to get enemies for a specific map (for sending to clients)
function getEnemiesForMap(mapId) {
  const mapEnemies = {};
  for (const [enemyId, enemy] of Object.entries(enemies)) {
    if (Number(enemy.map_id) === Number(mapId) && !enemy.is_dead) {
      mapEnemies[enemyId] = {
        id: enemy.id,
        enemy_type: enemy.enemy_type,
        pos_x: enemy.pos_x,
        pos_y: enemy.pos_y,
        direction: enemy.direction,
        step: enemy.step,
        hp: enemy.hp
      };
    }
  }
  return mapEnemies;
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

// Check if an enemy is at the specified position
function isEnemyAtPosition(x, y, mapId, excludeEnemyId = null) {
  for (const [enemyId, enemy] of Object.entries(enemies)) {
    if (Number(enemy.map_id) === Number(mapId) && 
        enemy.pos_x === x && 
        enemy.pos_y === y && 
        !enemy.is_dead &&
        enemyId !== excludeEnemyId) {
      return true;
    }
  }
  return false;
}

// Calculate Euclidean distance between two points
function getDistance(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Find the closest player to an enemy on the same map (within 4 tile range)
function findClosestPlayer(enemy) {
  let closestPlayer = null;
  let closestDistance = Infinity;
  const MAX_PURSUIT_RANGE = 4; // Only pursue players within 4 tiles
  
  for (const [ws, playerData] of clients.entries()) {
    if (playerData && 
        Number(playerData.map_id) === Number(enemy.map_id) && 
        !playerData.is_dead &&
        (!playerData.temporarySprite || playerData.temporarySprite === 0)) { // Ignore transformed players
      const distance = getDistance(
        enemy.pos_x, enemy.pos_y, 
        playerData.pos_x, playerData.pos_y
      );
      
      // Only consider players within pursuit range
      if (distance <= MAX_PURSUIT_RANGE && distance < closestDistance) {
        closestDistance = distance;
        closestPlayer = playerData;
      }
    }
  }
  
  return closestPlayer;
}

// Handle player attack on enemy
async function playerAttackEnemy(playerData, playerWs) {
  // Get position in front of player based on direction
  const targetPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
  
  console.log(`Player ${playerData.username} attacking position (${targetPos.x}, ${targetPos.y}) from (${playerData.pos_x}, ${playerData.pos_y}) facing ${playerData.direction}`);
  
  // Find enemy at target position
  const targetEnemy = Object.values(enemies).find(enemy => 
    Number(enemy.map_id) === Number(playerData.map_id) &&
    enemy.pos_x === targetPos.x &&
    enemy.pos_y === targetPos.y &&
    !enemy.is_dead
  );

  if (!targetEnemy) {
    console.log(`No enemy found at position (${targetPos.x}, ${targetPos.y}) on map ${playerData.map_id}`);
    return false;
  }
  
  console.log(`Found enemy ${targetEnemy.id} (type ${targetEnemy.enemy_type}) at position (${targetPos.x}, ${targetPos.y}), HP: ${targetEnemy.hp}`);

  // Check for electrocute spell if player has item #99 in hands
  let electrocuteTriggered = false;
  let electrocuteEnemyName = '';
  if (playerData.hands === 99 && (playerData.magic || 0) >= 5) {
    // Deduct magic cost
    playerData.magic = Math.max(0, (playerData.magic || 0) - 5);
    electrocuteTriggered = true;
    
    // Update magic in database
    updateStatsInDb(playerData.id, { magic: playerData.magic })
      .catch(err => console.error('Error updating magic after electrocute:', err));
    
    // Send magic update to client
    send(playerWs, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
    
    // Create electrocute effect
    const electrocuteId = Date.now() + Math.random(); // Unique ID for this effect
    createElectrocuteEffect(electrocuteId, targetPos.x, targetPos.y, playerData.map_id);
    
    // Deal electrocute damage (2 damage)
    targetEnemy.hp = Math.max(0, targetEnemy.hp - 2);
    
    // Store enemy name for later message
    const enemyDetails = targetEnemy.details;
    electrocuteEnemyName = enemyDetails?.name || `Enemy ${targetEnemy.enemy_type}`;
    
    console.log(`Player ${playerData.username} electrocuted enemy ${targetEnemy.id} for 2 damage, enemy HP now: ${targetEnemy.hp}`);
  }

  // Calculate player's attack damage
  let minDamage = 0;
  let maxDamage = 1; // Default fist damage

  if (playerData.weapon && playerData.weapon > 0) {
    const weaponDetails = getItemDetails(playerData.weapon);
    console.log(`Player weapon ${playerData.weapon}:`, weaponDetails);
    if (weaponDetails && weaponDetails.type === 'weapon' && 
        typeof weaponDetails.statMin === 'number' && typeof weaponDetails.statMax === 'number') {
      minDamage = weaponDetails.statMin;
      maxDamage = weaponDetails.statMax;
      console.log(`Using weapon damage: ${minDamage}-${maxDamage}`);
    }
  } else {
    console.log(`Player using fist damage: ${minDamage}-${maxDamage}`);
  }

  // Calculate initial damage
  const initialDamage = Math.floor(Math.random() * (maxDamage - minDamage + 1)) + minDamage;
  console.log(`Initial damage rolled: ${initialDamage}`);

  // Calculate enemy defense
  let defense = 0;
  const enemyDetails = targetEnemy.details;
  if (enemyDetails && typeof enemyDetails.defense_min === 'number' && typeof enemyDetails.defense_max === 'number') {
    defense = Math.floor(Math.random() * (enemyDetails.defense_max - enemyDetails.defense_min + 1)) + enemyDetails.defense_min;
    console.log(`Enemy defense rolled: ${defense} (from ${enemyDetails.defense_min}-${enemyDetails.defense_max})`);
  } else {
    console.log(`Enemy has no defense stats:`, enemyDetails);
  }

  // Calculate final damage
  const finalDamage = Math.max(0, initialDamage - defense);
  console.log(`Final damage: ${finalDamage} (${initialDamage} - ${defense})`);

  // Send attack message to player
  const enemyName = enemyDetails?.name || `Enemy ${targetEnemy.enemy_type}`;
  send(playerWs, { type: 'chat', text: `~ You attack ${enemyName} for ${finalDamage} damage!` });
  
  // Send electrocute message after attack message if electrocute triggered
  if (electrocuteTriggered) {
    send(playerWs, { 
      type: 'chat', 
      text: `Your attack also electrocutes ${electrocuteEnemyName} for 2 damage!`,
      color: 'purple'
    });
  }

  // Apply damage to enemy
  const oldHp = targetEnemy.hp;
  targetEnemy.hp = Math.max(0, targetEnemy.hp - finalDamage);
  console.log(`Enemy HP: ${oldHp} -> ${targetEnemy.hp}`);

  // Check if enemy died
  if (targetEnemy.hp <= 0) {
    console.log(`Enemy ${targetEnemy.id} died, handling death...`);
    // Send slain message to player
    const enemyName = enemyDetails?.name || `Enemy ${targetEnemy.enemy_type}`;
    send(playerWs, { type: 'chat', text: `~ You have slain ${enemyName}!` });
    await handleEnemyDeath(targetEnemy);
  } else {
    // Enemy survived, counter-attack the player
    console.log(`Enemy ${targetEnemy.id} survived with ${targetEnemy.hp} HP, counter-attacking...`);
    await enemyAttackPlayer(targetEnemy, playerData.pos_x, playerData.pos_y);
  }

  return true;
}

// Handle enemy death
async function handleEnemyDeath(enemy) {
  try {
    // Mark enemy as dead
    enemy.is_dead = true;

    // Remove enemy from database
    await pool.query('DELETE FROM enemies WHERE id = $1', [enemy.id]);

    // Remove from memory
    delete enemies[enemy.id];

    // Broadcast enemy removal to all clients on the same map
    console.log(`Broadcasting enemy_removed for enemy ${enemy.id} on map ${enemy.map_id}`);
    for (const [ws, playerData] of clients.entries()) {
      if (playerData && Number(playerData.map_id) === Number(enemy.map_id)) {
        if (ws.readyState === WebSocket.OPEN) {
          console.log(`Sending enemy_removed to player ${playerData.username} on map ${playerData.map_id}`);
          send(ws, {
            type: 'enemy_removed',
            id: enemy.id,
            map_id: enemy.map_id
          });
        }
      }
    }

    // Create drop container with item 201 at enemy position
    const dropItems = [];
    let dropGold = 0;
    
    const enemyDetails = enemy.details;
    if (enemyDetails) {
      // Handle item drop based on drop_chance
      if (enemyDetails.drop_item && typeof enemyDetails.drop_chance === 'number') {
        const dropRoll = Math.random() * 100; // 0-100
        console.log(`Drop roll: ${dropRoll}% vs ${enemyDetails.drop_chance}% chance for item ${enemyDetails.drop_item}`);
        if (dropRoll <= enemyDetails.drop_chance) {
          dropItems.push(enemyDetails.drop_item);
          console.log(`Item ${enemyDetails.drop_item} dropped!`);
        } else {
          console.log(`Item ${enemyDetails.drop_item} did not drop`);
        }
      }
      
      // Handle gold drop
      if (typeof enemyDetails.drop_gold_min === 'number' && typeof enemyDetails.drop_gold_max === 'number') {
        dropGold = Math.floor(Math.random() * (enemyDetails.drop_gold_max - enemyDetails.drop_gold_min + 1)) + enemyDetails.drop_gold_min;
        console.log(`Gold dropped: ${dropGold} (from ${enemyDetails.drop_gold_min}-${enemyDetails.drop_gold_max})`);
      }
    }

    await createOrUpdateDropContainer(enemy.map_id, enemy.pos_x, enemy.pos_y, dropItems, dropGold);

    // Set respawn timer (using existing enemy respawn logic)
    if (!enemy.is_admin_spawned) {
      // Re-spawn the enemy after delay (existing system should handle this)
      const respawnTime = new Date(Date.now() + 30000); // 30 second respawn
      await pool.query(
        'INSERT INTO enemies (enemy_type, map_id, pos_x, pos_y, spawn_x, spawn_y, hp, direction, step, is_dead, respawn_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [enemy.enemy_type, enemy.map_id, enemy.spawn_x, enemy.spawn_y, enemy.spawn_x, enemy.spawn_y, enemy.details?.hp || 100, 'down', 1, true, respawnTime]
      );
    }

    return true;
  } catch (error) {
    console.error('Error handling enemy death:', error);
    return false;
  }
}

// Handle enemy attack on player
async function enemyAttackPlayer(enemy, targetX, targetY) {
  console.log(`enemyAttackPlayer called: Enemy ${enemy.id} attacking position (${targetX}, ${targetY})`);
  
  // Debug: List all players on this map
  console.log(`Players on map ${enemy.map_id}:`);
  for (const [ws, playerData] of clients.entries()) {
    if (playerData && Number(playerData.map_id) === Number(enemy.map_id)) {
      console.log(`  Player ${playerData.username} at (${playerData.pos_x}, ${playerData.pos_y}), dead: ${playerData.is_dead}`);
    }
  }
  
  // Find the player at the target position
  let targetPlayer = null;
  let targetWs = null;
  
  for (const [ws, playerData] of clients.entries()) {
    if (playerData && 
        Number(playerData.map_id) === Number(enemy.map_id) && 
        playerData.pos_x === targetX && 
        playerData.pos_y === targetY && 
        !playerData.is_dead &&
        (!playerData.temporarySprite || playerData.temporarySprite === 0)) { // Don't attack transformed players
      targetPlayer = playerData;
      targetWs = ws;
      break;
    }
  }

  console.log(`Target player found: ${!!targetPlayer}`);
  if (!targetPlayer || !targetWs) return false;

  const playerData = targetPlayer;
  
  // Get enemy details for attack stats
  const enemyDetails = enemy.details;
  if (!enemyDetails || typeof enemyDetails.attack_min !== 'number' || typeof enemyDetails.attack_max !== 'number') {
    return false;
  }

  // Calculate initial damage (random between attack_min and attack_max)
  const initialDamage = Math.floor(Math.random() * (enemyDetails.attack_max - enemyDetails.attack_min + 1)) + enemyDetails.attack_min;
  
  // Calculate defense from player's armor
  let defense = 0;
  if (playerData.armor && playerData.armor > 0) {
    const armorDetails = getItemDetails(playerData.armor);
    if (armorDetails && armorDetails.type === 'armor' && 
        typeof armorDetails.statMin === 'number' && typeof armorDetails.statMax === 'number') {
      defense = Math.floor(Math.random() * (armorDetails.statMax - armorDetails.statMin + 1)) + armorDetails.statMin;
    }
  }

  // Calculate final damage
  const finalDamage = Math.max(0, initialDamage - defense);

  // Send attack text to player
  if (enemyDetails.attack_text) {
    send(targetWs, { type: 'chat', text: enemyDetails.attack_text, color: 'red' });
  }

  // Send damage message to player
  const enemyName = enemyDetails.name || `Enemy ${enemy.enemy_type}`;
  send(targetWs, { type: 'chat', text: `${enemyName} deals ${finalDamage} damage to you!`, color: 'red' });

  // Apply damage
  if (finalDamage > 0) {
    playerData.life = Math.max(0, (playerData.life || 0) - finalDamage);
    
    // Update player's HP in database
    await updateStatsInDb(playerData.id, { life: playerData.life });
    
    // Send stats update to player
    send(targetWs, { type: 'stats_update', id: playerData.id, life: playerData.life });
  }

  // Check if player died
  if (playerData.life <= 0) {
    await handlePlayerDeath(playerData, targetWs, enemy);
  }

  return true;
}

// Handle player death
async function handlePlayerDeath(playerData, playerWs, killerEnemy) {
  // Set player as dead
  playerData.is_dead = true;
  
  // Send death messages to player
  send(playerWs, { type: 'chat', text: 'You have died!', color: 'red' });
  send(playerWs, { type: 'chat', text: 'Anything you were holding in your hands has dropped on the ground where you died.', color: 'red' });
  
  // Broadcast death message to all players
  const enemyName = killerEnemy.details?.name || `Enemy ${killerEnemy.enemy_type}`;
  broadcast({ 
    type: 'chat', 
    text: `${playerData.username} has been killed by ${enemyName}!`,
    color: 'grey'
  });

  // Drop item from hands using drop_container system
  if (playerData.hands && playerData.hands > 0) {
    const droppedItemId = playerData.hands;
    const itemsToAdd = [droppedItemId];
    
    // Clear hands first
    playerData.hands = 0;
    
    // Check if there's already an item on the ground
    const currentMapSpec = getMapSpec(playerData.map_id);
    const existingItemId = getItemAtPosition(playerData.pos_x, playerData.pos_y, currentMapSpec, playerData.map_id);
    if (existingItemId && existingItemId > 0 && existingItemId !== 201) {
      // There's an item on the ground, add it to the drop container too
      itemsToAdd.push(existingItemId);
      // Remove the existing item from the map
      await saveItemToDatabase(playerData.pos_x, playerData.pos_y, 0, playerData.map_id);
    }
    
    // Create or update drop container with the item(s)
    await createOrUpdateDropContainer(playerData.map_id, playerData.pos_x, playerData.pos_y, itemsToAdd, 0);
    
    // Update player hands in database
    await updateStatsInDb(playerData.id, { hands: playerData.hands });
    
    // Send equipment update to player (hands cleared)
    send(playerWs, {
      type: 'player_equipment_update',
      id: playerData.id,
      hands: playerData.hands
    });
    
    console.log(`Player death: Created drop_container with items [${itemsToAdd.join(', ')}] at (${playerData.pos_x}, ${playerData.pos_y})`);
  }

  // Get respawn location from map data
  try {
    const currentMapData = getMapData(playerData.map_id);
    if (!currentMapData || typeof currentMapData.diemap !== 'number') {
      console.error('No diemap found for current map:', playerData.map_id);
      return;
    }

    const respawnMapId = currentMapData.diemap;
    const respawnMapData = getMapData(respawnMapId);
    
    if (!respawnMapData || !respawnMapData.start) {
      console.error('No start coordinates found for respawn map:', respawnMapId);
      return;
    }

    // Parse start coordinates (format: "x,y")
    const [respawnX, respawnY] = respawnMapData.start.split(',').map(Number);
    
    // Restore player stats
    playerData.life = playerData.max_life || 100;
    playerData.stamina = playerData.max_stamina || 100;
    playerData.magic = playerData.max_magic || 100;
    playerData.is_dead = false;
    
    // Update position and map
    playerData.pos_x = respawnX;
    playerData.pos_y = respawnY;
    playerData.map_id = respawnMapId;

    // Update database
    await updateStatsInDb(playerData.id, {
      life: playerData.life,
      stamina: playerData.stamina,
      magic: playerData.magic,
      hands: playerData.hands
    });
    
    await pool.query(
      'UPDATE players SET pos_x = $1, pos_y = $2, map_id = $3 WHERE id = $4',
      [respawnX, respawnY, respawnMapId, playerData.id]
    );

    // Send respawn data to player
    const respawnMapItems = await loadItemsFromDatabase(respawnMapId);
    const respawnEnemies = getEnemiesForMap(respawnMapId);
    
    send(playerWs, {
      type: 'teleport_result',
      success: true,
      id: playerData.id,
      x: respawnX,
      y: respawnY,
      mapId: respawnMapId,
      items: respawnMapItems,
      enemies: respawnEnemies
    });

    // Send stats update
    send(playerWs, {
      type: 'stats_update',
      id: playerData.id,
      life: playerData.life,
      stamina: playerData.stamina,
      magic: playerData.magic
    });

    // Broadcast player respawn
    broadcast({
      type: 'player_moved',
      id: playerData.id,
      x: respawnX,
      y: respawnY,
      map_id: respawnMapId,
      direction: playerData.direction,
      step: playerData.step,
      isMoving: false,
      isAttacking: false
    });

  } catch (error) {
    console.error('Error handling player death:', error);
  }
}

// Drop container management functions
async function createOrUpdateDropContainer(mapId, x, y, itemsToAdd = [], goldToAdd = 0) {
  try {
    // Check if drop container already exists
    const existing = await pool.query(
      'SELECT items, gold FROM drop_containers WHERE map_id = $1 AND pos_x = $2 AND pos_y = $3',
      [mapId, x, y]
    );

    let currentItems = [];
    let currentGold = 0;

    if (existing.rows.length > 0) {
      try {
        currentItems = JSON.parse(existing.rows[0].items || '[]');
      } catch (e) {
        currentItems = [];
      }
      currentGold = existing.rows[0].gold || 0;
    }

    // Add new items (up to max 10 total)
    const combinedItems = [...currentItems];
    for (const item of itemsToAdd) {
      if (combinedItems.length < 10) {
        combinedItems.push(item);
      }
    }

    // Add gold
    const totalGold = currentGold + goldToAdd;

    // Upsert the drop container
    await pool.query(`
      INSERT INTO drop_containers (map_id, pos_x, pos_y, items, gold)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (map_id, pos_x, pos_y)
      DO UPDATE SET items = $4, gold = $5
    `, [mapId, x, y, JSON.stringify(combinedItems), totalGold]);

    // Place item 201 on the map
    await saveItemToDatabase(x, y, 201, mapId);

    // Broadcast item placement
    broadcast({
      type: 'item_placed',
      x: x,
      y: y,
      itemId: 201,
      mapId: mapId
    });

    return true;
  } catch (error) {
    console.error('Error creating/updating drop container:', error);
    return false;
  }
}

async function getDropContainer(mapId, x, y) {
  try {
    const result = await pool.query(
      'SELECT items, gold FROM drop_containers WHERE map_id = $1 AND pos_x = $2 AND pos_y = $3',
      [mapId, x, y]
    );
    
    if (result.rows.length > 0) {
      let items = [];
      try {
        items = JSON.parse(result.rows[0].items || '[]');
      } catch (e) {
        items = [];
      }
      return {
        items: items,
        gold: result.rows[0].gold || 0
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting drop container:', error);
    return null;
  }
}

async function updateDropContainer(mapId, x, y, items, gold) {
  try {
    await pool.query(
      'UPDATE drop_containers SET items = $1, gold = $2 WHERE map_id = $3 AND pos_x = $4 AND pos_y = $5',
      [JSON.stringify(items), gold, mapId, x, y]
    );
    return true;
  } catch (error) {
    console.error('Error updating drop container:', error);
    return false;
  }
}

async function removeDropContainer(mapId, x, y) {
  try {
    await pool.query(
      'DELETE FROM drop_containers WHERE map_id = $1 AND pos_x = $2 AND pos_y = $3',
      [mapId, x, y]
    );

    // Remove item 201 from the map
    await saveItemToDatabase(x, y, 0, mapId);

    // Broadcast item removal
    broadcast({
      type: 'item_placed',
      x: x,
      y: y,
      itemId: 0,
      mapId: mapId
    });

    return true;
  } catch (error) {
    console.error('Error removing drop container:', error);
    return false;
  }
}

// Move enemy in a random direction
async function moveEnemyRandomly(enemy) {
  const directions = [
    { dx: 0, dy: -1, dir: 'up' },
    { dx: 0, dy: 1, dir: 'down' },
    { dx: -1, dy: 0, dir: 'left' },
    { dx: 1, dy: 0, dir: 'right' }
  ];
  
  // Pick a random direction
  const randomDirection = directions[Math.floor(Math.random() * directions.length)];
  const newX = enemy.pos_x + randomDirection.dx;
  const newY = enemy.pos_y + randomDirection.dy;
  
  // Get map specification for collision checking
  const mapSpec = getMapSpec(enemy.map_id);
  
  // Always update direction and step (even if blocked) to match moveEnemyToward behavior
  enemy.direction = randomDirection.dir;
  // Initialize step if it's not valid, then cycle between 1 and 2
  if (enemy.step !== 1 && enemy.step !== 2) {
    enemy.step = 1;
  } else {
    enemy.step = enemy.step === 1 ? 2 : 1; // Cycle between 1 and 2
  }
  enemy.last_move_time = Date.now();
  
  // Check if the move is valid
  if (canMoveTo(newX, newY, null, mapSpec, enemy.map_id, enemy.id)) {
    // Update enemy position
    enemy.pos_x = newX;
    enemy.pos_y = newY;
    if (enemy.is_admin_spawned) {
      console.log(`Spawned enemy ${enemy.id} moved to (${newX},${newY}) facing ${enemy.direction}`);
    }
  } else {
    if (enemy.is_admin_spawned) {
      console.log(`Spawned enemy ${enemy.id} blocked from moving to (${newX},${newY}), staying at (${enemy.pos_x},${enemy.pos_y})`);
    }
  }
  
  // Always update database and broadcast (direction/step changes even if position doesn't)
  await updateEnemyDirectionAndStep(enemy.id, enemy.direction, enemy.step);
  
  // Broadcast movement to all clients
  broadcast({
    type: 'enemy_moved',
    id: enemy.id,
    pos_x: enemy.pos_x,
    pos_y: enemy.pos_y,
    direction: enemy.direction,
    step: enemy.step,
    map_id: enemy.map_id
  });
}

// Update enemy direction and step in database
async function updateEnemyDirectionAndStep(enemyId, direction, step) {
  try {
    await pool.query(
      'UPDATE enemies SET direction = $1, step = $2 WHERE id = $3',
      [direction, step, enemyId]
    );
  } catch (error) {
    console.error('Error updating enemy direction and step:', error);
  }
}

// Update enemy position in database
async function updateEnemyPosition(enemyId, x, y, direction, step) {
  try {
    await pool.query(
      'UPDATE enemies SET pos_x = $1, pos_y = $2, direction = $3, step = $4, last_move_time = NOW() WHERE id = $5',
      [x, y, direction, step, enemyId]
    );
  } catch (error) {
    console.error('Error updating enemy position:', error);
  }
}

// Move an enemy toward a target position
async function moveEnemyToward(enemy, targetX, targetY) {
  const currentX = enemy.pos_x;
  const currentY = enemy.pos_y;
  
  // Calculate direction to move
  let newX = currentX;
  let newY = currentY;
  let newDirection = enemy.direction;
  
  // Simple AI: move in the direction that reduces distance most
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  
  if (Math.abs(dx) > Math.abs(dy)) {
    // Move horizontally
    if (dx > 0) {
      newX = currentX + 1;
      newDirection = 'right';
    } else {
      newX = currentX - 1;
      newDirection = 'left';
    }
  } else {
    // Move vertically
    if (dy > 0) {
      newY = currentY + 1;
      newDirection = 'down';
    } else {
      newY = currentY - 1;
      newDirection = 'up';
    }
  }
  
  // Always increment step and update direction (even if blocked)
  // Enemies only use steps 1 and 2, alternating between them
  const newStep = enemy.step === 1 ? 2 : 1;
  enemy.direction = newDirection;
  enemy.step = newStep;
  enemy.last_move_time = Date.now();
  
  // Check if the move is valid (exclude this enemy from collision check)
  const mapSpec = getMapSpec(enemy.map_id);
  if (canMoveTo(newX, newY, null, mapSpec, enemy.map_id, enemy.id)) {
    // Update position
    enemy.pos_x = newX;
    enemy.pos_y = newY;
    
    // Update database with new position
    await updateEnemyPosition(enemy.id, newX, newY, newDirection, newStep);
    
    // Broadcast movement to all clients
    broadcast({
      type: 'enemy_moved',
      id: enemy.id,
      pos_x: newX,
      pos_y: newY,
      direction: newDirection,
      step: newStep,
      map_id: enemy.map_id
    });
    
    return true;
  } else {
    // Can't move to optimal position, but still update direction and step
    await updateEnemyDirectionAndStep(enemy.id, newDirection, newStep);
    
    // Check if we're adjacent to the target player - if so, just face them and animate
    const dx = Math.abs(targetX - currentX);
    const dy = Math.abs(targetY - currentY);
    const isAdjacent = (dx <= 1 && dy <= 1) && (dx + dy === 1); // Only orthogonally adjacent
    
    if (isAdjacent) {
      // We're next to the player and can't move - this means there's a player blocking us
      // Since we're moving toward a target player, we should attack
      console.log(`Enemy ${enemy.id} adjacent to player at (${targetX}, ${targetY}), attempting attack`);
      await enemyAttackPlayer(enemy, targetX, targetY);
      
      // Face the player and animate in place
      broadcast({
        type: 'enemy_moved',
        id: enemy.id,
        pos_x: currentX,
        pos_y: currentY,
        direction: newDirection,
        step: newStep,
        map_id: enemy.map_id
      });
      return false; // Didn't move but did animate
    }
    
    // Not adjacent to player, try other directions for actual movement
    const directions = ['up', 'down', 'left', 'right'];
    for (const direction of directions) {
      if (direction === newDirection) continue; // Already tried this
      
      const pos = getAdjacentPosition(currentX, currentY, direction);
      if (canMoveTo(pos.x, pos.y, null, mapSpec, enemy.map_id, enemy.id)) {
        enemy.pos_x = pos.x;
        enemy.pos_y = pos.y;
        enemy.direction = direction;
        
        await updateEnemyPosition(enemy.id, pos.x, pos.y, direction, newStep);
        
        broadcast({
          type: 'enemy_moved',
          id: enemy.id,
          pos_x: pos.x,
          pos_y: pos.y,
          direction: direction,
          step: newStep,
          map_id: enemy.map_id
        });
        
        return true;
      }
    }
    
    // Couldn't move anywhere, just animate in place facing the player
    broadcast({
      type: 'enemy_moved',
      id: enemy.id,
      pos_x: currentX,
      pos_y: currentY,
      direction: newDirection,
      step: newStep,
      map_id: enemy.map_id
    });
    
    return false; // Couldn't move but did update animation
  }
}

// Main enemy AI processing function
async function processEnemyAI() {
  const currentTime = Date.now();
  
  for (const [enemyId, enemy] of Object.entries(enemies)) {
    if (enemy.is_dead) continue;
    
    // Check if enough time has passed since last move (based on enemy's move_delay)
    const timeSinceLastMove = currentTime - enemy.last_move_time;
    const moveDelayMs = (enemy.details.move_delay || 1) * 1000; // Convert seconds to milliseconds
    
    if (timeSinceLastMove < moveDelayMs) continue;
    
    // Find closest player on the same map (within pursuit range)
    const closestPlayer = findClosestPlayer(enemy);
    
    if (closestPlayer) {
      // Try to move toward the closest player
      await moveEnemyToward(enemy, closestPlayer.pos_x, closestPlayer.pos_y);
    } else {
      // No player within range - move randomly
      // Debug logging for spawned enemies
      if (enemy.is_admin_spawned) {
        console.log(`Spawned enemy ${enemyId} at (${enemy.pos_x},${enemy.pos_y}) attempting random movement...`);
      }
      await moveEnemyRandomly(enemy);
    }
  }
}

// Check if an enemy is moving onto a spell tile and handle collision
async function checkEnemySpellCollision(enemy, newX, newY) {
  // Check if there's a spell at the new position
  for (const [spellId, spell] of Object.entries(spells)) {
    if (spell.mapId === enemy.map_id && spell.currentX === newX && spell.currentY === newY) {
      // Enemy is moving onto a spell tile - deal damage
      console.log(`Enemy ${enemy.id} moved onto fire pillar spell ${spellId} at (${newX}, ${newY})`);
      
      // Deal 5 damage to enemy
      enemy.hp = Math.max(0, (enemy.hp || enemy.max_hp || 0) - 5);
      
      console.log(`Fire pillar deals 5 damage to enemy ${enemy.id}, HP: ${enemy.hp}`);
      
      // Update enemy HP in database
      try {
        await pool.query('UPDATE enemies SET hp = $1 WHERE id = $2', [enemy.hp, enemy.id]);
      } catch (err) {
        console.error('Error updating enemy HP in database:', err);
      }
      
      // Get enemy name from enemy details
      const enemyDetailsData = getEnemyDetails(enemy.enemy_type);
      const enemyName = enemyDetailsData ? enemyDetailsData.name : `Enemy ${enemy.enemy_type}`;
      
      // Find the caster player and send them a damage message
      for (const [ws, playerData] of clients.entries()) {
        if (playerData.id === spell.casterPlayerId) {
          send(ws, {
            type: 'chat',
            text: `Your Fire Pillar spell deals 5 damage to ${enemyName}!`,
            color: 'red'
          });
          break;
        }
      }
      
      // Check if enemy died
      if (enemy.hp <= 0) {
        // Send death message to caster before handling death
        for (const [ws, playerData] of clients.entries()) {
          if (playerData.id === spell.casterPlayerId) {
            send(ws, {
              type: 'chat',
              text: `You have slain ${enemyName}!`,
              color: 'red'
            });
            break;
          }
        }
        await handleEnemyDeath(enemy, null); // No attacking player for spell kills
        return true; // Enemy died, stop processing movement
      }
      
      // Only process collision with one spell per movement
      break;
    }
  }
  return false; // Enemy didn't die
}

// Move enemy toward a target position
async function moveEnemyToward(enemy, targetX, targetY) {
  const currentX = enemy.pos_x;
  const currentY = enemy.pos_y;
  
  // Calculate direction to move
  let newX = currentX;
  let newY = currentY;
  
  if (targetX > currentX) {
    newX = currentX + 1;
    enemy.direction = 'right';
  } else if (targetX < currentX) {
    newX = currentX - 1;
    enemy.direction = 'left';
  } else if (targetY > currentY) {
    newY = currentY + 1;
    enemy.direction = 'down';
  } else if (targetY < currentY) {
    newY = currentY - 1;
    enemy.direction = 'up';
  }
  
  // Check if movement is allowed
  const mapSpec = getMapSpec(enemy.map_id);
  if (canMoveTo(newX, newY, null, mapSpec, enemy.map_id, enemy.id)) {
    // Check for spell collision before moving
    const enemyDied = await checkEnemySpellCollision(enemy, newX, newY);
    if (enemyDied) return; // Enemy died from spell, don't continue movement
    
    // Update enemy position
    enemy.pos_x = newX;
    enemy.pos_y = newY;
    enemy.last_move_time = Date.now();
    
    // Update position in database
    try {
      await pool.query('UPDATE enemies SET pos_x = $1, pos_y = $2, direction = $3, last_move_time = $4 WHERE id = $5', 
        [newX, newY, enemy.direction, new Date(), enemy.id]);
    } catch (err) {
      console.error('Error updating enemy position in database:', err);
    }
    
    // Broadcast enemy movement to all players on the same map
    broadcastToMap(enemy.map_id, {
      type: 'enemy_moved',
      id: enemy.id,
      pos_x: newX,
      pos_y: newY,
      direction: enemy.direction,
      step: enemy.step || 1
    });
  } else {
    // Can't move to target position - check if we're adjacent to the target player for attack
    const dx = Math.abs(targetX - currentX);
    const dy = Math.abs(targetY - currentY);
    const isAdjacent = (dx <= 1 && dy <= 1) && (dx + dy === 1); // Only orthogonally adjacent
    
    if (isAdjacent) {
      // We're next to the player and can't move - attempt to attack
      console.log(`Enemy ${enemy.id} adjacent to player at (${targetX}, ${targetY}), attempting attack`);
      await enemyAttackPlayer(enemy, targetX, targetY);
    }
    
    // Update last move time and direction even if we can't move (for animation)
    enemy.last_move_time = Date.now();
    
    // Update direction in database
    try {
      await pool.query('UPDATE enemies SET direction = $1, last_move_time = $2 WHERE id = $3', 
        [enemy.direction, new Date(), enemy.id]);
    } catch (err) {
      console.error('Error updating enemy direction in database:', err);
    }
    
    // Broadcast enemy "movement" (direction change) to show attack animation
    broadcastToMap(enemy.map_id, {
      type: 'enemy_moved',
      id: enemy.id,
      pos_x: currentX, // Stay in same position
      pos_y: currentY, // Stay in same position
      direction: enemy.direction,
      step: enemy.step || 1
    });
  }
}

// Move enemy in a random direction
async function moveEnemyRandomly(enemy) {
  const directions = ['up', 'down', 'left', 'right'];
  const randomDirection = directions[Math.floor(Math.random() * directions.length)];
  
  let newX = enemy.pos_x;
  let newY = enemy.pos_y;
  
  switch (randomDirection) {
    case 'up':
      newY = enemy.pos_y - 1;
      break;
    case 'down':
      newY = enemy.pos_y + 1;
      break;
    case 'left':
      newX = enemy.pos_x - 1;
      break;
    case 'right':
      newX = enemy.pos_x + 1;
      break;
  }
  
  // Check if movement is allowed
  const mapSpec = getMapSpec(enemy.map_id);
  if (canMoveTo(newX, newY, null, mapSpec, enemy.map_id, enemy.id)) {
    // Check for spell collision before moving
    const enemyDied = await checkEnemySpellCollision(enemy, newX, newY);
    if (enemyDied) return; // Enemy died from spell, don't continue movement
    
    // Update enemy position
    enemy.pos_x = newX;
    enemy.pos_y = newY;
    enemy.direction = randomDirection;
    enemy.last_move_time = Date.now();
    
    // Update position in database
    try {
      await pool.query('UPDATE enemies SET pos_x = $1, pos_y = $2, direction = $3, last_move_time = $4 WHERE id = $5', 
        [newX, newY, enemy.direction, new Date(), enemy.id]);
    } catch (err) {
      console.error('Error updating enemy position in database:', err);
    }
    
    // Broadcast enemy movement to all players on the same map
    broadcastToMap(enemy.map_id, {
      type: 'enemy_moved',
      id: enemy.id,
      pos_x: newX,
      pos_y: newY,
      direction: randomDirection,
      step: enemy.step || 1
    });
  }
}

// Check if movement to position is allowed
function canMoveTo(x, y, excludePlayerId = null, mapSpec = null, mapId = 1, excludeEnemyId = null) {
  // Check map bounds
  if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
    return false;
  }
  
  // Get mapSpec if not provided
  if (!mapSpec) {
    mapSpec = getMapSpec(mapId);
  }
  
  // Check floor collision
  if (hasFloorCollision(x, y, mapSpec)) {
    return false;
  }
  
  // Check item collision
  const targetItemId = getItemAtPosition(x, y, mapSpec, mapId);
  const targetItemDetails = getItemDetails(targetItemId);
  if (targetItemDetails && targetItemDetails.collision) {
    return false;
  }
  
  // Check player collision
  if (isPlayerAtPosition(x, y, excludePlayerId)) {
    return false;
  }
  
  // Check enemy collision
  if (isEnemyAtPosition(x, y, mapId, excludeEnemyId)) {
    return false;
  }
  
  return true;
}

function checkTeleportDestination(x, y, itemId) {
  let destX = x, destY = y;
  
  if (itemId === 42) {
    // 2 left, 1 up
    destX = x - 2;
    destY = y - 1;
  } else if (itemId === 338) {
    // 2 up, 1 left
    destX = x - 1;
    destY = y - 2;
  }
  
  // Check if destination is within map bounds
  return destX >= 0 && destY >= 0 && destX < MAP_WIDTH && destY < MAP_HEIGHT;
}

function calculateChainTeleportation(startX, startY, mapSpec) {
  let currentX = startX;
  let currentY = startY;
  let teleportCount = 0;
  const maxTeleports = 10;
  
  // Keep teleporting until we land on a non-teleport tile or hit max teleports
  while (teleportCount < maxTeleports) {
    const currentItemId = getItemAtPosition(currentX, currentY, mapSpec);
    if (currentItemId !== 42 && currentItemId !== 338) {
      break; // Not a teleport tile, stop here
    }
    
    let nextX, nextY;
    if (currentItemId === 42) {
      // 2 left, 1 up from the teleport tile
      nextX = currentX - 2;
      nextY = currentY - 1;
    } else if (currentItemId === 338) {
      // 2 up, 1 left from the teleport tile  
      nextX = currentX - 1;
      nextY = currentY - 2;
    }
    
    // Check if teleport destination is within bounds
    if (nextX >= 0 && nextY >= 0 && nextX < MAP_WIDTH && nextY < MAP_HEIGHT) {
      currentX = nextX;
      currentY = nextY;
      teleportCount++;
    } else {
      // Can't teleport out of bounds, stop on current teleport tile
      break;
    }
  }
  
  return { x: currentX, y: currentY, teleportCount };
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
    map_id: playerData.map_id,
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
function stopAttackAnimation(playerData, ws, resetStep = true, shouldBroadcast = true) {
  if (!playerData.isAttacking) return;
  
  // Clear timeout if it exists
  const existingTimeout = attackTimeouts.get(playerData.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    attackTimeouts.delete(playerData.id);
  }

  // Set back to appropriate animation based on current state
  playerData.isAttacking = false;
  
  // Only reset step to 2 if requested (not when called from movement)
  if (resetStep) {
    playerData.step = 2;
    
    // Update database only if we're resetting step
    updateDirectionAndStep(playerData.id, playerData.direction, playerData.step)
      .catch(err => console.error('Attack stop DB error:', err));
  }

  // Only broadcast if requested (not when called from movement)
  if (shouldBroadcast) {
    // Broadcast attack stop to all players (clients will filter by map)
    broadcast({
      type: 'animation_update',
      id: playerData.id,
      map_id: playerData.map_id,
      direction: playerData.direction,
      step: playerData.step,
      isMoving: playerData.isMoving,
      isAttacking: false
    });
  }
}

// Start pickup animation for a player
function startPickupAnimation(playerData, ws) {
  // Clear any existing attack timeout
  const existingTimeout = attackTimeouts.get(playerData.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    attackTimeouts.delete(playerData.id);
  }

  // Set pickup state - using 'sit' animation (index 21)
  playerData.isPickingUp = true;
  playerData.isAttacking = false;
  playerData.isMoving = false;
  playerData.animationFrame = 21; // 'sit' animation

  // Update database
  updateAnimationState(playerData.id, playerData.direction, false, false, playerData.animationFrame, playerData.movementSequenceIndex)
    .catch(err => console.error('Pickup start DB error:', err));

  // Broadcast pickup animation start
  broadcast({
    type: 'animation_update',
    id: playerData.id,
    map_id: playerData.map_id,
    direction: playerData.direction,
    isMoving: false,
    isAttacking: false,
    isPickingUp: true,
    animationFrame: playerData.animationFrame,
    movementSequenceIndex: playerData.movementSequenceIndex
  });

  // Set timeout to stop pickup after 0.5 seconds
  const timeoutId = setTimeout(() => {
    stopPickupAnimation(playerData, ws);
    attackTimeouts.delete(playerData.id);
  }, 500);
  
  attackTimeouts.set(playerData.id, timeoutId);
}

// Stop pickup animation for a player
function stopPickupAnimation(playerData, ws) {
  if (!playerData.isPickingUp) return;
  
  // Clear timeout if it exists
  const existingTimeout = attackTimeouts.get(playerData.id);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    attackTimeouts.delete(playerData.id);
  }

  // Set to 'stand' animation - this will be overridden if player moves
  playerData.isPickingUp = false;
  playerData.step = 2; // Reset step to 2 after pickup
  
  // Update database
  updateDirectionAndStep(playerData.id, playerData.direction, playerData.step)
    .catch(err => console.error('Pickup stop DB error:', err));

  // Broadcast stand animation to all players (clients will filter by map)
  broadcast({
    type: 'animation_update',
    id: playerData.id,
    map_id: playerData.map_id,
    direction: playerData.direction,
    step: playerData.step,
    isMoving: playerData.isMoving,
    isAttacking: playerData.isAttacking,
    isPickingUp: false,
    animationFrame: 20 // 'stand' animation
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
      ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'player',
      ADD COLUMN IF NOT EXISTS is_picking_up BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_brb BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS map_id INTEGER DEFAULT 1
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

    // Create chat_log table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_log (
        id SERIAL PRIMARY KEY,
        player_id INTEGER,
        username VARCHAR(50),
        message_type VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        map_id INTEGER
      )
    `);

    // Create map_containers table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS map_containers (
        x INTEGER,
        y INTEGER,
        map_id INTEGER,
        item_id INTEGER,
        PRIMARY KEY (x, y, map_id)
      )
    `);

    // Create enemies table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS enemies (
        id SERIAL PRIMARY KEY,
        enemy_type INTEGER NOT NULL,
        map_id INTEGER NOT NULL,
        pos_x INTEGER NOT NULL,
        pos_y INTEGER NOT NULL,
        spawn_x INTEGER NOT NULL,
        spawn_y INTEGER NOT NULL,
        hp INTEGER NOT NULL,
        direction VARCHAR(10) DEFAULT 'down',
        step INTEGER DEFAULT 1,
        last_move_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_dead BOOLEAN DEFAULT false,
        respawn_time TIMESTAMP,
        is_admin_spawned BOOLEAN DEFAULT false
      )
    `);

    // Create drop_containers table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drop_containers (
        map_id INTEGER NOT NULL,
        pos_x INTEGER NOT NULL,
        pos_y INTEGER NOT NULL,
        items TEXT DEFAULT '[]',
        gold INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (map_id, pos_x, pos_y)
      )
    `);

    // Add map_id column if it doesn't exist (migration)
    try {
      await pool.query(`ALTER TABLE map_items ADD COLUMN IF NOT EXISTS map_id INTEGER DEFAULT 1`);
      // Update the primary key to include map_id (this might fail on existing data, that's okay)
      try {
        await pool.query(`ALTER TABLE map_items DROP CONSTRAINT IF EXISTS map_items_pkey`);
        await pool.query(`ALTER TABLE map_items ADD PRIMARY KEY (x, y, map_id)`);
      } catch (pkError) {
        console.log('Primary key update skipped (existing data may prevent this)');
      }
    } catch (alterError) {
      console.error('Error adding map_id column:', alterError);
    }

    // Create player_inventory table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS player_inventory (
        player_id INTEGER,
        slot_number INTEGER,
        item_id INTEGER DEFAULT 0,
        PRIMARY KEY (player_id, slot_number),
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
        CHECK (slot_number >= 1 AND slot_number <= 16)
      )
    `);

    console.log('Database tables initialized');
    
    // Load existing items (with error handling for schema migration)
    try {
      mapItems = await loadItemsFromDatabase();
      console.log(`Loaded ${Object.keys(mapItems).length} items from database`);
    } catch (itemLoadError) {
      console.error('Error loading items from database:', itemLoadError);
      mapItems = {}; // Initialize empty if loading fails
      console.log('Initialized empty items due to database migration');
    }

    // Load existing enemies
    try {
      await loadEnemiesFromDatabase();
    } catch (enemyLoadError) {
      console.error('Error loading enemies from database:', enemyLoadError);
      enemies = {}; // Initialize empty if loading fails
    }
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Initialize database on startup
initializeDatabase();
loadItemDetails();
loadEnemyDetails();
loadAllMaps();
loadFloorCollision();

wss.on('connection', (ws) => {
  let playerData = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'login') {
      try {
        // Input validation and sanitization
        if (!msg.username || !msg.password) {
          return send(ws, { type: 'login_error', message: 'Username and password are required' });
        }
        
        // Validate username format (alphanumeric + underscore, 3-20 chars)
        if (typeof msg.username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(msg.username)) {
          return send(ws, { type: 'login_error', message: 'Invalid username format' });
        }
        
        // Validate password length
        if (typeof msg.password !== 'string' || msg.password.length < 1 || msg.password.length > 100) {
          return send(ws, { type: 'login_error', message: 'Invalid password' });
        }
        
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
          step: found.step ?? 2,
          isMoving: found.is_moving ?? false,
          isAttacking: found.is_attacking ?? false,
          animationFrame: found.animation_frame ?? DIRECTION_IDLE.down,
          movementSequenceIndex: found.movement_sequence_index ?? 0,
          role: found.role ?? 'player',
          temporarySprite: 0,
          isBRB: false
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        // Load player inventory
        const inventory = await loadPlayerInventory(playerData.id);

        // Load items for the player's current map
        let playerMapItems = {};
        try {
          playerMapItems = await loadItemsFromDatabase(playerData.map_id);
        } catch (itemError) {
          console.error(`Error loading items for map ${playerData.map_id}:`, itemError);
          playerMapItems = {}; // Fallback to empty items
        }

        const others = Array.from(clients.values())
          .filter(p => p.id !== playerData.id)
          .map(p => ({ ...p, isBRB: p.isBRB || false }));
        
        // Get enemies for the player's map
        const mapEnemies = getEnemiesForMap(playerData.map_id);

        
        send(ws, { type: 'login_success', player: { ...playerData, temporarySprite: 0 }, players: others.map(p => ({ ...p, temporarySprite: p.temporarySprite || 0 })), items: playerMapItems, inventory: inventory, enemies: mapEnemies });
        broadcast({ type: 'player_joined', player: { ...playerData, isBRB: playerData.isBRB || false, map_id: playerData.map_id } });
        
        // Join message is handled by the player_joined broadcast and client-side logic
        // Log the login message (non-blocking)
        const joinMessage = `${playerData.username} has entered DragonSpires.`;
        logChatMessage(playerData.id, playerData.username, 'login', joinMessage, playerData.map_id)
          .catch(() => {}); // Silently ignore logging errors
      } catch (e) {
        console.error('Login error', e);
        send(ws, { type: 'login_error', message: 'Server error' });
      }
    }

    else if (msg.type === 'signup') {
      try {
        // Input validation and sanitization
        if (!msg.username || !msg.password) {
          return send(ws, { type: 'signup_error', message: 'Username and password are required' });
        }
        
        // Validate username format (alphanumeric + underscore, 3-20 chars)
        if (typeof msg.username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(msg.username)) {
          return send(ws, { type: 'signup_error', message: 'Username must be 3-20 characters (letters, numbers, underscore only)' });
        }
        
        // Validate password requirements
        if (typeof msg.password !== 'string' || msg.password.length < 3 || msg.password.length > 100) {
          return send(ws, { type: 'signup_error', message: 'Password must be 3-100 characters long' });
        }
        
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
          step: created.step ?? 2,
          isMoving: created.is_moving ?? false,
          isAttacking: created.is_attacking ?? false,
          animationFrame: created.animation_frame ?? DIRECTION_IDLE.down,
          movementSequenceIndex: created.movement_sequence_index ?? 0,
          role: created.role ?? 'player',
          temporarySprite: 0,
          isBRB: false
        };

        clients.set(ws, playerData);
        usernameToWs.set(playerData.username, ws);

        // Load player inventory
        const inventory = await loadPlayerInventory(playerData.id);

        // Load items for the player's current map
        let playerMapItems = {};
        try {
          playerMapItems = await loadItemsFromDatabase(playerData.map_id);
        } catch (itemError) {
          console.error(`Error loading items for map ${playerData.map_id}:`, itemError);
          playerMapItems = {}; // Fallback to empty items
        }

        const others = Array.from(clients.values()).filter(p => p.id !== playerData.id);
        
        // Get enemies for the player's map
        const mapEnemies = getEnemiesForMap(playerData.map_id);
        
        send(ws, { type: 'signup_success', player: playerData, players: others, items: playerMapItems, inventory: inventory, enemies: mapEnemies });
        broadcast({ type: 'player_joined', player: { ...playerData, temporarySprite: playerData.temporarySprite || 0, map_id: playerData.map_id } });
        
        // Join message is handled by the player_joined broadcast and client-side logic
        // Log the login message (non-blocking)
        const joinMessage = `${playerData.username} has entered DragonSpires.`;
        logChatMessage(playerData.id, playerData.username, 'login', joinMessage, playerData.map_id)
          .catch(() => {}); // Silently ignore logging errors
      } catch (e) {
        console.error('Signup error', e);
        send(ws, { type: 'signup_error', message: 'Server error' });
      }
    }

    else if (msg.type === 'move') {
      if (!playerData) return;
      
      // End NPC interaction on movement
      if (playerData.npcInteraction) {
        playerData.npcInteraction = null;
        send(ws, { type: 'npc_interaction_end' });
        console.log(`Player ${playerData.username} ended NPC interaction due to movement`);
      }
      
      // Cancel resting when moving
      if (playerData.isResting) {
        playerData.isResting = false;
        send(ws, { type: 'chat', text: 'You stand, feeling more rested.', color: 'gold' });
        console.log(`Player ${playerData.username} stopped resting due to movement`);
      }
      
      // Always clear animation frame when moving to restore normal movement sprites
      if (playerData.animationFrame !== null && playerData.animationFrame !== undefined) {
        playerData.animationFrame = null;
        
        // Broadcast animation frame clear
        broadcast({
          type: 'animation_update',
          id: playerData.id,
          map_id: playerData.map_id,
          animationFrame: null,
          isResting: false
        });
      }
      
      // Clear temporary sprite when moving
      playerData.temporarySprite = 0;
      // Broadcast temporary sprite clear to all players (client will filter by map)
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: 0
      });

      // Clear fountain effect when moving (broadcast to all players)
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
              type: 'clear_fountain_effect',
              playerId: playerData.id
            }));
          }
        }
      }
    
      // Clear BRB state when player moves
      if (playerData.isBRB) {
        playerData.isBRB = false;
        
        const brbUpdate = {
          type: 'player_brb_update',
          id: playerData.id,
          brb: false
        };
        
        for (const [otherWs, otherPlayer] of clients.entries()) {
          if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
            if (otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify(brbUpdate));
            }
          }
        }
      }
    
      // Cancel any pickup animation when moving
      if (playerData.isPickingUp) {
        const existingTimeout = attackTimeouts.get(playerData.id);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          attackTimeouts.delete(playerData.id);
        }
        playerData.isPickingUp = false;
      }
    
      // stamina gate
      if ((playerData.stamina ?? 0) <= 0) {
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        return;
      }

      // Cancel any attack animation when moving (don't reset step/direction, don't broadcast)
      if (playerData.isAttacking) {
        stopAttackAnimation(playerData, ws, false, false);
      }

      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;
      const nx = playerData.pos_x + dx;
      const ny = playerData.pos_y + dy;

     // Check for teleportation items first
      const playerMapSpec = getMapSpec(playerData.map_id);
      const targetItemId = getItemAtPosition(nx, ny, playerMapSpec, playerData.map_id);
      if (targetItemId === 42 || targetItemId === 338) {
        // Handle chain teleportation
        const finalDestination = calculateChainTeleportation(nx, ny, playerMapSpec);
        
        // Check if final destination is within bounds (should be, but double-check)
        if (finalDestination.x < 0 || finalDestination.y < 0 || 
            finalDestination.x >= MAP_WIDTH || finalDestination.y >= MAP_HEIGHT) {
          // Don't allow movement if final destination is out of bounds
          return;
        }
        
        // Decrement stamina for the movement attempt (only once)
        playerData.stamina = Math.max(0, (playerData.stamina ?? 0) - 1);
        
        // Set position to final teleport destination
        playerData.pos_x = finalDestination.x;
        playerData.pos_y = finalDestination.y;
        
        // Update direction
        if (msg.direction) {
          playerData.direction = msg.direction;
        }
        
        // Keep movement sequence at 0 for teleport (no walking animation)
        playerData.movementSequenceIndex = 0;
        playerData.animationFrame = DIRECTION_IDLE[playerData.direction] || DIRECTION_IDLE.down;
        playerData.isMoving = false;
        playerData.isAttacking = false;
        
        // Save to database
        Promise.allSettled([
          updateStatsInDb(playerData.id, { stamina: playerData.stamina }),
          updatePosition(playerData.id, finalDestination.x, finalDestination.y),
          updateAnimationState(playerData.id, playerData.direction, false, false, playerData.animationFrame, 0)
        ]).catch(()=>{});
        
        // Broadcast the final teleported position
        broadcast({ 
          type: 'player_moved', 
          id: playerData.id, 
          x: finalDestination.x, 
          y: finalDestination.y, 
          direction: playerData.direction,
          isMoving: false,
          isAttacking: false,
          animationFrame: playerData.animationFrame,
          movementSequenceIndex: 0
        });
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        return;
      }
      
      // Always increment step and update direction (even if movement is blocked)
      if (msg.direction) {
        playerData.direction = msg.direction;
      }
      
      // Increment step: 1 -> 2 -> 3 -> 1
      playerData.step = playerData.step === 3 ? 1 : (playerData.step ?? 2) + 1;
      
      if (canMoveTo(nx, ny, playerData.id, playerMapSpec, playerData.map_id)) {
        // Decrement stamina by **1**
        playerData.stamina = Math.max(0, (playerData.stamina ?? 0) - 1);
        playerData.pos_x = nx;
        playerData.pos_y = ny;
        playerData.isMoving = true;
        playerData.isAttacking = false; // Ensure attack state is cleared

        // Check for portals after moving to the new position
        const mapData = getMapData(playerData.map_id);
        if (mapData && mapData.portals) {
          for (const portal of mapData.portals) {
            const [portalX, portalY, newMapId, newX, newY] = portal.split(',').map(Number);
            
            if (playerData.pos_x === portalX && playerData.pos_y === portalY) {
              // Player stepped on a portal - teleport them
              const oldMapId = playerData.map_id;
              playerData.map_id = newMapId;
              playerData.pos_x = newX;
              playerData.pos_y = newY;
              
              // Save to database immediately with new position and map
              Promise.allSettled([
                updateStatsInDb(playerData.id, { stamina: playerData.stamina }),
                updatePosition(playerData.id, newX, newY),
                updateDirectionAndStep(playerData.id, playerData.direction, playerData.step),
                pool.query('UPDATE players SET map_id = $1 WHERE id = $2', [newMapId, playerData.id])
              ]).catch(()=>{});

              // Broadcast player moved with new map and position to all clients
              broadcast({
                type: 'player_moved',
                id: playerData.id,
                x: newX,
                y: newY,
                map_id: newMapId,
                direction: playerData.direction,
                step: playerData.step,
                isMoving: false,
                isAttacking: false
              });
              
              // If map changed, send teleport result to client (same as item#58 logic)
              if (oldMapId !== newMapId) {
                // Send loading message
                send(ws, { type: 'chat', text: '* Loading map. Please wait. *', color: 'cornflowerblue' });
                
                const newMapItems = await loadItemsFromDatabase(newMapId);
                const newMapEnemies = getEnemiesForMap(newMapId);
                send(ws, {
                  type: 'teleport_result',
                  success: true,
                  id: playerData.id,
                  x: newX,
                  y: newY,
                  mapId: newMapId,
                  items: newMapItems,
                  enemies: newMapEnemies,
                  showLoadingScreen: {
                    imagePath: '/assets/loadscreen.gif',
                    x: 232,
                    y: 20,
                    duration: 500
                  }
                });
              }
              
              send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
              return; // Exit early, portal teleportation handled
            }
          }
        }

        // No portal found, proceed with normal movement
        // Save to database immediately
        Promise.allSettled([
          updateStatsInDb(playerData.id, { stamina: playerData.stamina }),
          updatePosition(playerData.id, nx, ny),
          updateDirectionAndStep(playerData.id, playerData.direction, playerData.step)
        ]).catch(()=>{});

        // Broadcast to all players (clients will filter by map)
        broadcast({
          type: 'player_moved', 
          id: playerData.id, 
          x: nx, 
          y: ny, 
          map_id: playerData.map_id,
          direction: playerData.direction,
          step: playerData.step,
          isMoving: playerData.isMoving,
          isAttacking: playerData.isAttacking
        });
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
      } else {
        // Movement blocked but still increment step for visual feedback
        updateDirectionAndStep(playerData.id, playerData.direction, playerData.step).catch(()=>{});
        
        // Send position correction to ensure client stays in sync
        broadcast({
          type: 'player_moved',
          id: playerData.id,
          x: playerData.pos_x,
          y: playerData.pos_y,
          direction: playerData.direction,
          step: playerData.step,
          isMoving: false,
          isAttacking: false,
          map_id: playerData.map_id
        });
      }
    }

    else if (msg.type === 'rotate') {
      if (!playerData) return;

      // Clear temporary sprite when rotating
      playerData.temporarySprite = 0;
      // Broadcast temporary sprite clear to all players (client will filter by map)
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: 0
      });
      
      // Update direction without moving
      if (msg.direction) {
        playerData.direction = msg.direction;
        playerData.step = 2; // Set step to 2 when rotating
        playerData.isAttacking = false;
        playerData.isMoving = false;
        
        // Update database
        updateDirectionAndStep(playerData.id, playerData.direction, playerData.step)
          .catch(err => console.error('Rotation DB error:', err));
        
        // Broadcast rotation to all players (clients will filter by map)
        broadcast({
          type: 'animation_update',
          id: playerData.id,
          map_id: playerData.map_id,
          direction: playerData.direction,
          step: playerData.step,
          isMoving: false,
          isAttacking: false
        });
      }
    }

    else if (msg.type === 'attack') {
      if (!playerData) return;
      
      // End NPC interaction on attack
      if (playerData.npcInteraction) {
        playerData.npcInteraction = null;
        send(ws, { type: 'npc_interaction_end' });
        console.log(`Player ${playerData.username} ended NPC interaction due to attack`);
      }
      
      // Cancel resting when attacking
      if (playerData.isResting) {
        playerData.isResting = false;
        send(ws, { type: 'chat', text: 'You stand, feeling more rested.', color: 'gold' });
        console.log(`Player ${playerData.username} stopped resting due to attack`);
      }
      
      // Always clear animation frame when attacking to restore normal attack sprites
      if (playerData.animationFrame !== null && playerData.animationFrame !== undefined) {
        playerData.animationFrame = null;
        
        // Broadcast animation frame clear
        broadcast({
          type: 'animation_update',
          id: playerData.id,
          map_id: playerData.map_id,
          animationFrame: null,
          isResting: false
        });
      }
      
      console.log(`Attack message received from player ${playerData.username} at (${playerData.pos_x}, ${playerData.pos_y}) facing ${playerData.direction}`);
      
      // Check if attacking a fountain first - no stamina cost for fountains
      const adjacentPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
      const playerMapSpec = getMapSpec(playerData.map_id);
      const itemAtAdjacentPos = getItemAtPosition(adjacentPos.x, adjacentPos.y, playerMapSpec, playerData.map_id);
      const isFountain = (itemAtAdjacentPos === 60);
      
      console.log(`Checking target at (${adjacentPos.x}, ${adjacentPos.y}): item ${itemAtAdjacentPos}, isFountain: ${isFountain}`);
      
      if (!isFountain) {
        // First check if there's an enemy in front to attack (only for non-fountain attacks)
        const attacked = await playerAttackEnemy(playerData, ws);
        if (attacked) {
          console.log(`Player ${playerData.username} successfully attacked an enemy`);
          // Attack animation is handled by client, stamina reduction
          playerData.stamina = Math.max(0, (playerData.stamina ?? 0) - 1);
          updateStatsInDb(playerData.id, { stamina: playerData.stamina })
            .catch(err => console.error('Error updating stamina after attack:', err));
          send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
          return; // Exit early since we attacked an enemy
        } else {
          console.log(`Player ${playerData.username} attack found no enemy target`);
        }
      }
      
      // Check bounds (adjacentPos already calculated above)
      if (adjacentPos.x >= 0 && adjacentPos.x < MAP_WIDTH && adjacentPos.y >= 0 && adjacentPos.y < MAP_HEIGHT) {
        // Check if attacking a container first
        const mapData = getMapData(playerData.map_id);
        if (mapData && mapData.holders) {
          const coordinateString = `${adjacentPos.x},${adjacentPos.y}`;
          const holder = mapData.holders.find(h => h.coordinates === coordinateString);
          
          if (holder) {
            // Found a container - check if it has an item
            const containerItem = await getContainerItem(adjacentPos.x, adjacentPos.y, playerData.map_id);
            
            if (containerItem === -1) {
              // Container is empty, do nothing
              return;
            }
            
            if (containerItem !== null && containerItem > 0) {
              // Container has an item
              if (playerData.hands && playerData.hands > 0) {
                // Player hands are full
                send(ws, { type: 'chat', text: "~ You can't hold the item in the chest, your hands are full!" });
                return;
              }
              
              // Player hands are empty, take the item
              playerData.hands = containerItem;
              
              // Mark container as empty
              await updateContainerItem(adjacentPos.x, adjacentPos.y, playerData.map_id, -1);
              
              // Check if there's item#15 on the map at the same coordinates - change it to item#31
              const playerMapSpec = getMapSpec(playerData.map_id);
              const currentMapItem = getItemAtPosition(adjacentPos.x, adjacentPos.y, playerMapSpec, playerData.map_id);
              if (currentMapItem === 15) {
                // Change item#15 to item#31 on the map
                const key = `${adjacentPos.x},${adjacentPos.y}`;
                mapItems[key] = 31;
                
                // Save to database
                saveItemToDatabase(adjacentPos.x, adjacentPos.y, 31, playerData.map_id);
                
                // Broadcast item update to all clients
                broadcast({
                  type: 'item_placed',
                  x: adjacentPos.x,
                  y: adjacentPos.y,
                  itemId: 31
                });
              }
              
              // Update player in database
              updateStatsInDb(playerData.id, { hands: playerData.hands })
                .catch(err => console.error('Error updating player hands after container:', err));
              
              // Get item name for success message
              const itemDetails = getItemDetails(containerItem);
              const itemName = itemDetails ? itemDetails.name : `Item ${containerItem}`;
              
              // Send success message
              send(ws, { type: 'chat', text: `~ You found a ${itemName}!` });
              
              // Broadcast equipment update
              broadcast({
                type: 'player_equipment_update',
                id: playerData.id,
                hands: playerData.hands
              });
              
              return;
            }
          }
        }
      }
      
      // No container found or container interaction, proceed with normal attack
      
      // Clear temporary sprite when attacking
      playerData.temporarySprite = 0;
      // Broadcast temporary sprite clear to all players (client will filter by map)
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: 0
      });
      
      // Clear BRB state when player attacks
      if (playerData.isBRB) {
        playerData.isBRB = false;
        
        const brbUpdate = {
          type: 'player_brb_update',
          id: playerData.id,
          brb: false
        };
        
        for (const [otherWs, otherPlayer] of clients.entries()) {
          if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
            if (otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify(brbUpdate));
            }
          }
        }
      }
      
      console.log(`Attack attempt by ${playerData.username}: stamina ${playerData.stamina ?? 0}/10, attacking fountain: ${isFountain}`);
      
      if (!isFountain) {
        // Check stamina requirement (at least 10) - only for non-fountain attacks
        if ((playerData.stamina ?? 0) < 10) {
          console.log(`Attack blocked for player ${playerData.username}: insufficient stamina (${playerData.stamina ?? 0}/10)`);
          // Send stamina update to client to sync any discrepancy
          send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
          return;
        }
        
        // Reduce stamina by 10 - only for non-fountain attacks
        const oldStamina = playerData.stamina ?? 0;
        playerData.stamina = Math.max(0, oldStamina - 10);
        console.log(`Attack stamina: ${oldStamina} -> ${playerData.stamina}`);
      } else {
        console.log(`Fountain attack - no stamina cost`);
      }
      
      // Update direction if provided
      if (msg.direction) {
        playerData.direction = msg.direction;
      }
      
      // Start attack animation (this will handle alternating)
      startAttackAnimation(playerData, ws);
      
      // Update stamina in database and send to client - only for non-fountain attacks
      if (!isFountain) {
        updateStatsInDb(playerData.id, { stamina: playerData.stamina })
          .then(() => {
            console.log(`Stamina updated in database for ${playerData.username}: ${playerData.stamina}`);
          })
          .catch(err => console.error('Error updating stamina after attack:', err));
        
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        console.log(`Sent stamina update to client: ${playerData.stamina}`);
      }
    }

    else if (msg.type === 'stop_attack') {
      if (!playerData) return;
      
      // Stop attack animation
      stopAttackAnimation(playerData, ws);
    }

    else if (msg.type === 'heartbeat') {
      // Simple heartbeat response to keep connection alive
      // No response needed, just receiving the message keeps the server active
      return;
    }

    else if (msg.type === 'toggle_rest') {
      if (!playerData) return;
      
      // Toggle resting state
      playerData.isResting = !playerData.isResting;
      
      if (playerData.isResting) {
        // Start resting
        playerData.animationFrame = 21; // 'sit' sprite (index 21 in ANIMATION_NAMES)
        send(ws, { type: 'chat', text: 'You settle down and begin resting.', color: 'gold' });
        console.log(`Player ${playerData.username} started resting`);
      } else {
        // Stop resting
        playerData.animationFrame = 20; // 'stand' sprite (index 20 in ANIMATION_NAMES)
        send(ws, { type: 'chat', text: 'You stand, feeling more rested.', color: 'gold' });
        console.log(`Player ${playerData.username} stopped resting`);
      }
      
      // Update database
      try {
        await pool.query(
          'UPDATE players SET animation_frame = $1 WHERE id = $2',
          [playerData.animationFrame, playerData.id]
        );
      } catch (err) {
        console.error('Error updating resting state:', err);
      }
      
      // Broadcast animation update
      broadcast({
        type: 'animation_update',
        id: playerData.id,
        map_id: playerData.map_id,
        animationFrame: playerData.animationFrame,
        isResting: playerData.isResting
      });
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
      
      // End NPC interaction on pickup/drop
      if (playerData.npcInteraction) {
        playerData.npcInteraction = null;
        send(ws, { type: 'npc_interaction_end' });
        console.log(`Player ${playerData.username} ended NPC interaction due to pickup/drop`);
      }
      
      // Check if item at current position is item 201 (drop container)
      const playerMapSpec = getMapSpec(playerData.map_id);
      const itemAtPosition = getItemAtPosition(playerData.pos_x, playerData.pos_y, playerMapSpec, playerData.map_id);
      
      if (itemAtPosition === 201) {
        // Handle drop container pickup
        const dropContainer = await getDropContainer(playerData.map_id, playerData.pos_x, playerData.pos_y);
        if (dropContainer) {
          let pickedUpGold = false;
          let pickedUpItem = false;
          
          // Pick up gold first
          if (dropContainer.gold > 0) {
            const goldAmount = dropContainer.gold;
            playerData.gold = (playerData.gold || 0) + goldAmount;
            send(ws, { type: 'chat', text: `You found ${goldAmount} gold coins.`, color: 'gold' });
            
            // Update database and send stats update to client
            await updateStatsInDb(playerData.id, { gold: playerData.gold });
            send(ws, { type: 'stats_update', id: playerData.id, gold: playerData.gold });
            
            dropContainer.gold = 0;
            pickedUpGold = true;
            console.log(`Player ${playerData.username} picked up ${goldAmount} gold, total now: ${playerData.gold}`);
          }
          
          // Pick up first non-zero item if hands are empty
          if (dropContainer.items && dropContainer.items.length > 0) {
            const firstItemIndex = dropContainer.items.findIndex(item => item > 0);
            if (firstItemIndex !== -1) {
              if (!playerData.hands || playerData.hands === 0) {
                // Hands are empty, pick up the item
                playerData.hands = dropContainer.items[firstItemIndex];
                dropContainer.items[firstItemIndex] = 0; // Remove from container
                pickedUpItem = true;
                
                // Update player hands in database
                await updateStatsInDb(playerData.id, { hands: playerData.hands });
                
                // Send equipment update
                send(ws, {
                  type: 'player_equipment_update',
                  id: playerData.id,
                  hands: playerData.hands
                });
              } else {
                // Hands are full
                send(ws, { type: 'chat', text: '~ Your hands are full, you cannot hold another item.' });
              }
            }
          }
          
          // Clean up container if empty
          const hasItems = dropContainer.items && dropContainer.items.some(item => item > 0);
          if (!hasItems && dropContainer.gold === 0) {
            await removeDropContainer(playerData.map_id, playerData.pos_x, playerData.pos_y);
          } else if (pickedUpGold || pickedUpItem) {
            // Update the container with remaining items/gold
            const cleanedItems = dropContainer.items ? dropContainer.items.filter(item => item > 0) : [];
            await updateDropContainer(playerData.map_id, playerData.pos_x, playerData.pos_y, cleanedItems, dropContainer.gold);
          }
        }
        return; // Exit early for drop container pickup
      }
      
      // Clear temporary sprite when picking up
      playerData.temporarySprite = 0;
      // Broadcast temporary sprite clear to all players (client will filter by map)
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: 0
      });
      
      // Start pickup animation immediately for ALL pickup attempts
      startPickupAnimation(playerData, ws);
      
      const { x, y, itemId } = msg;
      
      // Special case: itemId=0 means player wants to drop their hands item
      if (itemId === 0) {
        const handsItem = playerData.hands || 0;
        if (handsItem === 0) return; // Animation already started, just return
        
        const key = `${x},${y}`;
        const playerMapSpec = getMapSpec(playerData.map_id);
        const existingMapItem = getItemAtPosition(x, y, playerMapSpec, playerData.map_id);
        
        console.log(`Drop check at (${x},${y}): mapItems[${key}]=${mapItems[key]}, getItemAtPosition=${existingMapItem}`);
        
        // Check if there's an existing item on the map at this position that we can see
        if (existingMapItem && existingMapItem > 0) {
          // Check if the existing item is pickupable
          const existingItemDetails = getItemDetails(existingMapItem);
          const pickupableTypes = ["weapon", "armor", "useable", "consumable", "buff", "garbage"];
          
          if (existingItemDetails && pickupableTypes.includes(existingItemDetails.type)) {
            // SWAP: existing map item goes to hands, hands item goes to map
            playerData.hands = existingMapItem;
            mapItems[key] = handsItem;
            saveItemToDatabase(x, y, handsItem, playerData.map_id);
            
            console.log(`Item swap: Player got ${existingMapItem} from map, placed ${handsItem} on map`);
          } else {
            // Existing item not pickupable, just drop hands item on top (overwrite)
            playerData.hands = 0;
            mapItems[key] = handsItem;
            saveItemToDatabase(x, y, handsItem, playerData.map_id);
            
            console.log(`Dropped ${handsItem} on map, overwriting non-pickupable item ${existingMapItem}`);
          }
        } else {
          // No existing visible item, just drop the hands item
          playerData.hands = 0;
          mapItems[key] = handsItem;
          saveItemToDatabase(x, y, handsItem, playerData.map_id);
          
          console.log(`Dropped ${handsItem} on empty map space`);
        }
        
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
      
      // Verify item exists (but animation already started)
      // playerMapSpec already declared above
      const actualItemId = getItemAtPosition(x, y, playerMapSpec, playerData.map_id);
      if (actualItemId !== itemId) {
        console.log(`ERROR: Item mismatch! Expected ${itemId}, found ${actualItemId}`);
        return; // Animation continues even if pickup fails
      }
      
      // Verify item is pickupable (but animation already started)
      const itemDetails = getItemDetails(itemId);
      if (!itemDetails) {
        console.log(`ERROR: No item details for item ${itemId}`);
        return; // Animation continues even if pickup fails
      }
      
      const pickupableTypes = ["weapon", "armor", "useable", "consumable", "buff", "garbage"];
      if (!pickupableTypes.includes(itemDetails.type)) {
        console.log(`ERROR: Item ${itemId} type '${itemDetails.type}' not pickupable`);
        return; // Animation continues even if pickup fails
      }
      
      // Pick up the item (animation already started above)
      const oldHands = playerData.hands || 0;
      playerData.hands = itemId;
      
      const key = `${x},${y}`;
      
      console.log(`Picking up item ${itemId} at (${x},${y}), oldHands: ${oldHands}`);
      
      // Mark as picked up with -1 (this should make it disappear)
      mapItems[key] = -1;
      saveItemToDatabase(x, y, -1, playerData.map_id);
      
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

    else if (msg.type === 'inventory_swap') {
      if (!playerData) return;
      
      const { slotNumber } = msg;
      
      // Validate slot number
      if (slotNumber < 1 || slotNumber > 16) {
        console.log(`ERROR: Invalid slot number ${slotNumber}`);
        return;
      }
      
      // Get current inventory
      const inventory = await loadPlayerInventory(playerData.id);
      const slotItem = inventory[slotNumber] || 0;
      const handsItem = playerData.hands || 0;
      
      // Swap items
      playerData.hands = slotItem;
      inventory[slotNumber] = handsItem;
      
      // Update database
      await Promise.allSettled([
        updateStatsInDb(playerData.id, { hands: playerData.hands }),
        updateInventorySlot(playerData.id, slotNumber, handsItem)
      ]);
      
      // Send updated inventory and hands to player
      send(ws, {
        type: 'inventory_update',
        inventory: inventory
      });
      
      broadcast({
        type: 'player_equipment_update',
        id: playerData.id,
        hands: playerData.hands
      });
    }

    else if (msg.type === 'set_brb') {
      if (!playerData || typeof msg.brb !== 'boolean') return;
      
      // Clear temporary sprite when toggling BRB
      playerData.temporarySprite = 0;

      // Clear fountain effect when moving (broadcast to all players)
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
              type: 'clear_fountain_effect',
              playerId: playerData.id
            }));
          }
        }
      }

      // Broadcast temporary sprite clear
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
              type: 'temporary_sprite_update',
              id: playerData.id,
              temporarySprite: 0
            }));
          }
        }
      }

      playerData.isBRB = msg.brb;
      
      // Broadcast BRB state update to all players on the same map
      const brbUpdate = {
        type: 'player_brb_update',
        id: playerData.id,
        brb: playerData.isBRB
      };
      
      // Send to all players on the same map
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify(brbUpdate));
          }
        }
      }
    }
    
      else if (msg.type === 'temporary_sprite_update') {
        if (!playerData) return;
        
        playerData.temporarySprite = msg.temporarySprite || 0;
        
        // Broadcast to all players on the same map
        for (const [otherWs, otherPlayer] of clients.entries()) {
          if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
            if (otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'temporary_sprite_update',
                id: playerData.id,
                temporarySprite: playerData.temporarySprite
              }));
            }
          }
        }
      }
    else if (msg.type === 'use_transformation_item') {
      if (!playerData) return;
      
      const { itemId, magicCost, resultItem } = msg;
      
      // Verify player has the item in hands
      if (playerData.hands !== itemId) return;
      
      // Verify player has enough magic
      if ((playerData.magic || 0) < magicCost) {
        send(ws, {
          type: 'transformation_result',
          success: false,
          message: '~ You do not have enough magic to use that item!'
        });
        return;
      }
      
      // Clear temporary sprite
      playerData.temporarySprite = 0;

      // Clear fountain effect when rotating (broadcast to all players)
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
              type: 'clear_fountain_effect',
              playerId: playerData.id
            }));
          }
        }
      }
      
      // Reduce magic
      playerData.magic = Math.max(0, (playerData.magic || 0) - magicCost);
      
      let finalResultItem = resultItem;
      
      // Special case for item 283 - random transformation
      if (itemId === 283) {
        const validTypes = ['nothing', 'sign', 'portal', 'interactable'];
        finalResultItem = getRandomItemByTypes(validTypes);
      }
      
      // Set temporary sprite
      playerData.temporarySprite = finalResultItem;
      
      // Update database
      updateStatsInDb(playerData.id, { magic: playerData.magic })
        .catch(err => console.error('Error updating magic after transformation:', err));
      
      // Send success response to player
      send(ws, {
        type: 'transformation_result',
        success: true,
        id: playerData.id,
        newMagic: playerData.magic,
        temporarySprite: playerData.temporarySprite
      });
      
      // Broadcast magic update
      send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
      
      // Broadcast temporary sprite update to all players (client will filter by map)
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: playerData.temporarySprite
      });
    }

    else if (msg.type === 'use_fire_pillar_spell') {
      if (!playerData) return;
      
      const { itemId } = msg;
      
      // Verify player has item 97 in hands
      if (playerData.hands !== 97 || itemId !== 97) {
        return;
      }
      
      // Verify player has enough magic (10)
      if ((playerData.magic || 0) < 10) {
        send(ws, { type: 'chat', text: 'You do not have enough magic to cast this spell!' });
        return;
      }
      
      // Reduce magic by 10
      playerData.magic = Math.max(0, (playerData.magic || 0) - 10);
      
      // Update database
      updateStatsInDb(playerData.id, { magic: playerData.magic })
        .catch(err => console.error('Error updating magic after fire pillar:', err));
      
      // Send magic update to client
      send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
      
      // Calculate starting position (tile in front of player)
      const startPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
      
      // Check if starting position is valid (within bounds)
      if (startPos.x < 0 || startPos.x >= MAP_WIDTH || startPos.y < 0 || startPos.y >= MAP_HEIGHT) {
        send(ws, { type: 'chat', text: 'Cannot cast spell outside map bounds!' });
        return;
      }
      
      // Create fire pillar spell
      const spellId = createFirePillar(playerData.id, startPos.x, startPos.y, playerData.direction, playerData.map_id);
      
      console.log(`Player ${playerData.username} cast fire pillar spell ${spellId} at (${startPos.x}, ${startPos.y})`);
    }

    else if (msg.type === 'use_consumable_item') {
      console.log(`Debug: Received use_consumable_item message for item ${msg.itemId}`);
      if (!playerData) return;
      
      const { itemId } = msg;
      console.log(`Debug: Player ${playerData.username} trying to use item ${itemId}, hands: ${playerData.hands}`);
      
      // Verify player has the item in hands
      if (playerData.hands !== itemId) {
        console.log(`Debug: Player hands (${playerData.hands}) doesn't match item (${itemId})`);
        return;
      }
      
      // Get item details
      const itemDetails = getItemDetails(itemId);
      console.log(`Debug: Server item details for ${itemId}:`, itemDetails);
      if (!itemDetails) {
        console.log(`Item ${itemId} not found in itemdetails.json`);
        return;
      }
      
      // Check if item is consumable
      if (itemDetails.type !== 'consumable') {
        console.log(`Item ${itemId} is not consumable (type: ${itemDetails.type})`);
        return;
      }
      
      console.log(`Debug: Item ${itemId} is consumable, proceeding with consumption`);
      
      // Get the stat to affect and the amount
      const statEffected = itemDetails.statEffected;
      const statIncrease = itemDetails.statMax;
      const useMessage = itemDetails.useMessage;
      
      if (!statEffected || !statIncrease) {
        console.log(`Item ${itemId} missing stat information`);
        return;
      }
      
      // Map stat names to player data fields
      let playerStatField, maxStatField;
      if (statEffected === 'hp') {
        playerStatField = 'life';
        maxStatField = 'max_life';
      } else if (statEffected === 'stamina') {
        playerStatField = 'stamina';
        maxStatField = 'max_stamina';
      } else if (statEffected === 'magic') {
        playerStatField = 'magic';
        maxStatField = 'max_magic';
      } else {
        console.log(`Unknown stat type: ${statEffected}`);
        return;
      }
      
      // Calculate new stat value
      const currentStat = playerData[playerStatField] || 0;
      const maxStat = playerData[maxStatField] || 100;
      const newStatValue = Math.min(currentStat + statIncrease, maxStat);
      
      // Update player stat
      playerData[playerStatField] = newStatValue;
      
      // Remove item from hands
      playerData.hands = 0;
      
      // Update database
      const updateFields = { hands: 0 };
      updateFields[playerStatField] = newStatValue;
      
      try {
        await updateStatsInDb(playerData.id, updateFields);
      } catch (err) {
        console.error('Error updating player stats after consumable use:', err);
      }
      
      // Send stat update to client
      const statUpdate = { type: 'stats_update', id: playerData.id };
      statUpdate[playerStatField] = newStatValue;
      send(ws, statUpdate);
      
      // Send equipment update to client and broadcast to other players
      broadcast({
        type: 'player_equipment_update',
        id: playerData.id,
        hands: playerData.hands
      });
      
      // Send use message to player chat
      if (useMessage) {
        send(ws, { type: 'chat', text: useMessage, color: 'green' });
      }
      
      console.log(`Player ${playerData.username} used consumable ${itemDetails.name}, ${statEffected} increased by ${statIncrease} to ${newStatValue}`);
    }

    else if (msg.type === 'use_heal_spell') {
      if (!playerData) return;
      
      const { itemId } = msg;
      
      // Check for item #100 (full heal spell)
      if (itemId === 100) {
        // Verify player has item 100 in hands
        if (playerData.hands !== 100) return;
        
        // Verify player has enough magic (15)
        if ((playerData.magic || 0) < 15) {
          send(ws, { type: 'chat', text: 'You do not have enough magic to cast this spell!' });
          return;
        }
        
        // Deduct magic cost
        playerData.magic = Math.max(0, (playerData.magic || 0) - 15);
        
        // Update magic in database
        updateStatsInDb(playerData.id, { magic: playerData.magic })
          .catch(err => console.error('Error updating magic after heal spell:', err));
        
        // Send magic update to client
        send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
        
        // Get position in front of player based on direction
        const targetPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
        
        // Check if there's another player at target position
        let targetPlayer = null;
        for (const [otherWs, otherPlayerData] of clients.entries()) {
          if (otherPlayerData && 
              otherPlayerData.id !== playerData.id &&
              Number(otherPlayerData.map_id) === Number(playerData.map_id) &&
              otherPlayerData.pos_x === targetPos.x &&
              otherPlayerData.pos_y === targetPos.y) {
            targetPlayer = { ws: otherWs, data: otherPlayerData };
            break;
          }
        }
        
        // If no other player found, heal self
        if (!targetPlayer) {
          targetPlayer = { ws: ws, data: playerData };
        }
        
        // Heal the target player to full HP
        const oldHp = targetPlayer.data.life || 0;
        targetPlayer.data.life = targetPlayer.data.max_life || 100;
        
        // Update database
        updateStatsInDb(targetPlayer.data.id, { life: targetPlayer.data.life })
          .catch(err => console.error('Error updating life after heal spell:', err));
        
        // Send stat update to target player
        send(targetPlayer.ws, { type: 'stats_update', id: targetPlayer.data.id, life: targetPlayer.data.life });
        
        // Send healing message to target player
        send(targetPlayer.ws, { 
          type: 'chat', 
          text: 'You are magically fully healed by the power of the scrolls!',
          color: 'purple'
        });
        
        // Create healing visual effect
        const healingId = Date.now() + Math.random();
        createHealingEffect(healingId, targetPlayer.data.pos_x, targetPlayer.data.pos_y, targetPlayer.data.map_id);
        
        console.log(`Player ${playerData.username} cast full heal on ${targetPlayer.data.username}, HP: ${oldHp} -> ${targetPlayer.data.life}`);
      }
      
      // Check for item #131 (partial heal spell)
      else if (itemId === 131) {
        // Verify player has item 131 in hands
        if (playerData.hands !== 131) return;
        
        // Verify player has enough magic (20)
        if ((playerData.magic || 0) < 20) {
          send(ws, { type: 'chat', text: 'You do not have enough magic to cast this spell!' });
          return;
        }
        
        // Deduct magic cost
        playerData.magic = Math.max(0, (playerData.magic || 0) - 20);
        
        // Update magic in database
        updateStatsInDb(playerData.id, { magic: playerData.magic })
          .catch(err => console.error('Error updating magic after heal spell:', err));
        
        // Send magic update to client
        send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
        
        // Get position in front of player based on direction
        const targetPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
        
        // Check if there's another player at target position
        let targetPlayer = null;
        for (const [otherWs, otherPlayerData] of clients.entries()) {
          if (otherPlayerData && 
              otherPlayerData.id !== playerData.id &&
              Number(otherPlayerData.map_id) === Number(playerData.map_id) &&
              otherPlayerData.pos_x === targetPos.x &&
              otherPlayerData.pos_y === targetPos.y) {
            targetPlayer = { ws: otherWs, data: otherPlayerData };
            break;
          }
        }
        
        // If no other player found, heal self
        if (!targetPlayer) {
          targetPlayer = { ws: ws, data: playerData };
        }
        
        // Heal the target player by 50 HP (up to max)
        const oldHp = targetPlayer.data.life || 0;
        const maxHp = targetPlayer.data.max_life || 100;
        targetPlayer.data.life = Math.min(oldHp + 50, maxHp);
        
        // Update database
        updateStatsInDb(targetPlayer.data.id, { life: targetPlayer.data.life })
          .catch(err => console.error('Error updating life after heal spell:', err));
        
        // Send stat update to target player
        send(targetPlayer.ws, { type: 'stats_update', id: targetPlayer.data.id, life: targetPlayer.data.life });
        
        // Send healing message to target player
        send(targetPlayer.ws, { 
          type: 'chat', 
          text: 'The power of the runes has restored some of your life force!',
          color: 'purple'
        });
        
        console.log(`Player ${playerData.username} cast partial heal on ${targetPlayer.data.username}, HP: ${oldHp} -> ${targetPlayer.data.life}`);
      }
    }

    else if (msg.type === 'use_silver_mist_spell') {
      if (!playerData) return;
      
      const { itemId } = msg;
      
      // Verify player has item 102 in hands
      if (playerData.hands !== 102 || itemId !== 102) {
        return;
      }
      
      // Verify player has enough magic (20)
      if ((playerData.magic || 0) < 20) {
        send(ws, { type: 'chat', text: 'You do not have enough magic to cast this spell!' });
        return;
      }
      
      // Deduct magic cost
      playerData.magic = Math.max(0, (playerData.magic || 0) - 20);
      
      // Update magic in database
      updateStatsInDb(playerData.id, { magic: playerData.magic })
        .catch(err => console.error('Error updating magic after silver mist:', err));
      
      // Send magic update to client
      send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
      
      // Send success message to player
      send(ws, { 
        type: 'chat', 
        text: 'The scroll summons a silver mist all around you.',
        color: 'purple'
      });
      
      // Create Silver Mist effects in 8 surrounding tiles
      const playerX = playerData.pos_x;
      const playerY = playerData.pos_y;
      const mapId = playerData.map_id;
      
      // Define the 8 surrounding positions (3x3 grid minus center)
      const mistPositions = [
        { x: playerX - 1, y: playerY - 1 }, // Top-left
        { x: playerX,     y: playerY - 1 }, // Top
        { x: playerX + 1, y: playerY - 1 }, // Top-right
        { x: playerX - 1, y: playerY     }, // Left
        { x: playerX + 1, y: playerY     }, // Right
        { x: playerX - 1, y: playerY + 1 }, // Bottom-left
        { x: playerX,     y: playerY + 1 }, // Bottom
        { x: playerX + 1, y: playerY + 1 }  // Bottom-right
      ];
      
      // Create Silver Mist effects and damage enemies
      mistPositions.forEach(pos => {
        // Check if position is within map bounds
        if (pos.x >= 0 && pos.x < MAP_WIDTH && pos.y >= 0 && pos.y < MAP_HEIGHT) {
          // Create Silver Mist visual effect
          const mistId = Date.now() + Math.random() + pos.x + pos.y; // Unique ID
          createSilverMistEffect(mistId, pos.x, pos.y, mapId);
          
          // Check for enemies at this position and damage them
          for (const [enemyId, enemy] of Object.entries(enemies)) {
            if (Number(enemy.map_id) === Number(mapId) &&
                enemy.pos_x === pos.x &&
                enemy.pos_y === pos.y &&
                !enemy.is_dead) {
              
              // Deal 3 damage to enemy
              const oldHp = enemy.hp;
              enemy.hp = Math.max(0, enemy.hp - 3);
              
              // Update enemy HP in database
              pool.query('UPDATE enemies SET hp = $1 WHERE id = $2', [enemy.hp, enemy.id])
                .catch(err => console.error('Error updating enemy HP after silver mist:', err));
              
              // Get enemy name for potential death message
              const enemyDetails = enemy.details;
              const enemyName = enemyDetails?.name || `Enemy ${enemy.enemy_type}`;
              
              console.log(`Silver Mist damaged enemy ${enemyId} at (${pos.x}, ${pos.y}) for 3 damage: ${oldHp} -> ${enemy.hp}`);
              
              // Check if enemy died
              if (enemy.hp <= 0) {
                console.log(`Enemy ${enemyId} died from Silver Mist`);
                handleEnemyDeath(enemy, null); // No attacking player for spell kills
              }
            }
          }
        }
      });
      
      console.log(`Player ${playerData.username} cast Silver Mist spell around (${playerX}, ${playerY})`);
    }

    else if (msg.type === 'use_teleport_item') {
      if (!playerData) return;
      
      const { itemId, magicCost, targetMap, targetX, targetY } = msg;
      
      // Verify player has the item in hands
      if (playerData.hands !== itemId) return;
      
      // Verify player has enough magic
      if ((playerData.magic || 0) < magicCost) {
        send(ws, {
          type: 'teleport_result',
          success: false,
          message: '~ You do not have enough magic to use that item!'
        });
        return;
      }
      
      // Clear temporary sprite
      playerData.temporarySprite = 0;
      
      // Reduce magic
      playerData.magic = Math.max(0, (playerData.magic || 0) - magicCost);
      
      // Update player position and map
      playerData.pos_x = targetX;
      playerData.pos_y = targetY;
      playerData.map_id = targetMap;
      
      // Update database
      Promise.allSettled([
        updateStatsInDb(playerData.id, { magic: playerData.magic }),
        updatePosition(playerData.id, targetX, targetY),
        pool.query('UPDATE players SET map_id = $1 WHERE id = $2', [targetMap, playerData.id])
      ]).catch(err => console.error('Error updating player after teleport:', err));
      
      // Broadcast position/map update to ALL players FIRST
      broadcast({
        type: 'player_moved',
        id: playerData.id,
        x: targetX,
        y: targetY,
        map_id: playerData.map_id,
        direction: playerData.direction || 'down',
        step: playerData.step || 2,
        isMoving: false,
        isAttacking: false
      });
      
      // Send loading message
      send(ws, { type: 'chat', text: '* Loading map. Please wait. *', color: 'cornflowerblue' });
      
      // Get enemies for target map
      const mapEnemies = getEnemiesForMap(targetMap);
      
      // Then send success response to teleporting player
      send(ws, {
        type: 'teleport_result',
        success: true,
        id: playerData.id,
        newMagic: playerData.magic,
        x: targetX,
        y: targetY,
        mapId: targetMap,
        items: mapItems,
        enemies: mapEnemies,
        showLoadingScreen: {
          imagePath: '/assets/loadscreen.gif',
          x: 232,
          y: 20,
          duration: 500
        }
      });
      
      // Broadcast magic update to teleporting player
      send(ws, { type: 'stats_update', id: playerData.id, magic: playerData.magic });
      
      // Broadcast temporary sprite clear to all players
      broadcast({
        type: 'temporary_sprite_update',
        id: playerData.id,
        map_id: playerData.map_id,
        temporarySprite: 0
      });
    }

    else if (msg.type === 'attack_fountain') {
      if (!playerData) return;

      // Clear temporary sprite when attacking fountain
      playerData.temporarySprite = 0;
      
      // Broadcast temporary sprite clear
      for (const [otherWs, otherPlayer] of clients.entries()) {
        if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
          if (otherWs.readyState === WebSocket.OPEN) {
            otherWs.send(JSON.stringify({
              type: 'temporary_sprite_update',
              id: playerData.id,
              temporarySprite: 0
            }));
          }
        }
      }
      
      // Clear BRB state when player attacks fountain
      if (playerData.isBRB) {
        playerData.isBRB = false;
        
        const brbUpdate = {
          type: 'player_brb_update',
          id: playerData.id,
          brb: false
        };
        
        for (const [otherWs, otherPlayer] of clients.entries()) {
          if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
            if (otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify(brbUpdate));
            }
          }
        }
      }
      
      // Check stamina requirement (at least 10)
      if ((playerData.stamina ?? 0) < 10) {
        send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
        return;
      }
      
      // Reduce stamina by 10
      const oldStamina = playerData.stamina ?? 0;
      playerData.stamina = Math.max(0, oldStamina - 10);
      
      // Update direction if provided
      if (msg.direction) {
        playerData.direction = msg.direction;
      }
      
      // Start attack animation
      startAttackAnimation(playerData, ws);
      
      // Verify the fountain item is still there
      const playerMapSpec = getMapSpec(playerData.map_id);
      const targetItemId = getItemAtPosition(msg.x, msg.y, playerMapSpec, playerData.map_id);
      if (targetItemId === 60) {
        // Heal the player
        playerData.stamina = playerData.max_stamina ?? 10;
        playerData.life = playerData.max_life ?? 20;
        playerData.magic = playerData.max_magic ?? 0;
        
        // Send healing response
        send(ws, {
          type: 'fountain_heal',
          id: playerData.id,
          stamina: playerData.stamina,
          life: playerData.life,
          magic: playerData.magic
        });
        
        // Broadcast fountain effect to all players on same map (show on the healed player)
        for (const [otherWs, otherPlayer] of clients.entries()) {
          if (otherPlayer && otherPlayer.map_id === playerData.map_id) {
            if (otherWs.readyState === WebSocket.OPEN) {
              otherWs.send(JSON.stringify({
                type: 'fountain_effect',
                playerId: playerData.id
              }));
            }
          }
        }
        
        // Update database
        updateStatsInDb(playerData.id, { 
          stamina: playerData.stamina, 
          life: playerData.life, 
          magic: playerData.magic 
        }).catch(err => console.error('Error updating stats after fountain heal:', err));
      } else {
        // Update stamina in database and send to client (fountain not found)
        updateStatsInDb(playerData.id, { stamina: playerData.stamina })
          .catch(err => console.error('Error updating stamina after fountain attack:', err));
      }
      
      send(ws, { type: 'stats_update', id: playerData.id, stamina: playerData.stamina });
    }

    else if (msg.type === 'look') {
      if (!playerData) return;
      
      // Get the adjacent position based on player's facing direction
      const adjacentPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
      
      // Check bounds
      if (adjacentPos.x < 0 || adjacentPos.x >= MAP_WIDTH || adjacentPos.y < 0 || adjacentPos.y >= MAP_HEIGHT) {
        send(ws, { type: 'chat', text: '~ You see nothing interesting.' });
        return;
      }
      
      // Get map data for readables
      const mapData = getMapData(playerData.map_id);
      
      // Check for NPCs first (highest priority)
      if (mapData && mapData.npcs) {
        const coordinateString = `${adjacentPos.x},${adjacentPos.y}`;
        const npc = mapData.npcs.find(n => n.coordinates === coordinateString);
        
        if (npc) {
          // Found an NPC - start interaction
          const npcDetails = getNPCDetails(npc.type);
          if (npcDetails) {
            // Set NPC interaction state for this player
            playerData.npcInteraction = {
              npcType: npc.type,
              npcDetails: npcDetails,
              position: { x: adjacentPos.x, y: adjacentPos.y }
            };
            
            // Send NPC interaction data to client
            send(ws, {
              type: 'npc_interaction_start',
              npcDetails: npcDetails
            });
            
            console.log(`Player ${playerData.username} started NPC interaction with type ${npc.type}`);
            return;
          }
        }
      }
      
      // Check for readables second
      if (mapData && mapData.readables) {
        const coordinateString = `${adjacentPos.x},${adjacentPos.y}`;
        const readable = mapData.readables.find(r => r.coordinates === coordinateString);
        
        if (readable) {
          // Found a readable - send its message with signblue color and stop here
          send(ws, { type: 'chat', text: readable.message, color: 'signblue' });
          return;
        }
      }
      
      // No readable found, check for other players first (priority)
      const otherPlayerAtPosition = Array.from(clients.values()).find(otherPlayer => 
        otherPlayer &&
        otherPlayer.id !== playerData.id &&
        Number(otherPlayer.map_id) === Number(playerData.map_id) &&
        otherPlayer.pos_x === adjacentPos.x &&
        otherPlayer.pos_y === adjacentPos.y
      );
      
      if (otherPlayerAtPosition) {
        send(ws, { type: 'chat', text: `You see ${otherPlayerAtPosition.username} in front of you.` });
        return;
      }
      
      // No player found, check for enemy
      const enemyAtPosition = Object.values(enemies).find(enemy => 
        Number(enemy.map_id) === Number(playerData.map_id) &&
        enemy.pos_x === adjacentPos.x &&
        enemy.pos_y === adjacentPos.y &&
        !enemy.is_dead
      );
      
      if (enemyAtPosition) {
        const enemyDetails = getEnemyDetails(enemyAtPosition.enemy_type);
        const enemyName = enemyDetails ? enemyDetails.name : `Enemy ${enemyAtPosition.enemy_type}`;
        send(ws, { type: 'chat', text: `~ You see ${enemyName}.` });
        return;
      }
      
      // No enemy found, check for item description
      const playerMapSpec = getMapSpec(playerData.map_id);
      const itemId = getItemAtPosition(adjacentPos.x, adjacentPos.y, playerMapSpec, playerData.map_id);
      
      if (itemId > 0) {
        const itemDetails = getItemDetails(itemId);
        if (itemDetails && itemDetails.description) {
          send(ws, { type: 'chat', text: itemDetails.description });
        } else {
          send(ws, { type: 'chat', text: '~ You see something interesting.' });
        }
      } else {
        send(ws, { type: 'chat', text: '~ You see nothing interesting.' });
      }
    }

    else if (msg.type === 'chat') {
      if (!playerData || typeof msg.text !== 'string') return;
      const t = msg.text.trim();
      if (looksMalicious(t)) return send(ws, { type: 'chat_error' });

      // Check if player is in NPC interaction and entered 1-4
      if (playerData.npcInteraction && /^[1-4]$/.test(t)) {
        const npcDetails = playerData.npcInteraction.npcDetails;
        
        // Check if it's a question/response NPC (not shop or quest giver)
        if (!npcDetails.shop && !npcDetails.quest_giver) {
          const responseKey = `response_${t}`;
          const response = npcDetails[responseKey];
          
          if (response && response.trim() !== '') {
            // Send NPC response with pink color
            send(ws, { 
              type: 'chat', 
              text: response,
              color: 'pink'
            });
          }
        }
        
        // Don't send the "1", "2", etc. to chat - interaction is handled
        return;
      }

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

          // Reload map containers
          const containersSuccess = await reloadMapContainers();
          if (!containersSuccess) {
            send(ws, { type: 'chat', text: '~ Error: Failed to reload map containers.' });
            return;
          }

          // Clear client-side enemies first
          broadcast({ type: 'enemies_cleared' });
          
          // Reload enemies
          const enemiesSuccess = await reloadEnemies();
          if (!enemiesSuccess) {
            send(ws, { type: 'chat', text: '~ Error: Failed to reload enemies.' });
            return;
          }

          // Send new enemies to all clients
          for (const [clientWs, clientPlayer] of clients.entries()) {
            if (clientPlayer && clientWs.readyState === WebSocket.OPEN) {
              const clientEnemies = getEnemiesForMap(clientPlayer.map_id);
              clientWs.send(JSON.stringify({
                type: 'enemies_reloaded',
                enemies: clientEnemies
              }));
            }
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

      // Check for -gotomap admin command
      const gotoMapMatch = t.match(/^-gotomap\s+(\d+)$/i);
      if (gotoMapMatch) {
        // Validate admin role
        if (playerData.role !== 'admin') {
          // Do nothing for non-admin users
          return;
        }

        const targetMapId = parseInt(gotoMapMatch[1]);
        if (targetMapId < 1 || targetMapId > 4) {
          send(ws, { type: 'chat', text: '~ Invalid map ID. Valid maps: 1-4' });
          return;
        }

        // Check if target map exists
        if (!getMapSpec(targetMapId)) {
          send(ws, { type: 'chat', text: `~ Map ${targetMapId} not found.` });
          return;
        }

        // Update player's map_id in database
        try {
          await pool.query(
            'UPDATE players SET map_id = $1 WHERE id = $2',
            [targetMapId, playerData.id]
          );
          
          // Update player data
          const oldMapId = playerData.map_id;
          playerData.map_id = targetMapId;
          
          // Broadcast player moved to all clients (they will filter by map)
          broadcast({
            type: 'player_moved',
            id: playerData.id,
            x: playerData.pos_x,
            y: playerData.pos_y,
            map_id: playerData.map_id,
            direction: playerData.direction,
            step: playerData.step,
            isMoving: false,
            isAttacking: false
          });
          
          // Send loading message
          send(ws, { type: 'chat', text: '* Loading map. Please wait. *', color: 'cornflowerblue' });
          
          // Send map change result to the admin
          const mapItems = await loadItemsFromDatabase(targetMapId);
          const mapEnemies = getEnemiesForMap(targetMapId);
          send(ws, {
            type: 'teleport_result',
            success: true,
            id: playerData.id,
            x: playerData.pos_x,
            y: playerData.pos_y,
            mapId: targetMapId,
            items: mapItems,
            enemies: mapEnemies,
            showLoadingScreen: {
              imagePath: '/assets/loadscreen.gif',
              x: 232,
              y: 20,
              duration: 500
            }
          });
          

          
        } catch (error) {
          console.error('Error changing player map:', error);
          send(ws, { type: 'chat', text: '~ Error changing map.' });
        }
        return;
      }
      
      // Check for -spawn admin command
      const spawnMatch = t.match(/^-spawn\s+(\d+)$/i);
      if (spawnMatch) {
        // Validate admin role
        if (playerData.role !== 'admin') {
          // Do nothing for non-admin users
          return;
        }

        const enemyType = parseInt(spawnMatch[1]);
        
        // Validate enemy type
        const enemyDetails = getEnemyDetails(enemyType);
        if (!enemyDetails) {
          send(ws, { type: 'chat', text: `~ Invalid enemy type ${enemyType}. Check enemiesdetails.json for valid types.` });
          return;
        }

        // Get position in front of player
        const spawnPos = getAdjacentPosition(playerData.pos_x, playerData.pos_y, playerData.direction);
        
        // Check if position is valid
        const playerMapSpec = getMapSpec(playerData.map_id);
        if (!canMoveTo(spawnPos.x, spawnPos.y, null, playerMapSpec, playerData.map_id)) {
          send(ws, { type: 'chat', text: '~ Cannot spawn enemy there - position blocked.' });
          return;
        }

        try {
          // Spawn the enemy (admin spawned = true, so it won't respawn)
          const newEnemy = await spawnEnemy(enemyType, playerData.map_id, spawnPos.x, spawnPos.y, true);
          
          if (newEnemy) {
            send(ws, { type: 'chat', text: `~ Spawned ${enemyDetails.name} at (${spawnPos.x}, ${spawnPos.y})` });
            
            // Broadcast the new enemy to all clients on the same map
            const enemyData = {
              [newEnemy.id]: {
                id: newEnemy.id,
                enemy_type: newEnemy.enemy_type,
                pos_x: newEnemy.pos_x,
                pos_y: newEnemy.pos_y,
                direction: newEnemy.direction,
                step: newEnemy.step,
                hp: newEnemy.hp
              }
            };
            
            // Send to all clients so they can add the enemy if they're on the same map
            broadcast({
              type: 'enemy_spawned',
              enemy: enemyData[newEnemy.id]
            });
          } else {
            send(ws, { type: 'chat', text: '~ Failed to spawn enemy.' });
          }
        } catch (error) {
          console.error('Error spawning enemy:', error);
          send(ws, { type: 'chat', text: '~ Error spawning enemy.' });
        }
        return;
      }

      // Check for -refresh admin command
      if (t.toLowerCase() === '-refresh') {
        // Validate admin role
        if (playerData.role !== 'admin') {
          // Do nothing for non-admin users
          return;
        }

        try {
          // Restore all stats to maximum
          playerData.life = playerData.max_life || 100;
          playerData.stamina = playerData.max_stamina || 100;
          playerData.magic = playerData.max_magic || 100;

          // Update database
          await updateStatsInDb(playerData.id, {
            life: playerData.life,
            stamina: playerData.stamina,
            magic: playerData.magic
          });

          // Send updated stats to client
          send(ws, {
            type: 'stats_update',
            id: playerData.id,
            life: playerData.life,
            stamina: playerData.stamina,
            magic: playerData.magic
          });

          send(ws, { type: 'chat', text: '~ All stats refreshed to maximum.' });
        } catch (error) {
          console.error('Error refreshing player stats:', error);
          send(ws, { type: 'chat', text: '~ Error refreshing stats.' });
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

      // Check for -buff command (available to all players)
      if (t.toLowerCase() === '-buff') {
        const handsItem = playerData.hands || 0;
        
        if (handsItem <= 0) {
          send(ws, { type: 'chat', text: 'No buffs currently active.' });
          return;
        }
        
        const itemDetails = getItemDetails(handsItem);
        if (!itemDetails || itemDetails.type !== 'buff') {
          send(ws, { type: 'chat', text: 'No buffs currently active.' });
          return;
        }
        
        // Format the buff message
        const itemName = itemDetails.name;
        const statMax = itemDetails.statMax || 0;
        const statEffected = itemDetails.statEffected || 'unknown';
        const buffMessage = `You hold a ${itemName}, which gives you a +${statMax} buff to your ${statEffected} regeneration.`;
        
        send(ws, { type: 'chat', text: buffMessage, color: 'cornflowerblue' });
        return;
      }

      // Check for private message commands (/tell <name> <message> or /<name> <message>)
      const tellMatch = t.match(/^\/tell\s+(\S+)\s+(.+)$/i) || t.match(/^\/(\S+)\s+(.+)$/);
      if (tellMatch) {
        const targetUsername = tellMatch[1];
        const message = tellMatch[2];
        
        // Basic sanitization for SQL injection prevention
        const sanitizedMessage = message.replace(/[<>'"\\;&|`]/g, '').trim();
        
        // Check message length (use same limits as regular chat)
        if (sanitizedMessage.length === 0) {
          send(ws, { type: 'chat', text: '~ Your message cannot be empty.' });
          return;
        }
        if (sanitizedMessage.length > 200) { // Assuming 200 char limit for chat
          send(ws, { type: 'chat', text: '~ Your message is too long.' });
          return;
        }
        
        // Find target player (case-insensitive)
        let targetPlayer = null;
        let targetWs = null;
        
        for (const [clientWs, clientPlayer] of clients.entries()) {
          if (clientPlayer && clientPlayer.username.toLowerCase() === targetUsername.toLowerCase()) {
            targetPlayer = clientPlayer;
            targetWs = clientWs;
            break;
          }
        }
        
        if (!targetPlayer || !targetWs) {
          send(ws, { 
            type: 'chat', 
            text: `~ No players named ${targetUsername} were found online. Check -players to see who's online now.` 
          });
          return;
        }
        
        // Send whisper message to target player
        const whisperMessage = `~ ${playerData.username} whispers, "${sanitizedMessage}" to you.`;
        send(targetWs, { 
          type: 'chat', 
          text: whisperMessage,
          color: 'pink'
        });
        
        // Send confirmation to sender (optional - shows what was sent)
        send(ws, { 
          type: 'chat', 
          text: `~ You whisper to ${targetPlayer.username}: "${sanitizedMessage}"`,
          color: 'pink'
        });
        
        console.log(`Private message from ${playerData.username} to ${targetPlayer.username}: ${sanitizedMessage}`);
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
          pool.query('DELETE FROM map_items WHERE x=$1 AND y=$2 AND map_id=$3', [adjacentPos.x, adjacentPos.y, playerData.map_id])
            .catch(err => console.error('Error removing item from database:', err));
        } else {
          mapItems[key] = itemId;
          // Save to database
          saveItemToDatabase(adjacentPos.x, adjacentPos.y, itemId, playerData.map_id);
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
            ? `Item removed from (${adjacentPos.x}, ${adjacentPos.y})`
            : `Item ${itemId} placed at (${adjacentPos.x}, ${adjacentPos.y})`,
          color: 'grey'
        });
        return;
      }

      // Regular chat message
      const chatMessage = `${playerData.username}: ${t}`;
      broadcast({ type: 'chat', text: chatMessage });
      
      // Log the chat message (non-blocking)
      logChatMessage(playerData.id, playerData.username, 'chat', chatMessage, playerData.map_id)
        .catch(() => {}); // Silently ignore logging errors
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
      
      // Set animation_frame to 6 (right idle) and reset direction/step when player disconnects
      pool.query(
        'UPDATE players SET animation_frame = $1, direction = $2, step = $3 WHERE id = $4',
        [6, 'right', 2, playerData.id]
      ).catch(err => console.error('Error updating player logout state:', err));
      
      clients.delete(ws);
      usernameToWs.delete(playerData.username);
      
      // Send global chat about player leaving and log it
      const leaveMessage = `${playerData.username} has left DragonSpires.`;
      broadcast({ type: 'chat', text: leaveMessage, color: 'grey' });
      broadcast({ type: 'player_left', id: playerData.id, username: playerData.username });
      
      // Log the logout message (non-blocking)
      logChatMessage(playerData.id, playerData.username, 'logout', leaveMessage, playerData.map_id)
        .catch(() => {}); // Silently ignore logging errors
    }
  });

  ws.on('error', (err) => console.warn('WS error', err));
});

// ---------- Regeneration Loops ----------
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Get buff bonus from held item
function getBuffBonus(player, statType) {
  const handsItem = player.hands || 0;
  if (handsItem <= 0) return 0;
  
  const itemDetails = getItemDetails(handsItem);
  if (!itemDetails || itemDetails.type !== 'buff') return 0;
  
  // Check if the buff affects the requested stat type
  if (itemDetails.statEffected === statType) {
    return itemDetails.statMax || 0;
  }
  
  return 0;
}

// Every 3s: stamina +10% max (+30% if resting - 200% increase) + buff bonus
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const basePercent = 0.10;
    const regenPercent = p.isResting ? 0.30 : basePercent; // 200% increase when resting
    const baseInc = Math.floor((p.max_stamina ?? 0) * regenPercent);
    const buffBonus = getBuffBonus(p, 'stamina');
    const totalInc = baseInc + buffBonus;
    const next = clamp((p.stamina ?? 0) + totalInc, 0, p.max_stamina ?? 0);
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

// Every 5s: life +5% max (min +1) + buff bonus
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const baseInc = Math.max(1, Math.floor((p.max_life ?? 0) * 0.05));
    const buffBonus = getBuffBonus(p, 'hp');
    const totalInc = baseInc + buffBonus;
    const next = clamp((p.life ?? 0) + totalInc, 0, p.max_life ?? 0);
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

// Every 30s: magic +5 flat + buff bonus
setInterval(async () => {
  const updates = [];
  for (const [ws, p] of clients.entries()) {
    const baseInc = 5;
    const buffBonus = getBuffBonus(p, 'magic');
    const totalInc = baseInc + buffBonus;
    const next = clamp((p.magic ?? 0) + totalInc, 0, p.max_magic ?? 0);
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

// Enemy AI loop - process every 500ms
setInterval(async () => {
  try {
    await processEnemyAI();
  } catch (error) {
    console.error('Enemy AI processing error:', error);
  }
}, 500);

const PORT = process.env.PORT || 3000;

// Initialize floor collision data
loadFloorCollision();

// Initialize NPC details
loadNPCDetails();

server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on ${PORT}`));
