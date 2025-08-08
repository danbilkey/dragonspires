let ws;
let player = null;
let players = {};

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function connect() {
    ws = new WebSocket("wss://dragonspires.onrender.com");

    ws.onopen = () => {
        console.log("WebSocket connected");
        // Enable buttons here if you want to disable until connected
    };

    ws.onerror = (err) => console.error("WebSocket error", err);
    ws.onclose = () => console.log("WebSocket closed");

    ws.onmessage = (msg) => {
        console.log("Received from server:", msg.data);
        const data = JSON.parse(msg.data);

        if (data.type === 'login_success' || data.type === 'signup_success') {
            player = data.player;
            players[player.id] = player;
            document.getElementById('login').style.display = 'none';
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

// Helper function to send messages only if ws is open
function sendMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        console.warn("WebSocket not connected, cannot send message");
    }
}

function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    sendMessage({
        type: 'login',
        username,
        password
    });
}

function signup() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    sendMessage({
        type: 'signup',
        username,
        password
    });
}

document.addEventListener('keydown', (e) => {
    if (!player) return;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp' || e.key === 'w') dy = -1;
    if (e.key === 'ArrowDown' || e.key === 's') dy = 1;
    if (e.key === 'ArrowLeft' || e.key === 'a') dx = -1;
    if (e.key === 'ArrowRight' || e.key === 'd') dx = 1;
    if (dx || dy) {
        sendMessage({ type: 'move', dx, dy });
    }
});

connect();
