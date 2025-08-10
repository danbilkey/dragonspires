// client.js
// Alignment tweaks, stat overlay after border, magic text with black outline and new position,
// gold y+6, chat input y+2, and refined centering offsets for tile/name (-5 x) and sprite (-41,+4).

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

  const TILE_W = 64, TILE_H = 32;

  // Base camera anchor for local tile
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // Existing global shift
  const WORLD_SHIFT_X = -32, WORLD_SHIFT_Y = 16;

  // Previously tuned centering for tile/name:
  const CENTER_LOC_ADJ_X = 32, CENTER_LOC_ADJ_Y = -8;
  // Your new correction for actual player location (applied on top):
  const CENTER_LOC_FINE_X = -5, CENTER_LOC_FINE_Y = 0;

  // Sprite-specific extra nudges (previous) plus new correction:
  const SPRITE_CENTER_ADJ_X = 64 - 41; // 23
  const SPRITE_CENTER_ADJ_Y = -24 + 4; // -20

  // Sprite sheet base offset
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;

  // GUI placement (+50,+50)
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
  let connectionPaused = false; // "Press any key to enter!"
  let showLoginGUI = false;     // after press, title stops rendering
  let loggedIn = false;
  let chatMode = false;

  let mapSpec = { width: 10, height: 10, tiles: [] };

  let usernameStr = "";
  let passwordStr = "";
  let activeField = null;

  let localPlayer = null;
  let otherPlayers = {};

  let messages = [];
  let typingBuffer = "";

  // ---------- ASSETS ----------
  const imgTitle = new Image();
  imgTitle.src = "/assets/title.GIF";

  const imgBorder = new Image();
  imgBorder.src = "/assets/game_border_2025.gif";
  let borderProcessed = null;

  imgBorder.onload = () => {
    // color-key pure magenta
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
      console.warn("Border transparency failed (CORS?) — using opaque border.");
      borderProcessed = null;
    }
  };

  const imgPlayerSrc = new Image();
  imgPlayerSrc.src = "/assets/player.gif";
  let playerSprite = null;

  imgPlayerSrc.onload = () => {
    // crop + black to alpha
    try {
      const sx = 264, sy = 1, sw = 44, sh = 55;
      const off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      const octx = off.getContext('2d');
      octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);
      const data = octx.getImageData(0,0,sw,sh);
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i] < 16 && data.data[i+1] < 16 && data.data[i+2] < 16) data.data[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
      const img = new Image();
      img.src = off.toDataURL();
      playerSprite = img;
    } catch {
      playerSprite = imgPlayerSrc;
    }
  };

  // ---------- MAP LOAD ----------
  fetch('map.json')
    .then(r => r.json())
    .then(m => { if (m && m.width && m.height && Array.isArray(m.tiles)) mapSpec = m; })
    .catch(() => {});

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
  function pushChat(line) {
    messages.push(String(line));
    if (messages.length > 200) messages.shift();
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success': {
        loggedIn = true;
        localPlayer = { ...msg.player };
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => { if (!localPlayer || p.id !== localPlayer.id) otherPlayers[p.id] = p; });
        }
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
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
        } else {
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
        // update local or other player values that exist in the payload
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
    if (connected && connectionPaused) {
      connectionPaused = false;
      showLoginGUI = true;
      return;
    }

    // Chat toggle/submit
    if (e.key === 'Enter' && loggedIn) {
      if (!chatMode) { chatMode = true; typingBuffer = ""; }
      else {
        const toSend = typingBuffer.trim();
        if (toSend.length > 0) send({ type: 'chat', text: toSend.slice(0, CHAT_INPUT.maxLen) });
        typingBuffer = ""; chatMode = false;
      }
      e.preventDefault(); return;
    }

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

    // Movement
    if (loggedIn && localPlayer) {
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0;
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;
      if (dx || dy) {
        const nx = localPlayer.pos_x + dx, ny = localPlayer.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
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

    // world shift
    screenX += WORLD_SHIFT_X; screenY += WORLD_SHIFT_Y;
    // prior centering for tile/name
    screenX += CENTER_LOC_ADJ_X; screenY += CENTER_LOC_ADJ_Y;
    // fine-tune correction you requested
    screenX += CENTER_LOC_FINE_X; screenY += CENTER_LOC_FINE_Y;

    return { screenX, screenY };
  }

  function drawTile(sx, sy, t) {
    ctx.beginPath();
    ctx.moveTo(sx, sy + TILE_H/2);
    ctx.lineTo(sx + TILE_W/2, sy);
    ctx.lineTo(sx + TILE_W, sy + TILE_H/2);
    ctx.lineTo(sx + TILE_W/2, sy + TILE_H);
    ctx.closePath();
    ctx.fillStyle = t === 1 ? '#C68642' : '#8DBF63';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke();
  }

  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);

    // Name centered and a bit higher
    const nameX = screenX + TILE_W / 2;
    const nameY = screenY - 20;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nameX, nameY);
    ctx.lineWidth = 1;

    // Sprite final position
    const drawX = screenX + PLAYER_OFFSET_X + SPRITE_CENTER_ADJ_X;
    const drawY = screenY + PLAYER_OFFSET_Y + SPRITE_CENTER_ADJ_Y;

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

  function drawBarsAndStats() {
    if (!loggedIn || !localPlayer) return;

    const topY = 19, bottomY = 135;
    const span = bottomY - topY;

    // Stamina green (x:187..200)
    const sPct = Math.max(0, Math.min(1, (localPlayer.stamina ?? 0) / Math.max(1, (localPlayer.max_stamina ?? 1))));
    const sFillY = topY + (1 - sPct) * span;
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(187, sFillY, 13, bottomY - sFillY);

    // Life red (x:211..224)
    const lPct = Math.max(0, Math.min(1, (localPlayer.life ?? 0) / Math.max(1, (localPlayer.max_life ?? 1))));
    const lFillY = topY + (1 - lPct) * span;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(211, lFillY, 13, bottomY - lFillY);

    // Magic text at (184,239) adjusted by x:-7, y:+8 -> (177,247) with black outline
    const mx = 177, my = 247;
    const mCur = localPlayer.magic ?? 0, mMax = localPlayer.max_magic ?? 0;
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(`${mCur}/${mMax}`, mx, my);
    ctx.fillStyle = 'yellow'; ctx.fillText(`${mCur}/${mMax}`, mx, my);
    ctx.lineWidth = 1;

    // Gold text at (177,267) with y:+6 -> (177,273)
    const gold = localPlayer.gold ?? 0;
    ctx.font = '14px sans-serif';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(String(gold), 177, 273);
    ctx.fillStyle = 'white'; ctx.fillText(String(gold), 177, 273);
    ctx.lineWidth = 1;
  }

  function drawChatHistory() {
    const { x1,y1,x2,y2,pad } = CHAT;
    const w = x2 - x1;
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
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
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';

    const words = typingBuffer.split(/(\s+)/);
    let line = '';
    let y = y1 + pad + extraY; // +2 lower
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i];
      if (ctx.measureText(test).width > w - pad*2) {
        ctx.fillText(line, x1 + pad, y);
        y += 16;
        line = words[i].trimStart();
        if (y > y2 - pad) break;
      } else {
        line = test;
      }
    }
    if (y <= y2 - pad && line.length) ctx.fillText(line, x1 + pad, y);
  }

  // ---------- SCENES ----------
  function drawConnecting() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!showLoginGUI) {
      if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
      else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    } else {
      ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    }
    ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
    if (connectionPaused) ctx.fillText('Press any key to enter!', 47, 347);
    else ctx.fillText('Connecting to server...', 47, 347);
  }

  function drawLogin() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // WHITE labels, nudged up by 2px
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);

    // Username field
    const uTop = FIELD_TOP(GUI.username.y);
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr || '', GUI.username.x + 4, GUI.username.y + 2);

    // Password field
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

    // Chat history
    drawChatHistory();
  }

  function drawGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    if (!localPlayer) return;

    // Tiles
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
        const { screenX, screenY } = isoScreen(x, y);
        drawTile(screenX, screenY, t);
      }
    }

    // Players (depth)
    const all = Object.values(otherPlayers).concat(localPlayer ? [localPlayer] : []);
    all.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    all.forEach(p => drawPlayer(p, localPlayer && p.id === localPlayer.id));

    // Border
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

    // Stats AFTER border (so they’re on top)
    drawBarsAndStats();

    // Chat layers
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

  // debug
  window.connectToServer = connectToServer;
});
