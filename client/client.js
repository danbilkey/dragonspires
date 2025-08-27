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

    // NPC interaction configuration
    const NPC_DIALOG = {
      x: 241,
      y: 28,
      width: 250,
      height: 150,
      backgroundColor: 'rgb(0, 133, 182)',
      borderColor: 'black',
      textColor: 'yellow',
      lineHeight: 17,
      padding: 8
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
    
    // Get item details by ID
    function getItemDetails(itemId) {
      console.log(`Debug getItemDetails: itemId=${itemId}, ready=${itemDetailsReady}, length=${itemDetails.length}`);
      if (!itemDetailsReady || !itemDetails || itemId < 1 || itemId > itemDetails.length) {
        console.log(`Debug getItemDetails: Returning null - ready:${itemDetailsReady}, hasArray:${!!itemDetails}, validId:${itemId >= 1 && itemId <= itemDetails.length}`);
        return null;
      }
      const result = itemDetails[itemId - 1];
      console.log(`Debug getItemDetails: Returning item:`, result);
      return result;
    }

    // Get enemy sprite ID based on enemy type, direction, and step
    function getEnemySpriteId(enemyType, direction, step) {
      // We need to get the sprite ID from the enemy details that were sent from server
      // For now, we'll use a simple mapping that matches the server's enemiesdetails.json structure
      
      // Map direction and step to the correct sprite field name
      let spriteField;
      if (step === 1) {
        spriteField = `enemy_image_${direction}_1`;
      } else {
        spriteField = `enemy_image_${direction}_2`;
      }
      
      // For now, we'll use a hardcoded mapping based on the enemy details structure
      // This should ideally be loaded from the server, but for immediate fix:
      const enemySpriteMappings = {
        1: { // A rabid dog
          enemy_image_up_1: 14, enemy_image_up_2: 15,
          enemy_image_right_1: 6, enemy_image_right_2: 7,
          enemy_image_down_1: 2, enemy_image_down_2: 3,
          enemy_image_left_1: 10, enemy_image_left_2: 11
        },
        2: { // A giant wasp
          enemy_image_up_1: 23, enemy_image_up_2: 24,
          enemy_image_right_1: 19, enemy_image_right_2: 20,
          enemy_image_down_1: 17, enemy_image_down_2: 18,
          enemy_image_left_1: 21, enemy_image_left_2: 22
        },
        3: { // A Swamp Dweller
          enemy_image_up_1: 31, enemy_image_up_2: 32,
          enemy_image_right_1: 27, enemy_image_right_2: 28,
          enemy_image_down_1: 25, enemy_image_down_2: 26,
          enemy_image_left_1: 29, enemy_image_left_2: 30
        },
        4: { // An OgRe
          enemy_image_up_1: 39, enemy_image_up_2: 40,
          enemy_image_right_1: 35, enemy_image_right_2: 36,
          enemy_image_down_1: 33, enemy_image_down_2: 34,
          enemy_image_left_1: 37, enemy_image_left_2: 38
        },
        5: { // Enemy type 5 (add more as needed)
          enemy_image_up_1: 47, enemy_image_up_2: 48,
          enemy_image_right_1: 43, enemy_image_right_2: 44,
          enemy_image_down_1: 41, enemy_image_down_2: 42,
          enemy_image_left_1: 45, enemy_image_left_2: 46
        },
        6: { // Enemy type 6
          enemy_image_up_1: 55, enemy_image_up_2: 56,
          enemy_image_right_1: 51, enemy_image_right_2: 52,
          enemy_image_down_1: 49, enemy_image_down_2: 50,
          enemy_image_left_1: 53, enemy_image_left_2: 54
        },
        7: { // Enemy type 7
          enemy_image_up_1: 63, enemy_image_up_2: 64,
          enemy_image_right_1: 59, enemy_image_right_2: 60,
          enemy_image_down_1: 57, enemy_image_down_2: 58,
          enemy_image_left_1: 61, enemy_image_left_2: 62
        },
        8: { // Enemy type 8
          enemy_image_up_1: 71, enemy_image_up_2: 72,
          enemy_image_right_1: 67, enemy_image_right_2: 68,
          enemy_image_down_1: 65, enemy_image_down_2: 66,
          enemy_image_left_1: 69, enemy_image_left_2: 70
        },
        9: { // Enemy type 9
          enemy_image_up_1: 79, enemy_image_up_2: 80,
          enemy_image_right_1: 75, enemy_image_right_2: 76,
          enemy_image_down_1: 73, enemy_image_down_2: 74,
          enemy_image_left_1: 77, enemy_image_left_2: 78
        },
        10: { // Enemy type 10
          enemy_image_up_1: 87, enemy_image_up_2: 88,
          enemy_image_right_1: 83, enemy_image_right_2: 84,
          enemy_image_down_1: 81, enemy_image_down_2: 82,
          enemy_image_left_1: 85, enemy_image_left_2: 86
        },
        11: { // Enemy type 11
          enemy_image_up_1: 95, enemy_image_up_2: 96,
          enemy_image_right_1: 91, enemy_image_right_2: 92,
          enemy_image_down_1: 89, enemy_image_down_2: 90,
          enemy_image_left_1: 93, enemy_image_left_2: 94
        },
        12: { // Enemy type 12
          enemy_image_up_1: 103, enemy_image_up_2: 104,
          enemy_image_right_1: 99, enemy_image_right_2: 100,
          enemy_image_down_1: 97, enemy_image_down_2: 98,
          enemy_image_left_1: 101, enemy_image_left_2: 102
        }
      };
      
      const enemyMapping = enemySpriteMappings[enemyType];
      if (enemyMapping && enemyMapping[spriteField]) {
        return enemyMapping[spriteField];
      }
      
      // Fallback to a default sprite if mapping not found
      return 1;
    }

    // ---------- STATE ----------
    let ws = null;
    let connected = false;
    let connectionPaused = false;
    let showLoginGUI = false;
    let loggedIn = false;
    let chatMode = false;
    let connectionAttempted = false; // Track if we've started connecting
    // BRB/AFK state
    let isBRB = false;
    
    // NPC interaction state
    let npcInteraction = null; // Will hold NPC details when interacting

    // Assets ready flags
    let tilesReady = false;
    let mapReady = false;
    let playerSpritesReady = false;
    let itemDetailsReady = false;
    let floorCollisionReady = false;
    let currentlyLoadingMap = false;

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
    let enemies = {}; // Store enemies by ID
    let spells = {}; // Store active spells by ID
    let electrocuteEffects = {}; // Store active electrocute effects by ID
    let healingEffects = {}; // Store active healing effects by ID
    let silverMistEffects = {}; // Store active silver mist effects by ID

    // NEW: Simplified direction and animation state system
    let playerDirection = 'down'; // Current facing direction
    let playerStep = 2; // Current step in movement sequence (1, 2, 3)
    let isLocallyAttacking = false; // Local attack state
    let localAttackState = 0; // 0 or 1 for attack_1 or attack_2
    let lastMoveTime = 0; // Prevent rapid movement through collision objects
    let justFinishedAttack = false; // Track if player just finished attacking

    // Chat
    let messages = [];
    let typingBuffer = "";

    // Animation state - SIMPLIFIED ATTACK HANDLING
    let localAttackTimeout = null; // Track our own attack timeout
    let isLocallyPickingUp = false; // Local pickup state
    let localPickupTimeout = null; // Track our own pickup timeout
    let shouldStayInStand = false;

    // Inventory state - MOVED TO TOP LEVEL
    let inventoryVisible = false;
    let temporarySprite = 0; // For temporary sprite rendering
    let fountainEffects = []; // Track fountain healing effects { playerId, startTime }
    let inventorySelectedSlot = 1; // Default to slot 1
    let chatScrollOffset = 0; // For scrolling through chat messages
    let playerInventory = {}; // { slotNumber: itemId }
    
    // Loading screen state
    let loadingScreenActive = false;
    let loadingScreenImage = null;
    let loadingScreenX = 0;
    let loadingScreenY = 0;
    let loadingScreenEndTime = 0;

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

    // Enemy sprites: extract individual enemy animations from enemies.png using enemy.json
    const imgEnemySrc = new Image();
    imgEnemySrc.src = "/assets/enemies.png";
    let enemySprites = []; // Array of Image objects for each enemy sprite
    let enemySpriteMeta = []; // Array of {w, h} for each sprite
    let enemySpritesReady = false;

    Promise.all([
      new Promise(resolve => {
        if (imgEnemySrc.complete) resolve();
        else { imgEnemySrc.onload = resolve; imgEnemySrc.onerror = () => { console.error('Failed to load enemies.png'); resolve(); }; }
      }),
      fetch('/assets/enemy.json').then(r => r.json()).catch(() => { console.error('Failed to load enemy.json'); return null; })
    ]).then(([_, enemyJson]) => {
      if (!enemyJson || !enemyJson.enemycoords) {
        console.error('Failed to load enemy.json or enemycoords data');
        enemySpritesReady = true;
        return;
      }

      const enemyCoords = enemyJson.enemycoords;
      const loadPromises = [];

      enemyCoords.forEach(([sx, sy, sw, sh], index) => {
        try {
          const off = document.createElement('canvas');
          off.width = sw;
          off.height = sh;
          const octx = off.getContext('2d');
          octx.drawImage(imgEnemySrc, sx, sy, sw, sh, 0, 0, sw, sh);

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
          
          enemySprites[index + 1] = sprite; // 1-based indexing to match server
          enemySpriteMeta[index + 1] = { w: sw, h: sh };
          loadPromises.push(promise);
        } catch (e) {
          console.error(`Failed to process enemy sprite ${index}:`, e);
        }
      });

      Promise.all(loadPromises).then(() => {
        enemySpritesReady = true;
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

        // Map loading will be handled by loadMapForPlayer function
        // Don't set mapReady to true here - let loadMapForPlayer handle it
        // mapReady will be set when a specific map is loaded

      } catch (e) {
        console.error("Floor tile extraction failed:", e);
        tilesReady = true; mapReady = true; // fail-safe
      }
    };

    // ---------- ITEMS (sheet + coords, true magenta keyed, top-left alignment with yOffset) ----------
    (() => {
      const imgItems = new Image();
      imgItems.src = "/assets/item.gif";
    
      const itemsJsonPromise = fetch("/assets/item.json")
        .then(r => r.json())
        .catch(() => null);
    
      const itemSprites = []; // 1-based
      const itemMeta = [];    // 1-based: { img, w, h, yOffset }
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
    
        meta.item_coords.forEach((coords, idx) => {
          const [sx, sy, sw, sh, yOffset] = coords;
          off.width = sw; off.height = sh;
          octx.clearRect(0, 0, sw, sh);
          octx.drawImage(imgItems, sx, sy, sw, sh, 0, 0, sw, sh);
    
          // Make true magenta transparent
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
    
            tempCtx.putImageData(data, 0, 0);
            octx.clearRect(0, 0, sw, sh);
            octx.drawImage(tempCanvas, 0, 0);
          } catch {
            // fallback if canvas is tainted (shouldn't be here)
          }
    
          // Freeze the processed pixels into an <img>
          const sprite = new Image();
          sprite.src = off.toDataURL();
    
          itemSprites[idx + 1] = sprite;
          itemMeta[idx + 1] = { img: sprite, w: sw, h: sh, yOffset: yOffset || 0 };
        });
    
        itemsReady = true;
      });
    
      // accessors
      window.getItemSprite = (i) => itemSprites[i] || null;
      window.getItemMeta   = (i) => itemMeta[i] || null;
      window.itemSpriteCount = () => itemSprites.length - 1;
      window.itemsReady = () => itemsReady;
    })();

    // ---------- MAP LOADING ----------
    async function loadMapForPlayer(mapId) {
      if (currentlyLoadingMap) {
        console.log('Map already loading, skipping duplicate request');
        return false;
      }
      
      currentlyLoadingMap = true;
      mapReady = false; // Prevent rendering while loading
      
      try {
        const mapFileName = `/maps/map${mapId}.json`;
        const response = await fetch(mapFileName);
        
        if (!response.ok) {
          console.error(`Failed to load map ${mapId}: ${response.status}`);
          mapReady = true; // Allow rendering even if map load failed
          currentlyLoadingMap = false;
          return false;
        }
        
        const m = await response.json();
        
        if (m && m.width && m.height) {
          const tiles = Array.isArray(m.tiles) ? m.tiles : (Array.isArray(m.tilemap) ? m.tilemap : null);
          mapSpec = {
            width: m.width,
            height: m.height,
            tiles: tiles || [],
            items: Array.isArray(m.items) ? m.items : []
          };
          console.log(`Client loaded map ${mapId}: ${mapSpec.width}x${mapSpec.height}`);
          mapReady = true; // Map is now ready for rendering
          currentlyLoadingMap = false;
          return true;
        }
      } catch (error) {
        console.error(`Error loading map ${mapId}:`, error);
      }
      
      mapReady = true; // Allow rendering even if failed
      currentlyLoadingMap = false;
      return false;
    }

    // ---------- ANIMATION HELPERS ----------
    function getCurrentAnimationFrame(player, isLocal = false) {
    // For local player, use local pickup state
    if (isLocal && isLocallyPickingUp) {
      return 21; // 'sit' animation
    }
    // For other players, use their pickup state
    if (!isLocal && player.isPickingUp) {
      return 21; // 'sit' animation
    }
    
    if (player.isAttacking) {
      return player.animationFrame || DIRECTION_IDLE[player.direction] || DIRECTION_IDLE.down;
    }

    // Special handling for specific animation frames (resting, standing, etc.)
    if (player.animationFrame === 21) {
      return 21; // 'sit' animation (resting) - index 21 in ANIMATION_NAMES
    }
    if (player.animationFrame === 20) {
      return 20; // 'stand' animation - index 20 in ANIMATION_NAMES
    }

    // For normal movement, use the direction and step system
    return getAnimationFrameFromDirectionAndStep(player.direction || 'down', player.step || 2);
  }

    // ---------- HEARTBEAT ----------
    let heartbeatInterval = null;
    
    function startHeartbeat() {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (loggedIn && ws && ws.readyState === WebSocket.OPEN) {
          send({ type: 'heartbeat' });
        }
      }, 30000); // Send heartbeat every 30 seconds
    }
    
    function stopHeartbeat() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }

    // ---------- WS ----------
    function connectToServer() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      
      connectionAttempted = true; // Mark that we've started connecting
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        connected = true;
        connectionPaused = true;
        showLoginGUI = false;
        
        // Start heartbeat to keep server alive
        startHeartbeat();
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
        enemies = {};
        mapItems = {};
        
        // Add disconnection message to chat
        pushChat("~ You have been disconnected from the server.");
        
        // Clear any pending attack timeout
        if (localAttackTimeout) {
          clearTimeout(localAttackTimeout);
          localAttackTimeout = null;
        }
        if (localPickupTimeout) {
          clearTimeout(localPickupTimeout);
          localPickupTimeout = null;
        }
        isLocallyPickingUp = false;
        shouldStayInStand = false;
        isBRB = false;
        playerInventory = {};
        inventoryVisible = false;
      
        // Stop heartbeat on close
        stopHeartbeat();
        
        // Auto-reconnect after 3 seconds if not manually closed
        if (e.code !== 1000) { // 1000 = normal closure
          console.log('Attempting to reconnect in 3 seconds...');
          setTimeout(connectToServer, 3000);
        }
      };;
    }
    
    // Focus tracking for warning
    let windowFocused = true;
    
    window.addEventListener('focus', () => {
      windowFocused = true;
    });
    
    window.addEventListener('blur', () => {
      windowFocused = false;
    });
    
    // Canvas click to regain focus
    canvas.addEventListener('click', () => {
      if (!windowFocused) {
        window.focus();
      }
    });

    // Wait 20ms for title to load, then start connecting
    setTimeout(connectToServer, 20);

    function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
    function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
    function pushChat(line, color = 'black') { 
      messages.push({ text: String(line), color: color }); 
      if (messages.length > 200) messages.shift(); 
    }

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
            step: msg.player.step || 2,
            isMoving: false,
            isAttacking: false,
            isPickingUp: false,
            weapon: msg.player.weapon || 0,
            armor: msg.player.armor || 0,
            hands: msg.player.hands || 0
          };

          // Load the correct map for the player
          loadMapForPlayer(localPlayer.map_id || 1).catch(error => {
            console.error('Failed to load map during login:', error);
          });
          
          // Initialize local state variables
          playerDirection = localPlayer.direction;
          playerStep = localPlayer.step;
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
                  step: p.step || 2,
                  isMoving: p.isMoving || false,
                  isAttacking: p.isAttacking || false,
                  isPickingUp: p.isPickingUp || false,
                  isBRB: p.isBRB || false,
                  temporarySprite: p.temporarySprite || 0
                };
              }
            });
          }
          
          // Initialize enemies
          enemies = {};
          if (msg.enemies) {
            for (const [enemyId, enemy] of Object.entries(msg.enemies)) {
              enemies[enemyId] = {
                ...enemy
              };
            }
          }

          if (msg.items) {
            mapItems = { ...msg.items };
          }

          pushChat("Welcome to DragonSpires!", 'blue');
          break;
          
        case 'player_joined':
          if (!localPlayer || msg.player.id !== localPlayer.id) {
            otherPlayers[msg.player.id] = {
              ...msg.player,
              direction: msg.player.direction || 'down',
              step: msg.player.step || 2,
              isMoving: msg.player.isMoving || false,
              isAttacking: false, // Force new players to not be attacking
              isPickingUp: msg.player.isPickingUp || false,
              isBRB: msg.player.isBRB || false,
              temporarySprite: msg.player.temporarySprite || 0,
              animationFrame: undefined // Clear any stale animation frame
            };
            pushChat(`${msg.player.username || msg.player.id} has entered DragonSpires!`, 'grey');
          }
          break;
          
        case 'player_moved':
          if (localPlayer && msg.id === localPlayer.id) { 
            localPlayer.pos_x = msg.x; 
            localPlayer.pos_y = msg.y;
            localPlayer.isMoving = msg.isMoving || false;
            // Sync direction and step with server
            if (msg.direction) {
              playerDirection = msg.direction;
              localPlayer.direction = msg.direction;
            }
            if (msg.step) {
              playerStep = msg.step;
              localPlayer.step = msg.step;
            }
          } else {
            if (!otherPlayers[msg.id]) {
              otherPlayers[msg.id] = { 
                id: msg.id, 
                username: msg.username || `#${msg.id}`, 
                pos_x: msg.x, 
                pos_y: msg.y,
                map_id: msg.map_id,
                direction: msg.direction || 'down',
                step: msg.step || 2,
                isMoving: msg.isMoving || false,
                isAttacking: msg.isAttacking || false,
                isPickingUp: false,
                isBRB: false,
                temporarySprite: 0
              };
            } else { 

              otherPlayers[msg.id].pos_x = msg.x; 
              otherPlayers[msg.id].pos_y = msg.y;
              otherPlayers[msg.id].map_id = msg.map_id;
              otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
              otherPlayers[msg.id].step = msg.step || otherPlayers[msg.id].step;
              otherPlayers[msg.id].isMoving = msg.isMoving || false;
              otherPlayers[msg.id].isAttacking = msg.isAttacking || false;
              // Clear animationFrame when player moves (so they exit stand animation)
              if (msg.isMoving) {
                otherPlayers[msg.id].animationFrame = undefined;
              }
            }
          }
          break;
          
        case 'animation_update':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.direction = msg.direction || localPlayer.direction;
          localPlayer.step = msg.step || localPlayer.step;
          localPlayer.isMoving = msg.isMoving || false;
          localPlayer.isAttacking = msg.isAttacking || false;
          localPlayer.isPickingUp = msg.isPickingUp || false;
          // Store animationFrame for resting/standing animations (including null to clear)
          if (msg.hasOwnProperty('animationFrame')) {
            localPlayer.animationFrame = msg.animationFrame;
          }
          // Update client state variables for local player
          playerDirection = localPlayer.direction;
          playerStep = localPlayer.step;
        } else if (otherPlayers[msg.id]) {
          otherPlayers[msg.id].map_id = msg.map_id || otherPlayers[msg.id].map_id;
          otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
          otherPlayers[msg.id].step = msg.step || otherPlayers[msg.id].step;
          otherPlayers[msg.id].isMoving = msg.isMoving || false;
          otherPlayers[msg.id].isAttacking = msg.isAttacking || false;
          otherPlayers[msg.id].isPickingUp = msg.isPickingUp || false;
          // Store animationFrame for attack animations
          if (typeof msg.animationFrame !== 'undefined') {
            otherPlayers[msg.id].animationFrame = msg.animationFrame;
          }
        }
        break;
        
        case 'player_animation_update':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.direction = msg.direction || localPlayer.direction;
          localPlayer.step = msg.step || localPlayer.step;
          localPlayer.isMoving = msg.isMoving || false;
          localPlayer.isAttacking = msg.isAttacking || false;
          // Update client state variables for local player
          playerDirection = localPlayer.direction;
          playerStep = localPlayer.step;
        } else if (otherPlayers[msg.id]) {
          otherPlayers[msg.id].map_id = msg.map_id || otherPlayers[msg.id].map_id;
          otherPlayers[msg.id].direction = msg.direction || otherPlayers[msg.id].direction;
          otherPlayers[msg.id].step = msg.step || otherPlayers[msg.id].step;
          otherPlayers[msg.id].isMoving = msg.isMoving || false;
          otherPlayers[msg.id].isAttacking = msg.isAttacking || false;
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
          case 'player_brb_update':
            if (localPlayer && msg.id === localPlayer.id) {
              isBRB = msg.brb || false;
            } else if (otherPlayers[msg.id]) {
              otherPlayers[msg.id].isBRB = msg.brb || false;
            }
            break;
          case 'temporary_sprite_update':
            if (localPlayer && msg.id === localPlayer.id) {
              localPlayer.temporarySprite = msg.temporarySprite || 0;
              temporarySprite = localPlayer.temporarySprite;
            } else if (otherPlayers[msg.id] && Number(msg.map_id) === Number(localPlayer.map_id)) {
              otherPlayers[msg.id].temporarySprite = msg.temporarySprite || 0;
            }
            break;
          case 'transformation_result':
            if (msg.success && localPlayer && msg.id === localPlayer.id) {
              localPlayer.magic = msg.newMagic;
              temporarySprite = msg.temporarySprite;
              localPlayer.temporarySprite = msg.temporarySprite;
            } else if (!msg.success && msg.message) {
              pushChat(msg.message);
            }
            break;
        case 'teleport_result':
            if (msg.success && localPlayer && msg.id === localPlayer.id) {
              // Show loading screen FIRST (before any position/map changes are visible)
              if (msg.showLoadingScreen) {
                showLoadingScreen(msg.showLoadingScreen);
              }
              
              // Only update magic if newMagic is provided (for item 58)
              if (msg.newMagic !== undefined) {
                localPlayer.magic = msg.newMagic;
              }
              localPlayer.pos_x = msg.x;
              localPlayer.pos_y = msg.y;
              
              // Check if map changed and reload if necessary
              if (localPlayer.map_id !== msg.mapId) {
                localPlayer.map_id = msg.mapId;
                loadMapForPlayer(msg.mapId).catch(error => {
                  console.error('Failed to load map during teleport:', error);
                });
              } else {
                localPlayer.map_id = msg.mapId;
              }
              
              // No need to update otherPlayers here - the server broadcasts position updates
              
              // Update map items
              if (msg.items) {
                mapItems = { ...msg.items };
              }
              
              // Update enemies for new map
              if (msg.enemies) {
                enemies = {};
                for (const [enemyId, enemy] of Object.entries(msg.enemies)) {
                  enemies[enemyId] = {
                    ...enemy
                  };
                }
              }

              // Clear spells when changing maps
              spells = {};
            } else if (!msg.success && msg.message) {
              pushChat(msg.message);
            }
            break;
        case 'enemy_moved':
          // Update enemy position and animation
          if (enemies[msg.id]) {
            enemies[msg.id].pos_x = msg.pos_x;
            enemies[msg.id].pos_y = msg.pos_y;
            enemies[msg.id].direction = msg.direction;
            enemies[msg.id].step = msg.step;
          }
          break;
          
        case 'enemy_removed':
          // Remove enemy from current map
          console.log(`Received enemy_removed for enemy ${msg.id} on map ${msg.map_id}`);
          console.log(`Current enemies:`, Object.keys(enemies));
          console.log(`Local player map:`, localPlayer?.map_id);
          
          if (enemies[msg.id]) {
            console.log(`Enemy ${msg.id} exists, removing...`);
            delete enemies[msg.id];
            console.log(`Enemy ${msg.id} removed. Remaining enemies:`, Object.keys(enemies));
          } else {
            console.log(`Enemy ${msg.id} not found in enemies object`);
          }
          break;

        case 'spell_created':
          spells[msg.spell.id] = msg.spell;
          console.log(`Spell ${msg.spell.id} created at (${msg.spell.currentX}, ${msg.spell.currentY})`);
          break;

        case 'spell_moved':
          if (spells[msg.spellId]) {
            spells[msg.spellId].currentX = msg.x;
            spells[msg.spellId].currentY = msg.y;
            console.log(`Spell ${msg.spellId} moved to (${msg.x}, ${msg.y})`);
          }
          break;

        case 'spell_removed':
          delete spells[msg.spellId];
          console.log(`Spell ${msg.spellId} removed`);
          break;

        case 'electrocute_created':
          electrocuteEffects[msg.effectId] = {
            id: msg.effectId,
            x: msg.x,
            y: msg.y
          };
          console.log(`Electrocute effect ${msg.effectId} created at (${msg.x}, ${msg.y})`);
          break;

        case 'electrocute_removed':
          delete electrocuteEffects[msg.effectId];
          console.log(`Electrocute effect ${msg.effectId} removed`);
          break;

        case 'healing_created':
          healingEffects[msg.effectId] = {
            id: msg.effectId,
            x: msg.x,
            y: msg.y
          };
          console.log(`Healing effect ${msg.effectId} created at (${msg.x}, ${msg.y})`);
          break;

        case 'healing_removed':
          delete healingEffects[msg.effectId];
          console.log(`Healing effect ${msg.effectId} removed`);
          break;

        case 'silver_mist_created':
          silverMistEffects[msg.effectId] = {
            id: msg.effectId,
            x: msg.x,
            y: msg.y
          };
          console.log(`Silver Mist effect ${msg.effectId} created at (${msg.x}, ${msg.y})`);
          break;

        case 'silver_mist_removed':
          delete silverMistEffects[msg.effectId];
          console.log(`Silver Mist effect ${msg.effectId} removed`);
          break;
          
        case 'enemy_spawned':
          // Add new enemy to the client
          if (msg.enemy) {
            enemies[msg.enemy.id] = {
              ...msg.enemy
            };
          }
          break;
          
        case 'enemies_cleared':
          // Clear all enemies from client
          enemies = {};
          break;
          
        case 'enemies_reloaded':
          // Reload enemies after server reset
          enemies = {};
          if (msg.enemies) {
            for (const [enemyId, enemy] of Object.entries(msg.enemies)) {
              enemies[enemyId] = {
                ...enemy
              };
            }
          }
          break;
          
        case 'fountain_heal':
            if (localPlayer && msg.id === localPlayer.id) {
              localPlayer.stamina = msg.stamina;
              localPlayer.life = msg.life;
              localPlayer.magic = msg.magic;
              pushChat("You are refreshed by the fountains healing waters!", 'cornflowerblue');
            }
            break;
          
          case 'fountain_effect':
              if (msg.playerId !== undefined) {
                fountainEffects.push({
                  playerId: msg.playerId,
                  startTime: Date.now()
                });
              }
              break;

        case 'clear_fountain_effect':
            if (msg.playerId !== undefined) {
              fountainEffects = fountainEffects.filter(effect => effect.playerId !== msg.playerId);
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
          // Remove player from game - chat message is handled by server
          delete otherPlayers[msg.id];
          break;
          
        case 'chat':
          if (typeof msg.text === 'string') {
            const color = msg.color || 'black';
            pushChat(msg.text, color);
          }
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
            if ('gold' in msg) obj.gold = msg.gold;
          };
          if (localPlayer && msg.id === localPlayer.id) apply(localPlayer);
          else if (otherPlayers[msg.id]) apply(otherPlayers[msg.id]);
          break;
          
        case 'login_error':
        case 'signup_error':
          pushChat(msg.message || 'Auth error');
          break;
          
        case 'npc_interaction_start':
          // Start NPC interaction with provided details
          npcInteraction = {
            npcDetails: msg.npcDetails,
            stage: 'main'
          };
          console.log('Started NPC interaction:', npcInteraction);
          break;
          
        case 'npc_interaction_update':
          // Update NPC interaction stage
          if (npcInteraction) {
            npcInteraction.stage = msg.stage;
            console.log('Updated NPC interaction stage:', msg.stage);
          }
          break;
          
        case 'npc_interaction_end':
          // End NPC interaction
          npcInteraction = null;
          console.log('Ended NPC interaction');
          break;
      }
    }

    // ---------- INPUT ----------
    window.addEventListener('keydown', (e) => {
      // Help controls with Ctrl+Z
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        showHelpControls();
        return;
      }
      if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

      // Inventory toggle with 'i' key (only when not in chat mode)
      if (loggedIn && localPlayer && (e.key === 'i' || e.key === 'I') && !chatMode) {
        e.preventDefault();
        
        // End NPC interaction if active
        if (npcInteraction) {
          npcInteraction = null;
          console.log('Ended NPC interaction due to inventory toggle');
        }
        
        // Toggle inventory visibility
        inventoryVisible = !inventoryVisible;
        return;
      }

      // Toggle / submit chat
      if (e.key === 'Enter' && loggedIn) {
        if (!chatMode) { chatMode = true; typingBuffer = ""; }
        else {
          const toSend = typingBuffer.trim();
        if (toSend === '-pos' && localPlayer) {
            pushChat(`~ ${localPlayer.username} is currently on Map ${localPlayer.map_id ?? 1} at location x:${localPlayer.pos_x}, y:${localPlayer.pos_y}.`);
          } else if (toSend === '-help') {
            showHelpControls();
          } else if (toSend === '-cls') {
            clearChatMessages();
          } else if (toSend === '-stats') {
            showPlayerStats();
          } else if (toSend === '-brb') {
            toggleBRB();
          } else if (toSend.length > 0) {
            send({ type: 'chat', text: toSend.slice(0, CHAT_INPUT.maxLen) });
          }
          typingBuffer = ""; chatMode = false;
        }
        e.preventDefault(); return;
      }

      // Capture chat text
      if (chatMode) {
        console.log(`Debug: In chat mode, ignoring key: ${e.key}`);
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

      // Debug: Log all key presses and state
      console.log(`Debug: Key pressed: '${e.key}', loggedIn=${loggedIn}, localPlayer=${!!localPlayer}`);
      if (loggedIn && localPlayer) {
        console.log(`Debug: Player state - hands: ${localPlayer.hands}, magic: ${localPlayer.magic}`);
      }

      // Handle NPC interaction number keys (1-5) - only when not in chat mode
      if (loggedIn && localPlayer && npcInteraction && /^[1-5]$/.test(e.key) && !chatMode) {
        e.preventDefault();
        // Send the number as a chat message to trigger NPC interaction
        send({ 
          type: 'chat', 
          text: e.key 
        });
        return;
      }

      // Look command with 'l' key
      if (loggedIn && localPlayer && e.key === 'l') {
        e.preventDefault();
        
        // End NPC interaction if active
        if (npcInteraction) {
          npcInteraction = null;
          console.log('Ended NPC interaction with l key');
          return;
        }
        
        // Close inventory if it's open
        if (inventoryVisible) {
          inventoryVisible = false;
        }
        
        // Send look request to server
        send({ type: 'look' });
        
        return;
      }

      // Transformation with 'U' key
      if (loggedIn && localPlayer && (e.key === 'u' || e.key === 'U')) {
        console.log(`Debug: 'u' key pressed! loggedIn=${loggedIn}, localPlayer=${!!localPlayer}`);
        e.preventDefault();
        
        const handsItem = localPlayer.hands || 0;
        const playerMagic = localPlayer.magic || 0;
        
        // Define transformation mappings
        const transformations = {
          57: { cost: 10, result: 14 },   // Item 57 -> Item 14
          101: { cost: 10, result: 87 },  // Item 101 -> Item 87
          59: { cost: 10, result: 61 },   // Item 59 -> Item 61
          98: { cost: 10, result: 117 },  // Item 98 -> Item 117
          285: { cost: 10, result: 323 }, // Item 285 -> Item 323
          283: { cost: 10, result: -1 },  // Item 283 -> Random (special case)
          58: { cost: 20, result: -2 },   // Item 58 -> Teleport to map 1 (special case)
          97: { cost: 10, result: -3 },   // Item 97 -> Fire pillar spell (special case)
          100: { cost: 15, result: -4 },  // Item 100 -> Full heal spell (special case)
          131: { cost: 20, result: -5 },  // Item 131 -> Partial heal spell (special case)
          102: { cost: 20, result: -6 }   // Item 102 -> Silver Mist spell (special case)
        };
        
        // First check if item is consumable
        const itemDetails = getItemDetails(handsItem);
        console.log(`Debug: Checking item ${handsItem}, details:`, itemDetails);
        
        if (itemDetails && itemDetails.type === 'consumable') {
          console.log(`Debug: Item ${handsItem} is consumable, sending use_consumable_item message`);
          // Send consumable item request to server
          send({ 
            type: 'use_consumable_item', 
            itemId: handsItem
          });
        } else if (handsItem === 200 || handsItem === 249) {
          // Key items - no magic cost required
          send({ 
            type: 'use_key_item', 
            itemId: handsItem
          });
        } else if (handsItem > 0 && transformations[handsItem]) {
          const transformation = transformations[handsItem];
          
          if (playerMagic >= transformation.cost) {
            // Clear any existing temporary sprite first
            clearTemporarySprite();
            
            // Send transformation request to server
            if (handsItem === 58) {
              // Special teleport item
              send({ 
                type: 'use_teleport_item', 
                itemId: handsItem,
                magicCost: transformation.cost,
                targetMap: 1,
                targetX: 33,
                targetY: 27
              });
            } else if (handsItem === 97) {
              // Special fire pillar spell
              send({ 
                type: 'use_fire_pillar_spell', 
                itemId: handsItem
              });
            } else if (handsItem === 100 || handsItem === 131) {
              // Healing spells
              send({ 
                type: 'use_heal_spell', 
                itemId: handsItem
              });
            } else if (handsItem === 102) {
              // Silver Mist spell
              send({ 
                type: 'use_silver_mist_spell', 
                itemId: handsItem
              });
            } else {
              send({ 
                type: 'use_transformation_item', 
                itemId: handsItem,
                magicCost: transformation.cost,
                resultItem: transformation.result
              });
            }
          } else {
            pushChat("~ You do not have enough magic to use that item!");
          }
        }
        
        return;
      }

      // Pick up item with 'g' key
      if (loggedIn && localPlayer && e.key === 'g') {
        e.preventDefault();
        
        // Clear temporary sprite when picking up
        clearTemporarySprite();

        // Clear fountain effect when picking up
        fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));

        // Start local pickup animation immediately
        isLocallyPickingUp = true;
        shouldStayInStand = true; // Set flag to stay in stand after animation
        
        if (localPickupTimeout) {
          clearTimeout(localPickupTimeout);
        }
        
        localPickupTimeout = setTimeout(() => {
          isLocallyPickingUp = false;
          localPickupTimeout = null;
          // Set step to 2 after pickup animation, shouldStayInStand remains true until movement
          playerStep = 2;
          localPlayer.step = playerStep;
        }, 700); // Slightly longer than server animation
        
        const itemId = getItemAtPosition(localPlayer.pos_x, localPlayer.pos_y);
        const itemDetails = getItemDetails(itemId);
        
        console.log(`Pickup attempt: position (${localPlayer.pos_x},${localPlayer.pos_y}), itemId: ${itemId}, itemDetails:`, itemDetails);
        
        // Priority: If player has something in hands, always drop/swap (even if there's an item on ground)
        if (localPlayer.hands && localPlayer.hands > 0) {
          console.log(`Dropping item from hands: ${localPlayer.hands} ${itemDetails ? '(will swap with ' + itemId + ')' : '(empty ground)'}`);
          send({
            type: 'pickup_item',
            x: localPlayer.pos_x,
            y: localPlayer.pos_y,
            itemId: 0
          });
        }
        // Only pick up if hands are empty
        else if (itemDetails && isItemPickupable(itemDetails)) {
          console.log(`Sending pickup request for item ${itemId}`);
          send({
            type: 'pickup_item',
            x: localPlayer.pos_x,
            y: localPlayer.pos_y,
            itemId: itemId
          });
        } else {
          console.log(`No action taken - no pickupable item and no hands item to drop`);
          // Send pickup anyway to show animation
          send({
            type: 'pickup_item',
            x: localPlayer.pos_x,
            y: localPlayer.pos_y,
            itemId: 0
          });
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

      // Toggle rest with 'r' key
      if (loggedIn && localPlayer && e.key === 'r') {
        e.preventDefault();
        send({ type: 'toggle_rest' });
        return;
      }

      // Rotation with '0' key
      if (loggedIn && localPlayer && e.key === '0') {
        e.preventDefault();
        
        // Clear stand flag when rotating
        shouldStayInStand = false;
        // Clear fountain effect when rotating
        fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));

        if (localAttackTimeout) {
          clearTimeout(localAttackTimeout);
          localAttackTimeout = null;
        }
        
        const directions = ['right', 'down', 'left', 'up'];
        const currentIndex = directions.indexOf(playerDirection);
        const nextIndex = (currentIndex + 1) % directions.length;
        playerDirection = directions[nextIndex];
        
        playerStep = 2; // Set step to 2 when rotating
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

        // Clear BRB state when attacking
        if (isBRB) {
          isBRB = false;
          send({ type: 'set_brb', brb: false });
        }

        // Clear stand flag when attacking
        shouldStayInStand = false;
        
        // Reduce stamina by 10 locally for immediate feedback
        localPlayer.stamina = Math.max(0, (localPlayer.stamina ?? 0) - 10);
        
        // Clear temporary sprite when attacking
        clearTemporarySprite();
        // Clear fountain effect when attacking
        fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));
        isLocallyAttacking = true;
        localAttackState = (localAttackState + 1) % 2;
        
        if (localAttackTimeout) {
          clearTimeout(localAttackTimeout);
        }
        
        localAttackTimeout = setTimeout(() => {
          isLocallyAttacking = false;
          // Only reset step to 2 if player hasn't moved during attack
          // (if they moved, their direction and step were already updated)
          if (!localPlayer.isMoving) {
            playerStep = 2; // Set step to 2 after attack concludes
            localPlayer.step = playerStep;
            justFinishedAttack = true; // Mark that we just finished attacking
          }
          localAttackTimeout = null;
        }, 1000);
        
        // Check for healing fountain in attack direction
        let attackX = localPlayer.pos_x;
        let attackY = localPlayer.pos_y;
        
        switch (playerDirection) {
          case 'up': attackY -= 1; break;
          case 'down': attackY += 1; break;
          case 'left': attackX -= 1; break;
          case 'right': attackX += 1; break;
        }
        
        const targetItemId = getItemAtPosition(attackX, attackY);
        if (targetItemId === 60) {
          // Send fountain attack to server
          send({ type: 'attack_fountain', direction: playerDirection, x: attackX, y: attackY });
        } else {
          // Normal attack
          send({ type: 'attack', direction: playerDirection });
        }

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
      if (k === 'l') {
        // Close inventory when 'l' is pressed
        e.preventDefault();
        inventoryVisible = false;
        return;
      } else if (k === 'w' || k === 'arrowup') {
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

        // Cancel pickup animation when moving
          if (isLocallyPickingUp) {
            isLocallyPickingUp = false;
            shouldStayInStand = false; // Don't stay in stand if we're moving
            if (localPickupTimeout) {
              clearTimeout(localPickupTimeout);
              localPickupTimeout = null;
            }
          }
        
        const currentTime = Date.now();
        if (currentTime - lastMoveTime < 100) return;
        
        const k = e.key.toLowerCase();
        let dx = 0, dy = 0, newDirection = null;
        
        if (k === 'arrowup' || k === 'w') { dy = -1; newDirection = 'up'; }
        else if (k === 'arrowdown' || k === 's') { dy = 1; newDirection = 'down'; }
        else if (k === 'arrowleft' || k === 'a') { dx = -1; newDirection = 'left'; }
        else if (k === 'arrowright' || k === 'd') { dx = 1; newDirection = 'right'; }
        
        if (dx || dy) {
          // Clear temporary sprite when moving
          clearTemporarySprite();

          // Clear fountain effect when moving
        fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));

          // Clear BRB state when moving
          if (isBRB) {
            isBRB = false;
            send({ type: 'set_brb', brb: false });
          }
          const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
          
          // Check for teleportation items first
          const targetItemId = getItemAtPosition(nx, ny);
          if (targetItemId === 42 || targetItemId === 338) {
            // Clear fountain effect when teleporting
            fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));
            
            // Calculate chain teleportation
            let currentX = nx;
            let currentY = ny;
            let teleportCount = 0;
            const maxTeleports = 10;
            
            // Keep teleporting until we land on a non-teleport tile or hit max teleports
            while (teleportCount < maxTeleports) {
              const currentItemId = getItemAtPosition(currentX, currentY);
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
              if (nextX >= 0 && nextY >= 0 && nextX < mapSpec.width && nextY < mapSpec.height) {
                currentX = nextX;
                currentY = nextY;
                teleportCount++;
              } else {
                // Can't teleport out of bounds, stop on current teleport tile
                break;
              }
            }
            
            // Clear any ongoing animations
            if (localAttackTimeout) {
              clearTimeout(localAttackTimeout);
              localAttackTimeout = null;
            }
            isLocallyAttacking = false;
            
            // Update direction for teleportation
            playerDirection = newDirection;
            // Don't update step for teleportation (as per requirements)
            
            localPlayer.direction = playerDirection;
            // Don't update position optimistically - let server be authoritative
            localPlayer.isAttacking = false;
            localPlayer.isMoving = false;
            
            lastMoveTime = currentTime;
            
            // Send teleport move to server
            send({ type: 'move', dx: dx, dy: dy, direction: playerDirection, teleport: true, finalX: currentX, finalY: currentY });
            
            // Reset stand flag when teleporting
            shouldStayInStand = false;
            
            // Clear pickup animation when teleporting
            if (isLocallyPickingUp) {
              isLocallyPickingUp = false;
              if (localPickupTimeout) {
                clearTimeout(localPickupTimeout);
                localPickupTimeout = null;
              }
            }
          } else if (canMoveTo(nx, ny, localPlayer.id)) {
            // Normal movement logic
            if (localAttackTimeout) {
              clearTimeout(localAttackTimeout);
              localAttackTimeout = null;
            }
            isLocallyAttacking = false;
            
            // Update direction and increment step
            playerDirection = newDirection;
            
            // Special case: if player just finished attacking, set step to 3
            if (justFinishedAttack) {
              playerStep = 3;
              justFinishedAttack = false; // Clear the flag
            } else {
              playerStep = playerStep === 3 ? 1 : playerStep + 1;
            }
            
            localPlayer.direction = playerDirection;
            localPlayer.step = playerStep;
            // Don't update position optimistically - let server be authoritative
            localPlayer.isAttacking = false;
            localPlayer.isMoving = true;
            
            lastMoveTime = currentTime;
            
            send({ type: 'move', dx, dy, direction: playerDirection });
          
            // Reset stand flag when actually moving
            shouldStayInStand = false;
            
            // Clear pickup animation when moving
            if (isLocallyPickingUp) {
              isLocallyPickingUp = false;
              if (localPickupTimeout) {
                clearTimeout(localPickupTimeout);
                localPickupTimeout = null;
              }
            }
          
            setTimeout(() => {
              if (localPlayer) {
                localPlayer.isMoving = false;
              }
            }, 200);
          } else {
            // Movement blocked - still increment step for visual feedback
            playerDirection = newDirection;
            
            // Special case: if player just finished attacking, set step to 3
            if (justFinishedAttack) {
              playerStep = 3;
              justFinishedAttack = false; // Clear the flag
            } else {
              playerStep = playerStep === 3 ? 1 : playerStep + 1;
            }
            
            localPlayer.direction = playerDirection;
            localPlayer.step = playerStep;
            
            lastMoveTime = currentTime;
            
            send({ type: 'move', dx, dy, direction: playerDirection });
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

      // Handle help area click (114,241 to 150,254)
      if (connected && loggedIn && mx >= 114 && mx <= 150 && my >= 241 && my <= 254) {
        showHelpControls();
        return;
      }
      // Handle clear chat area click (114,211 to 150,224)
      if (connected && loggedIn && mx >= 114 && mx <= 150 && my >= 211 && my <= 224) {
        clearChatMessages();
        return;
      }
      // Handle stats area click (74,196 to 110,209)
      if (connected && loggedIn && mx >= 74 && mx <= 110 && my >= 196 && my <= 209) {
        showPlayerStats();
        return;
      }
      // Handle buff area click (74,211 to 110,224)
      if (connected && loggedIn && mx >= 74 && mx <= 110 && my >= 211 && my <= 224) {
        // Show buff message (same as -buff command)
        if (localPlayer && localPlayer.hands && localPlayer.hands > 0) {
          const itemDetails = getItemDetails(localPlayer.hands);
          if (itemDetails && itemDetails.type === 'buff') {
            const buffMessage = `You hold a ${itemDetails.name}, which gives you a +${itemDetails.statMax || 0} buff to your ${itemDetails.statEffected || 'unknown'} regeneration.`;
            pushChat(buffMessage, 'cornflowerblue');
          } else {
            pushChat('No buffs currently active.', 'cornflowerblue');
          }
        } else {
          pushChat('No buffs currently active.', 'cornflowerblue');
        }
        return;
      }
      // Handle BRB area click (114,196 to 150,209)
      if (connected && loggedIn && mx >= 114 && mx <= 150 && my >= 196 && my <= 209) {
        toggleBRB();
        return;
      }

      // Handle chat scroll up click (135,382 to 151,390)
      if (connected && loggedIn && mx >= 135 && mx <= 151 && my >= 382 && my <= 390) {
        const maxVisibleLines = 7;
        const maxScrollUp = Math.max(0, messages.length - maxVisibleLines);
        chatScrollOffset = Math.min(chatScrollOffset + 1, maxScrollUp);
        return;
      }
      // Handle chat scroll down click (135,394 to 151,402)
      if (connected && loggedIn && mx >= 135 && mx <= 151 && my >= 394 && my <= 402) {
        chatScrollOffset = Math.max(chatScrollOffset - 1, 0);
        return;
      }

      // Handle movement quadrant clicks (only when logged in and playing)
      if (connected && loggedIn && localPlayer) {
        // Check if stamina is sufficient for movement
        if ((localPlayer.stamina ?? 0) <= 0) return;
        
        // Cancel pickup animation when moving
        if (isLocallyPickingUp) {
          isLocallyPickingUp = false;
          shouldStayInStand = false; // Don't stay in stand if we're moving
          if (localPickupTimeout) {
            clearTimeout(localPickupTimeout);
            localPickupTimeout = null;
          }
        }

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
          
          // Clear fountain effect when moving
          fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));

          // Use the same collision checking as keyboard movement
          if (canMoveTo(nx, ny, localPlayer.id)) {
            // Cancel attack animation on movement
            if (localAttackTimeout) {
              clearTimeout(localAttackTimeout);
              localAttackTimeout = null;
            }
            isLocallyAttacking = false;
            
            // Update direction and increment step
            playerDirection = newDirection;
            
            // Special case: if player just finished attacking, set step to 3
            if (justFinishedAttack) {
              playerStep = 3;
              justFinishedAttack = false; // Clear the flag
            } else {
              playerStep = playerStep === 3 ? 1 : playerStep + 1;
            }
            
            // Update local player object immediately
            localPlayer.direction = playerDirection;
            localPlayer.step = playerStep;
            localPlayer.pos_x = nx;
            localPlayer.pos_y = ny;
            localPlayer.isAttacking = false;
            localPlayer.isMoving = true;
            
            // Update last move time
            lastMoveTime = currentTime;
            
            // Send move command to server
            send({ type: 'move', dx, dy, direction: playerDirection });
            
            // Reset stand flag when actually moving
            shouldStayInStand = false;

            // Reset to standing after movement
            setTimeout(() => {
              if (localPlayer) {
                localPlayer.isMoving = false;
              }
            }, 200);
          } else {
            // Can't move but still update direction and animation for visual feedback
            playerDirection = newDirection;
            playerStep = playerStep === 3 ? 1 : playerStep + 1;
            localPlayer.direction = playerDirection;
            localPlayer.step = playerStep;
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

    const { img, w, h, yOffset } = meta;
    if (!img || !img.complete) return;

    // Top-left alignment with yOffset subtracted
    const drawX = sx;
    const drawY = sy - (yOffset || 0);

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
      
    // Draw BRB item (item 181) behind player if in BRB state
      const playerIsBRB = isLocal ? isBRB : (p.isBRB || false);
      if (playerIsBRB && window.itemsReady()) {
        drawItemAtTile(screenX, screenY-32, 181);
      }
      
      // Force sit animation if in BRB state
      if (playerIsBRB) {
        animFrame = 21; // 'sit' animation
      } else if (isLocal) {
        if (isLocallyPickingUp) {
          animFrame = 21; // 'sit' animation
        } else if (isLocallyAttacking) {
          const attackSeq = ATTACK_SEQUENCES[playerDirection] || ATTACK_SEQUENCES.down;
          animFrame = attackSeq[localAttackState];
        } else {
          // Use getCurrentAnimationFrame for local player to handle resting states
          animFrame = getCurrentAnimationFrame(localPlayer, true);
          
          // Fallback to direction/step if no special animation frame
          if (animFrame === null || animFrame === undefined) {
            // Check if we should stay in stand animation (after pickup and not moving)
            if (shouldStayInStand && !localPlayer.isMoving) {
              animFrame = 20; // Stay in 'stand' animation
            } else {
              animFrame = getAnimationFrameFromDirectionAndStep(playerDirection, playerStep);
            }
          }
        }
      } else {
        animFrame = getCurrentAnimationFrame(p, false);
      }
      
      // Check for temporary sprite first
      if (p.temporarySprite && p.temporarySprite > 0 && window.itemsReady()) {
        const meta = window.getItemMeta(p.temporarySprite);
        if (meta && meta.img && meta.img.complete) {
          const { img, yOffset } = meta;
          const drawX = screenX;
          const drawY = screenY - (yOffset || 0);
          ctx.drawImage(img, drawX, drawY);
        }
      } else if (playerSpritesReady && playerSprites[animFrame] && playerSprites[animFrame].complete) {
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

    function drawEnemy(enemy, screenX, screenY) {
      if (!enemy || !enemySpritesReady) return;
      
      // Get the sprite ID for this enemy's current animation
      const spriteId = getEnemySpriteId(enemy.enemy_type, enemy.direction || 'down', enemy.step || 1);
      
      if (enemySprites[spriteId] && enemySprites[spriteId].complete && enemySpriteMeta[spriteId]) {
        const sprite = enemySprites[spriteId];
        const meta = enemySpriteMeta[spriteId];
        
        // Calculate offsets as specified in requirements
        const x_offset = (62 - meta.w) / 2;
        const y_offset = (32 - meta.h) - 5; // Render 5 pixels higher
        
        const drawX = screenX + x_offset;
        const drawY = screenY + y_offset;
        
        ctx.drawImage(sprite, drawX, drawY, meta.w, meta.h);
      } else {
        // Fallback: draw a simple colored circle for enemies
        ctx.fillStyle = '#FF4500'; // Orange color for enemies
        ctx.beginPath();
        ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 10, 12, 0, 0, Math.PI*2);
        ctx.fill();
      }
    }

    function drawBarsAndStats() {
      if (!loggedIn || !localPlayer) return;
      const topY = 19, bottomY = 135, span = bottomY - topY;

      // Stamina bar with color based on percentage
      const sPct = Math.max(0, Math.min(1, (localPlayer.stamina ?? 0) / Math.max(1, (localPlayer.max_stamina ?? 1))));
      const sFillY = topY + (1 - sPct) * span;
      const staminaPercent = sPct * 100;
      
      // Determine stamina bar color based on percentage
      let staminaColor;
      if (staminaPercent >= 50) {
        staminaColor = '#0000ff'; // Blue for 50-100%
      } else if (staminaPercent >= 25) {
        staminaColor = '#ffff00'; // Yellow for 25-49%
      } else {
        staminaColor = '#ff0000'; // Red for 0-24%
      }
      
      ctx.fillStyle = staminaColor; 
      ctx.fillRect(187, sFillY, 13, bottomY - sFillY);

      // HP bar (now green like the old stamina bar)
      const lPct = Math.max(0, Math.min(1, (localPlayer.life ?? 0) / Math.max(1, (localPlayer.max_life ?? 1))));
      const lFillY = topY + (1 - lPct) * span;
      ctx.fillStyle = '#00ff00'; ctx.fillRect(211, lFillY, 13, bottomY - lFillY);

      const mx = 177, my = 247;
      const mCur = localPlayer.magic ?? 0, mMax = localPlayer.max_magic ?? 0;
      ctx.font = '14px monospace'; ctx.textAlign = 'left';
      ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(`${mCur}/${mMax}`, mx, my);
      ctx.fillStyle = 'yellow'; ctx.fillText(`${mCur}/${mMax}`, mx, my);
      ctx.lineWidth = 1;

      const gold = localPlayer.gold ?? 0;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center'; // Center the text
      ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(String(gold), 194, 273);
      ctx.fillStyle = 'white'; ctx.fillText(String(gold), 194, 273);
      ctx.lineWidth = 1;
      ctx.textAlign = 'left'; // Reset text alignment
    }

    function drawChatHistory() {
      const { x1,y1,x2,y2,pad } = CHAT;
      const w = x2 - x1;
      ctx.font = 'bold 12px "Times New Roman", serif'; ctx.textAlign = 'left';
      const lineH = 16;
      let y = y2 - pad;
      
      // Calculate visible messages based on scroll offset
      const maxVisibleLines = 7;
      const startIndex = Math.max(0, messages.length - maxVisibleLines - chatScrollOffset);
      const endIndex = Math.max(0, messages.length - chatScrollOffset);
      
      for (let i = endIndex - 1; i >= startIndex; i--) {
        const msg = messages[i];
        let line = typeof msg === 'string' ? msg : msg.text;
        let colorName = typeof msg === 'string' ? 'black' : (msg.color || 'black');
        
        // Convert color names to specific RGB values
        let color;
        switch (colorName) {
          case 'gold': color = 'rgb(145,141,58)'; break;
          case 'cornflowerblue': color = 'rgb(0,162,232)'; break;
          case 'blue': color = 'rgb(0,35,245)'; break;
          case 'signblue': color = 'rgb(0,35,45)'; break;
          case 'red': color = 'red'; break;
          case 'purple': color = 'rgb(128,0,128)'; break;
          case 'pink': color = 'rgb(185,114,164)'; break;
          case 'grey': color = 'grey'; break;
          default: color = 'black'; break;
        }
        
        while (ctx.measureText(line).width > w - pad*2 && line.length > 1) line = line.slice(0, -1);
        
        ctx.fillStyle = color;
        ctx.fillText(line, x1 + pad, y);
        y -= lineH;
        if (y < y1 + pad) break;
      }
      
      // Draw scroll indicator if there are more messages than can be displayed
      const totalLines = messages.length;
      if (totalLines > maxVisibleLines) {
        const scrollBarX = x2 - 8;
        const scrollBarY = y1 + 5;
        const scrollBarH = (y2 - y1) - 10;
        
        // Draw scroll track
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.strokeRect(scrollBarX, scrollBarY, 6, scrollBarH);
        
        // Calculate scroll thumb position and size
        const thumbHeight = Math.max(10, (maxVisibleLines / totalLines) * scrollBarH);
        const maxScrollOffset = totalLines - maxVisibleLines;
        const thumbY = scrollBarY + ((maxScrollOffset - chatScrollOffset) / maxScrollOffset) * (scrollBarH - thumbHeight);
        
        // Draw scroll thumb
        ctx.fillStyle = '#999';
        ctx.fillRect(scrollBarX + 1, thumbY, 4, thumbHeight);
      }
    }
    
    function drawChatInput() {
      if (!chatMode) return;
      
      // Draw yellow border rectangle when typing
      ctx.strokeStyle = 'yellow';
      ctx.lineWidth = 1;
      ctx.strokeRect(156, 411, 462, 42);
      
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

    const { img, yOffset } = meta;
    
    // Top-left alignment with yOffset subtracted
    const drawX = x;
    const drawY = y - (yOffset || 0);

    ctx.drawImage(img, drawX, drawY);
  }

  function drawItemInInventorySlot(itemId, slotX, slotY, slotW, slotH) {
    if (!window.getItemMeta || !window.itemsReady() || !itemId || itemId === 0) return;
    const meta = window.getItemMeta(itemId);
    if (!meta || !meta.img || !meta.img.complete) return;

    const { img, yOffset } = meta;
    
    // Top-left alignment with yOffset subtracted, plus additional 6 pixel offset
    const drawX = slotX;
    const drawY = slotY - (yOffset || 0) + 6;
    
    ctx.drawImage(img, drawX, drawY);
  }

  function drawInventory() {
    if (!inventoryVisible) return;
    
    // Draw inventory background
    ctx.fillStyle = 'rgba(0, 133, 182, 0.5)';
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

  function drawNPCDialog() {
    if (!npcInteraction) return;
    
    const npcDetails = npcInteraction.npcDetails;
    const stage = npcInteraction.stage || 'main';
    
    const { x, y, width, height, backgroundColor, borderColor, textColor, lineHeight, padding } = NPC_DIALOG;
    
    // Draw background rectangle with transparency (same as inventory)
    ctx.fillStyle = 'rgba(0, 133, 182, 0.85)'; // Same transparency as inventory
    ctx.fillRect(x, y, width, height);
    
    // Draw border
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    ctx.lineWidth = 1;
    
    // Draw text content
    ctx.fillStyle = textColor;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    
    let currentY = y + padding + 12; // Start position for text
    
    if (stage === 'main') {
      // Draw main interaction (question/response)
      drawNPCMainDialog(npcDetails, x, y, width, height, textColor, lineHeight, padding);
    } else if (stage === 'buy') {
      // Draw shop buy interface
      drawNPCShopDialog(npcDetails, x, y, width, height, textColor, lineHeight, padding, 'buy');
    } else if (stage === 'sell') {
      // Draw shop sell interface
      drawNPCShopDialog(npcDetails, x, y, width, height, textColor, lineHeight, padding, 'sell');
    }
  }

  function drawNPCMainDialog(npcDetails, x, y, width, height, textColor, lineHeight, padding) {
    let currentY = y + padding + 12; // Start position for text
    
    // Draw NPC name
    if (npcDetails.name) {
      ctx.fillText(npcDetails.name, x + padding, currentY);
      currentY += lineHeight;
      
      // Draw horizontal line directly under name
      ctx.strokeStyle = textColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + padding, currentY - 11);
      ctx.lineTo(x + width - padding, currentY - 11);
      ctx.stroke();
      currentY += 8; // Gap after line before description
    }
    
    // Draw description with word wrapping
    if (npcDetails.description) {
      const maxWidth = width - (padding * 2);
      const words = npcDetails.description.split(' ');
      let line = '';
      let lineCount = 0;
      const maxLines = 2;
      
      for (let i = 0; i < words.length && lineCount < maxLines; i++) {
        const testLine = line + words[i] + ' ';
        const testWidth = ctx.measureText(testLine).width;
        
        if (testWidth > maxWidth && line !== '') {
          // Draw current line and start new one
          ctx.fillText(line.trim(), x + padding, currentY + (lineCount * lineHeight));
          line = words[i] + ' ';
          lineCount++;
        } else {
          line = testLine;
        }
      }
      
      // Draw the last line if there's content and we haven't exceeded max lines
      if (line.trim() !== '' && lineCount < maxLines) {
        ctx.fillText(line.trim(), x + padding, currentY + (lineCount * lineHeight));
        lineCount++;
      }
      
      currentY += (lineCount * lineHeight) + 10; // Space after description
    }
    
    // Draw questions with proper spacing
    let questionY = currentY;
    
    if (npcDetails.question_1 && npcDetails.question_1.trim() !== '') {
      ctx.fillText(npcDetails.question_1, x + padding, questionY);
      questionY += lineHeight;
    }
    if (npcDetails.question_2 && npcDetails.question_2.trim() !== '') {
      ctx.fillText(npcDetails.question_2, x + padding, questionY);
      questionY += lineHeight;
    }
    if (npcDetails.question_3 && npcDetails.question_3.trim() !== '') {
      ctx.fillText(npcDetails.question_3, x + padding, questionY);
      questionY += lineHeight;
    }
    if (npcDetails.question_4 && npcDetails.question_4.trim() !== '') {
      ctx.fillText(npcDetails.question_4, x + padding, questionY);
      questionY += lineHeight;
    }
  }

  function drawNPCShopDialog(npcDetails, x, y, width, height, textColor, lineHeight, padding, shopType) {
    let currentY = y + padding + 12;
    
    // Draw table headers
    const valueColumnX = x + (width * 0.75); // 75% across the dialog
    
    ctx.fillText(`Item to ${shopType === 'buy' ? 'Buy' : 'Sell'}`, x + padding, currentY);
    ctx.fillText('Value', valueColumnX, currentY);
    
    // Move horizontal line up more and adjust currentY
    const headerLineY = currentY + 5; // Move line up closer to headers
    currentY = headerLineY + 15; // Start items closer to the line
    
    // Draw horizontal line under headers
    ctx.strokeStyle = textColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + padding, headerLineY);
    ctx.lineTo(x + width - padding, headerLineY);
    ctx.stroke();
    
    // Draw vertical line for column separator from top to bottom of NPC screen
    ctx.beginPath();
    ctx.moveTo(valueColumnX - 5, y + padding);
    ctx.lineTo(valueColumnX - 5, y + height - padding);
    ctx.stroke();
    
    // Draw shop items with 32px vertical spacing
    for (let i = 1; i <= 4; i++) {
      const itemKey = `${shopType}_item_${i}`;
      const priceKey = `${shopType}_price_${i}`;
      
      const itemId = npcDetails[itemKey] || 0;
      const price = npcDetails[priceKey] || 0;
      
      if (itemId > 0) {
        const itemDetails = getItemDetails(itemId);
        if (itemDetails) {
          // Draw item number to the left of the image with y:-16 offset
          ctx.fillText(`${i}.`, x + padding, currentY + 16 - 16); // y:-16 offset
          
          // Draw item image if available (original size, no scaling) with x:-16, y:-20 offset
          const imageX = x + padding + 20; // Space after number
          const imageY = currentY; // Image Y position
          if (window.getItemMeta && window.itemsReady()) {
            const meta = window.getItemMeta(itemId);
            if (meta && meta.img && meta.img.complete) {
              // Draw at original size with x:-16, y:-20 offset
              const originalWidth = meta.img.naturalWidth || meta.img.width;
              const originalHeight = meta.img.naturalHeight || meta.img.height;
              ctx.drawImage(meta.img, imageX - 16, imageY - 20, originalWidth, originalHeight);
            }
          }
          
          // Draw item name to the right of the image with y:-16 offset
          let itemText = itemDetails.name;
          const nameX = imageX + 35; // Space after image
          const maxTextWidth = (valueColumnX - 10) - nameX; // Leave space before value column
          while (ctx.measureText(itemText).width > maxTextWidth && itemText.length > 10) {
            itemText = itemText.slice(0, -1);
          }
          ctx.fillText(itemText, nameX, currentY + 16 - 16); // y:-16 offset
          
          // Draw price with y:-16 offset
          ctx.fillText(`${price}`, valueColumnX, currentY + 16 - 16); // y:-16 offset
          
          // Draw gold pile image with x:-23, y:-24 offset
          if (window.getItemMeta && window.itemsReady()) {
            const goldMeta = window.getItemMeta(25);
            if (goldMeta && goldMeta.img && goldMeta.img.complete) {
              // Draw at original size with x:-23, y:-24 offset
              const goldOriginalWidth = goldMeta.img.naturalWidth || goldMeta.img.width;
              const goldOriginalHeight = goldMeta.img.naturalHeight || goldMeta.img.height;
              ctx.drawImage(goldMeta.img, valueColumnX + 30 - 23, currentY + 16 - (goldOriginalHeight / 2) - 24, goldOriginalWidth, goldOriginalHeight);
            }
          }
          
          currentY += 32; // Move down for next item
        }
      }
    }
    
    // Add "5. Return to main menu" option at bottom center with new color and black background
    currentY += 20; // Space before return option
    const returnText = '5. Return to main menu';
    const returnTextWidth = ctx.measureText(returnText).width;
    const centerX = x + (width / 2) - (returnTextWidth / 2);
    const returnTextY = currentY - 16 + 14; // y:-16 then y:+14 offset
    
    // Draw black background for text (like player names)
    ctx.fillStyle = 'black';
    ctx.fillRect(centerX - 2, returnTextY - 12, returnTextWidth + 4, 14);
    
    // Draw the text with new green color
    ctx.fillStyle = 'rgb(34, 177, 76)'; // New green color
    ctx.fillText(returnText, centerX, returnTextY);
    ctx.fillStyle = textColor; // Reset to yellow
  }

    // ---------- SCENES ----------
    function drawConnecting() {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      if (!showLoginGUI) {
        if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
        else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
        
        // Only show text after we've started connecting
        if (connectionAttempted) {
          ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
          if (connectionPaused) ctx.fillText('Press any key to enter!', 47, 347);
          else if (connected) ctx.fillText('Connecting to server...', 47, 347);
          else ctx.fillText('Connecting to server...', 47, 347);
        }
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
        // Only render players on the same map as local player
        if (Number(p.map_id) === Number(localPlayer.map_id)) {
          const k = `${p.pos_x},${p.pos_y}`;
          (playersByTile[k] ||= []).push(p);
        }
      }

      if (tilesReady && mapReady && window.itemsReady()) {
        for (let y = 0; y < mapSpec.height; y++) {
          for (let x = 0; x < mapSpec.width; x++) {
            const { screenX, screenY } = isoScreen(x, y);

            const effectiveItemId = getItemAtPosition(x, y);
            
            if (effectiveItemId > 0) {
              drawItemAtTile(screenX, screenY, effectiveItemId);
            }

            // Draw enemies after items but before players
            for (const [enemyId, enemy] of Object.entries(enemies)) {
              if (enemy.pos_x === x && enemy.pos_y === y) {
                drawEnemy(enemy, screenX, screenY);
              }
            }

        // Draw fountain healing effects on players
        if (window.itemsReady()) {
          const currentTime = Date.now();
          fountainEffects = fountainEffects.filter(effect => {
            const elapsed = currentTime - effect.startTime;
            if (elapsed < 1000) { // Show for 1 second
              // Find the player with this ID
              let targetPlayer = null;
              if (localPlayer && localPlayer.id === effect.playerId) {
                targetPlayer = localPlayer;
              } else if (otherPlayers[effect.playerId] && Number(otherPlayers[effect.playerId].map_id) === Number(localPlayer.map_id)) {
                targetPlayer = otherPlayers[effect.playerId];
              }
              
              if (targetPlayer) {
                const { screenX, screenY } = isoScreen(targetPlayer.pos_x, targetPlayer.pos_y);
                const meta = window.getItemMeta(309);
                if (meta && meta.img && meta.img.complete) {
                  const { img, yOffset } = meta;
                  const drawX = screenX;
                  const drawY = screenY - (yOffset || 0);
                  ctx.drawImage(img, drawX, drawY);
                }
              }
              return true; // Keep effect
            }
            return false; // Remove effect
          });
        }

            const k = `${x},${y}`;
            const arr = playersByTile[k];
            if (arr && arr.length) {
              for (const p of arr) drawPlayer(p, !!p.__isLocal);
            }

            // Draw spells after players (renders item 289 for fire pillars)
            for (const [spellId, spell] of Object.entries(spells)) {
              if (spell.currentX === x && spell.currentY === y && spell.mapId === localPlayer.map_id) {
                drawItemAtTile(screenX, screenY, spell.itemId);
              }
            }

            // Draw electrocute effects after spells (renders item 291 for electrocute)
            for (const [effectId, effect] of Object.entries(electrocuteEffects)) {
              if (effect.x === x && effect.y === y) {
                drawItemAtTile(screenX, screenY, 291);
              }
            }

            // Draw healing effects after electrocute effects (renders item 309 for healing)
            for (const [effectId, effect] of Object.entries(healingEffects)) {
              if (effect.x === x && effect.y === y) {
                drawItemAtTile(screenX, screenY, 309);
              }
            }

            // Draw silver mist effects after healing effects (renders item 290 for silver mist)
            for (const [effectId, effect] of Object.entries(silverMistEffects)) {
              if (effect.x === x && effect.y === y) {
                drawItemAtTile(screenX, screenY, 290);
              }
            }
          }
        }
      }

      if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
      else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

      // Draw stand sprite at position 13,198 after game border
      if (playerSpritesReady && playerSprites[20] && playerSprites[20].complete) {
        ctx.drawImage(playerSprites[20], 13, 198);
      }

      drawBarsAndStats();
      
      // Draw focus warning if window is not focused (after HP/stamina bars)
      if (!windowFocused && loggedIn) {
        ctx.font = 'bold 14px "Times New Roman", serif';
        ctx.fillStyle = 'yellow';
        ctx.textAlign = 'left';
        ctx.fillText('*Warning* The window is not in focus. Click to regain focus.', 10, 15);
      }
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

      // Draw NPC dialog (on top of everything but below inventory)
      drawNPCDialog();
      
      // Draw inventory last (on top of everything)
      drawInventory();
      
      // Draw loading screen absolutely last (on top of everything including inventory)
      drawLoadingScreen();
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

    function showLoadingScreen(loadingScreenData) {
      if (!loadingScreenData || !loadingScreenData.imagePath) {
        console.log('Loading screen data missing:', loadingScreenData);
        return;
      }
      
      console.log('Attempting to show loading screen:', loadingScreenData);
      
      // Create and load the loading screen image
      if (!loadingScreenImage) {
        loadingScreenImage = new Image();
      }
      
      loadingScreenImage.onload = () => {
        console.log('Loading screen image loaded successfully');
        // Set loading screen state
        loadingScreenActive = true;
        loadingScreenX = loadingScreenData.x || 232;
        loadingScreenY = loadingScreenData.y || 20;
        loadingScreenEndTime = Date.now() + (loadingScreenData.duration || 200);
        console.log('Loading screen activated:', {
          active: loadingScreenActive,
          x: loadingScreenX,
          y: loadingScreenY,
          endTime: loadingScreenEndTime
        });
      };
      
      loadingScreenImage.onerror = () => {
        console.error('Failed to load loading screen image:', loadingScreenData.imagePath);
      };
      
      // Set the image source to start loading
      loadingScreenImage.src = loadingScreenData.imagePath;
      console.log('Loading screen image source set:', loadingScreenData.imagePath);
    }

    function drawLoadingScreen() {
      // Check if loading screen should be active
      if (!loadingScreenActive || !loadingScreenImage || !loadingScreenImage.complete) {
        if (loadingScreenActive) {
          console.log('Loading screen active but image not ready:', {
            active: loadingScreenActive,
            hasImage: !!loadingScreenImage,
            imageComplete: loadingScreenImage ? loadingScreenImage.complete : false
          });
        }
        return;
      }
      
      // Check if duration has expired
      if (Date.now() >= loadingScreenEndTime) {
        console.log('Loading screen duration expired, deactivating');
        loadingScreenActive = false;
        return;
      }
      
      // Draw the loading screen image on top of everything
      console.log('Drawing loading screen at:', loadingScreenX, loadingScreenY);
      ctx.drawImage(loadingScreenImage, loadingScreenX, loadingScreenY);
    }

    function showHelpControls() {
      pushChat("[*] DragonSpires - Controls [*]");
      pushChat("- WASD or Arrow Keys to Move");
      pushChat("- TAB key to Attack");
      pushChat("- 'G' key to pick-up / drop an item, 'U' to use an item");
      pushChat("- 'T' key to equip a weapon in your hand, 'Y' for armor");
      pushChat("- 'I' key to open / close your inventory");
      pushChat("- 'C' key to swap an item from your inventory to your hand");
    }

    function clearChatMessages() {
      messages = [];
    }

    function showPlayerStats() {
      if (!localPlayer) return;
      
      pushChat("[*] Player Stats [*]");
      
      // Get weapon stats
      let weaponStats = "None";
      if (localPlayer.weapon && localPlayer.weapon > 0) {
        const weaponDetails = getItemDetails(localPlayer.weapon);
        if (weaponDetails) {
          weaponStats = `${weaponDetails.statMin}-${weaponDetails.statMax} damage`;
        }
      }
      
      // Get armor stats
      let armorStats = "None";
      if (localPlayer.armor && localPlayer.armor > 0) {
        const armorDetails = getItemDetails(localPlayer.armor);
        if (armorDetails) {
          armorStats = `${armorDetails.statMin}-${armorDetails.statMax} defense`;
        }
      }
      
      pushChat(`Weapon: ${weaponStats}`);
      pushChat(`Armor: ${armorStats}`);
      pushChat(`Life: ${localPlayer.life || 0} / ${localPlayer.max_life || 0}`);
      pushChat(`Stamina: ${localPlayer.stamina || 0} / ${localPlayer.max_stamina || 0}`);
      pushChat(`Magic: ${localPlayer.magic || 0} / ${localPlayer.max_magic || 0}`);
    }

    function clearTemporarySprite() {
      if (temporarySprite !== 0) {
        temporarySprite = 0;
        if (localPlayer) {
          localPlayer.temporarySprite = 0;
          send({ type: 'temporary_sprite_update', temporarySprite: 0 });
        }
      }
    }

    function toggleBRB() {
      // Clear temporary sprite when toggling BRB
      clearTemporarySprite();

      // Clear fountain effect when toggling BRB
      fountainEffects = fountainEffects.filter(effect => effect.playerId !== (localPlayer ? localPlayer.id : null));

      isBRB = !isBRB;
      if (isBRB) {
        // Clear any ongoing animations when going BRB
        if (localAttackTimeout) {
          clearTimeout(localAttackTimeout);
          localAttackTimeout = null;
        }
        if (localPickupTimeout) {
          clearTimeout(localPickupTimeout);
          localPickupTimeout = null;
        }
        isLocallyAttacking = false;
        isLocallyPickingUp = false;
        shouldStayInStand = false;
        
        // Send BRB state to server
        send({ type: 'set_brb', brb: true });
      } else {
        // Send un-BRB state to server
        send({ type: 'set_brb', brb: false });
      }
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
            description: item[5],
            statEffected: item[6] || null,
            useMessage: item[7] || null
          }));
          itemDetailsReady = true;
          console.log(`Client loaded ${itemDetails.length} item details`);
          // Debug: Show first few items
          console.log('Sample items:', itemDetails.slice(0, 5));
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
                description: item[5],
                statEffected: item[6] || null,
                useMessage: item[7] || null
              }));
              itemDetailsReady = true;
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
                    description: item[5],
                    statEffected: item[6] || null,
                    useMessage: item[7] || null
                  }));
                  itemDetailsReady = true;
                }
              })
              .catch(err3 => {
                itemDetailsReady = true;
                console.warn('Failed to load item details from all paths');
              });
          });
      });
  });
