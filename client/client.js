// client.js
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

  // Item fine-tuning (center on tile a bit better)
  const ITEM_X_NUDGE = 0;//3;   // +right
  const ITEM_Y_NUDGE = 0;//15;  // +up (we subtract this in draw)


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

  // Map
  let mapSpec = { width: 10, height: 10, tiles: [] };

  // Auth GUI
  let usernameStr = "";
  let passwordStr = "";
  let activeField = null;

  // Players
  let localPlayer = null;
  let otherPlayers = {};

  // Chat
  let messages = [];
  let typingBuffer = "";

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

  // Player sprite: crop + **magenta** -> transparent
  const imgPlayerSrc = new Image();
  imgPlayerSrc.src = "/assets/player.gif";
  let playerSprite = null;
  imgPlayerSrc.onload = () => {
    try {
      const sx = 264, sy = 1, sw = 44, sh = 55;
      const off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      const octx = off.getContext('2d');
      octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);
      const data = octx.getImageData(0,0,sw,sh);
      for (let i = 0; i < data.data.length; i += 4) {
        const r = data.data[i], g = data.data[i+1], b = data.data[i+2];
        if (r === 255 && g === 0 && b === 255) data.data[i+3] = 0; // magenta
      }
      octx.putImageData(data, 0, 0);
      const img = new Image();
      img.src = off.toDataURL();
      playerSprite = img;
    } catch {
      playerSprite = imgPlayerSrc;
    }
  };
  // --- NEW: Extract *all* player frames from player.gif using /assets/player.json ---
let playerFrames = []; // 0..21 (22 frames)
const AnimIndex = {
  down_walk_1:0, down:1, down_walk_2:2, down_attack_1:3, down_attack_2:4,
  right_walk_1:5, right:6, right_walk_2:7, right_attack_1:8, right_attack_2:9,
  left_walk_1:10, left:11, left_walk_2:12, left_attack_1:13, left_attack_2:14,
  up_walk_1:15, up:16, up_walk_2:17, up_attack_1:18, up_attack_2:19,
  stand:20, sit:21
};
function idleIndexForDir(dir) {
  switch (dir) {
    case 'down': return AnimIndex.down;   // 2
    case 'left': return AnimIndex.left;   // 12
    case 'up':   return AnimIndex.up;     // 17
    case 'right':
    default:     return AnimIndex.right;  // 7 (default)
  }
}
// Wait helper
function waitImage(img) { return new Promise(r => { if (img.complete) r(); else { img.onload = r; img.onerror = r; } }); }

Promise.all([
  waitImage(imgPlayerSrc),
  fetch('/assets/player.json').then(r => r.json()).catch(() => null)
]).then(([_, meta]) => {
  if (!meta || !Array.isArray(meta.knight)) return;
  const list = meta.knight; // array of [x, y, w, h] in the given order (1..22)

  // Use first frame as the baseline to align bottoms and center frames
  const baseW = list[0][2], baseH = list[0][3];

  const off = document.createElement('canvas');
  const octx = off.getContext('2d');

  playerFrames = list.map(([sx, sy, sw, sh]) => {
    off.width = sw; off.height = sh;
    octx.clearRect(0, 0, sw, sh);
    octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);

    // True magenta -> transparent
    try {
      const data = octx.getImageData(0, 0, sw, sh);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
    } catch {}

    const img = new Image();
    img.src = off.toDataURL();

    return {
      img, w: sw, h: sh,
      // horizontally center each varying width around the same anchor;
      // align bottoms using the first frame as baseline:
      offsetX: Math.round((baseW - sw) / 2),
      offsetY: Math.round(baseH - sh)
    };
  });
});

  
  // Floor tiles from /assets/floor.png: 9 rows x 11 columns, each 61x31, with 1px shared border
  const imgFloor = new Image();
  imgFloor.src = "/assets/floor.png";
  let floorTiles = []; // 1-based indexing
  imgFloor.onload = async () => {
    try {
      const sheetW = imgFloor.width;
      const sheetH = imgFloor.height;
      const tileW = 61, tileH = 31;
      const stepX = 63; // 61 + (1px right border + 1px left border shared) => observed from provided coords
      const stepY = 33; // 31 + shared borders
      const cols = 9;   // per your sample wording: 9 per row
      const rows = 11;  // and 11 rows

      const off = document.createElement('canvas');
      off.width = sheetW; off.height = sheetH;
      const octx = off.getContext('2d');
      octx.drawImage(imgFloor, 0, 0);

      let idCounter = 1;
      const loadPromises = [];

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const sx = 1 + col * stepX;
          const sy = 1 + row * stepY;

          const tcan = document.createElement('canvas');
          tcan.width = tileW; tcan.height = tileH;
          const tctx = tcan.getContext('2d');
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

      // load map AFTER tiles are ready
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
        const data = octx.getImageData(0, 0, sw, sh);
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

        octx.putImageData(data, 0, 0);
      } catch {
        leftPad = 0; // fallback if canvas is tainted (shouldn't be here)
      }

      // Bottom-center anchor inside the sprite (relative to left edge)
      // Rightmost opaque column is at sw - 1 (bottom-right justified),
      // so center between leftPad and (sw - 1).
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



  // ---------- WS ----------
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      connected = true;
      connectionPaused = true;
      showLoginGUI = false;
    };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      handleServerMessage(data);
    };
    ws.onerror = (e) => console.error('WS error', e);
    ws.onclose = () => {
      connected = false;
      connectionPaused = false;
      showLoginGUI = false;
      loggedIn = false;
      chatMode = false;
      localPlayer = null;
      otherPlayers = {};
    };
  }
  connectToServer();

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function pushChat(line) { messages.push(String(line)); if (messages.length > 200) messages.shift(); }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success': {
        loggedIn = true;
        localPlayer = { ...msg.player };
        localPlayer.dir = localPlayer.dir || 'right'; // NEW: default facing right
        otherPlayers = {};
        if (Array.isArray(msg.players)) msg.players.forEach(p => { if (!localPlayer || p.id !== localPlayer.id) otherPlayers[p.id] = p; });
        pushChat("Welcome to DragonSpires!");
        break;
      }
      case 'player_joined':
        if (!localPlayer || msg.player.id !== localPlayer.id) {
          otherPlayers[msg.player.id] = msg.player;
          pushChat(`${msg.player.username || msg.player.id} has entered DragonSpires!`);
        }
        break;
      case 'player_moved':
        if (localPlayer && msg.id === localPlayer.id) { localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y; }
        else {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}`, pos_x: msg.x, pos_y: msg.y };
          else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
        }
        break;
      case 'player_left': {
        const p = otherPlayers[msg.id];
        const name = p?.username ?? msg.id;
        if (!localPlayer || msg.id !== localPlayer.id) pushChat(`${name} has left DragonSpires.`);
        delete otherPlayers[msg.id];
        break;
      }
      case 'chat':
        if (typeof msg.text === 'string') pushChat(msg.text);
        break;
      case 'chat_error':
        pushChat('~ The game has rejected your message due to bad language.');
        break;
      case 'stats_update': {
        const apply = (obj) => {
          if (!obj) return;
          if ('stamina' in msg) obj.stamina = msg.stamina;
          if ('life' in msg) obj.life = msg.life;
          if ('magic' in msg) obj.magic = msg.magic;
        };
        if (localPlayer && msg.id === localPlayer.id) apply(localPlayer);
        else if (otherPlayers[msg.id]) apply(otherPlayers[msg.id]);
        break;
      }
      case 'login_error':
      case 'signup_error':
        pushChat(msg.message || 'Auth error');
        break;
      default: break;
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
      if (e.key === 'Backspace') {
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

    // Movement (stamina gate; **1** per move)
    if (loggedIn && localPlayer) {
      if ((localPlayer.stamina ?? 0) <= 0) return;
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0;
       if (k === 'arrowup' || k === 'w')       { dy = -1; newDir = 'up'; }
        else if (k === 'arrowdown' || k === 's'){ dy = 1;  newDir = 'down'; }
        else if (k === 'arrowleft' || k === 'a'){ dx = -1; newDir = 'left'; }
        else if (k === 'arrowright' || k === 'd'){ dx = 1; newDir = 'right'; }
      if (dx || dy) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
          localPlayer.stamina = Math.max(0, (localPlayer.stamina ?? 0) - 1); // 1 per move
          localPlayer.pos_x = nx; localPlayer.pos_y = ny;
          send({ type: 'move', dx, dy });
        }
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (chatMode) return;

    if (connected && showLoginGUI && !loggedIn) {
      const u = GUI.username, p = GUI.password, lb = GUI.loginBtn, sb = GUI.signupBtn;
      const uTop = FIELD_TOP(u.y), uBottom = uTop + u.h;
      const pTop = FIELD_TOP(p.y), pBottom = pTop + p.h;

      if (mx >= u.x && mx <= u.x + u.w && my >= uTop && my <= uBottom) { activeField = 'username'; return; }
      else if (mx >= p.x && mx <= p.x + p.w && my >= pTop && my <= pBottom) { activeField = 'password'; return; }
      else if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
      else if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) { send({ type: 'signup', username: usernameStr, password: passwordStr }); return; }
      activeField = null;
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
    // Use extracted tile if available; center 61x31 inside 64x32 diamond
    if (t > 0 && floorTiles[t]) {
      ctx.drawImage(floorTiles[t], sx + 2, sy + 1, 61, 31);
    } else {
      // fallback diamond
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
  if (!window.getItemMeta) return;
  const meta = window.getItemMeta(itemIndex);
  if (!meta) return;

  const { img, w, h, anchorX } = meta;
  if (!img || !img.complete) return;

  // Tile center (contact point on the ground plane)
  const cx = sx + TILE_W / 2;
  const cy = sy + TILE_H / 2;

  // Place the sprite so its bottom-center of opaque content
  // sits on the tile center.
  const drawX = Math.round(cx - anchorX);
  const drawY = Math.round(cy - h);

  ctx.drawImage(img, drawX, drawY);
}


  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    // Name centered, adjusted x:-2, y:-14 from previous baseline
    const nameX = screenX + TILE_W / 2 - 2;
    const nameY = screenY - 34; // (-20 - 14)
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nameX, nameY);
    ctx.lineWidth = 1;

   const drawX = screenX + PLAYER_OFFSET_X + SPRITE_CENTER_ADJ_X;
const drawY = screenY + PLAYER_OFFSET_Y + SPRITE_CENTER_ADJ_Y;

// NEW: choose idle frame based on direction if JSON frames are ready
let usedJsonFrame = false;
if (Array.isArray(playerFrames) && playerFrames.length === 22) {
  const dir = (p.dir || 'right');
  const idx = idleIndexForDir(dir); // 2:down, 7:right, 12:left, 17:up (0-based: 1,6,11,16)
  const frame = playerFrames[idx];
  if (frame && frame.img && frame.img.complete && frame.img.naturalWidth > 0) {
    // align varying sizes: bottoms aligned, horizontal center matched
    ctx.drawImage(frame.img, drawX + frame.offsetX, drawY + frame.offsetY, frame.w, frame.h);
    usedJsonFrame = true;
  }
}
if (!usedJsonFrame) {
  // Fallback to existing single sprite (unchanged)
  if (playerSprite && playerSprite.complete) {
    const w = playerSprite.naturalWidth || playerSprite.width;
    const h = playerSprite.naturalHeight || playerSprite.height;
    ctx.drawImage(playerSprite, drawX, drawY, w, h);
  } else {
    ctx.fillStyle = isLocal ? '#1E90FF' : '#FF6347';
    ctx.beginPath();
    ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
    ctx.fill();
  }
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
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // WHITE labels, nudged up by 2px to align
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);

    // Username
    const uTop = FIELD_TOP(GUI.username.y);
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr || '', GUI.username.x + 4, GUI.username.y + 2);

    // Password
    const pTop = FIELD_TOP(GUI.password.y);
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    // Buttons
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

    // Map (only if ready)
    if (tilesReady && mapReady) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
          const { screenX, screenY } = isoScreen(x, y);
          drawTile(screenX, screenY, t);

        }
      }
    }

  // Build a quick lookup of players by tile
const playersByTile = {};
(function buildPlayersIndex() {
  if (localPlayer) {
    const k = `${localPlayer.pos_x},${localPlayer.pos_y}`;
    (playersByTile[k] ||= []).push({ ...localPlayer, __isLocal: true });
  }
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    const k = `${p.pos_x},${p.pos_y}`;
    (playersByTile[k] ||= []).push(p);
  }
})();

// Second pass: items + players in tile order (depth-safe with tall items)
if (tilesReady && mapReady) {
  for (let y = 0; y < mapSpec.height; y++) {
    for (let x = 0; x < mapSpec.width; x++) {
      const { screenX, screenY } = isoScreen(x, y);

      // 1) Item on this tile?
      const it = (mapSpec.items && mapSpec.items[y] && typeof mapSpec.items[y][x] !== 'undefined')
        ? mapSpec.items[y][x]
        : 0;
      if (it > 0) drawItemAtTile(screenX, screenY, it);

      // 2) Players standing on this tile
      const k = `${x},${y}`;
      const arr = playersByTile[k];
      if (arr && arr.length) {
        // Keep your usual name/sprite stacking; if multiple players share a tile, draw in arrival order
        for (const p of arr) drawPlayer(p, !!p.__isLocal);
      }
    }
  }
}


    // Border
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

    // Stats on top
    drawBarsAndStats();

    // Chat
    drawChatHistory();
    drawChatInput();
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

  // Click handler
  canvas.addEventListener('mousedown', () => {
    if (!connected) { connectToServer(); return; }
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; }
  });

  // utils
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; connectionPaused = true; showLoginGUI = false; };
    ws.onmessage = (ev) => { const d = safeParse(ev.data); if (d) handleServerMessage(d); };
    ws.onerror = (e) => console.error('WS error', e);
    ws.onclose = () => {
      connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false; chatMode = false;
      localPlayer = null; otherPlayers = {};
    };
  }
  window.connectToServer = connectToServer;
});
