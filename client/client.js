// client.js – loads map from server by map_id (varchar), x-major [x][y] like Java
document.addEventListener('DOMContentLoaded', function () {

  // ---- CONFIG ----
  var PROD_WS = "wss://dragonspires.onrender.com";
  var DEV_WS = "ws://localhost:3000";
  var WS_URL = location.hostname.indexOf('localhost') !== -1 ? DEV_WS : PROD_WS;

  var CANVAS_W = 640, CANVAS_H = 480;
  var TILE_W = 64, TILE_H = 32; // on-screen size; floor source tiles are 61x31, we can draw at 64x32
  var PLAYER_SCREEN_X = 430, PLAYER_SCREEN_Y = 142;

  // previously-requested sprite/name offsets retained
  var PLAYER_IMG_OFF_X = -41, PLAYER_IMG_OFF_Y = 4;      // sprite tweak
  var NAME_OFF_X = -2, NAME_OFF_Y = -14;                 // name tweak

  // GUI login (shifted and with proper highlight)
  var GUI_OFFSET_X = 50, GUI_OFFSET_Y = 50;
  var GUI = {
    username: { x: 260 + GUI_OFFSET_X, y: 34 + GUI_OFFSET_Y, w: 240, h: 18 },
    password: { x: 260 + GUI_OFFSET_X, y: 58 + GUI_OFFSET_Y, w: 240, h: 18 },
    loginBtn: { x: 260 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 },
    signupBtn:{ x: 390 + GUI_OFFSET_X, y: 86 + GUI_OFFSET_Y, w: 120, h: 22 }
  };

  // Chat box + input
  var CHAT = { x1: 156, y1: 289, x2: 618, y2: 407, pad: 8 }; // smaller per your update
  var INPUT = { x1: 156, y1: 411+2, x2: 618, y2: 453 };      // +2 y as requested
  var CHAT_MAX_CHARS = 200;

  // HUD positions (bars over border)
  // Stamina bar: starts 187x19 ends 200x135 (x range 187-200)
  // Life bar:    starts 211x19 ends 224x135 (x range 211-224)
  var HUD = {
    stam: { x1:187-12, x2:200-12, y1:19, y2:135 }, // -12 x adjustment per your last note
    life: { x1:211-12, x2:224-12, y1:19, y2:135 }, // -12 x adjustment
    magicText: { x:184+20-7, y:239+8 },            // +20 then -7,+8 adjustments
    goldText:  { x:177+20,  y:267+6 }
  };

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;

  // ---- State ----
  var ws = null;
  var connected = false;
  var connectionPaused = false; // show "Press any key to enter!"
  var showLogin = false;
  var loggedIn = false;

  var usernameStr = "", passwordStr = "", activeField = null;
  var messages = [];
  var inputMode = false; // when true, keystrokes go to chat input
  var inputBuffer = "";

  // Player data
  var me = null;             // full row from DB on login
  var others = {};           // id -> {id,username,pos_x,pos_y}
  var vitals = { stamina:0, max_stamina:0, life:0, max_life:0, magic:0, max_magic:0, gold:0 };

  // Map from server (x-major arrays)
  var mapSpec = null; // { width, height, tilemap[x][y], itemmap[x][y] }

  // ---- Assets ----
  var imgTitle = new Image();        imgTitle.src = "/assets/title.GIF";
  var imgBorderSrc = new Image();    imgBorderSrc.src = "/assets/game_border_2025.gif";
  var imgFloorAtlas = new Image();   imgFloorAtlas.src = "/assets/floor.png";
  var imgPlayerSrc = new Image();    imgPlayerSrc.src = "/assets/player.gif";

  // Process magenta transparency for border & player
  var borderImage = null;
  imgBorderSrc.onload = function(){
    borderImage = makeTransparent(imgBorderSrc, [255,0,255]);
  };

  var playerSprite = null;
  imgPlayerSrc.onload = function(){
    playerSprite = makeTransparent(imgPlayerSrc, [255,0,255]);
  };

  // Extract floor tiles (61x31 each, 1px gutter, 11 cols x 9 rows)
  var floorTiles = []; // 0-based index
  imgFloorAtlas.onload = function(){
    extractFloorTiles();
  };

  function makeTransparent(sourceImg, rgb) {
    try {
      var w = sourceImg.naturalWidth || sourceImg.width;
      var h = sourceImg.naturalHeight || sourceImg.height;
      var off = document.createElement('canvas');
      off.width = w; off.height = h;
      var octx = off.getContext('2d');
      octx.drawImage(sourceImg, 0, 0);
      var data = octx.getImageData(0,0,w,h);
      var r = rgb[0], g = rgb[1], b = rgb[2];
      for (var i = 0; i < data.data.length; i += 4) {
        if (data.data[i] === r && data.data[i+1] === g && data.data[i+2] === b) {
          data.data[i+3] = 0;
        }
      }
      octx.putImageData(data, 0, 0);
      var out = new Image();
      out.src = off.toDataURL();
      return out;
    } catch(e) {
      console.warn('Transparency processing failed; using original', e);
      return sourceImg;
    }
  }

  function extractFloorTiles() {
    try {
      var cols = 11, rows = 9;
      var srcW = 61, srcH = 31;
      var gutter = 1;

      for (var row = 0; row < rows; row++) {
        for (var col = 0; col < cols; col++) {
          var sx = 1 + col * (srcW + gutter);
          var sy = 1 + row * (srcH + gutter);

          var off = document.createElement('canvas');
          off.width = srcW; off.height = srcH;
          var octx = off.getContext('2d');
          octx.drawImage(imgFloorAtlas, sx, sy, srcW, srcH, 0, 0, srcW, srcH);

          // magenta transparent
          var data = octx.getImageData(0,0,srcW,srcH);
          for (var i = 0; i < data.data.length; i += 4) {
            if (data.data[i] === 255 && data.data[i+1] === 0 && data.data[i+2] === 255) {
              data.data[i+3] = 0;
            }
          }
          octx.putImageData(data,0,0);

          var tileImg = new Image();
          tileImg.src = off.toDataURL();
          floorTiles.push(tileImg); // index 0 is first
        }
      }
    } catch(e) {
      console.error('extractFloorTiles failed', e);
    }
  }

  // ---- WS ----
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = function(){
      connected = true;
      connectionPaused = true; // show "Press any key to enter!"
      showLogin = false;
    };
    ws.onmessage = function(ev){
      var msg = null; try { msg = JSON.parse(ev.data); } catch(e) { return; }
      handle(msg);
    };
    ws.onclose = function(){
      connected = false;
      connectionPaused = false;
      showLogin = false;
      loggedIn = false;
      me = null; others = {}; messages = [];
      inputMode = false; inputBuffer = "";
    };
  }
  connect();

  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
  function pushMsg(t) {
    messages.push(t);
    if (messages.length > 200) messages.shift();
  }

  function handle(msg) {
    if (msg.type === 'login_success' || msg.type === 'signup_success') {
      loggedIn = true;
      me = msg.player;
      others = {};
      (msg.players || []).forEach(function(p){ others[p.id] = p; });

      // vitals cache
      vitals.stamina = me.stamina || 0;  vitals.max_stamina = me.max_stamina || 0;
      vitals.life    = me.life || 0;     vitals.max_life    = me.max_life || 0;
      vitals.magic   = me.magic || 0;    vitals.max_magic   = me.max_magic || 0;
      vitals.gold    = me.gold  || 0;

      // map from server (x-major)
      if (msg.map && msg.map.width && msg.map.height && msg.map.tilemap) {
        mapSpec = msg.map;
      } else {
        mapSpec = { width: 52, height: 100, tilemap: Array.from({length:52},()=>Array(100).fill(0)) };
      }
      pushMsg("Welcome to DragonSpires!");
      return;
    }

    if (msg.type === 'login_error' || msg.type === 'signup_error') {
      pushMsg(msg.message || 'Auth error');
      return;
    }

    if (msg.type === 'player_joined') {
      if (!me || (msg.player && msg.player.id === me.id)) return;
      if (msg.player) {
        others[msg.player.id] = msg.player;
        pushMsg((msg.player.username || ('#'+msg.player.id)) + " has entered DragonSpires!");
      }
      return;
    }

    if (msg.type === 'player_left') {
      if (others[msg.id]) {
        pushMsg((others[msg.id].username || ('#'+msg.id)) + " has left DragonSpires.");
        delete others[msg.id];
      }
      return;
    }

    if (msg.type === 'player_moved') {
      if (me && msg.id === me.id) {
        me.pos_x = msg.x; me.pos_y = msg.y;
      } else {
        if (!others[msg.id]) others[msg.id] = { id: msg.id, username: ('#'+msg.id), pos_x: msg.x, pos_y: msg.y };
        others[msg.id].pos_x = msg.x; others[msg.id].pos_y = msg.y;
      }
      return;
    }

    if (msg.type === 'chat') {
      if (typeof msg.text === 'string') pushMsg(msg.text);
      return;
    }

    if (msg.type === 'vitals') {
      if (typeof msg.stamina === 'number') vitals.stamina = msg.stamina;
      if (typeof msg.life === 'number')    vitals.life    = msg.life;
      if (typeof msg.magic === 'number')   vitals.magic   = msg.magic;
      return;
    }
  }

  // ---- Input ----
  window.addEventListener('keydown', function(e){
    if (connected && connectionPaused) {
      connectionPaused = false;
      showLogin = true;
      return;
    }

    // toggle chat
    if (e.key === 'Enter') {
      if (!loggedIn) return; // ignore on login screen
      if (!inputMode) {
        inputMode = true;
        inputBuffer = "";
      } else {
        // submit
        var text = inputBuffer.trim();
        if (text.length) {
          // client-only command: -pos
          if (/^-pos$/i.test(text)) {
            if (me) pushMsg("~ " + me.username + " is currently on Map " + (me.map_id || 'lev01') + " at location x:" + me.pos_x + ", y:" + me.pos_y + ".");
          } else {
            send({ type: 'chat', text: text.slice(0, CHAT_MAX_CHARS) });
          }
        }
        inputMode = false;
        inputBuffer = "";
      }
      return;
    }

    if (inputMode) {
      if (e.key === 'Backspace') {
        inputBuffer = inputBuffer.slice(0, -1);
        e.preventDefault();
      } else if (e.key.length === 1) {
        if (inputBuffer.length < CHAT_MAX_CHARS) inputBuffer += e.key;
      }
      return;
    }

    // Login typing
    if (!loggedIn && showLogin) {
      if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else if (activeField === 'password') passwordStr = passwordStr.slice(0, -1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        send({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault();
      } else if (e.key.length === 1) {
        if (activeField === 'username') usernameStr += e.key;
        else if (activeField === 'password') passwordStr += e.key;
      }
      return;
    }

    // Movement (if logged in) – cost is enforced server-side; client can still optimistic-check bounds
    if (loggedIn && me && mapSpec) {
      var k = e.key.toLowerCase();
      var dx = 0, dy = 0;
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;
      if (dx !== 0 || dy !== 0) {
        var nx = me.pos_x + dx, ny = me.pos_y + dy;
        if (nx >= 0 && nx < mapSpec.width && ny >= 0 && ny < mapSpec.height) {
          // optional optimistic: me.pos_x = nx; me.pos_y = ny;
          send({ type: 'move', dx: dx, dy: dy });
        }
      }
    }
  });

  canvas.addEventListener('mousedown', function(e){
    var r = canvas.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;

    if (connected && connectionPaused) {
      connectionPaused = false;
      showLogin = true;
      return;
    }
    if (!loggedIn && showLogin) {
      var u = GUI.username, p = GUI.password, lb = GUI.loginBtn, sb = GUI.signupBtn;
      // Adjust clickable verticals to the drawn rectangles (y-14 to y-14+h)
      if (mx >= u.x && mx <= u.x + u.w && my >= u.y - 14 && my <= u.y - 14 + u.h) { activeField = 'username'; return; }
      if (mx >= p.x && mx <= p.x + p.w && my >= p.y - 14 && my <= p.y - 14 + p.h) { activeField = 'password'; return; }
      if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y && my <= lb.y + lb.h) { send({type:'login', username:usernameStr, password:passwordStr}); return; }
      if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y && my <= sb.y + sb.h) { send({type:'signup', username:usernameStr, password:passwordStr}); return; }
      activeField = null;
    }
  });

  // ---- Iso helpers (x-major) ----
  function isoBase(x, y) { return { x: (x - y) * (TILE_W/2), y: (x + y) * (TILE_H/2) }; }
  function worldToScreen(wx, wy, cx, cy) {
    var b = isoBase(wx, wy);
    var c = isoBase(cx, cy);
    var sx = (PLAYER_SCREEN_X - TILE_W/2) + (b.x - c.x);
    var sy = (PLAYER_SCREEN_Y - TILE_H/2) + (b.y - c.y);
    return { x: sx, y: sy };
  }

  // ---- Draw ----
  function drawConnecting() {
    if (imgTitle && imgTitle.complete) ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#222'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }
    ctx.fillStyle = 'yellow';
    ctx.font = '16px sans-serif';
    ctx.fillText('Press any key to enter!', 47, 347);
  }

  function drawLogin() {
    // only border (no title)
    if (borderImage && borderImage.complete) ctx.drawImage(borderImage, 0, 0, CANVAS_W, CANVAS_H);
    else { ctx.fillStyle = '#233'; ctx.fillRect(0,0,CANVAS_W,CANVAS_H); }

    // Labels (white), aligned a tad higher (-2)
    ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Username:', GUI.username.x - 70, GUI.username.y + 4 - 2);
    ctx.fillText('Password:', GUI.password.x - 70, GUI.password.y + 4 - 2);

    // Username field
    if (activeField === 'username') { ctx.fillStyle = 'rgb(153,213,255)'; }
    else { ctx.fillStyle = '#fff'; }
    ctx.fillRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
    ctx.fillStyle = '#000'; ctx.font = '12px sans-serif';
    ctx.fillText(usernameStr, GUI.username.x + 4, GUI.username.y + 2);

    // Password field
    if (activeField === 'password') { ctx.fillStyle = 'rgb(153,213,255)'; }
    else { ctx.fillStyle = '#fff'; }
    ctx.fillRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.strokeStyle = '#000'; ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
    ctx.fillStyle = '#000';
    ctx.fillText(new Array(passwordStr.length+1).join('*'), GUI.password.x + 4, GUI.password.y + 2);

    // Buttons
    ctx.fillStyle = '#ddd'; ctx.strokeStyle = '#000';
    ctx.fillRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y, GUI.loginBtn.w, GUI.loginBtn.h);
    ctx.fillRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y, GUI.signupBtn.w, GUI.signupBtn.h);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = '13px sans-serif';
    ctx.fillText('Login', GUI.loginBtn.x + GUI.loginBtn.w/2, GUI.loginBtn.y + GUI.loginBtn.h - 6);
    ctx.fillText('Create Account', GUI.signupBtn.x + GUI.signupBtn.w/2, GUI.signupBtn.y + GUI.signupBtn.h - 6);

    // Chat log (no background, black text)
    drawChat(false);
  }

  function drawFloor() {
    if (!mapSpec) return;
    var W = mapSpec.width, H = mapSpec.height;

    // diagonals
    for (var d = 0; d <= W + H - 2; d++) {
      var xStart = Math.max(0, d - (H - 1));
      var xEnd   = Math.min(W - 1, d);
      for (var x = xStart; x <= xEnd; x++) {
        var y = d - x;
        var tid = mapSpec.tilemap[x] && mapSpec.tilemap[x][y] != null ? mapSpec.tilemap[x][y] | 0 : 0;
        var img = floorTiles[tid] || null;
        var pos = worldToScreen(x, y, me ? me.pos_x : (W>>1), me ? me.pos_y : (H>>1));
        var sx = pos.x, sy = pos.y;
        if (img && img.complete) {
          ctx.drawImage(img, sx, sy, TILE_W, TILE_H);
        } else {
          // fallback diamond
          ctx.beginPath();
          ctx.moveTo(sx + TILE_W/2, sy);
          ctx.lineTo(sx + TILE_W, sy + TILE_H/2);
          ctx.lineTo(sx + TILE_W/2, sy + TILE_H);
          ctx.lineTo(sx, sy + TILE_H/2);
          ctx.closePath();
          ctx.fillStyle = '#8DBF63'; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
        }
      }
    }
  }

  function drawPlayers() {
    if (!me) return;
    var list = [];
    for (var k in others) if (others.hasOwnProperty(k)) list.push(others[k]);
    list.push(me);
    list.sort(function(a,b){ return (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y); });

    for (var i=0;i<list.length;i++) {
      var p = list[i];
      var base = worldToScreen(p.pos_x, p.pos_y, me.pos_x, me.pos_y);
      var drawX = base.x + PLAYER_IMG_OFF_X;
      var drawY = base.y + PLAYER_IMG_OFF_Y;

      if (playerSprite && playerSprite.complete) {
        var w = playerSprite.naturalWidth || playerSprite.width;
        var h = playerSprite.naturalHeight || playerSprite.height;
        ctx.drawImage(playerSprite, drawX, drawY, w, h);
      } else {
        ctx.fillStyle = (p.id === me.id) ? '#1E90FF' : '#FF6347';
        ctx.beginPath();
        ctx.ellipse(base.x + TILE_W/2, base.y + TILE_H/2 - 6, 12, 14, 0, 0, Math.PI*2);
        ctx.fill();
      }

      // name (stroke + fill), centered over sprite top
      var nameX = drawX + (playerSprite && playerSprite.naturalWidth ? playerSprite.naturalWidth/2 : TILE_W/2);
      var nameY = drawY + NAME_OFF_Y;
      var text = p.username || ('#'+p.id);
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(text, nameX + NAME_OFF_X, nameY);
      ctx.fillStyle = 'white'; ctx.fillText(text, nameX + NAME_OFF_X, nameY);
      ctx.lineWidth = 1;
    }
  }

  function drawHUD() {
    if (!loggedIn || !me) return;

    // Draw over the border (this function is called after border)
    // Stamina (green)
    var s = HUD.stam, l = HUD.life;
    var sh = s.y2 - s.y1;
    var lh = l.y2 - l.y1;

    var sPct = vitals.max_stamina ? Math.max(0, Math.min(1, vitals.stamina / vitals.max_stamina)) : 0;
    var lPct = vitals.max_life    ? Math.max(0, Math.min(1, vitals.life    / vitals.max_life))    : 0;

    var sFill = Math.round(sh * sPct);
    var lFill = Math.round(lh * lPct);

    // clear columns
    ctx.clearRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    ctx.clearRect(l.x1, l.y1, l.x2 - l.x1, l.y2 - l.y1);

    ctx.fillStyle = 'lime';
    ctx.fillRect(s.x1, s.y2 - sFill, s.x2 - s.x1, sFill);

    ctx.fillStyle = 'red';
    ctx.fillRect(l.x1, l.y2 - lFill, l.x2 - l.x1, lFill);

    // Magic text (with black outline like names)
    var mx = HUD.magicText.x, my = HUD.magicText.y;
    var magicTxt = (vitals.magic|0) + "/" + (vitals.max_magic|0);
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(magicTxt, mx, my);
    ctx.fillStyle = 'yellow'; ctx.fillText(magicTxt, mx, my);
    ctx.lineWidth = 1;

    // Gold text (white with black outline)
    var gx = HUD.goldText.x, gy = HUD.goldText.y;
    var goldTxt = String(vitals.gold|0);
    ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = 'black'; ctx.strokeText(goldTxt, gx, gy);
    ctx.fillStyle = 'white'; ctx.fillText(goldTxt, gx, gy);
    ctx.lineWidth = 1;
  }

  function drawChat(showBg) {
    var x1 = CHAT.x1, y1 = CHAT.y1, x2 = CHAT.x2, y2 = CHAT.y2, pad = CHAT.pad;
    var w = x2 - x1, h = y2 - y1;

    if (showBg) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x1, y1, w, h);
      ctx.strokeStyle = '#666'; ctx.strokeRect(x1, y1, w, h);
    }

    ctx.font = '12px monospace';
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    var lineH = 16;
    var y = y2 - pad;
    for (var i = messages.length - 1; i >= 0; i--) {
      var text = messages[i];
      var mw = ctx.measureText(text).width;
      if (mw <= w - pad*2) {
        ctx.fillText(text, x1 + pad, y);
        y -= lineH;
      } else {
        // simple wrap
        var chunk = text;
        while (chunk.length > 0 && y >= y1 + pad) {
          var fit = chunk;
          while (ctx.measureText(fit).width > (w - pad*2) && fit.length > 1) fit = fit.slice(0, -1);
          ctx.fillText(fit, x1 + pad, y);
          y -= lineH;
          chunk = chunk.slice(fit.length);
        }
      }
      if (y < y1 + pad) break;
    }

    // input line (top of input box)
    if (inputMode) {
      var ix1 = INPUT.x1, iy1 = INPUT.y1, ix2 = INPUT.x2, iy2 = INPUT.y2;
      ctx.font = '12px monospace';
      ctx.fillStyle = '#000';
      ctx.textAlign = 'left';
      ctx.fillText(inputBuffer, ix1 + pad, iy1);
    }
  }

  function drawGame() {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0,0,CANVAS_W,CANVAS_H);

    drawFloor();  // 1
    drawPlayers();// 2

    if (borderImage && borderImage.complete) ctx.drawImage(borderImage, 0, 0, CANVAS_W, CANVAS_H); // 3

    drawHUD();    // 4 (over border)
    drawChat(false); // 5 (no bg)
  }

  function loop() {
    if (!connected) drawConnecting();
    else if (connectionPaused) drawConnecting();
    else if (!loggedIn && showLogin) drawLogin();
    else if (loggedIn) drawGame();
    requestAnimationFrame(loop);
  }
  loop();
});
