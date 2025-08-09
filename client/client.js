// client.js
// Canvas-based client with GUI login, sprite cropping, transparent border overlay,
// player centered at fixed screen position (430,142), and WebSocket connection.

// ------------ CONFIG -------------
const RENDER_WS = "wss://dragonspires.onrender.com"; // authoritative Render WS endpoint
const DEV_WS = "ws://localhost:3000";                // dev fallback
const WS_URL = (location.hostname.includes('localhost') ? DEV_WS : RENDER_WS);

const CANVAS_ID = "gameCanvas";
const CANVAS_W = 640;
const CANVAS_H = 480;

// player fixed screen position
const PLAYER_SCREEN_X = 430;
const PLAYER_SCREEN_Y = 142;

// map (we expect map.json to be 10x10)
let mapSpec = { width: 10, height: 10, tiles: [] };

// tile size used for world rendering
const TILE_SIZE = 32;

// GUI input box layout (within x ~236..612, y ~24..72)
const GUI = {
  boxX: 236, boxY: 24, boxW: 376, boxH: 48,
  username: { x: 260, y: 34, w: 240, h: 18 },
  password: { x: 260, y: 58, w: 240, h: 18 },
  loginBtn: { x: 520, y: 34, w: 80, h: 18 },
  signupBtn: { x: 520, y: 58, w: 80, h: 18 }
};

// ------------ STATE -------------
let canvas, ctx;
let ws = null;
let connected = false;
let loggedIn = false;

let usernameStr = "";
let passwordStr = "";
let activeField = null; // "username" or "password" or null

let localPlayer = null; // { id, username, pos_x, pos_y }
let otherPlayers = {};  // id -> { id, username, pos_x, pos_y }

// images
let imgTitle = new Image();
let imgBorder = new Image();
let imgPlayerSource = new Image();
let playerSprite = null; // cropped & processed player sprite (Image)
let borderProcessed = null; // canvas with white->transparent

// loading flags
let assetsLoaded = { title: false, border: false, playerSrc: false };

// ------------ BOOTSTRAP -------------
document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById(CANVAS_ID);
  if (!canvas) {
    console.error(`Canvas element with id="${CANVAS_ID}" not found.`);
    return;
  }
  ctx = canvas.getContext('2d');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  // load map.json first so mapSpec is accurate
  fetch('map.json')
    .then(r => r.json())
    .then(m => {
      if (m && m.width && m.height && Array.isArray(m.tiles)) {
        mapSpec = m;
      } else {
        console.warn("map.json missing or malformed; falling back to 10x10.");
      }
      // Start loading assets afterwards
      loadAssets();
      startInputHandlers();
      requestAnimationFrame(loop);
    })
    .catch(err => {
      console.error("Failed loading map.json:", err);
      // fallback, still proceed
      loadAssets();
      startInputHandlers();
      requestAnimationFrame(loop);
    });
});

// ------------ ASSET LOADING & PROCESSING -------------
function loadAssets() {
  // title image shown while connecting
  imgTitle.onload = () => { assetsLoaded.title = true; };
  imgTitle.onerror = () => { console.warn("Failed to load title image /assets/title.GIF"); assetsLoaded.title = false; };
  imgTitle.src = "/assets/title.GIF";

  // border image used when connected; we will process to make white transparent
  imgBorder.onload = () => {
    assetsLoaded.border = true;
    processBorderToTransparent();
  };
  imgBorder.onerror = () => { console.warn("Failed to load border image /assets/game_border_2025.gif"); assetsLoaded.border = false; };
  imgBorder.src = "/assets/game_border_2025.gif";

  // player source GIF that contains many sprites; we'll crop 264..308 x 1..56 and remove black
  imgPlayerSource.onload = () => {
    assetsLoaded.playerSrc = true;
    cropAndMakePlayerTransparent();
  };
  imgPlayerSource.onerror = () => { console.warn("Failed to load player.gif at /assets/player.gif (404 etc)"); assetsLoaded.playerSrc = false; };
  imgPlayerSource.src = "/assets/player.gif";
}

function processBorderToTransparent() {
  // create offscreen canvas same size as loaded border
  const w = imgBorder.width, h = imgBorder.height;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  octx.drawImage(imgBorder, 0, 0);
  try {
    const data = octx.getImageData(0, 0, w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      // Treat near-white as white: r,g,b > 240
      if (d[i] > 240 && d[i+1] > 240 && d[i+2] > 240) {
        d[i+3] = 0;
      }
    }
    octx.putImageData(data, 0, 0);
    borderProcessed = off; // use this canvas when drawing overlay
  } catch (e) {
    console.warn("Unable to process border image for transparency (CORS?)", e);
    // If CORS prevents access, we'll fall back to drawing the original and not making white transparent.
    borderProcessed = null;
  }
}

function cropAndMakePlayerTransparent() {
  // Crop rect: sourceX=264, sourceY=1, w=44, h=55
  const sx = 264, sy = 1, sw = 44, sh = 55;
  const off = document.createElement('canvas');
  off.width = sw; off.height = sh;
  const octx = off.getContext('2d');
  try {
    octx.drawImage(imgPlayerSource, sx, sy, sw, sh, 0, 0, sw, sh);
    const data = octx.getImageData(0, 0, sw, sh);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      // Convert pure black (0,0,0) to transparent; allow small tolerance
      if (d[i] < 16 && d[i+1] < 16 && d[i+2] < 16) {
        d[i+3] = 0;
      }
    }
    octx.putImageData(data, 0, 0);
    // produce an Image from canvas
    const img = new Image();
    img.src = off.toDataURL();
    playerSprite = img;
  } catch (e) {
    console.warn("Unable to crop/process player sprite (CORS?)", e);
    // fallback: use whole source
    playerSprite = imgPlayerSource;
  }
}

// ------------ WEBSOCKET -------------
function connectToServer() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected to", WS_URL);
    connected = true;
  };

  ws.onmessage = (evt) => {
    const data = safeParse(evt.data);
    if (!data) return;
    handleServerMessage(data);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  ws.onclose = () => {
    console.log("WebSocket closed");
    connected = false;
    // keep loggedIn as-is (server authoritative)
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch(e) { return null; }
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  } else {
    console.warn("WS not open; message not sent:", obj);
  }
}

// Handle server messages (login_success includes players list, etc)
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'login_success':
    case 'signup_success':
      loggedIn = true;
      localPlayer = msg.player; // {id, username, pos_x, pos_y}
      otherPlayers = {};
      if (Array.isArray(msg.players)) {
        msg.players.forEach(p => { otherPlayers[p.id] = p; });
      }
      console.log("Login success:", localPlayer.username);
      break;
    case 'player_joined':
      if (msg.player) otherPlayers[msg.player.id] = msg.player;
      break;
    case 'player_moved':
      if (msg.id === (localPlayer && localPlayer.id)) {
        // server authoritative update for local player
        if (localPlayer) { localPlayer.pos_x = msg.x; localPlayer.pos_y = msg.y; }
      } else {
        if (!otherPlayers[msg.id]) otherPlayers[msg.id] = { id: msg.id, username: `#${msg.id}` };
        otherPlayers[msg.id].pos_x = msg.x;
        otherPlayers[msg.id].pos_y = msg.y;
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
      // ignore
      break;
  }
}

// ------------ INPUT HANDLERS (canvas-based GUI) -------------
function startInputHandlers() {
  // mouse clicks - to focus fields or press buttons
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // If not connected, clicking will attempt to connect (useful to trigger connect on first user action)
    if (!connected) {
      connectToServer();
      return;
    }

    // If connected but not loggedIn: process GUI clicks
    if (connected && !loggedIn) {
      // username box
      const u = GUI.username;
      if (mx >= u.x && mx <= u.x + u.w && my >= u.y - 12 && my <= u.y + u.h) {
        activeField = "username";
        return;
      }
      // password box
      const p = GUI.password;
      if (mx >= p.x && mx <= p.x + p.w && my >= p.y - 12 && my <= p.y + p.h) {
        activeField = "password";
        return;
      }
      // Login button
      const lb = GUI.loginBtn;
      if (mx >= lb.x && mx <= lb.x + lb.w && my >= lb.y - 12 && my <= lb.y + lb.h) {
        // send login
        sendWS({ type: 'login', username: usernameStr, password: passwordStr });
        return;
      }
      // Create Account button
      const sb = GUI.signupBtn;
      if (mx >= sb.x && mx <= sb.x + sb.w && my >= sb.y - 12 && my <= sb.y + sb.h) {
        sendWS({ type: 'signup', username: usernameStr, password: passwordStr });
        return;
      }

      // clicked outside, unfocus
      activeField = null;
    }
  });

  // keyboard input
  window.addEventListener('keydown', (e) => {
    // if GUI active and connected but not loggedIn, capture input into username/password
    if (connected && !loggedIn && activeField) {
      if (e.key === 'Backspace') {
        if (activeField === 'username') usernameStr = usernameStr.slice(0, -1);
        else if (activeField === 'password') passwordStr = passwordStr.slice(0, -1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        // Enter attempts login
        sendWS({ type: 'login', username: usernameStr, password: passwordStr });
        e.preventDefault();
      } else if (e.key.length === 1) {
        // printable char
        if (activeField === 'username') usernameStr += e.key;
        else if (activeField === 'password') passwordStr += e.key;
      }
    }

    // after login: movement keys - client-side bounds check then send move
    if (loggedIn && localPlayer) {
      const k = e.key.toLowerCase();
      let dx = 0, dy = 0;
      if (k === 'arrowup' || k === 'w') dy = -1;
      else if (k === 'arrowdown' || k === 's') dy = 1;
      else if (k === 'arrowleft' || k === 'a') dx = -1;
      else if (k === 'arrowright' || k === 'd') dx = 1;
      if (dx !== 0 || dy !== 0) {
        const newX = localPlayer.pos_x + dx;
        const newY = localPlayer.pos_y + dy;
        if (newX >= 0 && newX < mapSpec.width && newY >= 0 && newY < mapSpec.height) {
          // optimistic update
          localPlayer.pos_x = newX;
          localPlayer.pos_y = newY;
          // send intended move
          sendWS({ type: 'move', dx, dy });
        } else {
          // out of bounds; ignore
        }
      }
    }
  });
}

// ------------ RENDERING -------------
function drawConnectingTitle() {
  // draw title image stretched to fit canvas if available, otherwise a fallback box
  if (assetsLoaded.title && imgTitle.complete) {
    ctx.drawImage(imgTitle, 0, 0, CANVAS_W, CANVAS_H);
  } else {
    ctx.fillStyle = "#222";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#fff";
    ctx.font = "20px sans-serif";
    ctx.fillText("DragonSpires", 20, 40);
  }

  // yellow connecting text at (47,347)
  ctx.fillStyle = "yellow";
  ctx.font = "16px sans-serif";
  ctx.fillText("Connecting to server...", 47, 347);
}

function drawLoginGUI() {
  // Draw border image if available (draw it in background)
  if (assetsLoaded.border && imgBorder.complete) {
    ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
  } else {
    // fallback background for login area
    ctx.fillStyle = "#123";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // draw the little GUI region (username/password/buttons)
  // labels
  ctx.fillStyle = "#FFF";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("Username:", GUI.username.x - 70, GUI.username.y + 4);
  ctx.fillText("Password:", GUI.password.x - 70, GUI.password.y + 4);

  // username box
  ctx.strokeStyle = (activeField === "username") ? "yellow" : "#FFF";
  ctx.strokeRect(GUI.username.x, GUI.username.y - 14, GUI.username.w, GUI.username.h);
  ctx.fillStyle = "#000";
  ctx.fillRect(GUI.username.x + 1, GUI.username.y - 13, GUI.username.w - 2, GUI.username.h - 2);
  ctx.fillStyle = "#FFF";
  ctx.fillText(usernameStr || "", GUI.username.x + 4, GUI.username.y + 2);

  // password box (masked)
  ctx.strokeStyle = (activeField === "password") ? "yellow" : "#FFF";
  ctx.strokeRect(GUI.password.x, GUI.password.y - 14, GUI.password.w, GUI.password.h);
  ctx.fillStyle = "#000";
  ctx.fillRect(GUI.password.x + 1, GUI.password.y - 13, GUI.password.w - 2, GUI.password.h - 2);
  ctx.fillStyle = "#FFF";
  ctx.fillText("*".repeat(passwordStr.length), GUI.password.x + 4, GUI.password.y + 2);

  // buttons
  ctx.strokeStyle = "#FFF";
  ctx.strokeRect(GUI.loginBtn.x, GUI.loginBtn.y - 14, GUI.loginBtn.w, GUI.loginBtn.h);
  ctx.strokeRect(GUI.signupBtn.x, GUI.signupBtn.y - 14, GUI.signupBtn.w, GUI.signupBtn.h);
  ctx.fillStyle = "#FFF";
  ctx.textAlign = "center";
  ctx.fillText("Login", GUI.loginBtn.x + GUI.loginBtn.w / 2, GUI.loginBtn.y + 2);
  ctx.fillText("Create Account", GUI.signupBtn.x + GUI.signupBtn.w / 2, GUI.signupBtn.y + 2);
}

function drawGameWorld() {
  // background clear
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (!localPlayer) return;

  // Render tiles (simple square top-down but offset so player appears at PLAYER_SCREEN_X,Y)
  // We'll use tile grid (not isometric in this step) for clarity with the fixed-screen pos
  for (let y = 0; y < mapSpec.height; y++) {
    for (let x = 0; x < mapSpec.width; x++) {
      const sx = PLAYER_SCREEN_X - localPlayer.pos_x * TILE_SIZE + x * TILE_SIZE;
      const sy = PLAYER_SCREEN_Y - localPlayer.pos_y * TILE_SIZE + y * TILE_SIZE;
      // simple coloring from map tiles if present
      const t = (mapSpec.tiles && mapSpec.tiles[y] && mapSpec.tiles[y][x] !== undefined) ? mapSpec.tiles[y][x] : 0;
      ctx.fillStyle = (t === 0) ? "#2E8B57" : "#C68642";
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      ctx.strokeStyle = "#222";
      ctx.strokeRect(sx, sy, TILE_SIZE, TILE_SIZE);
    }
  }

  // draw other players
  Object.values(otherPlayers).forEach(p => {
    if (p && typeof p.pos_x === 'number' && typeof p.pos_y === 'number') {
      const sx = PLAYER_SCREEN_X - localPlayer.pos_x * TILE_SIZE + p.pos_x * TILE_SIZE;
      const sy = PLAYER_SCREEN_Y - localPlayer.pos_y * TILE_SIZE + p.pos_y * TILE_SIZE;
      if (playerSprite && playerSprite.complete) {
        ctx.drawImage(playerSprite, sx, sy, TILE_SIZE, TILE_SIZE);
      } else {
        ctx.fillStyle = "#FF6347";
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
      }
      // name tag
      ctx.fillStyle = "#fff";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(p.username || `#${p.id}`, sx + TILE_SIZE/2, sy - 4);
    }
  });

  // draw local player at fixed screen location
  if (playerSprite && playerSprite.complete) {
    ctx.drawImage(playerSprite, PLAYER_SCREEN_X, PLAYER_SCREEN_Y, TILE_SIZE, TILE_SIZE);
  } else {
    ctx.fillStyle = "#1E90FF";
    ctx.fillRect(PLAYER_SCREEN_X, PLAYER_SCREEN_Y, TILE_SIZE, TILE_SIZE);
  }

  // overlay border (with white transparent if we successfully processed it)
  if (borderProcessed) {
    ctx.drawImage(borderProcessed, 0, 0, CANVAS_W, CANVAS_H);
  } else if (assetsLoaded.border && imgBorder.complete) {
    // fallback: draw original border even if we couldn't make white transparent
    ctx.drawImage(imgBorder, 0, 0, CANVAS_W, CANVAS_H);
  }
}

// main loop
function loop() {
  // If not connected yet, show title + connecting message
  if (!connected) {
    drawConnectingTitle();
  } else if (connected && !loggedIn) {
    // connected, show login GUI (with border image in background)
    drawLoginGUI();
  } else {
    // in-game
    drawGameWorld();
  }
  requestAnimationFrame(loop);
}

// ------------ start connection early so cold-start message shows while connecting -------------
connectToServer();
