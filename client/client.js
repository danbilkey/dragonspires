const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
canvas.width = 640;
canvas.height = 480;

let ws;
let connected = false;
let loggedIn = false;
let assetsLoaded = false;

const images = {
    title: loadImage("/assets/title.GIF"),
    border: loadImage("/assets/game_border_2025.gif"),
    player: loadImage("/assets/player.png"), // placeholder sprite
};

let player = { x: 5, y: 5 };
let otherPlayers = [];

const TILE_SIZE = 32;
const MAP_WIDTH = 10;
const MAP_HEIGHT = 10;

// UI form values
let username = "";
let password = "";
let activeField = null;

function loadImage(src) {
    const img = new Image();
    img.src = src;
    img.onload = () => { checkAssetsLoaded(); };
    return img;
}

function checkAssetsLoaded() {
    assetsLoaded = Object.values(images).every(img => img.complete);
}

function connectToServer() {
    ws = new WebSocket(`wss://${window.location.host}`);
    ws.onopen = () => {
        connected = true;
    };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "login_success") {
            loggedIn = true;
            player = data.player;
        }
        else if (data.type === "player_joined") {
            otherPlayers.push(data.player);
        }
        else if (data.type === "player_moved") {
            const p = otherPlayers.find(p => p.id === data.id);
            if (p) {
                p.pos_x = data.x;
                p.pos_y = data.y;
            }
        }
        else if (data.type === "player_left") {
            otherPlayers = otherPlayers.filter(p => p.id !== data.id);
        }
    };
}

function sendLogin() {
    ws.send(JSON.stringify({
        type: "login",
        username,
        password
    }));
}

function sendSignup() {
    ws.send(JSON.stringify({
        type: "signup",
        username,
        password
    }));
}

function gameLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!connected) {
        // Title screen with connecting message
        ctx.drawImage(images.title, 0, 0);
        ctx.fillStyle = "yellow";
        ctx.font = "16px Arial";
        ctx.fillText("Connecting to server...", 47, 347);
    }
    else if (!loggedIn) {
        // Login screen with border and GUI inputs
        ctx.drawImage(images.border, 0, 0);
        ctx.fillStyle = "white";
        ctx.font = "14px Arial";
        ctx.fillText("Username:", 236, 40);
        ctx.fillText("Password:", 236, 60);

        // Input boxes
        ctx.strokeStyle = activeField === "username" ? "yellow" : "white";
        ctx.strokeRect(310, 28, 200, 20);
        ctx.strokeStyle = activeField === "password" ? "yellow" : "white";
        ctx.strokeRect(310, 48, 200, 20);

        ctx.fillStyle = "black";
        ctx.fillRect(311, 29, 198, 18);
        ctx.fillRect(311, 49, 198, 18);

        ctx.fillStyle = "white";
        ctx.fillText(username, 315, 43);
        ctx.fillText("*".repeat(password.length), 315, 63);

        // Buttons
        ctx.strokeStyle = "white";
        ctx.strokeRect(520, 28, 80, 20);
        ctx.strokeRect(520, 48, 80, 20);
        ctx.fillText("Login", 540, 43);
        ctx.fillText("Create Account", 522, 63);
    }
    else {
        // Render the game world with player centered
        for (let y = 0; y < MAP_HEIGHT; y++) {
            for (let x = 0; x < MAP_WIDTH; x++) {
                ctx.fillStyle = "#444";
                ctx.fillRect(
                    430 - player.pos_x * TILE_SIZE + x * TILE_SIZE,
                    142 - player.pos_y * TILE_SIZE + y * TILE_SIZE,
                    TILE_SIZE,
                    TILE_SIZE
                );
                ctx.strokeStyle = "#222";
                ctx.strokeRect(
                    430 - player.pos_x * TILE_SIZE + x * TILE_SIZE,
                    142 - player.pos_y * TILE_SIZE + y * TILE_SIZE,
                    TILE_SIZE,
                    TILE_SIZE
                );
            }
        }

        // Draw player at fixed position
        ctx.drawImage(images.player, 430, 142, TILE_SIZE, TILE_SIZE);

        // Draw other players
        for (const op of otherPlayers) {
            ctx.drawImage(
                images.player,
                430 - (player.pos_x - op.pos_x) * TILE_SIZE,
                142 - (player.pos_y - op.pos_y) * TILE_SIZE,
                TILE_SIZE,
                TILE_SIZE
            );
        }

        // Overlay border with white transparent
        const borderCanvas = document.createElement("canvas");
        borderCanvas.width = images.border.width;
        borderCanvas.height = images.border.height;
        const bctx = borderCanvas.getContext("2d");
        bctx.drawImage(images.border, 0, 0);
        const imgData = bctx.getImageData(0, 0, borderCanvas.width, borderCanvas.height);
        for (let i = 0; i < imgData.data.length; i += 4) {
            if (
                imgData.data[i] > 240 &&
                imgData.data[i + 1] > 240 &&
                imgData.data[i + 2] > 240
            ) {
                imgData.data[i + 3] = 0; // make transparent
            }
        }
        bctx.putImageData(imgData, 0, 0);
        ctx.drawImage(borderCanvas, 0, 0);
    }

    requestAnimationFrame(gameLoop);
}

canvas.addEventListener("mousedown", (e) => {
    if (!loggedIn && connected) {
        const mx = e.offsetX;
        const my = e.offsetY;

        // Check if clicking inside username box
        if (mx >= 310 && mx <= 510 && my >= 28 && my <= 48) {
            activeField = "username";
        }
        // Check if clicking inside password box
        else if (mx >= 310 && mx <= 510 && my >= 48 && my <= 68) {
            activeField = "password";
        }
        // Login button
        else if (mx >= 520 && mx <= 600 && my >= 28 && my <= 48) {
            sendLogin();
        }
        // Signup button
        else if (mx >= 520 && mx <= 600 && my >= 48 && my <= 68) {
            sendSignup();
        }
    }
});

window.addEventListener("keydown", (e) => {
    if (!loggedIn && connected && activeField) {
        if (e.key === "Backspace") {
            if (activeField === "username") {
                username = username.slice(0, -1);
            } else {
                password = password.slice(0, -1);
            }
        }
        else if (e.key.length === 1) {
            if (activeField === "username") {
                username += e.key;
            } else {
                password += e.key;
            }
        }
    }
});

connectToServer();
gameLoop();
