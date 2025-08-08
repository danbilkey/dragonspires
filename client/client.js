let ws;
let player = null;
let players = {};

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function connect() {
    ws = new WebSocket("wss://dragonspires.onrender.com"); // Change to Render WS URL when deployed

    ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.type === 'login_success' || data.type === 'signup_success') {
            player = data.player;
            players[player.id] = player;
            document.getElementById('login').style.display = 'none';
        }
        else if (data.type === 'player_joined') {
            players[data.player.id] = data.player;
        }
        else if (data.type === 'player_moved') {
            if (players[data.id]) {
                players[data.id].pos_x = data.x;
                players[data.id].pos_y = data.y;
            }
        }
        else if (data.type === 'player_left') {
            delete players[data.id];
        }
    };
}

function login() {
    ws.send(JSON.stringify({
        type: 'login',
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
    }));
}

function signup() {
    ws.send(JSON.stringify({
        type: 'signup',
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
    }));
}

document.addEventListener('keydown', (e) => {
    if (!player) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp' || e.key === 'w') dy = -1;
    if (e.key === 'ArrowDown' || e.key === 's') dy = 1;
    if (e.key === 'ArrowLeft' || e.key === 'a') dx = -1;
    if (e.key === 'ArrowRight' || e.key === 'd') dx = 1;
    if (dx || dy) {
        ws.send(JSON.stringify({ type: 'move', dx, dy }));
    }
});

function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let id in players) {
        let p = players[id];
        ctx.fillStyle = (p.id === player?.id) ? 'blue' : 'red';
        ctx.fillRect(p.pos_x * 20, p.pos_y * 20, 20, 20);
    }
    requestAnimationFrame(render);
}

connect();
render();

