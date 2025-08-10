// client.js
// Isometric map, canvas GUI login, chat overlay (transparent bg, black text),
// sprite anchor correction (+32, -16), border color-key transparency (0,0,82),
// title never shown after continuing, precise input hitboxes.

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

  // Player screen anchor and sprite offset
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;     // previous sheet alignment
  const ANCHOR_SHIFT_X = 32,   ANCHOR_SHIFT_Y = -16;       // NEW: shift base tile by (+32, -16)

  // GUI placement (moved +50,+50 earlier)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const FIELD_H = 16;
  const FIELD_TOP = (y) => (y - 13);
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: FIELD_H },
    loginBtn:  { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn: { x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat box region (topmost overlay)
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };

  // ---------- STATE ----------
  let ws = null;
  let connected = false;
  let connectionPaused = false; // after ws open; wait for key/click to continue
  let showLoginGUI = false;     // title should never render once this is true
  let loggedIn = false;

  let mapSpec = { width: 10, height: 10, tiles: [] }; // will load from map.json

  let usernameStr = "";
  let passwordStr = "";
  let activeField = null; // 'username'|'password'|null

  let localPlayer = null; // {id, username, pos_x, pos_y}
  let otherPlayers = {};  // id -> player

  let messages = [];      // chat lines (bottom-up render)

  // ---------- ASSETS ----------
  const imgTitle = new Image();
  imgTitle.src = "/assets/title.GIF";

  const imgBorder = new Image();
  imgBorder.src = "/assets/game_border_2025.gif";
  let borderProcessed = null; // offscreen canvas with color-key transparency

  imgBorder.onload = () => {
    // Make RGB (0, 0, 82) fully transparent
    try {
      const w = imgBorder.width, h = imgBorder.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(imgBorder, 0, 0);
      const data = octx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i+1], b = d[i+2];
        if (r === 0 && g === 0 && b === 82) {
          d[i+3] = 0; // transparent
        }
      }
      octx.putImageData(data, 0, 0);
      borderProcessed = off;
    } catch (e) {
      console.warn("Border transparency processing failed (likely CORS). Using opaque border.");
      borderProcessed = null;
    }
  };

  const imgPlayerSrc = new Image();
  imgPlayerSrc.src = "/assets/player.gif";

  let playerSprite = null;
  imgPlayerSrc.onload = () => {
    // Crop (264,1)-(308,56) → 44x55, make black transparent; fallback if CORS blocks.
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
    } catch (e) {
      console.warn("Could not process player.gif in browser (CORS?). Using source image.");
      playerSprite = imgPlayerSrc;
    }
  };

  // ---------- MAP LOAD ----------
  fetch('map.json')
    .then(r => r.json())
    .then(m => { if (m && m.width && m.height && Array.isArray(m.tiles)) mapSpec = m; })
    .catch(err => console.warn("Could not load map.json; using fallback 10x10", err));

  // ---------- WEBSOCKET ----------
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      connected = true;
      connectionPaused = true;  // show "Press any key to enter!"
      showLoginGUI = false;     // title still shows UNTIL user presses a key; then never again
    };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      handleServerMessage(data);
    };
    ws.onerror = (e) => console.error("WS error", e);
    ws.onclose = () => {
      connected = false;
      connectionPaused = false;
      showLoginGUI = false;
      loggedIn = false;
      localPlayer = null;
      otherPlayers = {};
    };
  }
  connectToServer();

  function safeParse(s) { try { return JSON.parse(s); } catch(_) { return null; } }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function pushChat(text) {
    messages.push(String(text));
    if (messages.length > 200) messages.shift();
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success':
        loggedIn = true;
        localPlayer = msg.player;
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => { if (!localPlayer || p.id !== localPlayer.id) otherPlayers[p.id] = p; });
        }
        // Welcome message for current user
        pushChat("Welcome to DragonSpires!");
        break;

      case 'player_joined':
        // Only add & announce other players
        if (!localPlayer || msg.player.id !== localPlayer.id) {
          otherPlayers[msg.player.id] = msg.player;
          const name = msg.player.username || msg.player.id;
          pushChat(`${name} has entered DragonSpires!`);
        }
        break;

      case 'player_moved':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
        } else {
          if (!otherPlayers[msg.id]) {
            otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}`, pos_x: msg.x, pos_y: msg.y };
          } else {
            otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y;
          }
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
      showLoginGUI = true;   // after this, title should never render again
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
      if (dx !== 0 || dy !== 0) {
        const nx = localPlayer.pos_x + dx;
        const ny = localPlayer.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
          localPlayer.pos_x = nx; localPlayer.pos_y = ny;
          send({ type: 'move', dx, dy });
        }
      }
    }

    // GUI typing
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
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) {
      connectionPaused = false;
      showLoginGUI = true; // title stops rendering after this
      return;
    }

    if (connected && showLoginGUI && !loggedIn) {
      const u = GUI.username;
      const p = GUI.password;
      const lb = GUI.loginBtn;
      const sb = GUI.signupBtn;

      const uTop = FIELD_TOP(u.y), uBottom = uTop + u.h;
      const pTop = FIELD_TOP(p.y), pBottom = pTop + p.h;

      if (mx >= u.x && mx <= u.x + u.w && my >= uTop && my <= uBottom) {
        activeField = 'username'; return;
      } else if (mx >= p.x && mx <= p.x + p.w && my >= pTop && my <= pBottom) {
        activeField = 'password'; return;
      } else if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) {
        send({ type: 'login', username: usernameStr, password: passwordStr }); return;
      } else if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) {
        send({ type: 'signup', username: usernameStr, password: passwordStr }); return;
      }
      activeField = null;
    }
  });

  // ---------- RENDER HELPERS ----------
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    const base = isoBase(x, y);
    const camBase = localPlayer ? isoBase(localPlayer.pos_x, localPlayer.pos_y)
                                : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));
    // Base screen position of tile top-left
    let screenX = PLAYER_SCREEN_X - TILE_W/2 + (base.x - camBase.x);
    let screenY = PLAYER_SCREEN_Y - TILE_H/2 + (base.y - camBase.y);
    // Apply requested (+32, -16) anchor shift
    screenX += ANCHOR_SHIFT_X;
    screenY += ANCHOR_SHIFT_Y;
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
    // Get shifted tile screen position (includes +32,-16)
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);

    // Final sprite placement = shifted tile + sprite offset
    const drawX = screenX + PLAYER_OFFSET_X;
    const drawY = screenY + PLAYER_OFFSET_Y;

    if (playerSprite && playerSprite.complete) {
      const w = playerSprite.naturalWidth || playerSprite.width;
      const h = playerSprite.naturalHeight || playerSprite.height;
      ctx.drawImage(playerSprite, drawX, drawY, w, h);
    } else {
      // fallback ellipse roughly at tile center (account for shift)
      ctx.fillStyle = isLocal ? '#1E90FF' : '#FF6347';
      ctx.beginPath();
      ctx.ellipse(screenX + TILE_W/2, screenY + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fill();
    }

    // Name label centered over the tile center (independent of sprite width)
    const nameX = screenX + TILE_W / 2;
    const nameY = screenY - 10;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(p.username || `#${p.id}`, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(p.username || `#${p.id}`, nameX, nameY);
    ctx.lineWidth = 1;
  }

  function drawChatBox() {
    const { x1,y1,x2,y2,pad } = CHAT;
    const w = x2 - x1, h = y2 - y1;

    // Transparent background requested: do NOT draw any bg or border.

    // Text (bottom-up), in BLACK
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    const lineH = 16;
    let y = y2 - pad;
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = messages[i];
      // simple clip if too long
      let line = text;
      while (ctx.measureText(line).width > w - pad*2 && line.length > 1) {
        line = line.slice(0, -1);
      }
      ctx.fillText(line, x1 + pad, y);
      y -= lineH;
      if (y < y1 + pad) break;
    }
  }

  // ---------- DRAW SCENES ----------
  function drawConnecting() {
    // Title only while not yet proceeded; once showLoginGUI=true we never draw title again
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!showLoginGUI) {
      if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
      else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    } else {
      // explicit solid background; NO title anymore
      ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    }
    ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
    if (connectionPaused) ctx.fillText('Press any key to enter!', 47, 347);
    else ctx.fillText('Connecting to server...', 47, 347);
  }

  function drawLogin() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // border background (with color-key transparency if processed)
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // labels black
    ctx.fillStyle = '#000'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 4);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 4);

    // username field
    const uTop = FIELD_TOP(GUI.username.y);
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, uTop, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr || '', GUI.username.x + 4, GUI.username.y + 2);

    // password field
    const pTop = FIELD_TOP(GUI.password.y);
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, pTop, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    // buttons
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    // chat (transparent bg, black text) OVER the border
    drawChatBox();
  }

  function drawGame() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // world
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);
    if (!localPlayer) return;

    // tiles
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
        const { screenX, screenY } = isoScreen(x, y);
        drawTile(screenX, screenY, t);
      }
    }

    // players sorted by depth
    const all = Object.values(otherPlayers).concat(localPlayer ? [localPlayer] : []);
    all.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    all.forEach(p => {
      const isLocal = !!(localPlayer && p.id === localPlayer.id);
      if (isLocal) drawPlayer(localPlayer, true);
      else drawPlayer(p, false);
    });

    // border (color-key transparent if processed)
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);

    // chat on top
    drawChatBox();
  }

  // ---------- MAIN LOOP ----------
  function loop() {
    if (!connected) drawConnecting();
    else if (connected && connectionPaused) drawConnecting();
    else if (connected && !showLoginGUI) drawConnecting(); // title won't draw after proceed
    else if (connected && showLoginGUI && !loggedIn) drawLogin();
    else if (connected && loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();

  // minimal click handler bootstrap
  canvas.addEventListener('mousedown', () => {
    if (!connected) { connectToServer(); return; }
    if (connected && connectionPaused) {
      connectionPaused = false;
      showLoginGUI = true;
    }
  });

  // expose connect for debug
  window.connectToServer = connectToServer;
});
