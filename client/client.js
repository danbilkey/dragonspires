// client.js
// Title screen, login GUI on-canvas, magenta transparency for border & player,
// floor.png (61x31) extraction w/ 1px gutters, new map schema (tilemap),
// HUD & chat drawn after border, stamina cost=1, alignment fixes.

document.addEventListener('DOMContentLoaded', () => {
  // ---- CONFIG ----
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS  = "ws://localhost:3000";
  const WS_URL  = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const CANVAS_W = 640, CANVAS_H = 480;
  const TILE_W = 64, TILE_H = 32;           // isometric logic size
  const FLOOR_W = 61, FLOOR_H = 31;         // floor.png actual tile art size
  const GUT = 1, FLOOR_ROWS = 9, FLOOR_COLS = 11;

  // Center of playfield inside the window (we put the player here)
  const PLAYER_SCREEN_X = 320;
  const PLAYER_SCREEN_Y = 240;

  // Render alignment offsets
  const PLAYER_LOC_OFFSET_X = -5;   // tweak "actual location" used by camera
  const PLAYER_LOC_OFFSET_Y = 0;
  const PLAYER_SPRITE_OFFSET_X = -41; // tweak sprite over its tile
  const PLAYER_SPRITE_OFFSET_Y = 4;
  const PLAYER_NAME_OFFSET_X   = -2;  // name above head
  const PLAYER_NAME_OFFSET_Y   = -14;

  // Login GUI positions (already shifted +50,+50 earlier)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn:{ x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat area (on top of border)
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };

  // HUD positions (drawn AFTER border so they appear on top)
  const HUD = {
    // vertical bars from y:19 → y:135
    yTop: 19, yBot: 135, h: (135 - 19),
    staminaX: 200,      // 10px wide (200..209)
    lifeX: 224,         // 10px wide (224..233)
    magicText: { x: 184 - 7, y: 239 + 8 }, // with outlined text
    goldText:  { x: 177,     y: 267 + 6 }  // with outlined text
  };

  // ---- CANVAS ----
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Missing <canvas id="gameCanvas">'); return; }
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // ---- STATE ----
  let ws = null;
  let connected = false;        // websocket open?
  let connectionPaused = false; // after open, waiting for any key/click
  let showLoginGUI = false;
  let loggedIn = false;

  let usernameStr = "";
  let passwordStr = "";
  let activeField = null; // 'username' | 'password' | null

  let localPlayer = null; // {id, username, map_id, pos_x, pos_y, stamina, ...}
  let otherPlayers = {};  // id -> player
  let messages = [];

  // Map (new schema)
  let mapSpec = { width: 52, height: 100, tilemap: [] }; // filled after login

  // ---- ASSETS ----
  const imgTitle = new Image();  imgTitle.src  = "/assets/title.GIF";

  const imgBorderSrc = new Image(); imgBorderSrc.src = "/assets/game_border_2025.gif";
  let imgBorder = null; // processed (magenta transparent)

  const imgPlayerSrc = new Image(); imgPlayerSrc.src = "/assets/player.gif";
  let playerSprite = null; // processed (magenta transparent & cropped or full)

  const imgFloor = new Image(); imgFloor.src = "/assets/floor.png";
  let floorTiles = []; // processed tiles (magenta transparent), 0-based index

  // ---- UTIL: apply magenta transparency to an Image -> returns HTMLImageElement ----
  function makeMagentaTransparent(img, sx=0, sy=0, sw=img.width, sh=img.height) {
    const off = document.createElement('canvas');
    off.width = sw; off.height = sh;
    const octx = off.getContext('2d');
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = octx.getImageData(0, 0, sw, sh);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0; // pure magenta -> transparent
    }
    octx.putImageData(data, 0, 0);
    const out = new Image(); out.src = off.toDataURL();
    return out;
  }

  // Process border (magenta -> transparent)
  imgBorderSrc.onload = () => { imgBorder = makeMagentaTransparent(imgBorderSrc); };

  // Process player (magenta -> transparent). Use single frame crop (264,1 → 44x55).
  imgPlayerSrc.onload = () => {
    try {
      playerSprite = makeMagentaTransparent(imgPlayerSrc, 264, 1, 44, 55);
    } catch {
      playerSprite = imgPlayerSrc; // fallback
    }
  };

  // Extract floor.png tiles (61x31 with 1px gutters), 0-based index
  function extractFloorTiles() {
    const off = document.createElement('canvas');
    off.width = FLOOR_W; off.height = FLOOR_H;
    const octx = off.getContext('2d');
    floorTiles = [];
    for (let r = 0; r < FLOOR_ROWS; r++) {
      for (let c = 0; c < FLOOR_COLS; c++) {
        const sx = 1 + c * (FLOOR_W + GUT);
        const sy = 1 + r * (FLOOR_H + GUT);
        octx.clearRect(0,0,FLOOR_W,FLOOR_H);
        octx.drawImage(imgFloor, sx, sy, FLOOR_W, FLOOR_H, 0, 0, FLOOR_W, FLOOR_H);
        const data = octx.getImageData(0, 0, FLOOR_W, FLOOR_H);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
        }
        octx.putImageData(data, 0, 0);
        const tileImg = new Image(); tileImg.src = off.toDataURL();
        floorTiles.push(tileImg);
      }
    }
  }
  imgFloor.onload = extractFloorTiles;

  // ---- MAP LOAD (after login, using player.map_id) ----
  async function loadMapById(mapId) {
    const name = `map${mapId || 1}.json`;
    try {
      const res = await fetch(name);
      const m = await res.json();
      // expect { width, height, tilemap }
      if (m && m.width && m.height && Array.isArray(m.tilemap)) mapSpec = m;
    } catch (e) {
      console.warn("Failed to load map file", e);
    }
  }

  // ---- WEBSOCKET ----
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connected = true;
      connectionPaused = true;   // switch to border + "Press any key to enter!"
      showLoginGUI = false;
    };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data); if (!data) return;
      handleServerMessage(data);
    };
    ws.onclose = () => {
      connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false;
      localPlayer = null; otherPlayers = {}; messages = [];
    };
  }
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success': {
        loggedIn = true;
        localPlayer = msg.player;
        messages.push("Welcome to DragonSpires!");
        loadMapById(localPlayer.map_id);
        break;
      }
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
          const name = otherPlayers[msg.id]?.username || `#${msg.id}`;
          messages.push(`${name} has left DragonSpires.`);
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
        messages.push(msg.message || 'Auth error');
        break;
      }
    }
  }

  // ---- INPUT ----
  window.addEventListener('keydown', (e) => {
    // Proceed from border screen to login GUI
    if (connected && connectionPaused) {
      connectionPaused = false; showLoginGUI = true; return;
    }

    // Typing into login GUI
    if (!loggedIn && showLoginGUI && activeField) {
      if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else passwordStr = passwordStr.slice(0, -1);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        send({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault();
        return;
      }
      if (e.key.length === 1) {
        if (activeField === 'username') usernameStr += e.key;
        else passwordStr += e.key;
        return;
      }
    }

    // Game movement (stamina cost 1; block at 0)
    if (loggedIn && localPlayer) {
      let dx = 0, dy = 0;
      const k = e.key.toLowerCase();
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;

      if ((dx || dy) && localPlayer.stamina > 0) {
        send({ type: 'move', dx, dy });
        // optimistic local drain
        localPlayer.stamina = Math.max(0, (localPlayer.stamina || 0) - 1);
      }
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (!(connected && showLoginGUI && !loggedIn)) return;

    // Accurate hit boxes for inputs
    const inBox = (bx, by, bw, bh) => (mx >= bx && mx <= bx + bw && my >= (by - 14) && my <= (by - 14 + bh));

    if (inBox(GUI.username.x, GUI.username.y, GUI.username.w, GUI.username.h)) {
      activeField = 'username'; return;
    }
    if (inBox(GUI.password.x, GUI.password.y, GUI.password.w, GUI.password.h)) {
      activeField = 'password'; return;
    }

    // Buttons (drawn fully at y)
    const inBtn = (b) => (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h);
    if (inBtn(GUI.loginBtn)) { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
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

  // ---- DRAW HELPERS ----
  const tileArtOffsetX = Math.floor((TILE_W - FLOOR_W) / 2); // center 61 on 64
  const tileArtOffsetY = Math.floor((TILE_H - FLOOR_H) / 2); // center 31 on 32

  function drawTileAt(x, y, tileId) {
    if (!floorTiles.length) return;
    // tileId is 0-based (first extracted tile is tile 0)
    const tile = floorTiles[tileId] || floorTiles[0];
    const { screenX, screenY } = isoScreen(x, y);
    ctx.drawImage(tile, Math.round(screenX + tileArtOffsetX), Math.round(screenY + tileArtOffsetY));
  }

  function drawPlayer(p) {
    if (!playerSprite) return;
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    // sprite
    ctx.drawImage(playerSprite,
      Math.round(screenX + PLAYER_SPRITE_OFFSET_X),
      Math.round(screenY + PLAYER_SPRITE_OFFSET_Y));

    // name (outlined, centered)
    const nx = Math.round(screenX + PLAYER_NAME_OFFSET_X);
    const ny = Math.round(screenY + PLAYER_NAME_OFFSET_Y);
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nx, ny);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nx, ny);
    ctx.lineWidth = 1;
  }

  function drawChatBox() {
    // no background; black text; draw on top of border
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    const w = (CHAT.x2 - CHAT.x1) - CHAT.pad*2;
    const lineH = 16;
    let y = CHAT.y2 - CHAT.pad; // bottom-up
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = messages[i];
      // very simple clipping (no hard wrap): truncate if wider than box
      let s = text;
      while (ctx.measureText(s).width > w && s.length > 1) s = s.slice(0, -1);
      ctx.fillText(s, CHAT.x1 + CHAT.pad, y);
      y -= lineH;
      if (y < CHAT.y1 + CHAT.pad) break;
    }
  }

  function drawHUD() {
    if (!localPlayer) return;
    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    const sp = clamp((localPlayer.stamina || 0)/(localPlayer.max_stamina || 1), 0, 1);
    const lp = clamp((localPlayer.life    || 0)/(localPlayer.max_life    || 1), 0, 1);

    // vertical bars from top (yTop) down to yBot
    const sH = sp * HUD.h;
    const lH = lp * HUD.h;

    // stamina (bright green)
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(HUD.staminaX, HUD.yBot - sH, 10, sH);

    // life (bright red)
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(HUD.lifeX, HUD.yBot - lH, 10, lH);

    // magic text (outlined yellow)
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    const magicStr = `${localPlayer.magic ?? 0}/${localPlayer.max_magic ?? 0}`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'black';
    ctx.strokeText(magicStr, HUD.magicText.x, HUD.magicText.y);
    ctx.fillStyle = 'yellow';
    ctx.fillText(magicStr, HUD.magicText.x, HUD.magicText.y);

    // gold text (outlined white)
    const goldStr = String(localPlayer.gold ?? 0);
    ctx.strokeText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.fillStyle = 'white';
    ctx.fillText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.lineWidth = 1;
  }

  // ---- SCREENS ----
  function drawTitleConnecting() {
    // background: title.GIF
    if (imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    // message
    ctx.fillStyle = 'yellow';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'left';
    const msg = connected ? 'Press any key to enter!' : 'Connecting to server...';
    ctx.fillText(msg, 47, 347);
  }

  function drawLogin() {
    // show border (magenta transparent)
    const border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // Labels (white) — tiny y tweak (-2 requested)
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

    // Buttons (visible under inputs)
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    // Chat on login screen too (on top of border)
    drawChatBox();
  }

  function drawGame() {
    // Floor
    if (Array.isArray(mapSpec.tilemap) && mapSpec.tilemap.length) {
      for (let y = 0; y < mapSpec.height; y++) {
        const row = mapSpec.tilemap[y];
        if (!row) continue;
        for (let x = 0; x < mapSpec.width; x++) {
          drawTileAt(x, y, row[x] || 0); // 0-based tile index
        }
      }
    }

    // Players (depth sort)
    const list = Object.values(otherPlayers);
    if (localPlayer) list.push(localPlayer);
    list.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    list.forEach(p => drawPlayer(p));

    // Border on top
    const border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // HUD & Chat on top of border
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
