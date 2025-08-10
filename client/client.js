// client.js
document.addEventListener('DOMContentLoaded', () => {
  // Config
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS = "ws://localhost:3000";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error("Missing canvas element with id 'gameCanvas'"); return; }
  const ctx = canvas.getContext('2d');

  // Canvas size
  canvas.width = 640;
  canvas.height = 480;

  // Tile sizes (isometric)
  const TILE_W = 64;
  const TILE_H = 32;

  // Player fixed screen pos
  const PLAYER_SCREEN_X = 430;
  const PLAYER_SCREEN_Y = 142;
  const PLAYER_OFFSET_X = -32; // shift all players left by 16 pixels
  const PLAYER_OFFSET_Y = -16; // shift all players up by 16 pixels

  // Map defaults; will load map.json
  let mapSpec = { width: 10, height: 10, tiles: [] };

  // GUI layout (moved +50,+50 earlier)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }, // below boxes
    signupBtn: { x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 } // beside login
  };

  // Chat box coords: between 156,89 and 618,407
  const CHAT = { x1: 156, y1: 89, x2: 618, y2: 407, padding: 8 };

  // State
  let ws = null;
  let connected = false;
  let loggedIn = false;
  let localPlayer = null;   // {id, username, pos_x, pos_y}
  let otherPlayers = {};    // id -> player
  let usernameStr = "";
  let passwordStr = "";
  let activeField = null; // 'username'|'password'|null
  let messages = []; // chat messages array of strings

  // Assets
  const imgTitle = new Image(); imgTitle.src = "/assets/title.GIF";
  const imgBorder = new Image(); imgBorder.src = "/assets/game_border_2025.gif";
  const imgPlayerSrc = new Image(); imgPlayerSrc.src = "/assets/player.gif";

  let playerSprite = null; // Image of cropped sprite
  // process sprite when loaded
  imgPlayerSrc.onload = () => {
    try {
      // crop area 264,1 -> 308,56 (44x55)
      const sx = 264, sy = 1, sw = 44, sh = 55;
      const off = document.createElement('canvas');
      off.width = sw; off.height = sh;
      const octx = off.getContext('2d');
      octx.drawImage(imgPlayerSrc, sx, sy, sw, sh, 0, 0, sw, sh);
      const data = octx.getImageData(0,0,sw,sh);
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i] < 16 && data.data[i+1] < 16 && data.data[i+2] < 16) {
          data.data[i+3] = 0;
        }
      }
      octx.putImageData(data, 0, 0);
      const img = new Image();
      img.src = off.toDataURL();
      playerSprite = img;
    } catch (e) {
      // CORS or error — fallback to using source image (draw part of it)
      console.warn("Sprite processing failed (CORS?). Using source GIF as fallback.");
      playerSprite = imgPlayerSrc; // may draw entire gif; alignment uses crop offset below
    }
  };

  // WebSocket connect
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => { connected = true; console.log("WS connected"); };
    ws.onmessage = (ev) => {
      const data = safeParse(ev.data);
      if (!data) return;
      handleServerMessage(data);
    };
    ws.onerror = (e) => { console.error("WS error", e); };
    ws.onclose = () => { connected = false; console.log("WS closed"); };
  }
  connect(); // try to connect early so connecting message shows during cold-start

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else console.warn("WS not open - not sending", msg);
  }

  function safeParse(s) { try { return JSON.parse(s); } catch(e) { return null; } }

  // Server messages handling
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
      case 'signup_success':
        loggedIn = true;
        localPlayer = msg.player;
        // Rebuild otherPlayers from server-provided list (server only sends logged-in players)
        otherPlayers = {};
        if (Array.isArray(msg.players)) {
          msg.players.forEach(p => {
            if (!localPlayer || p.id !== localPlayer.id) otherPlayers[p.id] = p;
          });
        }
        break;
      case 'player_joined':
        if (!localPlayer || msg.player.id !== localPlayer.id) otherPlayers[msg.player.id] = msg.player;
        break;
      case 'player_moved':
        if (localPlayer && msg.id === localPlayer.id) {
          localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
        } else {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}`, pos_x: msg.x, pos_y: msg.y };
          else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
        }
        break;
      case 'player_left':
        delete otherPlayers[msg.id];
        break;
      case 'chat':
        if (typeof msg.text === 'string') pushChatMessage(msg.text);
        break;
      case 'login_error':
      case 'signup_error':
        pushChatMessage(msg.message || 'Auth error');
        break;
      default:
        console.log("Unknown server message:", msg);
    }
  }

  // Chat handling: push message to array, keep max messages, show at bottom of box
  function pushChatMessage(text) {
    const line = String(text);
    messages.push(line);
    // Keep recent 200 messages limit
    if (messages.length > 200) messages.shift();
  }

  // Input handlers for canvas-based GUI
  function startInputHandlers() {
    canvas.addEventListener('mousedown', (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;

      if (!connected) { connect(); return; }

      if (!loggedIn) {
        // username box
        const u = GUI.username;
        if (mx >= u.x && mx <= u.x + u.w && my >= u.y - 14 && my <= u.y + u.h) { activeField = 'username'; return; }
        const p = GUI.password;
        if (mx >= p.x && mx <= p.x + p.w && my >= p.y - 14 && my <= p.y + p.h) { activeField = 'password'; return; }
        // login button
        const lb = GUI.loginBtn;
        if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) {
          send({ type: 'login', username: usernameStr, password: passwordStr });
          return;
        }
        const sb = GUI.signupBtn;
        if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) {
          send({ type: 'signup', username: usernameStr, password: passwordStr });
          return;
        }
        activeField = null;
      }
    });

    window.addEventListener('keydown', (e) => {
      if (!connected) return;
      if (!loggedIn && activeField) {
        if (e.key === 'Backspace') {
          if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
          else passwordStr = passwordStr.slice(0, -1);
          e.preventDefault();
          return;
        } else if (e.key === 'Enter') {
          send({ type: 'login', username: usernameStr, password: passwordStr });
          e.preventDefault();
          return;
        } else if (e.key.length === 1) {
          if (activeField === 'username') usernameStr += e.key;
          else passwordStr += e.key;
        }
      }

      // movement keys post-login
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
            // optimistic
            localPlayer.pos_x = nx; localPlayer.pos_y = ny;
            send({ type: 'move', dx, dy });
          }
        }
      }
    });
  }

  // Iso helpers: convert tile coords to screen coordinates centered on localPlayer at PLAYER_SCREEN_X/Y
  function isoBase(x, y) {
    return { x: (x - y) * (TILE_W / 2), y: (x + y) * (TILE_H / 2) };
  }
  function isoScreen(x, y) {
    const centerX = PLAYER_SCREEN_X;
    const centerY = PLAYER_SCREEN_Y;
    const base = isoBase(x, y);
    const camBase = localPlayer ? isoBase(localPlayer.pos_x, localPlayer.pos_y) : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));
    const screenX = centerX - TILE_W/2 + (base.x - camBase.x);
    const screenY = centerY - TILE_H/2 + (base.y - camBase.y);
    return { screenX, screenY };
  }

  // Draw tile diamond
  function drawTile(screenX, screenY, t) {
    ctx.beginPath();
    ctx.moveTo(screenX, screenY + TILE_H/2);
    ctx.lineTo(screenX + TILE_W/2, screenY);
    ctx.lineTo(screenX + TILE_W, screenY + TILE_H/2);
    ctx.lineTo(screenX + TILE_W/2, screenY + TILE_H);
    ctx.closePath();
    ctx.fillStyle = t === 1 ? "#C68642" : "#8DBF63";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.stroke();
  }

  // Draw player with natural sprite dimensions and offset (-16,-16)
  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    const drawX = screenX + PLAYER_OFFSET_X;
    const drawY = screenY + PLAYER_OFFSET_Y;
    if (playerSprite && playerSprite.complete) {
      // draw at natural dimensions
      const w = playerSprite.naturalWidth || playerSprite.width;
      const h = playerSprite.naturalHeight || playerSprite.height;
      // Draw with top-left anchored using offsets
      ctx.drawImage(playerSprite, drawX, drawY, w, h);
    } else {
      // fallback: small rectangle centered on tile
      ctx.fillStyle = isLocal ? "#1E90FF" : "#FF6347";
      ctx.fillRect(drawX + 8, drawY + 8, TILE_W/2, TILE_H/2);
    }
    // Name tag above head
    const cx = drawX + (playerSprite && playerSprite.naturalWidth ? (playerSprite.naturalWidth/2) : (TILE_W/2));
    const cy = drawY - 6;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3; ctx.strokeStyle = "black"; ctx.strokeText(p.username || `#${p.id}`, cx, cy);
    ctx.fillStyle = "white"; ctx.fillText(p.username || `#${p.id}`, cx, cy);
    ctx.lineWidth = 1;
  }

  // Chat rendering: draw background, then last messages bottom-up
  function drawChatBox() {
    const { x1, y1, x2, y2, padding } = CHAT;
    const width = x2 - x1;
    const height = y2 - y1;
    // background
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x1, y1, width, height);
    // border
    ctx.strokeStyle = "#666";
    ctx.strokeRect(x1, y1, width, height);

    // text area: render messages from bottom up
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    const lineHeight = 16;
    let y = y2 - padding; // start bottom
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // wrap long lines simply by clipping (can be improved)
      const words = msg.split(' ');
      let line = "";
      // attempt to fit as many words per line as width allows
      for (let w = 0; w < words.length; w++) {
        const test = line.length ? (line + " " + words[w]) : words[w];
        // measure width
        if (ctx.measureText(test).width > width - padding*2) {
          // render current line and move up
          ctx.fillText(line, x1 + padding, y);
          y -= lineHeight;
          line = words[w];
        } else {
          line = test;
        }
      }
      // render remaining
      if (line) {
        ctx.fillText(line, x1 + padding, y);
        y -= lineHeight;
      }
      // stop when out of box
      if (y < y1 + padding) break;
    }
  }

  // Draw login GUI with black text and black borders, buttons under boxes
  function drawLoginGUI() {
    // draw border image background if available
    if (imgBorder && imgBorder.complete) ctx.drawImage(imgBorder, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = "#123"; ctx.fillRect(0,0,canvas.width,canvas.height); }

    // Labels - black
    ctx.fillStyle = "#000";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Username:", GUI.username.x - 70, GUI.username.y + 4);
    ctx.fillText("Password:", GUI.password.x - 70, GUI.password.y + 4);

    // username box (white bg, black border, black typed text)
    ctx.fillStyle = "#fff";
    ctx.fillRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = "#000";
    ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = "#000";
    ctx.font = "12px sans-serif";
    ctx.fillText(usernameStr || "", GUI.username.x + 4, GUI.username.y + 2);

    // password box
    ctx.fillStyle = "#fff";
    ctx.fillRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = "#000";
    ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = "#000";
    ctx.fillText("*".repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

    // Buttons below text boxes (visible)
    ctx.fillStyle = "#ddd"; ctx.strokeStyle = "#000";
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.font = "13px sans-serif";
    ctx.fillText("Login", GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText("Create Account", GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);
  }

  // Draw connecting screen when not connected
  function drawConnecting() {
    if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0,0,canvas.width,canvas.height); }
    ctx.fillStyle = "yellow"; ctx.font = "16px sans-serif";
    ctx.fillText("Connecting to server...", 47, 347);
  }

  // Draw the isometric world and players
  function drawWorld() {
    // clear background
    ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0,0,canvas.width,canvas.height);
    if (!localPlayer) return;

    // draw tiles in row-major order (y then x)
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        const t = (mapSpec.tiles && mapSpec.tiles[y] && typeof mapSpec.tiles[y][x] !== 'undefined') ? mapSpec.tiles[y][x] : 0;
        const { screenX, screenY } = isoScreen(x, y);
        drawTile(screenX, screenY, t);
      }
    }

    // build list of players and sort by depth (x+y)
    const list = Object.values(otherPlayers).concat(localPlayer ? [localPlayer] : []);
    list.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));

    // draw players
    list.forEach(p => {
      const isLocal = localPlayer && p.id === localPlayer.id;
      drawPlayer(p, isLocal);
    });

    // draw chat box on top (so players don't obscure messages)
    drawChatBox();

    // overlay border, if available
    if (imgBorder && imgBorder.complete) {
      // attempt to draw border image; we do not process transparency here to avoid CORS issues,
      // but earlier code attempted to remove white if same-origin. We'll just draw image.
      ctx.drawImage(imgBorder, 0, 0, canvas.width, canvas.height);
    }
  }

  // Loop
  function loop() {
    if (!connected) drawConnecting();
    else if (connected && !loggedIn) drawLoginGUI();
    else drawWorld();
    requestAnimationFrame(loop);
  }
  loop();

  // Start input handlers and attempt to connect on user click (so cold start is interactive)
  startInputHandlers();

  // Expose connect/send for debugging
  window.connectToServer = connect;
});
