// client.js
// Reworked: isometric map, single local player (no ghost), name labels,
// canvas-based GUI moved +50,+50, black typed text, visible buttons.

document.addEventListener('DOMContentLoaded', () => {
  // ------------ CONFIG -------------
  const DEV_WS = "ws://localhost:3000";
  const PROD_WS = "wss://dragonspires.onrender.com";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const CANVAS_ID = "gameCanvas";
  const CANVAS_W = 640;
  const CANVAS_H = 480;

  // player fixed screen position (where player's sprite is drawn)
  const PLAYER_SCREEN_X = 430;
  const PLAYER_SCREEN_Y = 142;

  // isometric tile size
  const TILE_W = 64;
  const TILE_H = 32;

  // default map size (will be replaced by map.json)
  let mapSpec = { width: 10, height: 10, tiles: [] };

  // GUI base (moved +50 right/down relative to prior values)
  const GUI_OFFSET_X = 50;
  const GUI_OFFSET_Y = 50;

  const GUI = {
    boxX: 236 + GUI_OFFSET_X, boxY: 24 + GUI_OFFSET_Y, boxW: 376, boxH: 48,
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 520 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 80, h: 18 },
    signupBtn: { x: 520 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 80, h: 18 }
  };

  // ------------ STATE -------------
  const canvas = document.getElementById(CANVAS_ID);
  if (!canvas) {
    console.error(`Missing canvas id="${CANVAS_ID}"`);
    return;
  }
  const ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  let ws = null;
  let connected = false;
  let loggedIn = false;

  let usernameStr = "";
  let passwordStr = "";
  let activeField = null; // "username" or "password" or null

  // local player (server authoritative); otherPlayers keyed by id
  let localPlayer = null; // { id, username, pos_x, pos_y }
  let otherPlayers = {};

  // assets
  const imgTitle = new Image();
  const imgBorder = new Image();
  const imgPlayerSource = new Image();
  let playerSprite = null;     // processed sprite (cropped & transparent) or fallback
  let borderProcessed = null;  // processed border (white -> transparent) canvas
  let assets = { title: false, border: false, playerSrc: false };

  // ------------ MAP LOAD & ASSETS -------------
  fetch('map.json')
    .then(r => r.json())
    .then(m => {
      if (m && m.width && m.height && Array.isArray(m.tiles)) {
        mapSpec = m;
      } else {
        console.warn("map.json malformed; using fallback 10x10");
      }
      loadAssets();
      startInputHandlers();
      requestAnimationFrame(loop);
    })
    .catch(err => {
      console.error("Failed to load map.json:", err);
      loadAssets();
      startInputHandlers();
      requestAnimationFrame(loop);
    });

  function loadAssets() {
    imgTitle.onload = () => { assets.title = true; };
    imgTitle.onerror = () => { console.warn("title.GIF load failed"); assets.title = false; };
    imgTitle.src = '/assets/title.GIF';

    imgBorder.onload = () => { assets.border = true; processBorder(); };
    imgBorder.onerror = () => { console.warn("game_border_2025.gif load failed"); assets.border = false; };
    imgBorder.src = '/assets/game_border_2025.gif';

    imgPlayerSource.onload = () => { assets.playerSrc = true; processPlayerSprite(); };
    imgPlayerSource.onerror = () => { console.warn("player.gif load failed"); assets.playerSrc = false; };
    imgPlayerSource.src = '/assets/player.gif';
  }

  function processBorder() {
    // Try to make white pixels transparent
    try {
      const w = imgBorder.width, h = imgBorder.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(imgBorder, 0, 0);
      const data = octx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 240 && d[i+1] > 240 && d[i+2] > 240) d[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
      borderProcessed = off;
    } catch (e) {
      console.warn("Could not process border transparent (CORS?)", e);
      borderProcessed = null;
    }
  }

  function processPlayerSprite() {
    // Crop rectangle 264..308 x 1..56 (w=44,h=55)
    const sx = 264, sy = 1, sw = 44, sh = 55;
    try {
      const off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      const octx = off.getContext('2d');
      octx.drawImage(imgPlayerSource, sx, sy, sw, sh, 0, 0, sw, sh);
      const data = octx.getImageData(0, 0, sw, sh);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 16 && d[i+1] < 16 && d[i+2] < 16) d[i+3] = 0; // make black transparent
      }
      octx.putImageData(data, 0, 0);
      const img = new Image();
      img.src = off.toDataURL();
      playerSprite = img;
    } catch (e) {
      console.warn("Could not crop/process player sprite (CORS?), using source image as fallback", e);
      playerSprite = imgPlayerSource;
    }
  }

  // ------------ WEBSOCKET -------------
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("WS connected");
      connected = true;
    };
    ws.onmessage = (evt) => {
      const msg = safeParse(evt.data);
      if (!msg) return;
      handleServerMessage(msg);
    };
    ws.onerror = (e) => console.error("WS error", e);
    ws.onclose = () => {
      console.log("WS closed");
      connected = false;
    };
  }
  connectToServer(); // start early so connecting screen shows

  function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  function sendWS(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    else console.warn("WS not open, cannot send", obj);
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success':
        loggedIn = true;
        localPlayer = msg.player;
        // rebuild otherPlayers from provided list (server should exclude the local player already)
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => {
            if (!localPlayer || p.id !== localPlayer.id) otherPlayers[p.id] = p;
          });
        }
        break;
      case 'player_joined':
        // Only add if it's not our local player
        if (!localPlayer || msg.player.id !== localPlayer.id) otherPlayers[msg.player.id] = msg.player;
        break;
      case 'player_moved':
        // Server authoritative: if it is our id, update localPlayer; otherwise update otherPlayers
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
        } else {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}` };
          otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y;
        }
        break;
      case 'player_left':
        delete otherPlayers[msg.id];
        break;
      case 'login_error':
      case 'signup_error':
        alert(msg.message || "Auth error");
        break;
      default:
        break;
    }
  }

  // ------------ INPUT HANDLERS (canvas-based GUI) -------------
  function startInputHandlers() {
    canvas.addEventListener('mousedown', (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      // If not connected, clicking on canvas attempts to connect (allow user to click to wake cold-start)
      if (!connected) { connectToServer(); return; }

      // If connected but not logged in -> GUI interactions
      if (connected && !loggedIn) {
        // username box
        const u = GUI.username;
        if (mx >= u.x && mx <= u.x + u.w && my >= u.y - 14 && my <= u.y + u.h) { activeField = "username"; return; }
        const p = GUI.password;
        if (mx >= p.x && mx <= p.x + p.w && my >= p.y - 14 && my <= p.y + p.h) { activeField = "password"; return; }
        const lb = GUI.loginBtn;
        if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y - 14 && my <= lb.y + lb.h) {
          sendWS({ type: 'login', username: usernameStr, password: passwordStr });
          return;
        }
        const sb = GUI.signupBtn;
        if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y - 14 && my <= sb.y + sb.h) {
          sendWS({ type: 'signup', username: usernameStr, password: passwordStr });
          return;
        }
        activeField = null;
      }
    });

    window.addEventListener('keydown', (e) => {
      // GUI input capture when connected & not logged in
      if (connected && !loggedIn && activeField) {
        if (e.key === 'Backspace') {
          if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
          else passwordStr = passwordStr.slice(0, -1);
          e.preventDefault();
          return;
        } else if (e.key === 'Enter') {
          sendWS({ type: 'login', username: usernameStr, password: passwordStr });
          e.preventDefault();
          return;
        } else if (e.key.length === 1) {
          if (activeField === 'username') usernameStr += e.key;
          else passwordStr += e.key;
        }
      }

      // Movement keys after login (client-side bounds check then send)
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
            // optimistic update
            localPlayer.pos_x = nx; localPlayer.pos_y = ny;
            sendWS({ type: 'move', dx, dy });
          }
        }
      }
    });
  }

  // ------------ RENDERING: isometric helpers -------------
  // world -> isometric base coords
  function isoBase(x, y) {
    return { x: (x - y) * (TILE_W / 2), y: (x + y) * (TILE_H / 2) };
  }

  // convert tile coords -> screen coords based on camera anchored to localPlayer,
  // then offset so top-left of tile bounding box is correct and player is at PLAYER_SCREEN_X/Y.
  function isoScreen(x, y) {
    // if no localPlayer, center map visually
    const centerX = PLAYER_SCREEN_X;
    const centerY = PLAYER_SCREEN_Y;

    const base = isoBase(x, y);
    const camBase = localPlayer ? isoBase(localPlayer.pos_x, localPlayer.pos_y) : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));

    const screenX = centerX - TILE_W / 2 + (base.x - camBase.x);
    const screenY = centerY - TILE_H / 2 + (base.y - camBase.y);
    return { screenX, screenY };
  }

  function drawTile(screenX, screenY, t) {
    ctx.beginPath();
    ctx.moveTo(screenX, screenY + TILE_H/2);
    ctx.lineTo(screenX + TILE_W/2, screenY);
    ctx.lineTo(screenX + TILE_W, screenY + TILE_H/2);
    ctx.lineTo(screenX + TILE_W/2, screenY + TILE_H);
    ctx.closePath();
    if (t === 1) ctx.fillStyle = "#C68642";
    else ctx.fillStyle = "#8DBF63";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.stroke();
  }

  function drawPlayerSprite(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    // center of avatar
    const cx = screenX + TILE_W/2;
    const cy = screenY + TILE_H/2;
    if (playerSprite && playerSprite.complete) {
      // draw sprite with its top-left at tile bbox
      ctx.drawImage(playerSprite, screenX, screenY, TILE_W, TILE_H);
    } else {
      // fallback: circle
      ctx.beginPath();
      ctx.ellipse(cx, cy - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fillStyle = isLocal ? "#1E90FF" : "#FF6347";
      ctx.fill();
      ctx.strokeStyle = "#000"; ctx.stroke();
    }
    // name tag (always visible, white text with black stroke for contrast)
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "black";
    ctx.strokeText(p.username || `#${p.id}`, cx, cy - 18);
    ctx.fillStyle = "white";
    ctx.fillText(p.username || `#${p.id}`, cx, cy - 18);
    ctx.lineWidth = 1;
  }

  // draw border overlay (use processed border if available)
  function drawBorderOverlay() {
    if (borderProcessed) ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
    else if (assets.border && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
  }

  // ------------ MAIN DRAW LOOP -------------
  function drawConnecting() {
    // title
    if (assets.title && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle="#111"; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); ctx.fillStyle="#fff"; ctx.fillText("DragonSpires", 20, 40); }
    ctx.fillStyle = "yellow";
    ctx.font = "16px sans-serif";
    ctx.fillText("Connecting to server...", 47, 347);
  }

  function drawLoginGUI() {
    // draw background border (if available)
    if (assets.border && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle="#223"; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // Labels (white)
    ctx.fillStyle = "#FFF";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Username:", GUI.username.x - 70, GUI.username.y + 4);
    ctx.fillText("Password:", GUI.password.x - 70, GUI.password.y + 4);

    // username box (black bg, black typed text)
    ctx.strokeStyle = activeField === "username" ? "yellow" : "#FFF";
    ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = "#FFF"; ctx.fillRect(GUI.username.x+1, GUI.username.y-13, GUI.username.w-2, GUI.username.h-2);
    ctx.fillStyle = "#000"; ctx.font = "12px sans-serif";
    ctx.fillText(usernameStr || "", GUI.username.x + 4, GUI.username.y + 2);

    // password box (masked)
    ctx.strokeStyle = activeField === "password" ? "yellow" : "#FFF";
    ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = "#FFF"; ctx.fillRect(GUI.password.x+1, GUI.password.y-13, GUI.password.w-2, GUI.password.h-2);
    ctx.fillStyle = "#000";
    ctx.fillText("*".repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    // Buttons - visible fill and border and black text
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ddd";
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y - 14, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y - 14, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y - 14, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y - 14, GUI.signupBtn.w, GUI.signupBtn.h);

    ctx.fillStyle = "#000"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Login", GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + 2);
    ctx.fillText("Create Account", GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + 2);
  }

  function drawGameWorld() {
    // clear
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0,0,CANVAS_W,CANVAS_H);

    if (!localPlayer) return; // nothing to center on

    // Draw tiles in correct isometric order (y then x)
    // To handle depth we should draw tiles row by row and players sorted by (x+y)
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        const { screenX, screenY } = isoScreen(x, y);
        const t = (mapSpec.tiles && mapSpec.tiles[y] && mapSpec.tiles[y][x] !== undefined) ? mapSpec.tiles[y][x] : 0;
        drawTile(screenX, screenY, t);
      }
    }

    // collect all players (otherPlayers + local) and sort by depth (x+y) to draw in correct order
    const all = Object.values(otherPlayers).concat(localPlayer ? [localPlayer] : []);
    all.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));

    // draw each player (skip drawing local twice)
    all.forEach(p => {
      const isLocal = localPlayer && p.id === localPlayer.id;
      // If server incorrectly sent local player as otherPlayers, ensure we don't draw duplicate:
      if (isLocal) drawPlayerSprite(localPlayer, true);
      else drawPlayerSprite(p, false);
    });

    // overlay border (processed to be transparent on white)
    drawBorderOverlay();
  }

  function loop() {
    if (!connected) drawConnecting();
    else if (connected && !loggedIn) drawLoginGUI();
    else drawGameWorld();
    requestAnimationFrame(loop);
  }

  // start the render loop (already requested after map load)
  // requestAnimationFrame(loop); // called in bootstrap

  // ------------ Exposed GUI functions (for debugging / backward compatibility) -------------
  window.connectToServer = connectToServer;
  window.getState = () => ({ connected, loggedIn, localPlayer, otherPlayers });

  // end of DOMContentLoaded
});
