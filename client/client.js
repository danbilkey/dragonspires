// client.js
// Fixes: regen handling, chat input (Enter to type -> Enter to send), -pos client-side,
// admin handled server-side, exact HUD bar rectangles, player/name above floor,
// no optional chaining (for older browsers).

document.addEventListener('DOMContentLoaded', () => {
  // ---- CONFIG ----
  const PROD_WS = "wss://dragonspires.onrender.com";
  const DEV_WS  = "ws://localhost:3000";
  const WS_URL  = location.hostname.indexOf('localhost') !== -1 ? DEV_WS : PROD_WS;

  const CANVAS_W = 640, CANVAS_H = 480;
  const TILE_W = 64, TILE_H = 32;      // logic iso tile
  const FLOOR_W = 61, FLOOR_H = 31;    // bitmap tile (from floor.png)
  const STEP_X = 63, STEP_Y = 33;
  const FLOOR_ROWS = 9, FLOOR_COLS = 11;
  const FLOOR_START_X = 1, FLOOR_START_Y = 1;

  // screen center
  const PLAYER_SCREEN_X = 320, PLAYER_SCREEN_Y = 240;

  // map/camera offsets
  const PLAYER_LOC_OFFSET_X = -5;
  const PLAYER_LOC_OFFSET_Y = 0;

  // sprite/name offsets
  const PLAYER_SPRITE_OFFSET_X = -41, PLAYER_SPRITE_OFFSET_Y = 4;
  const PLAYER_NAME_OFFSET_X = -2,   PLAYER_NAME_OFFSET_Y = -14;

  // login GUI
  const GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  const GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn:{ x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // chat log (no background)
  const CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 };
  // chat input (top-left anchored, wrap downward)
  const CHAT_INPUT = { x1: 156, y1: 411 + 2, x2: 618, y2: 453, pad: 8 }; // +2 per your tweak
  const CHAT_MAX = 200;

  // HUD exact rectangles
  const HUD = {
    yTop: 19, yBot: 135, h: (135 - 19),
    staminaX1: 187, staminaX2: 200, // width = 13
    lifeX1:    211, lifeX2:    224, // width = 13
    magicText: { x: (184 - 7) + 20, y: 239 + 8 },
    goldText:  { x: 177 + 20,       y: 267 + 6 }
  };

  // ---- CANVAS ----
  const canvas = document.getElementById('gameCanvas');
  if (!canvas) { console.error('Missing <canvas id="gameCanvas">'); return; }
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // ---- STATE ----
  let ws = null;
  let connected = false;
  let connectionPaused = true; // show "Press any key to enter!" after connect
  let showLoginGUI = false;
  let loggedIn = false;

  let usernameStr = "", passwordStr = "", activeField = null;

  // chat typing
  let chatMode = false;
  let chatBuffer = "";

  let localPlayer = null;
  let otherPlayers = {};
  let messages = [];

  let mapSpec = { width: 52, height: 100, tilemap: [] };

  // ---- ASSETS ----
  const imgTitle = new Image(); imgTitle.src = "/assets/title.GIF";
  const imgBorderSrc = new Image(); imgBorderSrc.src = "/assets/game_border_2025.gif";
  let imgBorder = null; // processed magenta->alpha

  const imgPlayerSrc = new Image(); imgPlayerSrc.src = "/assets/player.gif";
  let playerSprite = null;

  const imgFloor = new Image(); imgFloor.src = "/assets/floor.png";
  let floorTiles = [];

  // ---- Helpers ----
  function magentaToAlpha(img, sx, sy, sw, sh) {
    const w = sw || img.width, h = sh || img.height;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(img, sx||0, sy||0, w, h, 0, 0, w, h);
    let data;
    try { data = octx.getImageData(0,0,w,h); }
    catch (e) { return img; }
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      if (r >= 250 && g <= 5 && b >= 250) d[i+3] = 0;
    }
    octx.putImageData(data, 0, 0);
    const out = new Image();
    out.src = off.toDataURL();
    return out;
  }

  imgBorderSrc.onload = () => { imgBorder = magentaToAlpha(imgBorderSrc); };
  imgPlayerSrc.onload = () => {
    playerSprite = magentaToAlpha(imgPlayerSrc, 264, 1, 44, 55);
  };

  imgFloor.onload = () => {
    const off = document.createElement('canvas');
    off.width = FLOOR_W; off.height = FLOOR_H;
    const octx = off.getContext('2d');
    floorTiles = [];
    for (let r = 0; r < FLOOR_ROWS; r++) {
      for (let c = 0; c < FLOOR_COLS; c++) {
        const sx = FLOOR_START_X + c * STEP_X;
        const sy = FLOOR_START_Y + r * STEP_Y;
        octx.clearRect(0,0,FLOOR_W,FLOOR_H);
        octx.drawImage(imgFloor, sx, sy, FLOOR_W, FLOOR_H, 0, 0, FLOOR_W, FLOOR_H);
        // also strip pure magenta if present
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

  function loadMapById(mapId) {
    const name = 'map' + (mapId || 1) + '.json';
    return fetch(name).then(r => r.json()).then(m => {
      if (m && m.width && m.height && m.tilemap) mapSpec = m;
    }).catch(() => {});
  }

  // ---- WS ----
  function connectToServer() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { connected = true; connectionPaused = true; showLoginGUI = false; };
    ws.onmessage = (ev) => {
      var d = null; try { d = JSON.parse(ev.data); } catch {}
      if (!d) return;
      handleServerMessage(d);
    };
    ws.onclose = () => {
      connected = false; connectionPaused = false; showLoginGUI = false; loggedIn = false;
      localPlayer = null; otherPlayers = {}; messages = [];
    };
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function handleServerMessage(msg) {
    if (msg.type === 'login_success' || msg.type === 'signup_success') {
      loggedIn = true;
      localPlayer = msg.player;
      messages.push("Welcome to DragonSpires!");
      loadMapById(localPlayer && localPlayer.map_id);
      return;
    }
    if (msg.type === 'player_joined') {
      if (!localPlayer || (msg.player && msg.player.id === localPlayer.id)) return;
      otherPlayers[msg.player.id] = msg.player;
      messages.push((msg.player.username || ('#' + msg.player.id)) + ' has entered DragonSpires!');
      return;
    }
    if (msg.type === 'player_left') {
      if (!localPlayer || msg.id === localPlayer.id) return;
      var n = (otherPlayers[msg.id] && otherPlayers[msg.id].username) ? otherPlayers[msg.id].username : ('#' + msg.id);
      messages.push(n + ' has left DragonSpires.');
      delete otherPlayers[msg.id];
      return;
    }
    if (msg.type === 'player_moved') {
      if (localPlayer && msg.id === localPlayer.id) {
        localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y;
      } else {
        if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: msg.username || ('#' + msg.id), pos_x: msg.x, pos_y: msg.y };
        else { otherPlayers[msg.id].pos_x = msg.x; otherPlayers[msg.id].pos_y = msg.y; }
      }
      return;
    }
    if (msg.type === 'stats_update') {
      if (localPlayer && msg.stats) {
        for (var k in msg.stats) localPlayer[k] = msg.stats[k];
      }
      return;
    }
    if (msg.type === 'chat') {
      if (typeof msg.text === 'string') {
        messages.push(msg.text);
        if (messages.length > 300) messages.shift();
      }
      return;
    }
    if (msg.type === 'login_error' || msg.type === 'signup_error') {
      messages.push(msg.message || 'Auth error');
    }
  }

  // ---- Input ----
  window.addEventListener('keydown', function(e) {
    // go from title to login
    if (connected && connectionPaused) {
      connectionPaused = false; showLoginGUI = true; return;
    }

    // chat typing mode (pauses game input)
    if (loggedIn && chatMode) {
      if (e.key === 'Enter') {
        var txt = chatBuffer.trim();
        if (txt.length > 0) {
          // client-side -pos
          if (txt.toLowerCase() === '-pos') {
            var nm = (localPlayer && localPlayer.username) ? localPlayer.username : 'Player';
            var x = (localPlayer && typeof localPlayer.pos_x === 'number') ? localPlayer.pos_x : 0;
            var y = (localPlayer && typeof localPlayer.pos_y === 'number') ? localPlayer.pos_y : 0;
            messages.push('~ ' + nm + ' is currently on Map 1 at location x:' + x + ', y:' + y + '.');
          } else {
            send({ type: 'chat', text: txt });
          }
        }
        chatBuffer = '';
        chatMode = false;
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace') {
        chatBuffer = chatBuffer.slice(0, -1);
        e.preventDefault();
        return;
      }
      if (e.key.length === 1 && chatBuffer.length < CHAT_MAX) {
        chatBuffer += e.key;
        e.preventDefault();
        return;
      }
      // ignore other keys while chatting
      e.preventDefault();
      return;
    }

    // toggle chat on Enter
    if (loggedIn && e.key === 'Enter') {
      chatMode = true; chatBuffer = '';
      e.preventDefault();
      return;
    }

    // login typing
    if (!loggedIn && showLoginGUI && activeField) {
      if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else passwordStr = passwordStr.slice(0, -1);
        e.preventDefault(); return;
      } else if (e.key === 'Enter') {
        send({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault(); return;
      } else if (e.key.length === 1) {
        if (activeField === 'username') usernameStr += e.key;
        else passwordStr += e.key;
        return;
      }
    }

    // movement (blocked if no stamina)
    if (loggedIn && localPlayer) {
      var dx = 0, dy = 0;
      var k = e.key.toLowerCase();
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;

      if ((dx !== 0 || dy !== 0) && (localPlayer.stamina || 0) > 0) {
        send({ type: 'move', dx: dx, dy: dy });
        localPlayer.stamina = Math.max(0, (localPlayer.stamina || 0) - 1); // optimistic
      }
    }
  });

  canvas.addEventListener('mousedown', function(e) {
    var r = canvas.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) { connectionPaused = false; showLoginGUI = true; return; }

    if (connected && showLoginGUI && !loggedIn) {
      function inField(f) { return mx >= f.x && mx <= f.x + f.w && my >= (f.y - 14) && my <= (f.y - 14 + f.h); }
      function inBtn(b) { return mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h; }

      if (inField(GUI.username)) { activeField = 'username'; return; }
      if (inField(GUI.password)) { activeField = 'password'; return; }

      if (inBtn(GUI.loginBtn))  { send({ type: 'login', username: usernameStr, password: passwordStr }); return; }
      if (inBtn(GUI.signupBtn)) { send({ type: 'signup', username: usernameStr, password: passwordStr }); return; }

      activeField = null;
    }
  });

  // ---- Iso helpers ----
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function isoScreen(x, y) {
    var base = isoBase(x, y);
    var camX = 0, camY = 0;
    if (localPlayer) {
      var cam = isoBase(localPlayer.pos_x + PLAYER_LOC_OFFSET_X, localPlayer.pos_y + PLAYER_LOC_OFFSET_Y);
      camX = cam.x; camY = cam.y;
    }
    return { screenX: PLAYER_SCREEN_X + (base.x - camX), screenY: PLAYER_SCREEN_Y + (base.y - camY) };
  }

  var tileArtOffsetX = Math.floor((TILE_W - FLOOR_W) / 2);
  var tileArtOffsetY = Math.floor((TILE_H - FLOOR_H) / 2);

  function drawTileAt(x, y, tileId) {
    if (!floorTiles.length) return;
    var tile = floorTiles[tileId] || floorTiles[0];
    var pos = isoScreen(x, y);
    ctx.drawImage(tile, Math.round(pos.screenX + tileArtOffsetX), Math.round(pos.screenY + tileArtOffsetY));
  }

  function drawPlayer(p) {
    var pos = isoScreen(p.pos_x, p.pos_y);

    if (playerSprite && playerSprite.complete) {
      ctx.drawImage(
        playerSprite,
        Math.round(pos.screenX + PLAYER_SPRITE_OFFSET_X),
        Math.round(pos.screenY + PLAYER_SPRITE_OFFSET_Y)
      );
    } else {
      // fallback placeholder if sprite not ready
      ctx.fillStyle = '#1E90FF';
      ctx.beginPath();
      ctx.ellipse(pos.screenX, pos.screenY - 6, 12, 14, 0, 0, Math.PI*2);
      ctx.fill();
    }

    // name (outlined)
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    var nameX = Math.round(pos.screenX + PLAYER_NAME_OFFSET_X);
    var nameY = Math.round(pos.screenY + PLAYER_NAME_OFFSET_Y);
    var label = p.username ? p.username : ('#' + p.id);
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(label, nameX, nameY);
    ctx.fillStyle = 'white'; ctx.fillText(label, nameX, nameY);
    ctx.lineWidth = 1;
  }

  function drawChatLog() {
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    var w = (CHAT.x2 - CHAT.x1) - CHAT.pad*2;
    var lineH = 16;
    var y = CHAT.y2 - CHAT.pad;
    for (var i = messages.length - 1; i >= 0; i--) {
      var s = messages[i];
      // simple clip (single line); if you need multi-line wrapping, can extend
      while (ctx.measureText(s).width > w && s.length > 1) s = s.slice(0, -1);
      ctx.fillText(s, CHAT.x1 + CHAT.pad, y);
      y -= lineH;
      if (y < CHAT.y1 + CHAT.pad) break;
    }
  }

  function drawChatInput() {
    if (!loggedIn || !chatMode) return;
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    var w = (CHAT_INPUT.x2 - CHAT_INPUT.x1) - CHAT_INPUT.pad*2;
    var lineH = 16;
    var y = CHAT_INPUT.y1 + CHAT_INPUT.pad;
    // wrap downward
    var s = chatBuffer;
    while (s.length > 0) {
      var chunk = s;
      while (ctx.measureText(chunk).width > w && chunk.length > 1) chunk = chunk.slice(0, -1);
      ctx.fillText(chunk, CHAT_INPUT.x1 + CHAT_INPUT.pad, y);
      y += lineH;
      s = s.slice(chunk.length);
      if (y > CHAT_INPUT.y2 - CHAT_INPUT.pad) break;
    }
  }

  function drawHUD() {
    if (!localPlayer) return;
    function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }
    var sp = clamp((localPlayer.stamina||0)/(localPlayer.max_stamina||1), 0, 1);
    var lp = clamp((localPlayer.life||0)/(localPlayer.max_life||1), 0, 1);
    var sH = sp * HUD.h, lH = lp * HUD.h;

    // stamina (green) in 187..200 x, 19..135 y (fill bottom-up)
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(HUD.staminaX1, HUD.yBot - sH, (HUD.staminaX2 - HUD.staminaX1), sH);

    // life (red) in 211..224 x, 19..135 y
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(HUD.lifeX1, HUD.yBot - lH, (HUD.lifeX2 - HUD.lifeX1), lH);

    // magic (outlined yellow)
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    var magicStr = String(localPlayer.magic || 0) + '/' + String(localPlayer.max_magic || 0);
    ctx.lineWidth = 3; ctx.strokeStyle = 'black';
    ctx.strokeText(magicStr, HUD.magicText.x, HUD.magicText.y);
    ctx.fillStyle = 'yellow';
    ctx.fillText(magicStr, HUD.magicText.x, HUD.magicText.y);

    // gold (outlined white)
    var goldStr = String(localPlayer.gold || 0);
    ctx.strokeText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.fillStyle = 'white';
    ctx.fillText(goldStr, HUD.goldText.x, HUD.goldText.y);
    ctx.lineWidth = 1;
  }

  // ---- Screens ----
  function drawTitle() {
    if (imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#000'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    ctx.fillStyle = 'yellow';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Press any key to enter!', 47, 347);
  }

  function drawLogin() {
    var border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // labels (white, y -2)
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 2 - 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 2 - 2);

    // username field
    ctx.fillStyle = (activeField === 'username') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr, GUI.username.x + 4, GUI.username.y + 2);

    // password field
    ctx.fillStyle = (activeField === 'password') ? 'rgb(153,213,255)' : '#fff';
    ctx.fillRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText(Array(passwordStr.length + 1).join('*'), GUI.password.x + 4, GUI.password.y + 2);

    // buttons
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    // chat log on top
    drawChatLog();
  }

  function drawGame() {
    // floor (tilemap[x][y])
    if (mapSpec && mapSpec.tilemap) {
      for (var y = 0; y < mapSpec.height; y++) {
        for (var x = 0; x < mapSpec.width; x++) {
          var col = mapSpec.tilemap[x];
          var id = (col && typeof col[y] !== 'undefined') ? col[y] : 0;
          if (id < 0) id = 0;
          drawTileAt(x, y, id);
        }
      }
    }

    // players above floor
    var list = [];
    for (var oid in otherPlayers) list.push(otherPlayers[oid]);
    if (localPlayer) list.push(localPlayer);
    list.sort(function(a,b){ return (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y); });
    for (var i = 0; i < list.length; i++) drawPlayer(list[i]);

    // border
    var border = imgBorder || imgBorderSrc;
    if (border && border.complete) ctx.drawImage(border, 0, 0, CANVAS_W, CANVAS_H);

    // HUD + chat (on top)
    drawHUD();
    drawChatLog();
    drawChatInput();
  }

  function loop() {
    ctx.clearRect(0,0,CANVAS_W,CANVAS_H);
    if (!connected || connectionPaused) drawTitle();
    else if (showLoginGUI && !loggedIn) drawLogin();
    else if (loggedIn) drawGame();
    requestAnimationFrame(loop);
  }

  connectToServer();
  loop();
});
