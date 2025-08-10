// client.js
// Fixes: HUD positions, map indexing (use tilemap[x][y]), robust magenta transparency,
// floor.png extraction (STEP_X=63, STEP_Y=33, 61x31 tiles), ensure player/name
// render ABOVE tiles, stamina/life/magic/gold x-offsets, title/login visuals.

document.addEventListener('DOMContentLoaded', () => {
  // ---- CONFIG ----
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS  = "ws://localhost:3000";
  const WS_URL  = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const CANVAS_W = 640, CANVAS_H = 480;

  // Isometric logic tile (grid math)
  const TILE_W = 64, TILE_H = 32;

  // floor.png tile art (actual bitmap)
  const FLOOR_W = 61, FLOOR_H = 31;
  const STEP_X = 63, STEP_Y = 33;      // <- spacing between tile starts (from your samples)
  const FLOOR_ROWS = 9, FLOOR_COLS = 11;
  const FLOOR_START_X = 1, FLOOR_START_Y = 1;

  // Player centered on screen
  const PLAYER_SCREEN_X = 320;
  const PLAYER_SCREEN_Y = 240;

  // Map/camera & sprite offsets
  const PLAYER_LOC_OFFSET_X = -5;     // “actual location” (camera anchor) tweak
  const PLAYER_LOC_OFFSET_Y = 0;
  const PLAYER_SPRITE_OFFSET_X = -41; // sprite tweak
  const PLAYER_SPRITE_OFFSET_Y = 4;
  const PLAYER_NAME_OFFSET_X   = -2;  // name tweak (and height so it stays above)
  const PLAYER_NAME_OFFSET_Y   = -14;

  // Login GUI placement
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn:{ x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat area (no background, black text)
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };

  // HUD (drawn AFTER the border so it appears on top)
  const HUD = {
    yTop: 19, yBot: 135, h: (135 - 19),
    staminaX: 200 - 12,  // ← shift left by 12
    lifeX:    224 - 12,  // ← shift left by 12
    magicText: { x: (184 - 7) + 20, y: 239 + 8 }, // ← +20 x
    goldText:  { x: 177 + 20,       y: 267 + 6 }  // ← +20 x
  };

  // ---- CANVAS ----
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Missing <canvas id="gameCanvas">'); return; }
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // ---- STATE ----
  let ws = null;
  let connected = false;
  let connectionPaused = false; // “Press any key to enter!”
  let showLoginGUI = false;
  let loggedIn = false;

  let usernameStr = "", passwordStr = "", activeField = null;

  let localPlayer = null; // includes stamina/life/magic/etc
  let otherPlayers = {};
  let messages = [];

  // Map (we’ll load map{map_id}.json after login)
  let mapSpec = { width: 52, height: 100, tilemap: [] };

  // ---- ASSETS ----
  const imgTitle = new Image(); imgTitle.src = "/assets/title.GIF";

  const imgBorderSrc = new Image(); imgBorderSrc.src = "/assets/game_border_2025.gif";
  let imgBorder = null; // processed (magenta→transparent)

  const imgPlayerSrc = new Image(); imgPlayerSrc.src = "/assets/player.gif";
  let playerSprite = null; // processed (magenta→transparent and cropped to one frame)

  const imgFloor = new Image(); imgFloor.src = "/assets/floor.png";
  let floorTiles = []; // 0-based extracted tiles

  // ---- UTIL: robust magenta transparency (GIF palettes can be “near magenta”) ----
  function magentaToAlpha(img, sx=0, sy=0, sw=img.width, sh=img.height) {
    const off = document.createElement('canvas');
    off.width = sw; off.height = sh;
    const octx = off.getContext('2d');
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = octx.getImageData(0, 0, sw, sh);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      // tolerate slight palette drift
      if (r >= 250 && g <= 5 && b >= 250) d[i+3] = 0;
    }
    octx.putImageData(data, 0, 0);
    const out = new Image(); out.src = off.toDataURL();
    return out;
  }

  // Process border/player on load
  imgBorderSrc.onload = () => { imgBorder = magentaToAlpha(imgBorderSrc); };
  imgPlayerSrc.onload = () => {
    try {
      // crop one player frame (264,1, 44x55) then magenta→alpha
      playerSprite = magentaToAlpha(imgPlayerSrc, 264, 1, 44, 55);
    } catch {
      playerSprite = imgPlayerSrc;
    }
  };

  // Extract floor tiles (0-based). Uses STEP_X/STEP_Y from your examples.
  imgFloor.onload = () => {
    const off = document.createElement('canvas');
    off.width = FLOOR_W; off.height = FLOOR_H;
    const octx = off.getContext('2d');
    floorTiles = [];
    for (let r = 0; r < FLOOR_ROWS; r++) {
      for (let c = 0; c < FLOOR_COLS; c++) {
        const sx = FLOOR_START_X + (c * STEP_X);
        const sy = FLOOR_START_Y + (r * STEP_Y);
        octx.clearRect(0,0,FLOOR_W,FLOOR_H);
        octx.drawImage(imgFloor, sx, sy, FLOOR_W, FLOOR_H, 0, 0, FLOOR_W, FLOOR_H);
        // keep PNG alpha; also clear pure magenta if present
        const data = octx.getImageData(0,0,FLOOR_W,FLOOR_H);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] >= 250 && d[i+1] <= 5 && d[i+2] >= 250) d[i+3] = 0;
        }
        octx.putImageData(data, 0, 0);
        const tileImg = new Image(); tileImg.src = off.toDataURL();
        floorTiles.push(tileImg);
      }
    }
  };

  // ---- MAP LOADER (after login) ----
  async function loadMapById(mapId) {
    const name = `map${mapId || 1}.json`;
    try {
      const res = await fetch(name);
      const m = await res.json();
      if (m && m.width && m.height && m.tilemap) {
        mapSpec = m;
      }
    } catch (e) {
      console.warn("Failed to load map file:", e);
    }
  }

  // ---- WEBSOCKET ----
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; connectionPaused = true; showLoginGUI = false; };
    ws.onmessage = (ev) => { const d = safeParse(ev.data); if (d) handleServerMessage(d); };
    ws.onclose = () => {
      connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false;
      localPlayer = null; otherPlayers = {}; messages = [];
    };
  }
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success': {
        loggedIn = true;
        localPlayer = msg.player;
        messages.push("Welcome to DragonSpires!");
        loadMapById(localPlayer.map_id);
        break;
      }
      case 'player_joined': {
        if (!localPlayer || msg.player.id === localPlayer.id) break;
        otherPlayers[msg.player.id] = msg.player;
        messages.push(`${msg.player.username} has entered DragonSpires!`);
        break;
      }
      case 'player_left': {
        if (msg.id !== localPlayer?.id) {
          const n = otherPlayers[msg.id]?.username || `#${msg.id}`;
          messages.push(`${n} has left DragonSpires.`);
        }
        delete otherPlayers[msg.id];
        break;
      }
      case 'player_moved': {
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
        } else {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: msg.username || `#${msg.id}`, pos_x: msg.x, pos_y: msg.y };
          else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
        }
        break;
      }
      case 'stats_update': {
        if (localPlayer && msg.stats) Object.assign(localPlayer, msg.stats);
        break;
      }
      case 'chat': {
        if (typeof msg.text === 'string') { messages.push(msg.text); if (messages.length > 300) messages.shift(); }
        break;
      }
      case 'login_error':
      case 'signup_error': {
        messages.push(msg.message || 'Auth error'); break;
      }
    }
  }

  // ---- INPUT ----
  window.addEventListener('keydown', (e) => {
    // Leave title → show login GUI
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    // Login typing
    if (!loggedIn && showLoginGUI && activeField) {
      if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else passwordStr = passwordStr.slice(0, -1);
        e.preventDefault(); return;
      }
      if (e.key === 'Enter') { send({ type: 'login', username: usernameStr, password: passwordStr }); e.preventDefault(); return; }
      if (e.key.length === 1) { if (activeField === 'username') usernameStr += e.key; else passwordStr += e.key; return; }
    }

    // Movement (cost 1 stamina, block at 0)
    if (loggedIn && localPlayer) {
      let dx = 0, dy = 0;
      const k = e.key.toLowerCase();
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;

      if ((dx || dy) && (localPlayer.stamina || 0) > 0) {
        send({ type: 'move', dx, dy });
        localPlayer.stamina = Math.max(0, (localPlayer.stamina || 0) - 1); // optimistic
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (!(connected && showLoginGUI && !loggedIn)) return;

    const inField = (fld) => (mx >= fld.x && mx <= fld.x + fld.w && my >= (fld.y - 14) && my <= (fld.y - 14 + fld.h));
    if (inField(GUI.username)) { activeField = 'username'; return; }
    if (inField(GUI.password)) { activeField = 'password'; return; }

    const inBtn = (b) => (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
    if (inBtn(GUI.loginBtn))  { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
    if (inBtn(GUI.signupBtn)) { send({ type: 'signup', username: usernameStr, password: passwordStr }); return; }

    activeField = null;
  });

  // ---- ISO HELPERS ----
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    const base = isoBase(x, y);
    const camBase = localPlayer
      ? isoBase(localPlayer.pos_x + PLAYER_LOC_OFFSET_X, localPlayer.pos_y + PLAYER_LOC_OFFSET_Y)
      : isoBase(0, 0);
    return {
      screenX: PLAYER_SCREEN_X + (base.x - camBase.x),
      screenY: PLAYER_SCREEN_Y + (base.y - camBase.y)
    };
  }

  // Center 61×31 art on 64×32 logical tile
  const tileArtOffsetX = Math.floor((TILE_W - FLOOR_W) / 2);
  const tileArtOffsetY = Math.floor((TILE_H - FLOOR_H) / 2);

  function drawTileAt(x, y, tileId) {
    if (!floorTiles.length) return;
    const tile = floorTiles[tileId] || floorTiles[0];
    const { screenX, screenY } = isoScreen(x, y);
    ctx.drawImage(tile,
      Math.round(screenX + tileArtOffsetX),
      Math.round(screenY + tileArtOffsetY));
  }

  function drawPlayer(p) {
    if (!playerSprite) return;
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);

    // sprite (draw AFTER floor, BEFORE border)
    ctx.drawImage(playerSprite,
      Math.round(screenX + PLAYER_SPRITE_OFFSET_X),
      Math.round(screenY + PLAYER_SPRITE_OFFSET_Y));

    // name (outlined, centered)
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    const nx = Math.round(screenX + PLAYER_NAME_OFFSET_X);
    const ny = Math.round(screenY + PLAYER_NAME_OFFSET_Y);
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nx, ny);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nx, ny);
    ctx.lineWidth = 1;
  }

  function drawChatBox() {
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    const w = (CHAT.x2 - CHAT.x1) - CHAT.pad*2;
    const lineH = 16;
    let y = CHAT.y2 - CHAT.pad; // bottom-up
    for (let i = messages.length - 1; i >= 0; i--) {
      let s = messages[i];
      while (ctx.measureText(s).width > w && s.length > 1) s = s.slice(0, -1);
      ctx.fillText(s, CHAT.x1 + CHAT.pad, y);
      y -= lineH;
      if (y < CHAT.y1 + CHAT.pad) break;
    }
  }

  function drawHUD() {
    if (!localPlayer) return;
    const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
    const sp = clamp((localPlayer.stamina||0)/(localPlayer.max_stamina||1),0,1);
    const lp = clamp((localPlayer.life||0)/(localPlayer.max_life||1),0,1);
    const sH = sp * HUD.h, lH = lp * HUD.h;

    // stamina (green)
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(HUD.staminaX, HUD.yBot - sH, 10, sH);

    // life (red)
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(HUD.lifeX, HUD.yBot - lH, 10, lH);

    // magic (outlined yellow)
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    const magicStr = `${localPlayer.magic ?? 0}/${localPlayer.max_magic ?? 0}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'black';
    ctx.strokeText(magicStr, HUD.magicText.x, HUD.magicText.y);
    ctx.fillStyle = 'yellow';
    ctx.fillText(magicStr, HUD.magicText.x, HUD.magicText.y);

    // gold (outlined white)
    const goldStr = String(localPlayer.gold ?? 0);
    ctx.strokeText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.fillStyle = 'white';
    ctx.fillText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.lineWidth = 1;
  }

  // ---- SCREENS ----
  function drawTitleConnecting() {
    if (imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    ctx.fillStyle = 'yellow';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'left';
    const msg = connected ? 'Press any key to enter!' : 'Connecting to server...';
    ctx.fillText(msg, 47, 347);
  }

  function drawLogin() {
    // Border only (title not shown here)
    const border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // Labels (white) with small -2 y tweak per your note
    ctx.fillStyle = '#fff';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2 - 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2 - 2);

    // Username field
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr, GUI.username.x + 4, GUI.username.y + 2);

    // Password field
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
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

    // Chat on top of border
    drawChatBox();
  }

  function drawGame() {
    // FLOOR (use tilemap[x][y] per your “y vs x” request)
    if (mapSpec && mapSpec.tilemap) {
      for (let y = 0; y < mapSpec.height; y++) {
        for (let x = 0; x < mapSpec.width; x++) {
          const col = mapSpec.tilemap[x];      // flip access
          const id  = (col && typeof col[y] !== 'undefined') ? col[y] : 0;
          drawTileAt(x, y, id || 0);           // 0-based tile index
        }
      }
    }

    // PLAYERS (above floor)
    const list = Object.values(otherPlayers);
    if (localPlayer) list.push(localPlayer);
    list.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    list.forEach(p => drawPlayer(p));

    // BORDER
    const border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // HUD + CHAT (on top of border)
    drawHUD();
    drawChatBox();
  }

  // ---- MAIN LOOP ----
  function loop() {
    ctx.clearRect(0,0,CANVAS_W,CANVAS_H);
    if (!connected || connectionPaused) drawTitleConnecting();
    else if (showLoginGUI && !loggedIn) drawLogin();
    else if (loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();

  // Start
  connectToServer();
});
