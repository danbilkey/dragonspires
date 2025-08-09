// client.js
document.addEventListener('DOMContentLoaded', () => {
  // --- Config ---
  const WS_URL = "wss://dragonspires.onrender.com";   // your Render WS endpoint
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  // canvas size (feel free to tweak)
  canvas.width = 1024;
  canvas.height = 640;

  // isometric tile size (classic 2:1)
  const tileW = 64;
  const tileH = 32;

  // --- Game state ---
  let ws = null;
  let map = null;                  // loaded map.json
  let player = null;               // logged-in player's record {id, username, pos_x, pos_y}
  let players = {};                // id -> {id, username, pos_x, pos_y}

  // --- Helpers ---
  function connect() {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("WebSocket connected");
      const loginBtn = document.getElementById('loginBtn');
      const signupBtn = document.getElementById('signupBtn');
      if (loginBtn) loginBtn.disabled = false;
      if (signupBtn) signupBtn.disabled = false;
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        handleServerMessage(data);
      } catch (e) {
        console.warn("Invalid server message", e, evt.data);
      }
    };

    ws.onerror = (err) => console.error("WebSocket error", err);

    ws.onclose = () => {
      console.log("WebSocket closed");
      const loginBtn = document.getElementById('loginBtn');
      const signupBtn = document.getElementById('signupBtn');
      if (loginBtn) loginBtn.disabled = true;
      if (signupBtn) signupBtn.disabled = true;
    };
  }

  function sendMessage(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      console.warn("WS not open; cannot send:", obj);
    }
  }

  // Convert tile coords -> isometric base coords (top-left of tile bounding box)
  function isoBase(x, y) {
    return {
      x: (x - y) * (tileW / 2),
      y: (x + y) * (tileH / 2)
    };
  }

  // Convert tile coords -> screen coords (apply camera so player stays centered)
  function isoScreen(x, y) {
    // if player isn't set yet, fall back to centering map
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    // base coords in world space
    const base = isoBase(x, y);

    // camera center base coords (player)
    const cam = player ? isoBase(player.pos_x, player.pos_y) : { x: (map.width - 1 - (map.height - 1)) * (tileW/2) / 2, y: (map.width - 1 + map.height - 1) * (tileH/2) / 2 };

    // We want the tile's bounding box to be positioned so that:
    // top-left = center - tileW/2, center - tileH/2 + (base - cam)
    const screenX = centerX - tileW / 2 + (base.x - cam.x);
    const screenY = centerY - tileH / 2 + (base.y - cam.y);

    return { screenX, screenY };
  }

  // Draw a diamond tile whose bounding box top-left is (screenX, screenY)
  function drawTileAt(screenX, screenY, type = 0) {
    ctx.beginPath();
    ctx.moveTo(screenX, screenY + tileH / 2);                // left
    ctx.lineTo(screenX + tileW / 2, screenY);                // top
    ctx.lineTo(screenX + tileW, screenY + tileH / 2);        // right
    ctx.lineTo(screenX + tileW / 2, screenY + tileH);        // bottom
    ctx.closePath();

    if (type === 0) ctx.fillStyle = '#2E8B57'; // grass
    else if (type === 1) ctx.fillStyle = '#C68642'; // path
    else ctx.fillStyle = '#666';

    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke();
  }

  function drawPlayerSprite(p) {
    const { screenX, screenY } = isoScreen(p.pos_x, p.pos_y);
    // player center position:
    const cx = screenX + tileW / 2;
    const cy = screenY + tileH / 2;
    // simple ellipse avatar
    ctx.beginPath();
    ctx.ellipse(cx, cy - 8, 12, 16, 0, 0, Math.PI * 2);
    ctx.fillStyle = (player && p.id === player.id) ? '#1E90FF' : '#FF6347';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();

    // optional name tag
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.fillText(p.username || `#${p.id}`, cx, cy - 18);
  }

  // --- Server message handler ---
  function handleServerMessage(data) {
    switch (data.type) {
      case 'login_success':
      case 'signup_success': {
        // server sends { player, players: [ ...otherPlayers ] }
        player = data.player;
        // clear existing and set players
        players = {};
        players[player.id] = player;
        if (Array.isArray(data.players)) {
          data.players.forEach(p => (players[p.id] = p));
        }
        // hide login UI (ensure your HTML uses this id)
        const lc = document.getElementById('loginContainer');
        if (lc) lc.style.display = 'none';
        console.log("Logged in as", player.username);
        break;
      }
      case 'player_joined': {
        if (data.player) players[data.player.id] = data.player;
        break;
      }
      case 'player_moved': {
        // update or create
        if (!players[data.id]) players[data.id] = { id: data.id, username: data.id, pos_x: data.x, pos_y: data.y };
        else { players[data.id].pos_x = data.x; players[data.id].pos_y = data.y; }
        // if it's the server's authoritative position for our player, sync local player too
        if (player && data.id === player.id) {
          player.pos_x = data.x; player.pos_y = data.y;
          players[player.id] = player;
        }
        break;
      }
      case 'player_left': {
        delete players[data.id];
        break;
      }
      case 'login_error':
      case 'signup_error': {
        console.warn(data.message || "Auth error");
        alert(data.message || "Auth error");
        break;
      }
      default:
        // ignore unknown
        break;
    }
  }

  // --- Rendering ---
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!map) {
      // draw "loading map"
      ctx.fillStyle = "#999";
      ctx.fillText("Loading map...", 20, 20);
      return;
    }

    // Draw tiles (we must use row-major map.tiles[y][x])
    for (let y = 0; y < map.height; y++) {
      if (!Array.isArray(map.tiles[y])) continue;
      for (let x = 0; x < map.width; x++) {
        const t = map.tiles[y][x];
        const { screenX, screenY } = isoScreen(x, y);
        drawTileAt(screenX, screenY, t);
      }
    }

    // Draw players sorted by y for simple depth (optional)
    const drawOrder = Object.values(players).sort((a, b) => (a.pos_x + a.pos_y) - (b.pos_x + b.pos_y));
    drawOrder.forEach(drawPlayerSprite);
  }

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }

  // --- Input & movement (client side bounds check; server also enforces) ---
  document.addEventListener('keydown', (e) => {
    if (!player || !map) return;

    let dx = 0, dy = 0;
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') dy = -1;
    else if (k === 'arrowdown' || k === 's') dy = 1;
    else if (k === 'arrowleft' || k === 'a') dx = -1;
    else if (k === 'arrowright' || k === 'd') dx = 1;
    else return;

    const newX = player.pos_x + dx;
    const newY = player.pos_y + dy;

    if (newX >= 0 && newX < map.width && newY >= 0 && newY < map.height) {
      // optimistic client move (instant feedback)
      player.pos_x = newX;
      player.pos_y = newY;
      players[player.id] = player;

      // send intended movement (server will validate)
      sendMessage({ type: 'move', dx, dy });
    } else {
      // outside bounds
      // optionally play a bump sound / animation
      console.log("Blocked: outside map");
    }
  });

  // --- Auth helpers (exposed to global for onclick handlers) ---
  function login() {
    const username = document.getElementById('username')?.value;
    const password = document.getElementById('password')?.value;
    if (!username || !password) { alert("Enter username & password"); return; }
    sendMessage({ type: 'login', username, password });
  }
  function signup() {
    const username = document.getElementById('username')?.value;
    const password = document.getElementById('password')?.value;
    if (!username || !password) { alert("Enter username & password"); return; }
    sendMessage({ type: 'signup', username, password });
  }
  window.login = login;
  window.signup = signup;

  // --- Start: load map, connect, start loop ---
  fetch('map.json')
    .then(r => r.json())
    .then(m => {
      // Validate shape
      if (!m.width || !m.height || !Array.isArray(m.tiles)) {
        console.error("Invalid map.json format", m);
        alert("map.json invalid");
        return;
      }
      map = m;
      // connect after map is loaded (so we can use map size if needed)
      connect();
      // start render loop
      requestAnimationFrame(loop);
    })
    .catch(err => {
      console.error("Failed to load map.json", err);
      alert("Failed to load map.json");
    });
});
