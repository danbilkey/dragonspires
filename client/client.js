document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 800;
  canvas.height = 600;

  const tileWidth = 64;
  const tileHeight = 32;
  const playerColor = 'blue';

  let ws;
  let map = null;
  let player = null;
  let players = {};

  // Connect to WebSocket server
  function connect() {
    ws = new WebSocket("wss://dragonspires.onrender.com");

    ws.onopen = () => {
      console.log("WebSocket connected");
      document.getElementById('loginBtn').disabled = false;
      document.getElementById('signupBtn').disabled = false;
    };

    ws.onerror = (err) => console.error("WebSocket error", err);
    ws.onclose = () => {
      console.log("WebSocket closed");
      document.getElementById('loginBtn').disabled = true;
      document.getElementById('signupBtn').disabled = true;
    };

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);

      if (data.type === 'login_success' || data.type === 'signup_success') {
        player = data.player;
        players[player.id] = player;
        document.getElementById('loginContainer').style.display = 'none';
      } else if (data.type === 'player_joined') {
        players[data.player.id] = data.player;
      } else if (data.type === 'player_moved') {
        if (players[data.id]) {
          players[data.id].pos_x = data.x;
          players[data.id].pos_y = data.y;
        }
      } else if (data.type === 'player_left') {
        delete players[data.id];
      }
    };
  }

  // Send a JSON message if WS is open
  function sendMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn("WebSocket not connected, cannot send message");
    }
  }

  // Login handler
  function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    sendMessage({ type: 'login', username, password });
  }

  // Signup handler
  function signup() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    sendMessage({ type: 'signup', username, password });
  }

  // Convert tile coords to isometric screen coords
  function isoCoords(x, y) {
    return {
      screenX: (x - y) * tileWidth / 2 + canvas.width / 2 - tileWidth / 2,
      screenY: (x + y) * tileHeight / 2
    };
  }

  function drawTile(x, y, type) {
    const { screenX, screenY } = isoCoords(x, y);
    ctx.beginPath();
    ctx.moveTo(screenX, screenY + tileHeight / 2);
    ctx.lineTo(screenX + tileWidth / 2, screenY);
    ctx.lineTo(screenX + tileWidth, screenY + tileHeight / 2);
    ctx.lineTo(screenX + tileWidth / 2, screenY + tileHeight);
    ctx.closePath();

    if (type === 0) ctx.fillStyle = '#228B22'; // green grass
    else if (type === 1) ctx.fillStyle = '#8B4513'; // brown path
    else ctx.fillStyle = 'gray';

    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.stroke();
  }

  function drawPlayer(player) {
    const { screenX, screenY } = isoCoords(player.pos_x, player.pos_y);
    ctx.fillStyle = playerColor;
    ctx.beginPath();
    ctx.ellipse(screenX + tileWidth / 2, screenY + tileHeight / 2 - 10, 12, 16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.stroke();
  }

  function draw() {
    if (!map || !map.tiles) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < map.height; y++) {
      if (!map.tiles[y]) continue;
      for (let x = 0; x < map.width; x++) {
        drawTile(x, y, map.tiles[y][x]);
      }
    }

    for (const id in players) {
      drawPlayer(players[id]);
    }
  }

  // Movement with arrow keys / WASD
  document.addEventListener('keydown', (e) => {
    if (!player) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'w') dy = -1;
    else if (e.key === 'ArrowDown' || e.key.toLowerCase() === 's') dy = 1;
    else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') dx = -1;
    else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'd') dx = 1;
    if (dx !== 0 || dy !== 0) {
      sendMessage({ type: 'move', dx, dy });
    }
  });

  // Load map JSON then start
  fetch('map.json')
    .then(res => res.json())
    .then(data => {
      map = data;
      connect();
      setInterval(draw, 1000 / 30);
    })
    .catch(err => console.error("Failed to load map.json:", err));

  // Expose login/signup for buttons
  window.login = login;
  window.signup = signup;
});
