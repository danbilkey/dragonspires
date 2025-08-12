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

  // ---------- LOGICAL/RENDER CONSTANTS ----------
  // Logical diamond for positioning
  const TILE_W = 64, TILE_H = 32;

  // Item fine-tuning (center on tile a bit better)
  const ITEM_X_NUDGE = 0;//:3;      // +right
  const ITEM_Y_NUDGE = 0;//:15;// +up (we subtract this in draw)

  // Screen anchor for local title
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // World/camera offsets (as previously tuned)
  const WORLD_SHIFT_X = -32, WORLD_SHIFT_Y = 16;
  const CENTER_LOC_ADJ_X = 32, CENTER_LOC_ADJ_Y = -8;
  const CENTER_LOC_FINE_X = -5, CENTER_LOC_FINE_Y = 0;

  // Sprite offsets (as tuned earlier)
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;
  const SPRITE_CENTER_ADJ_X = 23;  // = 64 - 41
  const SPRITE_CENTER_ADJ_Y = -24; // = -24 + 4

  // ---------- STATE ----------
  let ws = null;
  let connected = false;
  let connectionPaused = false;
  let showLoginGUI = false;
  let loggedIn = false;

  let mapSpec = {
    width: 64, height: 64,
    tileIndex: [], // 2D array of floor tile sprite indices.
    items: []      // [{x, y, spriteIndex, name?}, ...]
  };

  let localPlayer = null;
  let otherPlayers = {};
  let usernameStr = "", passwordStr = "";
  let typingBuffer = "";
  let chatMode = false;

  // ---------- CHAT ----------
  const CHAT_INPUT = {
    top: 425, left: 10, w: 620, h: 20, maxLen: 120
  };
  const messages = [];
  function drawChat() {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 360, CANVAS_W, 120);

    ctx.font = '12px monospace';
    ctx.fillStyle = 'white';
    let y = 370;
    for (let i = Math.max(0, messages.length - 7); i < messages.length; i++) {
      ctx.fillText(messages[i], 10, y); y += 16;
    }

    if (chatMode) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(CHAT_INPUT.left, CHAT_INPUT.top, CHAT_INPUT.w, CHAT_INPUT.h);
      ctx.strokeStyle = '#ddd';
      ctx.strokeRect(CHAT_INPUT.left, CHAT_INPUT.top, CHAT_INPUT.w, CHAT_INPUT.h);
      ctx.fillStyle = 'white';
      ctx.fillText("> " + typingBuffer, CHAT_INPUT.left + 6, CHAT_INPUT.top + 14);
    }
  }

  // ---------- GUI ----------
  const GUI = {
    username: { x: 80, y: 120, w: 200, h: 24, label: 'Username:' },
    password: { x: 80, y: 160, w: 200, h: 24, label: 'Password:' },
    loginBtn: { x: 300, y: 120, w: 80,  h: 24, label: 'Login' },
    signupBtn:{ x: 300, y: 160, w: 80,  h: 24, label: 'Signup' }
  };
  const FIELD_TOP = (y) => y;
  let activeField = null;

  // ---------- ASSETS ----------
  // Title
  const imgTitle = new Image();
  imgTitle.src = "/assets/title.png";
  let titleReady = false;
  imgTitle.onload = () => { titleReady = true; };

  // Border
  const imgBorder = new Image();
  imgBorder.src = "/assets/border.png";
  let borderReady = false;
  imgBorder.onload = () => {
    try {
      const off = document.createElement('canvas');
      off.width = imgBorder.width; off.height = imgBorder.height;
      const octx = off.getContext('2d');
      octx.drawImage(imgBorder, 0, 0);
      const imgData = octx.getImageData(0,0,off.width,off.height);
      for (let i=0;i<imgData.data.length;i+=4) {
        if (imgData.data[i]===255 && imgData.data[i+1]===0 && imgData.data[i+2]===255) imgData.data[i+3]=0;
      }
      octx.putImageData(imgData, 0, 0);
      const img = new Image();
      img.src = off.toDataURL();
      imgBorderTransparent = img;
    } catch {
      imgBorderTransparent = null;
    }
  };
  let imgBorderTransparent = null;

  // Player sprite: crop + **magenta** -> transparent (old single frame fallback)
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

  // ---------- PLAYER FRAMES (knight) ----------
  let knightFrames = []; // 22 frames (indices 0..21)
  const AnimIndices = {
    down_walk_1:0, down:1, down_walk_2:2, down_attack_1:3, down_attack_2:4,
    right_walk_1:5, right:6, right_walk_2:7, right_attack_1:8, right_attack_2:9,
    left_walk_1:10, left:11, left_walk_2:12, left_attack_1:13, left_attack_2:14,
    up_walk_1:15, up:16, up_walk_2:17, up_attack_1:18, up_attack_2:19,
    stand:20, sit:21
  };
  const walkCycles = {
    up:    [AnimIndices.up_walk_1, AnimIndices.up,    AnimIndices.up_walk_2,   AnimIndices.up],
    down:  [AnimIndices.down_walk_1, AnimIndices.down,AnimIndices.down_walk_2, AnimIndices.down],
    left:  [AnimIndices.left_walk_1, AnimIndices.left,AnimIndices.left_walk_2, AnimIndices.left],
    right: [AnimIndices.right_walk_1, AnimIndices.right,AnimIndices.right_walk_2, AnimIndices.right]
  };
  function idleIndexFor(dir){
    return ({down:AnimIndices.down, right:AnimIndices.right, left:AnimIndices.left, up:AnimIndices.up})[dir] ?? AnimIndices.stand;
  }
  function waitImage(img){return new Promise(r => { if (img.complete) return r(); img.onload = img.onerror = r; });}

  Promise.all([
    waitImage(imgPlayerSrc),
    fetch('/assets/player.json').then(r => r.json()).catch(() => null)
  ]).then(([_, playerMeta]) => {
    if (!playerMeta || !Array.isArray(playerMeta.knight)) return;
    const list = playerMeta.knight;           // [[sx,sy,sw,sh], ...] length 22

    const baseW = list[0][2], baseH = list[0][3];
    const off = document.createElement('canvas');
    const octx = off.getContext('2d');

    knightFrames = list.map(([sx, sy, sw, sh]) => {
      off.width = sw; off.height = sh;
      octx.clearRect(0, 0, sw, sh);
      octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);

      // true magenta -> transparent
      try {
        const data = octx.getImageData(0, 0, sw, sh);
        const d = data.data;
        for (let i=0; i<d.length; i+=4) {
          if (d[i]===255 && d[i+1]===0 && d[i+2]===255) d[i+3]=0;
        }
        octx.putImageData(data, 0, 0);
      } catch {}

      const img = new Image();
      img.src = off.toDataURL();

      return {
        img, w: sw, h: sh,
        // center horizontally, align bottoms to a common baseline
        offsetX: Math.round((baseW - sw)/2),
        offsetY: Math.round(baseH - sh)
      };
    });
  });

  // Floor tiles from /assets/floor.png: 9 rows x 11 columns, each 61x31, with 1px shared border
  const imgFloor = new Image();
  imgFloor.src = "/assets/floor.png";
  const FLOOR_COLS = 11, FLOOR_ROWS = 9;
  const FLOOR_SW = 61, FLOOR_SH = 31;
  let floorSprites = [];
  imgFloor.onload = () => {
    try {
      const off = document.createElement('canvas');
      off.width = imgFloor.width; off.height = imgFloor.height;
      const octx = off.getContext('2d');
      octx.drawImage(imgFloor, 0, 0);
      const imgData = octx.getImageData(0,0,off.width,off.height);
      for (let i=0;i<imgData.data.length;i+=4) {
        if (imgData.data[i]===255 && imgData.data[i+1]===0 && imgData.data[i+2]===255) imgData.data[i+3]=0;
      }
      octx.putImageData(imgData, 0, 0);

      for (let r = 0; r < FLOOR_ROWS; r++) {
        for (let c = 0; c < FLOOR_COLS; c++) {
          const sx = c * FLOOR_SW + c, sy = r * FLOOR_SH + r;
          const off2 = document.createElement('canvas');
          off2.width = FLOOR_SW; off2.height = FLOOR_SH;
          const o2 = off2.getContext('2d');
          o2.drawImage(off, sx, sy, FLOOR_SW, FLOOR_SH, 0, 0, FLOOR_SW, FLOOR_SH);
          const img = new Image();
          img.src = off2.toDataURL();
          floorSprites.push(img);
        }
      }
    } catch {
      // fall back: whole atlas as-is
      floorSprites = [imgFloor];
    }
  };

  // Item sprites
  const imgItems = new Image();
  imgItems.src = "/assets/item.gif";
  let itemSprites = [];
  imgItems.onload = () => {
    try {
      const off = document.createElement('canvas');
      off.width = imgItems.width; off.height = imgItems.height;
      const octx = off.getContext('2d');
      octx.drawImage(imgItems, 0, 0);
      const imgData = octx.getImageData(0,0,off.width,off.height);
      for (let i=0;i<imgData.data.length;i+=4) {
        if (imgData.data[i]===255 && imgData.data[i+1]===0 && imgData.data[i+2]===255) imgData.data[i+3]=0;
      }
      octx.putImageData(imgData, 0, 0);

      // Parse /assets/item.json with { x,y,w,h } list
      fetch('/assets/item.json').then(r => r.json()).then(list => {
        if (!Array.isArray(list)) return;
        itemSprites = list.map(({x,y,w,h}) => {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(off, x, y, w, h, 0, 0, w, h);
          const img = new Image();
          img.src = c.toDataURL();
          return img;
        });
      }).catch(()=>{});
    } catch {
      itemSprites = [imgItems];
    }
  };

  // ---------- MAP ----------
  function isoScreen(x, y) {
    const ox = WORLD_SHIFT_X + CENTER_LOC_ADJ_X + CENTER_LOC_FINE_X;
    const oy = WORLD_SHIFT_Y + CENTER_LOC_ADJ_Y + CENTER_LOC_FINE_Y;
    const screenX = Math.floor(ox + PLAYER_SCREEN_X + (x - (localPlayer?.pos_x ?? 0)) * (TILE_W/2) - (y - (localPlayer?.pos_y ?? 0)) * (TILE_W/2));
    const screenY = Math.floor(oy + PLAYER_SCREEN_Y + (x - (localPlayer?.pos_x ?? 0)) * (TILE_H/2) + (y - (localPlayer?.pos_y ?? 0)) * (TILE_H/2));
    return { screenX, screenY };
  }

  function drawFloor() {
    if (!floorSprites.length) return;
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        const idx = mapSpec.tileIndex[y][x] || 0;
        const img = floorSprites[idx % floorSprites.length];
        const { screenX, screenY } = isoScreen(x, y);
        ctx.drawImage(img, screenX, screenY);
      }
    }
  }

  function drawItems() {
    if (!itemSprites.length) return;
    for (const it of mapSpec.items) {
      const { screenX, screenY } = isoScreen(it.x, it.y);
      const img = itemSprites[it.spriteIndex % itemSprites.length];
      // align bottom to tile center a touch higher (subtract ITEM_Y_NUDGE)
      ctx.drawImage(img, screenX + TILE_W/2 - Math.floor((img.width || 0)/2) + ITEM_X_NUDGE, screenY + TILE_H/2 - (img.height || 0) - ITEM_Y_NUDGE);
    }
  }

  // ---------- WEBSOCKET ----------
  function connectToServer() {
    try { ws?.close(); } catch {}
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      connectionPaused = false;
      showLoginGUI = true;
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
        // defaults for animation state
        localPlayer.dir = localPlayer.dir || 'down';
        if (!Number.isInteger(localPlayer.animIndex)) localPlayer.animIndex = idleIndexFor(localPlayer.dir);
        localPlayer.walkStep = 0;
        localPlayer.attackStep = 0;
        localPlayer.lastAttack = 0;

        otherPlayers = {};
        if (Array.isArray(msg.players)) msg.players.forEach(p => {
          if (!localPlayer || p.id !== localPlayer.id) {
            const cp = { ...p };
            cp.dir = cp.dir || 'down';
            if (!Number.isInteger(cp.animIndex)) cp.animIndex = idleIndexFor(cp.dir);
            otherPlayers[cp.id] = cp;
          }
        });
        pushChat("Welcome to DragonSpires!");
        break;
      }
      case 'player_joined': {
        if (!localPlayer || msg.player.id !== localPlayer.id) {
          const cp = { ...msg.player };
          cp.dir = cp.dir || 'down';
          if (!Number.isInteger(cp.animIndex)) cp.animIndex = idleIndexFor(cp.dir);
          otherPlayers[cp.id] = cp;
          pushChat(`${cp.username || cp.id} has entered DragonSpires!`);
        }
        break;
      }
      case 'player_moved': {
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
          if (typeof msg.dir === 'string') localPlayer.dir = msg.dir;
          if (Number.isInteger(msg.animIndex)) localPlayer.animIndex = msg.animIndex;
        } else {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}`, pos_x: msg.x, pos_y: msg.y };
          else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
          if (typeof msg.dir === 'string') otherPlayers[msg.id].dir = msg.dir;
          if (Number.isInteger(msg.animIndex)) otherPlayers[msg.id].animIndex = msg.animIndex;
        }
        break;
      }
      case 'player_update': {
        const p = (localPlayer && msg.id === localPlayer.id) ? localPlayer : otherPlayers[msg.id];
        if (p) {
          if (typeof msg.dir === 'string') p.dir = msg.dir;
          if (Number.isInteger(msg.animIndex)) p.animIndex = msg.animIndex;
        }
        break;
      }
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
          pushChat(`~ ${localPlayer.username} is currently on Map ${localPlayer.map_id} at location x:${localPlayer.pos_x}, y:${localPlayer.pos_y}.`);
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

      // --- Attack (Tab toggles attack_1/attack_2 for facing dir)
      if (k === 'tab') {
        e.preventDefault();
        localPlayer.attackStep = ((localPlayer.attackStep ?? 0) + 1) % 2;
        const idx = localPlayer.attackStep === 0 ? 1 : 2; // 1 or 2
        localPlayer.animIndex = AnimIndices[`${localPlayer.dir}_attack_${idx}`];
        localPlayer.lastAttack = Date.now();
        send({ type: 'attack', dir: localPlayer.dir, animIndex: localPlayer.animIndex });

        clearTimeout(localPlayer._atkTimer);
        localPlayer._atkTimer = setTimeout(() => {
          if (Date.now() - (localPlayer.lastAttack || 0) >= 1000) {
            localPlayer.animIndex = idleIndexFor(localPlayer.dir);
            send({ type: 'animation', dir: localPlayer.dir, animIndex: localPlayer.animIndex });
          }
        }, 1000);
        return;
      }

      let dx = 0, dy = 0, newDir = localPlayer.dir || 'down';
      if (k === 'arrowup' || k === 'w')       { dy = -1; newDir = 'up'; }
      else if (k === 'arrowdown' || k === 's'){ dy = 1;  newDir = 'down'; }
      else if (k === 'arrowleft' || k === 'a'){ dx = -1; newDir = 'left'; }
      else if (k === 'arrowright' || k === 'd'){ dx = 1; newDir = 'right'; }

      if (dx || dy) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
          localPlayer.stamina = Math.max(0, (localPlayer.stamina ?? 0) - 1); // 1 per move
          localPlayer.pos_x = nx; localPlayer.pos_y = ny;

          // walking cycle: reset on dir change, else advance
          if (localPlayer.dir !== newDir) localPlayer.walkStep = 0;
          else localPlayer.walkStep = ((localPlayer.walkStep ?? 0) + 1) % walkCycles[newDir].length;

          localPlayer.dir = newDir;
          localPlayer.animIndex = walkCycles[newDir][localPlayer.walkStep];

          // send dir/animIndex along with the move
          send({ type: 'move', dx, dy, dir: localPlayer.dir, animIndex: localPlayer.animIndex });
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

      if (mx >= u.x && mx <= u.x + u.w && my >= uTop && my <= uBottom) activeField = 'username';
      else if (mx >= p.x && mx <= p.x + p.w && my >= pTop && my <= pBottom) activeField = 'password';
      else if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) send({ type: 'login', username: usernameStr, password: passwordStr });
      else if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) send({ type: 'signup', username: usernameStr, password: passwordStr });
      else activeField = null;
    }
  });

  // ---------- DRAW ----------
  function drawLoginGUI() {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = 'white';
    ctx.font = '16px sans-serif';
    ctx.fillText('Login to DragonSpires', 80, 90);

    const drawField = (fld, txt, active) => {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(fld.x, FIELD_TOP(fld.y), fld.w, fld.h);
      ctx.strokeStyle = active ? '#fff' : '#888';
      ctx.strokeRect(fld.x, FIELD_TOP(fld.y), fld.w, fld.h);
      ctx.fillStyle = '#ddd';
      ctx.fillText(fld.label, fld.x, FIELD_TOP(fld.y) - 4);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, fld.x + 6, FIELD_TOP(fld.y) + 16);
    };

    drawField(GUI.username, usernameStr, activeField === 'username');
    drawField(GUI.password, '*'.repeat(passwordStr.length), activeField === 'password');

    const drawButton = (b, label) => {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = '#ddd'; ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = 'white'; ctx.fillText(label, b.x + 6, b.y + 16);
    };
    drawButton(GUI.loginBtn, 'Login');
    drawButton(GUI.signupBtn, 'Signup');
  }

  function drawTitleAndBorder() {
    if (imgBorderTransparent) ctx.drawImage(imgBorderTransparent, 0, 0);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0);
    else {
      // fallback: simple border
      ctx.strokeStyle = 'white';
      ctx.strokeRect(0, 0, CANVAS_W, CANVAS_H);
    }
    if (titleReady) ctx.drawImage(imgTitle, CANVAS_W/2 - Math.floor(imgTitle.width/2), 10);
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

    // Select current animation frame
    const idx = Number.isInteger(p.animIndex) ? p.animIndex : idleIndexFor(p.dir || 'down');
    const frame = (knightFrames && knightFrames[idx]) ? knightFrames[idx] : null;

    const baseX = screenX + PLAYER_OFFSET_X + SPRITE_CENTER_ADJ_X;
    const baseY = screenY + PLAYER_OFFSET_Y + SPRITE_CENTER_ADJ_Y;

    if (frame && frame.img && frame.img.complete) {
      ctx.drawImage(frame.img, baseX + frame.offsetX, baseY + frame.offsetY, frame.w, frame.h);
    } else if (playerSprite && playerSprite.complete) {
      // fallback old single sprite
      const w = playerSprite.naturalWidth || playerSprite.width;
      const h = playerSprite.naturalHeight || playerSprite.height;
      ctx.drawImage(playerSprite, baseX, baseY, w, h);
    } else {
      // last resort: ellipse
      ctx.fillStyle = isLocal ? '#1E90FF' : '#FF6347';
      ctx.beginPath();
      ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawBarsAndStats() {
    if (!loggedIn || !localPlayer) return;
    const sX = 10, sY = 8, barW = 170, barH = 10, gap = 16;

    // Stamina
    ctx.fillStyle = '#333'; ctx.fillRect(sX, sY, barW, barH);
    ctx.fillStyle = '#6cf';
    const stPct = Math.max(0, Math.min(1, (localPlayer.stamina ?? 0) / (localPlayer.max_stamina ?? 1)));
    ctx.fillRect(sX, sY, Math.floor(barW * stPct), barH);
    ctx.strokeStyle = '#ddd'; ctx.strokeRect(sX, sY, barW, barH);

    // Life
    ctx.fillStyle = '#333'; ctx.fillRect(sX, sY + gap, barW, barH);
    ctx.fillStyle = '#f66';
    const lfPct = Math.max(0, Math.min(1, (localPlayer.life ?? 0) / (localPlayer.max_life ?? 1)));
    ctx.fillRect(sX, sY + gap, Math.floor(barW * lfPct), barH);
    ctx.strokeStyle = '#ddd'; ctx.strokeRect(sX, sY + gap, barW, barH);

    // Magic
    ctx.fillStyle = '#333'; ctx.fillRect(sX, sY + gap*2, barW, barH);
    ctx.fillStyle = '#7f7';
    const mgPct = Math.max(0, Math.min(1, (localPlayer.magic ?? 0) / (localPlayer.max_magic ?? 1)));
    ctx.fillRect(sX, sY + gap*2, Math.floor(barW * mgPct), barH);
    ctx.strokeStyle = '#ddd'; ctx.strokeRect(sX, sY + gap*2, barW, barH);

    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
    ctx.fillText(`Gold: ${localPlayer.gold ?? 0}`, sX, sY + gap*3 + 10);
  }

  function draw() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    drawTitleAndBorder();

    if (!connected) {
      ctx.fillStyle = 'white';
      ctx.font = '14px sans-serif';
      ctx.fillText('Connecting...', 12, CANVAS_H - 12);
      return;
    }

    if (connectionPaused) {
      ctx.fillStyle = 'white';
      ctx.font = '14px sans-serif';
      ctx.fillText('Connection lost. Click to reconnect.', 12, CANVAS_H - 12);
      return;
    }

    if (showLoginGUI && !loggedIn) {
      drawLoginGUI();
      drawChat();
      return;
    }

    // Main Game Scene
    drawFloor();
    drawItems();

    // Draw all players: sort by Y for depth
    const all = [];
    if (localPlayer) all.push({p: localPlayer, local: true});
    for (const id in otherPlayers) all.push({p: otherPlayers[id], local: false});
    all.sort((a,b)=> a.p.pos_y === b.p.pos_y ? a.p.pos_x - b.p.pos_x : a.p.pos_y - b.p.pos_y);
    for (const ent of all) drawPlayer(ent.p, ent.local);

    drawBarsAndStats();
    drawChat();
  }

  // ---------- GAME LOOP ----------
  function loop() {
    draw();
    requestAnimationFrame(loop);
  }
  loop();
});
