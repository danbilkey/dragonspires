const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = 800;
canvas.height = 600;

const tileWidth = 64;
const tileHeight = 32;

// Placeholder player color
const playerColor = 'blue';

// Load static map JSON
let map = null;
fetch('map.json')
  .then(res => res.json())
  .then(data => {
    map = data;
    draw();
  });

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
  // Draw a circle slightly above the tile center
  ctx.beginPath();
  ctx.ellipse(screenX + tileWidth / 2, screenY + tileHeight / 2 - 10, 12, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'black';
  ctx.stroke();
}

function draw() {
  if (!map) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw all tiles
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      drawTile(x, y, map.tiles[y][x]);
    }
  }

  // Draw all players
  for (const id in players) {
    drawPlayer(players[id]);
  }
}

// Call draw() on each frame or after player movement to update
setInterval(draw, 1000 / 30);
