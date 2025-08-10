// client.js (map system updated: map_id -> /maps/map<id>.json, use {width,height,tilemap}, zero-based tiles)
document.addEventListener('DOMContentLoaded', () => {
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS = "ws://localhost:3000";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  const CANVAS_W = 640, CANVAS_H = 480;
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  // Isometric tile screen footprint (what we draw on screen per cell)
  const TILE_W = 64, TILE_H = 32;

  // Player screen anchor (we already tuned this with you)
  const PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // Sprite offsets (from prior tuning)
  const PLAYER_OFFSET_X = -32, PLAYER_OFFSET_Y = -16;

  // GUI login positions (you already tuned)
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn:{ x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat bounds (unchanged)
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };

  // State
  let ws = null;
  let connected = false;
  let connectionPaused = false;
  let showLoginGUI = false;
  let loggedIn = false;

  let usernameStr = "", passwordStr = "", activeField = null; // 'username'|'password'|null

  let localPlayer = null;  // {id, username, map_id, pos_x, pos_y, ...stats}
  let otherPlayers = {};   // id -> player
  let messages = [];

  // Map data from file: { width, height, tilemap: number[][] }
  let mapSpec = { width: 52, height: 100, tilemap: [] };

  // Assets
  const imgTitle  = new Image(); imgTitle.src = "/assets/title.GIF";
  const imgBorder = new Image(); imgBorder.crossOrigin = "anonymous"; imgBorder.src = "/assets/game_border_2025.gif";
  const imgFloor  = new Image(); imgFloor.crossOrigin = "anonymous"; imgFloor.src = "/assets/floor.png";
  const imgPlayerSrc = new Image(); imgPlayerSrc.crossOrigin = "anonymous"; imgPlayerSrc.src = "/assets/player.gif";

  // Make magenta transparent helper
  function maskMagentaToAlpha(image) {
    const off = document.createElement('canvas');
    off.width = image.naturalWidth || image.width;
    off.height = image.naturalHeight || image.height;
    const octx = off.getContext('2d');
    octx.drawImage(image, 0, 0);
    const data = octx.getImageData(0,0,off.width,off.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0; // pure magenta -> transparent
    }
    octx.putImageData(data, 0, 0);
    const out = new Image();
    out.src = off.toDataURL();
    return out;
  }

  // Process border & player magenta masks when loaded
  let borderMasked = null;
  imgBorder.onload = () => { borderMasked = maskMagentaToAlpha(imgBorder); };
  let playerSprite = null;
  imgPlayerSrc.onload = () => { playerSprite = maskMagentaToAlpha(imgPlayerSrc); };

  // Extract floor tiles from /assets/floor.png (61x31 cells, 1px gutters), layout 9 rows x 11 cols
  const FLOOR_COLS = 9;
  const FLOOR_ROWS = 11;
  const CELL_W = 61, CELL_H = 31;
  const GUT = 1;
  let floorTiles = []; // array of canvas images, index 0 is first tile (zero-based)
  imgFloor.onload = () => {
    floorTiles = [];
    const off = document.createElement('canvas');
    off.width = CELL_W; off.height = CELL_H;
    const octx = off.getContext('2d');

    for (let row = 0; row < FLOOR_ROWS; row++) {
      for (let col = 0; col < FLOOR_COLS; col++) {
        const sx = 1 + col*(CELL_W + GUT*?1:1) + (col*GUT?0:0); // explicit formula below
      }
    }
  };
  // The sx, sy formula with 1px border shared by cells:
  function extractFloorTiles() {
    const off = document.createElement('canvas');
    off.width = CELL_W; off.height = CELL_H;
    const octx = off.getContext('2d');
    floorTiles = [];
    for (let r = 0; r < FLOOR_ROWS; r++) {
      for (let c = 0; c < FLOOR_COLS; c++) {
        const sx = 1 + c*(CELL_W + GUT);
        const sy = 1 + r*(CELL_H + GUT);
        octx.clearRect(0,0,CELL_W,CELL_H);
        octx.drawImage(imgFloor, sx, sy, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);

        // magenta -> alpha for floor too (if any)
        const data = octx.getImageData(0,0,CELL_W,CELL_H);
        const d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i+1] === 0 && d[i+2] === 255) d[i+3] = 0;
        }
        octx.putImageData(data, 0, 0);

        const tileImg = new Image();
        tileImg.src = off.toDataURL();
        floorTiles.push(tileImg); // zero-based index
      }
    }
  }
  imgFloor.onload = extractFloorTiles;

  // Basic helpers
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    // camera centered on local player
    const base = isoBase(x, y);
    const camBase = localPlayer
      ? isoBase(localPlayer.pos_x, localPlayer.pos_y)
      : isoBase(Math.floor(mapSpec.width/2), Math.floor(mapSpec.height/2));
    const screenX = PLAYER_SCREEN_X - TILE_W/2 + (base.x - camBase.x);
    const screenY = PLAYER_SCREEN_Y - TILE_H/2 + (base.y - camBase.y);
    return { screenX, screenY };
  }

  // Draw one floor tile by image index (zero-based)
  function drawFloorTile(screenX, screenY, tileIndex) {
    const img = floorTiles[tileIndex];
    if (img && img.complete) {
      // center the 61x31 tile into our 64x32 diamond footprint
      const dx = screenX + (TILE_W - CELL_W) / 2;
      const dy = screenY + (TILE_H - CELL_H) / 2;
      ctx.drawImage(img, dx, dy, CELL_W, CELL_H);
    } else {
      // fallback: simple colored diamond
      ctx.beginPath();
      ctx.moveTo(screenX,               screenY + TILE_H/2);
      ctx.lineTo(screenX + TILE_W/2,    screenY);
      ctx.lineTo(screenX + TILE_W,      screenY + TILE_H/2);
      ctx.lineTo(screenX + TILE_W/2,    screenY + TILE_H);
      ctx.closePath();
      ctx.fillStyle = '#8DBF63';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
    }
  }

  function drawPlayer(p, isLocal) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    const drawX = screenX + PLAYER_OFFSET_X;
    const drawY = screenY + PLAYER_OFFSET_Y;

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

    // name (centered)
    const name = p.username || `#${p.id}`;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    const nameX = drawX + (playerSprite && playerSprite.naturalWidth ? playerSprite.naturalWidth/2 : TILE_W/2);
    const nameY = drawY - 20; // slightly higher so it doesn't overlap the sprite
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(name, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(name, nameX, nameY);
    ctx.lineWidth = 1;
  }

  // Chat drawing (visible, no background per your last pass)
  function drawChatBox() {
    const { x1,y1,x2,y2,pad } = CHAT;
    const w = x2 - x1, h = y2 - y1;
    // no background, just text
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    const lineH = 16;
    let y = y2 - pad;
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = messages[i];
      // naive wrap
      let chunk = text;
      while (chunk.length && y >= y1 + pad) {
        let fit = chunk;
        while (ctx.measureText(fit).width > w - pad*2 && fit.length > 1) fit = fit.slice(0, -1);
        ctx.fillText(fit, x1 + pad, y);
        y -= lineH;
        chunk = chunk.slice(fit.length);
      }
      if (y < y1 + pad) break;
    }
  }

  // Stats bars & labels (drawn AFTER border, as requested earlier)
  function drawHudOverlays() {
    if (!localPlayer) return;
    // Stamina (green) between x=200..187? (You provided coords; using them verbatim)
    const stX = 200, stTop = 19, stBottom = 135, stW = 187 - 200; // width negative means 0
    const stH = stBottom - stTop;
    const stRatio = (localPlayer.stamina ?? 0) / Math.max(1, (localPlayer.max_stamina ?? 1));
    const stFill = Math.floor(stH * stRatio);
    ctx.fillStyle = '#00FF00';
    ctx.fillRect(stX, stBottom - stFill, Math.max(1, stW + 1), stFill);

    // Life (red) between x=224..211
    const lfX = 224, lfTop = 19, lfBottom = 135, lfW = 211 - 224;
    const lfH = lfBottom - lfTop;
    const lfRatio = (localPlayer.life ?? 0) / Math.max(1, (localPlayer.max_life ?? 1));
    const lfFill = Math.floor(lfH * lfRatio);
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(lfX, lfBottom - lfFill, Math.max(1, lfW + 1), lfFill);

    // Magic text at (184,239) with outlined text, adjusted per previous tweaks
    const mx = 184 - 7, my = 239 + 8;
    const magicText = `${localPlayer.magic ?? 0}/${localPlayer.max_magic ?? 0}`;
    ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(magicText, mx, my);
    ctx.fillStyle = 'yellow'; ctx.fillText(magicText, mx, my);

    // Gold at (177,267) + y:6 with outlined white
    const gx = 177, gy = 267 + 6;
    const goldText = String(localPlayer.gold ?? 0);
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(goldText, gx, gy);
    ctx.fillStyle = 'white'; ctx.fillText(goldText, gx, gy);
    ctx.lineWidth = 1;
  }

  // Scenes
  function drawConnecting() {
    if (!showLoginGUI) {
      if (imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
      else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
      ctx.fillStyle = 'yellow'; ctx.font = '16px sans-serif';
      ctx.fillText(connected ? 'Press any key to enter!' : 'Connecting to server...', 47, 347);
    } else {
      // Once we transitioned to login GUI, don't draw the title anymore.
      drawLogin();
    }
  }

  function drawLogin() {
    if (borderMasked && borderMasked.complete) ctx.drawImage(borderMasked, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // Labels in white, nudged up by 2px
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);

    // Username box
    ctx.fillStyle = activeField === 'username' ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr, GUI.username.x + 4, GUI.username.y + 4); // +2 -> +4

    // Password box
    ctx.fillStyle = activeField === 'password' ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000'; ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 4);

    // Buttons
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    drawChatBox();
  }

  function drawGame() {
    // Floor
    if (!localPlayer) return;
    ctx.clearRect(0,0,CANVAS_W,CANVAS_H);

    // Draw tilemap (zero-based tile ids)
    const tm = mapSpec.tilemap || [];
    for (let y = 0; y < mapSpec.height; y++) {
      const row = tm[y] || [];
      for (let x = 0; x < mapSpec.width; x++) {
        const id = row[x] ?? 0; // zero-based tile index from JSON
        const { screenX, screenY } = isoScreen(x, y);
        drawFloorTile(screenX, screenY, id);
      }
    }

    // Players (depth-sort)
    const all = Object.values(otherPlayers).concat(localPlayer ? [localPlayer] : []);
    all.sort((a,b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    all.forEach(p => drawPlayer(p, localPlayer && p.id === localPlayer.id));

    // Border on top
    if (borderMasked && borderMasked.complete) ctx.drawImage(borderMasked, 0, 0, CANVAS_W, CANVAS_H);

    // Overlays (bars & text) on top of border per your last spec
    drawHudOverlays();

    // Chat on top
    drawChatBox();
  }

  // WS
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; connectionPaused = true; showLoginGUI = false; };
    ws.onclose = () => {
      connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false;
      localPlayer = null; otherPlayers = {};
    };
    ws.onerror = (e) => console.error('WS error', e);
    ws.onmessage = (ev) => {
      const msg = safeParse(ev.data);
      if (!msg) return;
      handleServer(msg);
    };
  }
  connect();

  const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const send = (o) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };

  function handleServer(m) {
    switch (m.type) {
      case 'login_success':
      case 'signup_success': {
        loggedIn = true;
        localPlayer = m.player;
        otherPlayers = {};
        if (Array.isArray(m.players)) m.players.forEach(p => { if (p.id !== localPlayer.id) otherPlayers[p.id] = p; });
        // Load the proper map via map_id
        const mapId = (m.map && m.map.map_id) || localPlayer.map_id || 1;
        fetch(`/maps/map${mapId}.json`).then(r => r.json()).then(data => {
          // Expect { width, height, tilemap }
          if (data && data.width && data.height && Array.isArray(data.tilemap)) {
            mapSpec = { width: data.width, height: data.height, tilemap: data.tilemap };
          } else {
            console.warn('Map JSON missing expected keys; falling back.');
            mapSpec = { width: 52, height: 100, tilemap: [] };
          }
        }).catch(err => {
          console.warn('Failed to load map JSON', err);
          mapSpec = { width: 52, height: 100, tilemap: [] };
        });
        messages.push('Welcome to DragonSpires!');
        break;
      }

      case 'player_joined':
        if (!localPlayer || m.player.id !== localPlayer.id) {
          otherPlayers[m.player.id] = m.player;
          if (m.player.username) messages.push(`${m.player.username} has entered DragonSpires!`);
        }
        break;

      case 'player_left':
        if (otherPlayers[m.id]) {
          const name = otherPlayers[m.id].username || `#${m.id}`;
          messages.push(`${name} has left DragonSpires.`);
        }
        delete otherPlayers[m.id];
        break;

      case 'player_moved':
        if (localPlayer && m.id === localPlayer.id) {
          localPlayer.pos_x = m.x; localPlayer.pos_y = m.y;
        } else {
          if (!otherPlayers[m.id]) otherPlayers[m.id] = { id: m.id, username: `#${m.id}`, pos_x: m.x, pos_y: m.y };
          else { otherPlayers[m.id].pos_x = m.x; otherPlayers[m.id].pos_y = m.y; }
        }
        break;

      case 'stats_update':
        if (localPlayer && m.id === localPlayer.id) {
          if (typeof m.stamina === 'number') localPlayer.stamina = m.stamina;
          if (typeof m.life === 'number')    localPlayer.life = m.life;
          if (typeof m.magic === 'number')   localPlayer.magic = m.magic;
        }
        break;

      case 'chat':
        if (typeof m.text === 'string') {
          messages.push(m.text);
          if (messages.length > 200) messages.shift();
        }
        break;

      case 'chat_error':
        messages.push('~ The game has rejected your message due to bad language.');
        break;
    }
  }

  // Input
  window.addEventListener('keydown', (e) => {
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    if (loggedIn && localPlayer) {
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0;
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;

      if (dx || dy) {
        const nx = localPlayer.pos_x + dx;
        const ny = localPlayer.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
          // optimistic move (server also validates and deducts stamina)
          if ((localPlayer.stamina ?? 0) > 0) {
            localPlayer.pos_x = nx; localPlayer.pos_y = ny;
            // local stamina gate visual only; server authoritatively deducts 1
            send({ type: 'move', dx, dy });
          }
        }
      }
    }

    // Login typing
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

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    if (connected && showLoginGUI && !loggedIn) {
      const u = GUI.username, p = GUI.password, lb = GUI.loginBtn, sb = GUI.signupBtn;

      // Precise hitboxes (y-14..y-14+h)
      if (mx >= u.x && mx <= u.x + u.w && my >= u.y - 14 && my <= u.y - 14 + u.h) { activeField = 'username'; return; }
      if (mx >= p.x && mx <= p.x + p.w && my >= p.y - 14 && my <= p.y - 14 + p.h) { activeField = 'password'; return; }

      if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) {
        send({ type: 'login', username: usernameStr, password: passwordStr }); return;
      }
      if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) {
        send({ type: 'signup', username: usernameStr, password: passwordStr }); return;
      }
      activeField = null;
    }
  });

  // Loop
  function loop() {
    if (!connected || (connected && (connectionPaused || !showLoginGUI) && !loggedIn)) {
      drawConnecting();
    } else if (connected && showLoginGUI && !loggedIn) {
      drawLogin();
    } else if (connected && loggedIn) {
      drawGame();
    }
    requestAnimationFrame(loop);
  }
  loop();

  // kick WS if needed
  canvas.addEventListener('mousedown', () => { if (!connected) connect(); });
});
