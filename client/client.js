// client.js - Browser-side game client
document.addEventListener('DOMContentLoaded', () => {
  // ---------- CONFIG ----------
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS = "ws://localhost:3000";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Missing <canvas id="gameCanvas">'); return; }
  const ctx = canvas.getContext('2d');

  const CANVAS_W = 640, CANVAS_H = 480;
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  // Logical diamond for positioning
  const TILE_W = 64, TILE_H = 32;

  // Screen anchor for local tile
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // World/camera offsets (as previously tuned)
  const WORLD_SHIFT_X = -32, WORLD_SHIFT_Y = 16;
  const CENTER_LOC_ADJ_X = 32, CENTER_LOC_ADJ_Y = -8;
  const CENTER_LOC_FINE_X = -5, CENTER_LOC_FINE_Y = 0;

  // Sprite offsets (as tuned earlier)
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;
  const SPRITE_CENTER_ADJ_X = 23;  // = 64 - 41
  const SPRITE_CENTER_ADJ_Y = -20; // = -24 + 4

  // GUI (+50,+50)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const FIELD_H = 16;
  const FIELD_TOP = (y) => (y - 13);
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    loginBtn:  { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn: { x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat areas
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };
  const CHAT_INPUT = { x1: 156, y1: 411, x2: 618, y2: 453, pad: 8, maxLen: 200, extraY: 2 };
  // Inventory configuration
  const INVENTORY = {
    x: 241,
    y: 28,
    width: 250,
    height: 150,
    backgroundColor: 'rgb(0, 133, 182)',
    borderColor: 'black',
    slotWidth: 62,
    slotHeight: 38,
    cols: 4,
    rows: 4,
    selectionCircleColor: 'yellow',
    selectionCircleDiameter: 32
  };

  // Animation constants
  const ANIMATION_NAMES = [
    'down_walk_1', 'down', 'down_walk_2', 'down_attack_1', 'down_attack_2',
    'right_walk_1', 'right', 'right_walk_2', 'right_attack_1', 'right_attack_2',
    'left_walk_1', 'left', 'left_walk_2', 'left_attack_1', 'left_attack_2',
    'up_walk_1', 'up', 'up_walk_2', 'up_attack_1', 'up_attack_2',
    'stand', 'sit'
  ];

  // Attack animation pairs
  const ATTACK_SEQUENCES = {
    down: [3, 4],   // down_attack_1, down_attack_2
    right: [8, 9],  // right_attack_1, right_attack_2
    left: [13, 14], // left_attack_1, left_attack_2
    up: [18, 19]    // up_attack_1, up_attack_2
  };

  // Direction animations for idle state
  const DIRECTION_IDLE = {
    down: 1,   // down
    right: 6,  // right
    left: 11,  // left
    up: 16     // up
  };

  // Movement animation sequence: walk_1 -> walk_2 -> idle
  const MOVEMENT_SEQUENCE = ['walk_1', 'walk_2', 'idle'];

  // ---------- STATE ----------
  let ws = null;
  let connected = false;
  let connectionPaused = false;
  let showLoginGUI = false;
  let loggedIn = false;
  let chatMode = false;

  // Assets ready flags
  let tilesReady = false;
  let mapReady = false;
  let playerSpritesReady = false;
  let itemDetailsReady = false;
  let floorCollisionReady = false;

  // Map
  let mapSpec = { width: 64, height: 64, tiles: [] };
  let mapItems = {}; // { "x,y": itemId }

  // Item details
  let itemDetails = []; // Array of item detail objects

  // Floor collision data
  let floorCollision = []; // Array of collision data for tile types

  // Auth GUI
  let usernameStr = "";
  let passwordStr = "";
  let activeField = null;

  // Players
  let localPlayer = null;
  let otherPlayers = {};

  // NEW: Simplified direction and animation state system
  let playerDirection = 'down'; // Current facing direction
  let movementAnimationState = 0; // 0=standing, 1=walk_1, 2=walk_2
  let isLocallyAttacking = false; // Local attack state
  let localAttackState = 0; // 0 or 1 for attack_1 or attack_2
  let lastMoveTime = 0; // Prevent rapid movement through collision objects

  // Chat
  let messages = [];
  let typingBuffer = "";

  // Animation state - SIMPLIFIED ATTACK HANDLING
  let localAttackTimeout = null; // Track our own attack timeout

  // Inventory state - MOVED TO TOP LEVEL
  let inventoryVisible = false;
  let inventorySelectedSlot = 1; // Default to slot 1
  let playerInventory = {}; // { slotNumber: itemId }

  // ---------- COLLISION HELPERS ----------
  function hasFloorCollision(x, y) {
    if (!floorCollisionReady || !floorCollision || 
        x < 0 || y < 0 || x >= mapSpec.width || y >= mapSpec.height) {
      return false; // No collision data or out of bounds
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
    // Check local player
    if (localPlayer && localPlayer.pos_x === x && localPlayer.pos_y === y) {
      if (!excludePlayerId || localPlayer.id !== excludePlayerId) {
        return true;
      }
    }
    
    // Check other players
    for (const id in otherPlayers) {
      const player = otherPlayers[id];
      if (player.pos_x === x && player.pos_y === y) {
        if (!excludePlayerId || player.id !== excludePlayerId) {
          return true;
        }
      }
    }
    
    return false;
  }

  function canMoveTo(x, y, excludePlayerId = null) {
    // Check map bounds
    if (x < 0 || x >= mapSpec.width || y < 0 || y >= mapSpec.height) {
      return false;
    }
    
    // Check floor collision
    if (hasFloorCollision(x, y)) {
      return false;
    }
    
    // Check item collision
    const targetItemId = getItemAtPosition(x, y);
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

  // ---------- INVENTORY HELPERS ----------
  function getInventorySlotPosition(slotNumber) {
    // Convert slot number (1-16) to row/col (0-based)
    const index = slotNumber - 1;
    const col = index % INVENTORY.cols;
    const row = Math.floor(index / INVENTORY.cols);
    
    // Calculate position within inventory
    const x = INVENTORY.x + col * INVENTORY.slotWidth;
    const y = INVENTORY.y + row * INVENTORY.slotHeight;
    
    return { x, y };
  }
  
  function moveInventorySelection(direction) {
    if (!inventoryVisible) return;
    
    const currentIndex = inventorySelectedSlot - 1; // Convert to 0-based
    const currentRow = Math.floor(currentIndex / INVENTORY.cols);
    const currentCol = currentIndex % INVENTORY.cols;
    
    let newRow = currentRow;
    let newCol = currentCol;
    
    switch (direction) {
      case 'up':
        newRow = currentRow === 0 ? INVENTORY.rows - 1 : currentRow - 1;
        break;
      case 'down':
        newRow = currentRow === INVENTORY.rows - 1 ? 0 : currentRow + 1;
        break;
      case 'left':
        newCol = currentCol === 0 ? INVENTORY.cols - 1 : currentCol - 1;
        break;
      case 'right':
        newCol = currentCol === INVENTORY.cols - 1 ? 0 : currentCol + 1;
        break;
    }
    
    // Convert back to slot number (1-based)
    inventorySelectedSlot = (newRow * INVENTORY.cols) + newCol + 1;
  }

  // ---------- ASSETS ----------
  const imgTitle = new Image();
  imgTitle.src = "/assets/title.GIF";

  // Border: magenta keyed
  const imgBorder = new Image();
  imgBorder.src = "/assets/game_border_2025.gif";
  let borderProcessed = null;
  imgBorder.onload = () => {
    try {
      const w = imgBorder.width, h = imgBorder.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(imgBorder, 0, 0);
      const data = octx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
      borderProcessed = off;
    } catch {
      borderProcessed = null;
    }
  };

  // Player sprites: extract multiple animations from player.gif using player.json
  const imgPlayerSrc = new Image();
  imgPlayerSrc.src = "/assets/player.gif";
  let playerSprites = []; // Array of Image objects for each animation frame
  let playerSpriteMeta = []; // Array of {w, h} for each sprite

  Promise.all([
    new Promise(resolve => {
      if (imgPlayerSrc.complete) resolve();
      else { imgPlayerSrc.onload = resolve; imgPlayerSrc.onerror = resolve; }
    }),
    fetch('/assets/player.json').then(r => r.json()).catch(() => null)
  ]).then(([_, playerJson]) => {
    if (!playerJson || !playerJson.knight) {
      console.error('Failed to load player.json or knight data');
      playerSpritesReady = true;
      return;
    }

    const knightCoords = playerJson.knight;
    const loadPromises = [];

    knightCoords.forEach(([sx, sy, sw, sh], index) => {
      try {
        const off = document.createElement('canvas');
        off.width = sw;
        off.height = sh;
        const octx = off.getContext('2d');
        octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);

        // Make magenta transparent
        const data = octx.getImageData(0, 0, sw, sh);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
        }
        octx.putImageData(data, 0, 0);

        const sprite = new Image();
        const promise = new Promise(resolve => {
          sprite.onload = resolve;
          sprite.onerror = resolve;
        });
        sprite.src = off.toDataURL();
        
        playerSprites[index] = sprite;
        playerSpriteMeta[index] = { w: sw, h: sh };
        loadPromises.push(promise);
      } catch (e) {
        console.error(`Failed to process sprite ${index}:`, e);
      }
    });

    Promise.all(loadPromises).then(() => {
      playerSpritesReady = true;
    });
  });

  // Floor tiles from /assets/floor.png: 9 columns x 11 rows, each 62x32, with 1px overlapping border
  const imgFloor = new Image();
  imgFloor.src = "/assets/floor.png";
  let floorTiles = []; // 1-based indexing
  imgFloor.onload = async () => {
    try {
      const sheetW = imgFloor.width;
      const sheetH = imgFloor.height;
      const tileW = 62, tileH = 32;
      const cols = 9;   // 9 columns
      const rows = 11;  // 11 rows

      const off = document.createElement('canvas');
      off.width = sheetW; off.height = sheetH;
      const octx = off.getContext('2d');
      octx.drawImage(imgFloor, 0, 0);

      let idCounter = 1;
      const loadPromises = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const sx = 1 + (col * 63);  // 63 = 62 + 1 pixel border
          const sy = 1 + (row * 33);  // 33 = 32 + 1 pixel border

          const tcan = document.createElement('canvas');
          tcan.width = tileW; tcan.height = tileH;
          const tctx = tcan.getContext('2d', { willReadFrequently: true });
          tctx.drawImage(off, sx, sy, tileW, tileH, 0, 0, tileW, tileH);

          // magenta -> transparent (if present in art)
          const imgData = tctx.getImageData(0, 0, tileW, tileH);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
          }
          tctx.putImageData(imgData, 0, 0);

          const tileImg = new Image();
          const p = new Promise((resolve) => { tileImg.onload = resolve; tileImg.onerror = resolve; });
          tileImg.src = tcan.toDataURL();
          floorTiles[idCounter] = tileImg;
          loadPromises.push(p);
          idCounter++;
        }
      }

      await Promise.all(loadPromises);
      tilesReady = true;

      fetch('map.json')
        .then(r => r.json())
        .then(m => {
          if (m && m.width && m.height) {
            const tiles = Array.isArray(m.tiles) ? m.tiles : (Array.isArray(m.tilemap) ? m.tilemap : null);
            mapSpec = {
              width: m.width,
              height: m.height,
              tiles: tiles || [],
              items: Array.isArray(m.items) ? m.items : []
            };
          }
        })
        .catch(() => {})
        .finally(() => { mapReady = true; });

    } catch (e) {
      console.error("Floor tile extraction failed:", e);
      tilesReady = true; mapReady = true; // fail-safe
    }
  };

// ---------- ITEMS (sheet + coords, true magenta keyed, formula-based anchoring) ----------
(() => {
  const imgItems = new Image();
  imgItems.src = "/assets/item.gif";

  const itemsJsonPromise = fetch("/assets/item.json")
    .then(r => r.json())
    .catch(() => null);

  const itemSprites = []; // 1-based
  const itemMeta = [];    // 1-based: { img, w, h, leftPad, anchorX }
  let itemsReady = false;

  function waitImage(img) {
    return new Promise((resolve) => {
      if (img.complete) return resolve();
      img.onload = resolve;
      img.onerror = resolve;
    });
  }

  Promise.all([waitImage(imgItems), itemsJsonPromise]).then(([_, meta]) => {
    if (!meta || !Array.isArray(meta.item_coords)) return;

    const off = document.createElement("canvas");
    const octx = off.getContext("2d");

    meta.item_coords.forEach((quad, idx) => {
      const [sx, sy, sw, sh] = quad;
      off.width = sw; off.height = sh;
      octx.clearRect(0, 0, sw, sh);
      octx.drawImage(imgItems, sx, sy, sw, sh, 0, 0, sw, sh);

      // Make true magenta transparent + compute leftPad (first opaque column)
      let leftPad = 0;
      try {
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = sw; tempCanvas.height = sh;
        const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
        tempCtx.drawImage(off, 0, 0);
        
        const data = tempCtx.getImageData(0, 0, sw, sh);
        const d = data.data;

        // magenta -> transparent
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
        }

        // find first opaque column from the left
        leftPad = sw; // default "none found"
        outer:
        for (let x = 0; x < sw; x++) {
          for (let y = 0; y < sh; y++) {
            const a = d[((y * sw) + x) * 4 + 3];
            if (a !== 0) { leftPad = x; break outer; }
          }
        }
        if (leftPad === sw) leftPad = 0; // all transparent (safety)

        tempCtx.putImageData(data, 0, 0);
        octx.clearRect(0, 0, sw, sh);
        octx.drawImage(tempCanvas, 0, 0);
      } catch {
        leftPad = 0; // fallback if canvas is tainted (shouldn't be here)
      }

      // Bottom-center anchor inside the sprite (relative to left edge)
      const anchorX = (leftPad + (sw - 1)) / 2;

      // Freeze the processed pixels into an <img>
      const sprite = new Image();
      sprite.src = off.toDataURL();

      itemSprites[idx + 1] = sprite;
      itemMeta[idx + 1] = { img: sprite, w: sw, h: sh, leftPad, anchorX };
    });

    itemsReady = true;
  });

  // accessors
  window.getItemSprite = (i) => itemSprites[i] || null;
  window.getItemMeta   = (i) => itemMeta[i] || null;
  window.itemSpriteCount = () => itemSprites.length - 1;
  window.itemsReady = () => itemsReady;
})();

  // ---------- ANIMATION HELPERS ----------
  function getCurrentAnimationFrame(player, isLocal = false) {
    if (player.isAttacking) {
      return player.animationFrame || DIRECTION_IDLE[player.direction] || DIRECTION_IDLE.down;
    }

    if (typeof player.animationFrame !== 'undefined') {
      return player.animationFrame;
    }

    return DIRECTION_IDLE[player.direction] || DIRECTION_IDLE.down;
  }

  // ---------- WS ----------
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    
    console.log('Attempting to connect to:', WS_URL);
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected successfully');
      connected = true;
      connectionPaused = true;
      showLoginGUI = false;
    };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      handleServerMessage(data);
    };
    ws.onerror = (e) => {
      console.error('WebSocket error:', e);
      console.log('Failed to connect to:', WS_URL);
    };
    ws.onclose = (e) => {
      console.log('WebSocket closed:', e.code, e.reason);
      connected = false;
      connectionPaused = false;
      showLoginGUI = false;
      loggedIn = false;
      chatMode = false;
      localPlayer = null;
      otherPlayers = {};
      mapItems = {};
      // Clear any pending attack timeout
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
        localAttackTimeout = null;
      }
      playerInventory = {};
      inventoryVisible = false;

      // Auto-reconnect after 3 seconds if not manually closed
      if (e.code !== 1000) { // 1000 = normal closure
        console.log('Attempting to reconnect in 3 seconds...');
        setTimeout(connectToServer, 3000);
      }
    };
  }
  connectToServer();

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function pushChat(line) { messages.push(String(line)); if (messages.length > 200) messages.shift(); }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
        if (msg.inventory) {
          playerInventory = { ...msg.inventory };
        }
      case 'signup_success':
        loggedIn = true;
        localPlayer = { 
          ...msg.player,
          direction: msg.player.direction || 'down',
          isMoving: false,
          isAttacking: false,
          animationFrame: msg.player.animationFrame || DIRECTION_IDLE.down,
          movementSequenceIndex: msg.player.movementSequenceIndex || 0,
          weapon: msg.player.weapon || 0,
          armor: msg.player.armor || 0,
          hands: msg.player.hands || 0
        };
        
        // Initialize local state variables
        playerDirection = localPlayer.direction;
        movementAnimationState = 0;
        isLocallyAttacking = false;
        localAttackState = 0;
        
        // Initialize inventory if not already set
        if (msg.inventory) {
          playerInventory = { ...msg.inventory };
        }
        
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => { 
            if (!localPlayer || p.id !== localPlayer.id) {
              otherPlayers[p.id] = {
                ...p,
                direction: p.direction || 'down',
                isMoving: p.isMoving || false,
                isAttacking: p.isAttacking || false,
                animationFrame: p.animationFrame || DIRECTION_IDLE.down,
                movementSequenceIndex: p.movementSequenceIndex || 0
              };
            }
          });
        }

        if (msg.items) {
          mapItems = { ...msg.items };
        }

        pushChat("Welcome to DragonSpires!");
        break;
        
      case 'player_joined':
        if (!localPlayer || msg.player.id !== localPlayer.id) {
          otherPlayers[msg.player.id] = {
            ...msg.player,
            direction: msg.player.direction || 'down',
            isMoving: msg.player.isMoving || false,
            isAttacking: msg.player.isAttacking || false,
            animationFrame: msg.player.animationFrame || DIRECTION_IDLE.down,
            movementSequenceIndex: msg.player.movementSequenceIndex || 0
          };
          pushChat(`${msg.player.username || msg.player.id} has entered DragonSpires!`);
        }
        break;
        
      case 'player_moved':
        if (localPlayer && msg.id === localPlayer.id) { 
          localPlayer.pos_x = msg.x; 
          localPlayer.pos_y = msg.y;
          localPlayer.isMoving = msg.isMoving || false;
          if (!localPlayer.isMoving) {
            localPlayer.animationFrame = msg.animationFrame || localPlayer.animationFrame;
            localPlayer.movementSequenceIndex = msg.movementSequenceIndex || localPlayer.movementSequenceIndex;
          }
        } else {
          if (!otherPlayers[msg.id]) {
            otherPlayers[msg.id] = { 
              id: msg.id, 
              username: `#${msg.id}`, 
              pos_x: msg.x, 
              pos_y: msg.y,
              direction: msg.direction || 'down',
              isMoving: msg.isMoving || false,
              isAttacking: false,
              animationFrame: msg.animationFrame || DIRECTION_IDLE.down,
              movementSequenceIndex: msg.movementSequenceIndex || 0
            };
          } else { 
            otherPlayers[msg.id].pos_x = msg.x; 
            otherPlayers[msg.id].pos_y = msg.y;
            otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
            otherPlayers[msg.id].isMoving = msg.isMoving || false;
            otherPlayers[msg.id].animationFrame = msg.animationFrame || otherPlayers[msg.id].animationFrame;
            otherPlayers[msg.id].movementSequenceIndex = msg.movementSequenceIndex || otherPlayers[msg.id].movementSequenceIndex;
          }
        }
        break;
        
      case 'animation_update':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.direction = msg.direction || localPlayer.direction;
          localPlayer.isMoving = msg.isMoving || false;
          localPlayer.isAttacking = msg.isAttacking || false;
          localPlayer.animationFrame = msg.animationFrame || localPlayer.animationFrame;
          localPlayer.movementSequenceIndex = msg.movementSequenceIndex || localPlayer.movementSequenceIndex;
        } else if (otherPlayers[msg.id]) {
          otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
          otherPlayers[msg.id].isMoving = msg.isMoving || false;
          otherPlayers[msg.id].isAttacking = msg.isAttacking || false;
          otherPlayers[msg.id].animationFrame = msg.animationFrame || otherPlayers[msg.id].animationFrame;
          otherPlayers[msg.id].movementSequenceIndex = msg.movementSequenceIndex || otherPlayers[msg.id].movementSequenceIndex;
        }
        break;
        
      case 'player_equipment_update':
        if (localPlayer && msg.id === localPlayer.id) {
          if ('weapon' in msg) localPlayer.weapon = msg.weapon;
          if ('armor' in msg) localPlayer.armor = msg.armor;
          if ('hands' in msg) localPlayer.hands = msg.hands;
        } else if (otherPlayers[msg.id]) {
          if ('weapon' in msg) otherPlayers[msg.id].weapon = msg.weapon;
          if ('armor' in msg) otherPlayers[msg.id].armor = msg.armor;
          if ('hands' in msg) otherPlayers[msg.id].hands = msg.hands;
        }
        break;
        
      case 'item_placed':
        const key = `${msg.x},${msg.y}`;
        if (msg.itemId === 0) {
          delete mapItems[key];
        } else {
          mapItems[key] = msg.itemId;
        }
        break;

      case 'server_reset':
        // Handle server reset - update items and show message
        if (msg.items) {
          mapItems = { ...msg.items };
        }
        if (msg.message) {
          pushChat(`~ ${msg.message}`);
        }
        break;
        
      case 'player_left':
        const p = otherPlayers[msg.id];
        const name = p?.username ?? msg.id;
        if (!localPlayer || msg.id !== localPlayer.id) pushChat(`${name} has left DragonSpires.`);
        delete otherPlayers[msg.id];
        break;
        
      case 'chat':
        if (typeof msg.text === 'string') pushChat(msg.text);
        break;
        
      case 'chat_error':
        pushChat('~ The game has rejected your message due to bad language.');
        break;

      case 'inventory_update':
        if (msg.inventory) {
          playerInventory = { ...msg.inventory };
        }
        break;
        
      case 'stats_update':
        const apply = (obj) => {
          if (!obj) return;
          if ('stamina' in msg) obj.stamina = msg.stamina;
          if ('life' in msg) obj.life = msg.life;
          if ('magic' in msg) obj.magic = msg.magic;
        };
        if (localPlayer && msg.id === localPlayer.id) apply(localPlayer);
        else if (otherPlayers[msg.id]) apply(otherPlayers[msg.id]);
        break;
        
      case 'login_error':
      case 'signup_error':
        pushChat(msg.message || 'Auth error');
        break;
    }
  }

  // ---------- INPUT ----------
  window.addEventListener('keydown', (e) => {
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    // Toggle / submit chat
    if (e.key === 'Enter' && loggedIn) {
      if (!chatMode) { chatMode = true; typingBuffer = ""; }
      else {
        const toSend = typingBuffer.trim();
        if (toSend === '-pos' && localPlayer) {
          pushChat(`~ ${localPlayer.username} is currently on Map ${localPlayer.map_id ?? 1} at location x:${localPlayer.pos_x}, y:${localPlayer.pos_y}.`);
        } else if (toSend.length > 0) {
          send({ type: 'chat', text: toSend.slice(0, CHAT_INPUT.maxLen) });
        }
        typingBuffer = ""; chatMode = false;
      }
      e.preventDefault(); return;
    }

    // Capture chat text
    if (chatMode) {
      if (e.key === 'Backspace') { typingBuffer = typingBuffer.slice(0, -1); e.preventDefault(); }
      else if (e.key.length === 1 && typingBuffer.length < CHAT_INPUT.maxLen) typingBuffer += e.key;
      return;
    }

    // Login GUI typing
    if (!loggedIn && showLoginGUI && activeField) {
      if (e.key === 'Tab') {
        e.preventDefault();
        activeField = (activeField === 'username') ? 'password' : 'username';
        return;
      } else if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else passwordStr = passwordStr.slice(0, -1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        send({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault();
      } else if (e.key.length === 1) {
        if (activeField === 'username') usernameStr += e.key;
        else passwordStr += e.key;
      }
      return;
    }

    // Look command with 'l' key
    if (loggedIn && localPlayer && e.key === 'l') {
      e.preventDefault();
      
      let lookX = localPlayer.pos_x;
      let lookY = localPlayer.pos_y;
      
      switch (playerDirection) {
        case 'up': lookY -= 1; break;
        case 'down': lookY += 1; break;
        case 'left': lookX -= 1; break;
        case 'right': lookX += 1; break;
      }
      
      if (lookX >= 0 && lookX < mapSpec.width && lookY >= 0 && lookY < mapSpec.height) {
        const itemId = getItemAtPosition(lookX, lookY);
        const itemDetails = getItemDetails(itemId);
        
        if (itemDetails && itemDetails.description && itemDetails.description.trim()) {
          pushChat(`~ ${itemDetails.description}`);
        } else {
          pushChat("~ You see nothing.");
        }
      } else {
        pushChat("~ You see nothing.");
      }
      
      return;
    }

    // Pick up item with 'g' key
    if (loggedIn && localPlayer && e.key === 'g') {
      e.preventDefault();
      
      const itemId = getItemAtPosition(localPlayer.pos_x, localPlayer.pos_y);
      const itemDetails = getItemDetails(itemId);
      
      console.log(`Pickup attempt: position (${localPlayer.pos_x},${localPlayer.pos_y}), itemId: ${itemId}, itemDetails:`, itemDetails);
      
      if (itemDetails && isItemPickupable(itemDetails)) {
        console.log(`Sending pickup request for item ${itemId}`);
        send({
          type: 'pickup_item',
          x: localPlayer.pos_x,
          y: localPlayer.pos_y,
          itemId: itemId
        });
      }
      else if ((!itemDetails || !isItemPickupable(itemDetails)) && localPlayer.hands && localPlayer.hands > 0) {
        console.log(`Dropping item from hands: ${localPlayer.hands}`);
        send({
          type: 'pickup_item',
          x: localPlayer.pos_x,
          y: localPlayer.pos_y,
          itemId: 0
        });
      } else {
        console.log(`No action taken - no pickupable item and no hands item to drop`);
      }
      
      return;
    }

    // Equip weapon with 't' key
    if (loggedIn && localPlayer && e.key === 't') {
      e.preventDefault();
      send({ type: 'equip_weapon' });
      return;
    }

    // Equip armor with 'y' key
    if (loggedIn && localPlayer && e.key === 'y') {
      e.preventDefault();
      send({ type: 'equip_armor' });
      return;
    }

    // Rotation with '0' key
    if (loggedIn && localPlayer && e.key === '0') {
      e.preventDefault();
      
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
        localAttackTimeout = null;
      }
      
      const directions = ['right', 'down', 'left', 'up'];
      const currentIndex = directions.indexOf(playerDirection);
      const nextIndex = (currentIndex + 1) % directions.length;
      playerDirection = directions[nextIndex];
      
      movementAnimationState = 0;
      isLocallyAttacking = false;
      
      localPlayer.direction = playerDirection;
      localPlayer.isAttacking = false;
      localPlayer.isMoving = false;
      
      send({ type: 'rotate', direction: playerDirection });
      return;
    }

    // Attack input
    if (loggedIn && localPlayer && e.key === 'Tab') {
      e.preventDefault();
      
      // Check stamina requirement (at least 10)
      if ((localPlayer.stamina ?? 0) < 10) {
        console.log('Not enough stamina to attack (need 10, have ' + (localPlayer.stamina ?? 0) + ')');
        return;
      }
      
      // Reduce stamina by 10 locally for immediate feedback
      localPlayer.stamina = Math.max(0, (localPlayer.stamina ?? 0) - 10);
      
      isLocallyAttacking = true;
      localAttackState = (localAttackState + 1) % 2;
      
      if (localAttackTimeout) {
        clearTimeout(localAttackTimeout);
      }
      
      localAttackTimeout = setTimeout(() => {
        isLocallyAttacking = false;
        movementAnimationState = 0;
        localAttackTimeout = null;
      }, 1000);
      
      send({ type: 'attack', direction: playerDirection });
      return;
    }

// Toggle inventory with 'i' key
if (loggedIn && localPlayer && e.key === 'i') {
  e.preventDefault();
  inventoryVisible = !inventoryVisible;
  return;
}

// Inventory swap with 'c' key
if (loggedIn && localPlayer && inventoryVisible && e.key === 'c') {
  e.preventDefault();
  send({
    type: 'inventory_swap',
    slotNumber: inventorySelectedSlot
  });
  return;
}

  // Inventory navigation when inventory is visible
  if (loggedIn && localPlayer && inventoryVisible) {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'arrowup') {
      e.preventDefault();
      moveInventorySelection('up');
      return;
    } else if (k === 's' || k === 'arrowdown') {
      e.preventDefault();
      moveInventorySelection('down');
      return;
    } else if (k === 'a' || k === 'arrowleft') {
      e.preventDefault();
      moveInventorySelection('left');
      return;
    } else if (k === 'd' || k === 'arrowright') {
      e.preventDefault();
      moveInventorySelection('right');
      return;
    }
  }

    // Movement (only if inventory is not visible)
    if (loggedIn && localPlayer && !inventoryVisible) {
      if ((localPlayer.stamina ?? 0) <= 0) return;
      
      const currentTime = Date.now();
      if (currentTime - lastMoveTime < 100) return;
      
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0, newDirection = null;
      
      if (k === 'arrowup' || k === 'w') { dy = -1; newDirection = 'up'; }
      else if (k === 'arrowdown' || k === 's') { dy = 1; newDirection = 'down'; }
      else if (k === 'arrowleft' || k === 'a') { dx = -1; newDirection = 'left'; }
      else if (k === 'arrowright' || k === 'd') { dx = 1; newDirection = 'right'; }
      
      if (dx || dy) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        
        if (canMoveTo(nx, ny, localPlayer.id)) {
          if (localAttackTimeout) {
            clearTimeout(localAttackTimeout);
            localAttackTimeout = null;
          }
          isLocallyAttacking = false;
          
          playerDirection = newDirection;
          movementAnimationState = (movementAnimationState + 1) % 3;
          
          localPlayer.direction = playerDirection;
          localPlayer.pos_x = nx;
          localPlayer.pos_y = ny;
          localPlayer.isAttacking = false;
          localPlayer.isMoving = true;
          
          lastMoveTime = currentTime;
          
          send({ type: 'move', dx, dy, direction: playerDirection });
          
          setTimeout(() => {
            if (localPlayer) {
              localPlayer.isMoving = false;
              movementAnimationState = 0;
            }
          }, 200);
        } else {
          playerDirection = newDirection;
          movementAnimationState = (movementAnimationState + 1) % 3;
          lastMoveTime = currentTime;
        }
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (chatMode) return;

    // Handle login GUI clicks
    if (connected && showLoginGUI && !loggedIn) {
      const u = GUI.username, p = GUI.password, lb = GUI.loginBtn, sb = GUI.signupBtn;
      const uTop = FIELD_TOP(u.y), uBottom = uTop + u.h;
      const pTop = FIELD_TOP(p.y), pBottom = pTop + p.h;

      if (mx >= u.x && mx <= u.x + u.w && my >= uTop && my <= uBottom) { activeField = 'username'; return; }
      else if (mx >= p.x && mx <= p.x + p.w && my >= pTop && my <= pBottom) { activeField = 'password'; return; }
      else if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
      else if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) { send({ type: 'signup', username: usernameStr, password: passwordStr }); return; }
      activeField = null;
      return;
    }

    // Handle movement quadrant clicks (only when logged in and playing)
    if (connected && loggedIn && localPlayer) {
      // Check if stamina is sufficient for movement
      if ((localPlayer.stamina ?? 0) <= 0) return;
      
      // Prevent rapid clicks (same as keyboard movement)
      const currentTime = Date.now();
      if (currentTime - lastMoveTime < 100) return;

      let dx = 0, dy = 0, newDirection = null;

      // Game area: 232,20 to 621,276 (width=389, height=256)
      // Center point: x=426.5, y=148
      
      // Movement quadrants within the game area:
      // Top-left quadrant (left): 232,20 to 426,148
      if (mx >= 232 && mx <= 426 && my >= 20 && my <= 148) {
        dx = -1; newDirection = 'left';
      }
      // Top-right quadrant (up): 426,20 to 621,148
      else if (mx >= 426 && mx <= 621 && my >= 20 && my <= 148) {
        dy = -1; newDirection = 'up';
      }
      // Bottom-right quadrant (right): 426,148 to 621,276
      else if (mx >= 426 && mx <= 621 && my >= 148 && my <= 276) {
        dx = 1; newDirection = 'right';
      }
      // Bottom-left quadrant (down): 232,148 to 426,276
      else if (mx >= 232 && mx <= 426 && my >= 148 && my <= 276) {
        dy = 1; newDirection = 'down';
      }

      // Process movement if a valid quadrant was clicked
      if (dx !== 0 || dy !== 0) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        
        // Use the same collision checking as keyboard movement
        if (canMoveTo(nx, ny, localPlayer.id)) {
          // Cancel attack animation on movement
          if (localAttackTimeout) {
            clearTimeout(localAttackTimeout);
            localAttackTimeout = null;
          }
          isLocallyAttacking = false;
          
          // Update direction and animation state
          playerDirection = newDirection;
          movementAnimationState = (movementAnimationState + 1) % 3;
          
          // Update local player object immediately
          localPlayer.direction = playerDirection;
          localPlayer.pos_x = nx;
          localPlayer.pos_y = ny;
          localPlayer.isAttacking = false;
          localPlayer.isMoving = true;
          
          // Update last move time
          lastMoveTime = currentTime;
          
          // Send move command to server
          send({ type: 'move', dx, dy, direction: playerDirection });
          
          // Reset to standing after movement
          setTimeout(() => {
            if (localPlayer) {
              localPlayer.isMoving = false;
              movementAnimationState = 0;
            }
          }, 200);
        } else {
          // Can't move but still update direction and animation for visual feedback
          playerDirection = newDirection;
          movementAnimationState = (movementAnimationState + 1) % 3;
          lastMoveTime = currentTime;
        }
      }
    }
  });

  // ---------- RENDER HELPERS ----------
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    const base = isoBase(x, y);
    const camBase = localPlayer ? isoBase(localPlayer.pos_x, localPlayer.pos_y)
                                : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));
    let screenX = PLAYER_SCREEN_X - TILE_W/2 + (base.x - camBase.x);
    let screenY = PLAYER_SCREEN_Y - TILE_H/2 + (base.y - camBase.y);
    screenX += WORLD_SHIFT_X + CENTER_LOC_ADJ_X + CENTER_LOC_FINE_X;
    screenY += WORLD_SHIFT_Y + CENTER_LOC_ADJ_Y + CENTER_LOC_FINE_Y;
    return { screenX, screenY };
  }

  function drawTile(sx, sy, t) {
    if (t > 0 && floorTiles[t]) {
      ctx.drawImage(floorTiles[t], sx + 1, sy, 62, 32);
    } else {
      ctx.beginPath();
      ctx.moveTo(sx, sy + TILE_H/2);
      ctx.lineTo(sx + TILE_W/2, sy);
      ctx.lineTo(sx + TILE_W, sy + TILE_H/2);
      ctx.lineTo(sx + TILE_W/2, sy + TILE_H);
      ctx.closePath();
      ctx.fillStyle = '#8DBF63';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
  }

  function drawItemAtTile(sx, sy, itemIndex) {
    if (!window.getItemMeta || !window.itemsReady()) return;
    const meta = window.getItemMeta(itemIndex);
    if (!meta) return;

    const { img, w, h } = meta;
    if (!img || !img.complete) return;

    let drawX = (sx + TILE_W) - w;
    let drawY = (sy + TILE_H) - h;
    
    if (w < 62) {
      const offsetX = w - 62;
      drawX += offsetX;
    }
    
    if (h < 32) {
      const offsetY = h - 32;
      drawY += offsetY;
    }

    ctx.drawImage(img, drawX, drawY);
  }

  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    
    const nameX = screenX + TILE_W / 2 - 2;
    const nameY = screenY - 34;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nameX, nameY);
    ctx.lineWidth = 1;

    let animFrame;
    
    if (isLocal) {
      if (isLocallyAttacking) {
        const attackSeq = ATTACK_SEQUENCES[playerDirection] || ATTACK_SEQUENCES.down;
        animFrame = attackSeq[localAttackState];
      } else {
        if (movementAnimationState === 0) {
          animFrame = DIRECTION_IDLE[playerDirection] || DIRECTION_IDLE.down;
        } else {
          const walkIndex = movementAnimationState === 1 ? 0 : 2;
          const directionOffsets = { down: 0, right: 5, left: 10, up: 15 };
          animFrame = (directionOffsets[playerDirection] || 0) + walkIndex;
        }
      }
    } else {
      animFrame = getCurrentAnimationFrame(p, false);
    }
    
    if (playerSpritesReady && playerSprites[animFrame] && playerSprites[animFrame].complete) {
      const sprite = playerSprites[animFrame];
      const meta = playerSpriteMeta[animFrame];
      
      if (sprite && meta) {
        let spriteX = (screenX + TILE_W) - meta.w - 7;
        let spriteY = (screenY + TILE_H) - meta.h - 12;
        
        if (meta.w < 62) {
          const offsetX = meta.w - 62;
          spriteX += offsetX;
        }
        
        if (meta.h < 32) {
          const offsetY = meta.h - 32;
          spriteY += offsetY;
        }
        
        ctx.drawImage(sprite, spriteX, spriteY, meta.w, meta.h);
      }
    } else {
      ctx.fillStyle = isLocal ? '#1E90FF' : '#FF6347';
      ctx.beginPath();
      ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawBarsAndStats() {
    if (!loggedIn || !localPlayer) return;
    const topY = 19, bottomY = 135, span = bottomY - topY;

    const sPct = Math.max(0, Math.min(1, (localPlayer.stamina ?? 0) / Math.max(1, (localPlayer.max_stamina ?? 1))));
    const sFillY = topY + (1 - sPct) * span;
    ctx.fillStyle = '#00ff00'; ctx.fillRect(187, sFillY, 13, bottomY - sFillY);

    const lPct = Math.max(0, Math.min(1, (localPlayer.life ?? 0) / Math.max(1, (localPlayer.max_life ?? 1))));
    const lFillY = topY + (1 - lPct) * span;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(211, lFillY, 13, bottomY - lFillY);

    const mx = 177, my = 247;
    const mCur = localPlayer.magic ?? 0, mMax = localPlayer.max_magic ?? 0;
    ctx.font = '14px monospace'; ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(`${mCur}/${mMax}`, mx, my);
    ctx.fillStyle = 'yellow'; ctx.fillText(`${mCur}/${mMax}`, mx, my);
    ctx.lineWidth = 1;

    const gold = localPlayer.gold ?? 0;
    ctx.font = '14px sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(String(gold), 177, 273);
    ctx.fillStyle = 'white'; ctx.fillText(String(gold), 177, 273);
    ctx.lineWidth = 1;
  }

  function drawChatHistory() {
    const { x1,y1,x2,y2,pad } = CHAT;
    const w = x2 - x1;
    ctx.font = '12px monospace'; ctx.fillStyle = '#000'; ctx.textAlign = 'left';
    const lineH = 16;
    let y = y2 - pad;
    for (let i = messages.length - 1; i >= 0; i--) {
      let line = messages[i];
      while (ctx.measureText(line).width > w - pad*2 && line.length > 1) line = line.slice(0, -1);
      ctx.fillText(line, x1 + pad, y);
      y -= lineH;
      if (y < y1 + pad) break;
    }
  }
  
  function drawChatInput() {
    if (!chatMode) return;
    const { x1, y1, x2, y2, pad, extraY } = CHAT_INPUT;
    const w = x2 - x1;
    ctx.font = '12px monospace'; ctx.fillStyle = '#000'; ctx.textAlign = 'left';
    const words = typingBuffer.split(/(\s+)/);
    let line = '', y = y1 + pad + extraY;
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i];
      if (ctx.measureText(test).width > w - pad*2) {
        ctx.fillText(line, x1 + pad, y);
        y += 16; line = words[i].trimStart();
        if (y > y2 - pad) break;
      } else line = test;
    }
    if (y <= y2 - pad && line.length) ctx.fillText(line, x1 + pad, y);
  }

  function drawItemOnBorder(itemId, x, y) {
    if (!window.getItemMeta || !window.itemsReady()) return;
    const meta = window.getItemMeta(itemId);
    if (!meta || !meta.img || !meta.img.complete) return;

    // Draw item on top of border at specified position
    ctx.drawImage(meta.img, x, y);
  }

function drawItemInInventorySlot(itemId, slotX, slotY, slotW, slotH) {
  if (!window.getItemMeta || !window.itemsReady() || !itemId || itemId === 0) return;
  const meta = window.getItemMeta(itemId);
  if (!meta || !meta.img || !meta.img.complete) return;

  const { img, w, h } = meta;
  
  // Position item so bottom-right of image aligns with bottom-right of slot at 62x32
  let drawX = (slotX + 62) - w;
  let drawY = (slotY + 32) - h - 6; // tile_bottom - 6
  
  // Apply offsets for smaller items
  if (w < 62) {
    const xOffset = w - 62; // This will be negative
    drawX += xOffset;
  }
  
  if (h < 32) {
    const yOffset = (h - 32) / 2; // This will be negative, centers the item
    drawY += yOffset;
  }
  
  ctx.drawImage(img, drawX, drawY);
}

function drawInventory() {
  if (!inventoryVisible) return;
  
  // Draw inventory background
  ctx.fillStyle = INVENTORY.backgroundColor;
  ctx.fillRect(INVENTORY.x, INVENTORY.y, INVENTORY.width, INVENTORY.height);
  
  // Draw inventory border
  ctx.strokeStyle = INVENTORY.borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(INVENTORY.x, INVENTORY.y, INVENTORY.width, INVENTORY.height);
  
  // Draw inventory slots and items
  for (let slot = 1; slot <= 16; slot++) {
    const slotPos = getInventorySlotPosition(slot);
    
    // Draw item in slot if it exists
    const itemId = playerInventory[slot] || 0;
    if (itemId > 0) {
      drawItemInInventorySlot(itemId, slotPos.x, slotPos.y, INVENTORY.slotWidth, INVENTORY.slotHeight);
    }
    
    // Draw selection circle if this slot is selected
    if (slot === inventorySelectedSlot) {
      const centerX = slotPos.x + INVENTORY.slotWidth / 2;
      const centerY = slotPos.y + INVENTORY.slotHeight / 2;
      const radius = INVENTORY.selectionCircleDiameter / 2;
      
      ctx.strokeStyle = INVENTORY.selectionCircleColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

  // ---------- SCENES ----------
  function drawConnecting() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!showLoginGUI) {
      if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
      else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
      ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
      if (connectionPaused) ctx.fillText('Press any key to enter!', 47, 347);
      else ctx.fillText('Connecting to server...', 47, 347);
    } else {
      ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
      ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
      if (!connected) ctx.fillText('Connecting to server...', 47, 347);
    }
  }

  function drawLogin() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    if (activeField === null) {
      activeField = 'username';
    }

    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);

    const uTop = FIELD_TOP(GUI.username.y);
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr || '', GUI.username.x + 4, GUI.username.y + 2);

    const pTop = FIELD_TOP(GUI.password.y);
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    drawChatHistory();
  }

  function drawGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    if (!localPlayer) return;

    if (tilesReady && mapReady) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
          const { screenX, screenY } = isoScreen(x, y);
          drawTile(screenX, screenY, t);
        }
      }
    }

    const playersByTile = {};
    if (localPlayer) {
      const k = `${localPlayer.pos_x},${localPlayer.pos_y}`;
      (playersByTile[k] ||= []).push({ ...localPlayer, __isLocal: true });
    }
    for (const id in otherPlayers) {
      const p = otherPlayers[id];
      const k = `${p.pos_x},${p.pos_y}`;
      (playersByTile[k] ||= []).push(p);
    }

    if (tilesReady && mapReady && window.itemsReady()) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const { screenX, screenY } = isoScreen(x, y);

          const effectiveItemId = getItemAtPosition(x, y);
          
          if (effectiveItemId > 0) {
            drawItemAtTile(screenX, screenY, effectiveItemId);
          }

          const k = `${x},${y}`;
          const arr = playersByTile[k];
          if (arr && arr.length) {
            for (const p of arr) drawPlayer(p, !!p.__isLocal);
          }
        }
      }
    }

    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

    drawBarsAndStats();
    drawChatHistory();
    drawChatInput();

    if (localPlayer && itemDetailsReady) {
      const playerItemId = getItemAtPosition(localPlayer.pos_x, localPlayer.pos_y);
      const playerItemDetails = getItemDetails(playerItemId);
      
      if (playerItemDetails && isItemPickupable(playerItemDetails)) {
        drawItemOnBorder(playerItemId, 57, 431);
      }

      if (localPlayer.armor && localPlayer.armor > 0) {
        drawItemOnBorder(localPlayer.armor, 56, 341);
      }
      
      if (localPlayer.weapon && localPlayer.weapon > 0) {
        drawItemOnBorder(localPlayer.weapon, 38, 296);
      }
      
      if (localPlayer.hands && localPlayer.hands > 0) {
        drawItemOnBorder(localPlayer.hands, 73, 296);
      }
    }

    // Draw inventory last (on top of everything)
    drawInventory();
  }

  // ---------- LOOP ----------
  function loop() {
    if (!connected) drawConnecting();
    else if (connected && connectionPaused) drawConnecting();
    else if (connected && !showLoginGUI) drawConnecting();
    else if (connected && showLoginGUI && !loggedIn) drawLogin();
    else if (connected && loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();

  canvas.addEventListener('mousedown', () => {
    if (!connected) { connectToServer(); return; }
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; }
  });

  // Helper functions
  function getItemDetails(itemId) {
    if (!itemDetailsReady || !itemDetails || itemId < 1 || itemId > itemDetails.length) {
      return null;
    }
    return itemDetails[itemId - 1];
  }

  function getItemAtPosition(x, y) {
    const mapItem = (mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined') 
      ? mapSpec.items[y][x] : 0;
    const placedItem = mapItems[`${x},${y}`];
    
    if (placedItem !== undefined) {
      if (placedItem === -1) {
        return 0;
      }
      if (placedItem === 0) {
        return 0;
      }
      return placedItem;
    }
    
    return mapItem;
  }

  function isItemPickupable(itemDetails) {
    if (!itemDetails) return false;
    const pickupableTypes = ["weapon", "armor", "useable", "consumable", "buff", "garbage"];
    return pickupableTypes.includes(itemDetails.type);
  }

  window.connectToServer = connectToServer;

  // Load floor collision data - fix path issue
  const baseUrl = location.hostname.includes('localhost') ? '' : '';
  
  fetch(`${baseUrl}/assets/floorcollision.json`)
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.floor)) {
        floorCollision = data.floor;
        floorCollisionReady = true;
        console.log(`Client loaded floor collision data: ${floorCollision.length} tiles`);
      }
    })
    .catch(err => {
      // Try alternative paths
      fetch('/client/assets/floorcollision.json')
        .then(r => r.json())
        .then(data => {
          if (data && Array.isArray(data.floor)) {
            floorCollision = data.floor;
            floorCollisionReady = true;
            console.log(`Client loaded floor collision data: ${floorCollision.length} tiles`);
          }
        })
        .catch(err2 => {
          // Try without any path prefix
          fetch('floorcollision.json')
            .then(r => r.json())
            .then(data => {
              if (data && Array.isArray(data.floor)) {
                floorCollision = data.floor;
                floorCollisionReady = true;
                console.log(`Client loaded floor collision data: ${floorCollision.length} tiles`);
              }
            })
            .catch(err3 => {
              floorCollisionReady = true;
              console.warn('Failed to load floor collision data from all paths');
            });
        });
    });

  // Load item details - fix path issue
  fetch(`${baseUrl}/assets/itemdetails.json`)
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.items)) {
        itemDetails = data.items.map((item, index) => ({
          id: index + 1,
          name: item[0],
          collision: item[1] === "true",
          type: item[2],
          statMin: parseInt(item[3]) || 0,
          statMax: parseInt(item[4]) || 0,
          description: item[5]
        }));
        itemDetailsReady = true;
        console.log(`Client loaded ${itemDetails.length} item details`);
      }
    })
    .catch(err => {
      // Try alternative paths
      fetch('/client/assets/itemdetails.json')
        .then(r => r.json())
        .then(data => {
          if (data && Array.isArray(data.items)) {
            itemDetails = data.items.map((item, index) => ({
              id: index + 1,
              name: item[0],
              collision: item[1] === "true",
              type: item[2],
              statMin: parseInt(item[3]) || 0,
              statMax: parseInt(item[4]) || 0,
              description: item[5]
            }));
            itemDetailsReady = true;
            console.log(`Client loaded ${itemDetails.length} item details`);
          }
        })
        .catch(err2 => {
          // Try without any path prefix
          fetch('itemdetails.json')
            .then(r => r.json())
            .then(data => {
              if (data && Array.isArray(data.items)) {
                itemDetails = data.items.map((item, index) => ({
                  id: index + 1,
                  name: item[0],
                  collision: item[1] === "true",
                  type: item[2],
                  statMin: parseInt(item[3]) || 0,
                  statMax: parseInt(item[4]) || 0,
                  description: item[5]
                }));
                itemDetailsReady = true;
                console.log(`Client loaded ${itemDetails.length} item details`);
              }
            })
            .catch(err3 => {
              itemDetailsReady = true;
              console.warn('Failed to load item details from all paths');
            });
        });
    });
});
