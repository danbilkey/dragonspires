// client.js
// Updated: floor tile extraction, magenta transparency, HUD bars, chat tweaks, player position offsets

document.addEventListener('DOMContentLoaded', () => {
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS = "ws://localhost:3000";
  const WS_URL = location.hostname.includes('localhost') ? DEV_WS : PROD_WS;

  const canvas = document.getElementById('gameCanvas');
  if (!canvas) return console.error('Missing <canvas id="gameCanvas">');
  const ctx = canvas.getContext('2d');

  const CANVAS_W = 640, CANVAS_H = 480;
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  const TILE_W = 64, TILE_H = 32;
  const FLOOR_W = 61, FLOOR_H = 31; // floor tile size from floor.png
  const GUT = 1; // 1px gutter around tiles in floor.png
  const FLOOR_ROWS = 9, FLOOR_COLS = 11;

  const PLAYER_SCREEN_X = 320, PLAYER_SCREEN_Y = 240;
  const PLAYER_LOC_OFFSET_X = -5, PLAYER_LOC_OFFSET_Y = 0;
  const PLAYER_SPRITE_OFFSET_X = -41, PLAYER_SPRITE_OFFSET_Y = 4;
  const PLAYER_NAME_OFFSET_X = -2, PLAYER_NAME_OFFSET_Y = -14;

  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn: { x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };

  let ws, connected = false, connectionPaused = false, showLoginGUI = false, loggedIn = false;

  let mapSpec = { width: 64, height: 64, tiles: [] };
  let usernameStr = "", passwordStr = "", activeField = null;
  let localPlayer = null, otherPlayers = {}, messages = [];

  let imgBorder = new Image(); imgBorder.src = "/assets/game_border_2025.gif";
  let imgPlayerSrc = new Image(); imgPlayerSrc.src = "/assets/player.gif";
  let imgFloor = new Image(); imgFloor.src = "/assets/floor.png";
  let floorTiles = [];
  let playerSprite = null;

  // Extract floor tiles with magenta transparency
  function extractFloorTiles() {
    const off = document.createElement('canvas');
    off.width = FLOOR_W; off.height = FLOOR_H;
    const octx = off.getContext('2d');
    floorTiles = [];
    for (let r = 0; r < FLOOR_ROWS; r++) {
      for (let c = 0; c < FLOOR_COLS; c++) {
        const sx = 1 + c * (FLOOR_W + GUT);
        const sy = 1 + r * (FLOOR_H + GUT);
        octx.clearRect(0, 0, FLOOR_W, FLOOR_H);
        octx.drawImage(imgFloor, sx, sy, FLOOR_W, FLOOR_H, 0, 0, FLOOR_W, FLOOR_H);

        let data = octx.getImageData(0, 0, FLOOR_W, FLOOR_H);
        let d = data.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) d[i + 3] = 0;
        }
        octx.putImageData(data, 0, 0);

        const tileImg = new Image();
        tileImg.src = off.toDataURL();
        floorTiles.push(tileImg);
      }
    }
  }
  imgFloor.onload = extractFloorTiles;

  // Process player sprite for magenta transparency
  imgPlayerSrc.onload = () => {
    try {
      const off = document.createElement('canvas');
      off.width = imgPlayerSrc.width;
      off.height = imgPlayerSrc.height;
      const octx = off.getContext('2d');
      octx.drawImage(imgPlayerSrc, 0, 0);
      const data = octx.getImageData(0, 0, off.width, off.height);
      for (let i = 0; i < data.data.length; i += 4) {
        if (data.data[i] === 255 && data.data[i+1] === 0 && data.data[i+2] === 255) data.data[i+3] = 0;
      }
      octx.putImageData(data, 0, 0);
      playerSprite = new Image();
      playerSprite.src = off.toDataURL();
    } catch (e) {
      console.warn("Player sprite processing failed", e);
      playerSprite = imgPlayerSrc;
    }
  };

  fetch('map.json').then(r => r.json()).then(m => mapSpec = m).catch(() => {});

  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; connectionPaused = true; };
    ws.onmessage = e => { const msg = safeParse(e.data); if (msg) handleServerMessage(msg); };
    ws.onclose = () => { connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false; };
  }
  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
  function send(o) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'login_success':
        loggedIn = true; localPlayer = msg.player;
        messages.push("Welcome to DragonSpires!");
        break;
      case 'player_joined':
        if (msg.player.id !== localPlayer.id) {
          otherPlayers[msg.player.id] = msg.player;
          messages.push(`${msg.player.username} has entered DragonSpires!`);
        }
        break;
      case 'player_left':
        if (msg.id !== localPlayer.id) messages.push(`${otherPlayers[msg.id]?.username || msg.id} has left DragonSpires.`);
        delete otherPlayers[msg.id];
        break;
      case 'player_moved':
        if (msg.id !== localPlayer.id) {
          if (!otherPlayers[msg.id]) otherPlayers[msg.id] = msg;
          else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
        } else { localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y; }
        break;
      case 'stats_update':
        if (localPlayer) Object.assign(localPlayer, msg.stats);
        break;
      case 'chat':
        messages.push(msg.text);
        break;
    }
  }

  window.addEventListener('keydown', e => {
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (!loggedIn || !localPlayer) return;
    let dx=0, dy=0;
    if (e.key === 'ArrowUp' || e.key === 'w') dy = -1;
    else if (e.key === 'ArrowDown' || e.key === 's') dy = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'a') dx = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd') dx = 1;
    if (dx || dy) send({ type: 'move', dx, dy });
  });

  canvas.addEventListener('mousedown', e => {
    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }
    if (!showLoginGUI) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (mx >= GUI.username.x && mx <= GUI.username.x + GUI.username.w && my >= GUI.username.y - 14 && my <= GUI.username.y + GUI.username.h) activeField = 'username';
    else if (mx >= GUI.password.x && mx <= GUI.password.x + GUI.password.w && my >= GUI.password.y - 14 && my <= GUI.password.y + GUI.password.h) activeField = 'password';
    else if (mx >= GUI.loginBtn.x && mx <= GUI.loginBtn.x + GUI.loginBtn.w && my >= GUI.loginBtn.y && my <= GUI.loginBtn.y + GUI.loginBtn.h) send({ type: 'login', username: usernameStr, password: passwordStr });
    else if (mx >= GUI.signupBtn.x && mx <= GUI.signupBtn.x + GUI.signupBtn.w && my >= GUI.signupBtn.y && my <= GUI.signupBtn.y + GUI.signupBtn.h) send({ type: 'signup', username: usernameStr, password: passwordStr });
  });

  function isoBase(x, y) { return { x: (x - y) * (TILE_W / 2), y: (x + y) * (TILE_H / 2) }; }
  function isoScreen(x, y) {
    const base = isoBase(x, y);
    const camBase = isoBase(localPlayer.pos_x + PLAYER_LOC_OFFSET_X, localPlayer.pos_y + PLAYER_LOC_OFFSET_Y);
    return { screenX: PLAYER_SCREEN_X + (base.x - camBase.x), screenY: PLAYER_SCREEN_Y + (base.y - camBase.y) };
  }

  function drawTileAt(x, y, tileId) {
    const { screenX, screenY } = isoScreen(x, y);
    if (floorTiles[tileId - 1]) ctx.drawImage(floorTiles[tileId - 1], screenX, screenY);
  }

  function drawPlayer(p) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    ctx.drawImage(playerSprite, screenX + PLAYER_SPRITE_OFFSET_X, screenY + PLAYER_SPRITE_OFFSET_Y);
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black';
    ctx.strokeText(p.username, screenX + PLAYER_NAME_OFFSET_X, screenY + PLAYER_NAME_OFFSET_Y);
    ctx.fillStyle = 'white';
    ctx.fillText(p.username, screenX + PLAYER_NAME_OFFSET_X, screenY + PLAYER_NAME_OFFSET_Y);
  }

  function drawHUD() {
    if (!localPlayer) return;
    let staminaPct = localPlayer.stamina / localPlayer.max_stamina;
    let lifePct = localPlayer.life / localPlayer.max_life;
    ctx.fillStyle = 'lime';
    ctx.fillRect(200, 135 - staminaPct * (135 - 19), 10, staminaPct * (135 - 19));
    ctx.fillStyle = 'red';
    ctx.fillRect(224, 135 - lifePct * (135 - 19), 10, lifePct * (135 - 19));
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'black'; ctx.lineWidth = 3;
    ctx.strokeText(`${localPlayer.magic}/${localPlayer.max_magic}`, 184 - 7, 239 + 8);
    ctx.fillStyle = 'yellow';
    ctx.fillText(`${localPlayer.magic}/${localPlayer.max_magic}`, 184 - 7, 239 + 8);
    ctx.strokeText(localPlayer.gold.toString(), 177, 267 + 6);
    ctx.fillStyle = 'white';
    ctx.fillText(localPlayer.gold.toString(), 177, 267 + 6);
  }

  function drawChatBox() {
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    let y = CHAT.y2 - CHAT.pad;
    for (let i = messages.length - 1; i >= 0; i--) {
      ctx.fillText(messages[i], CHAT.x1 + CHAT.pad, y);
      y -= 16;
      if (y < CHAT.y1) break;
    }
  }

  function drawLogin() {
    ctx.drawImage(imgBorder, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText(usernameStr, GUI.username.x + 4, GUI.username.y + 2);
    ctx.fillText('*'.repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);
  }

  function drawGame() {
    for (let y = 0; y < mapSpec.height; y++) {
      for (let x = 0; x < mapSpec.width; x++) {
        drawTileAt(x, y, mapSpec.tiles[y][x]);
      }
    }
    Object.values(otherPlayers).forEach(drawPlayer);
    drawPlayer(localPlayer);
    ctx.drawImage(imgBorder, 0, 0);
    drawHUD();
    drawChatBox();
  }

  function loop() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!connected) ctx.fillText('Connecting...', 50, 50);
    else if (connectionPaused) ctx.fillText('Press any key to enter!', 50, 50);
    else if (showLoginGUI && !loggedIn) drawLogin();
    else if (loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();

  connectToServer();
});
