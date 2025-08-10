// server.js
// WS game server with: login, movement (costs 1 stamina), regen (stam/life/magic),
// chat validation, admin "-refresh PLAYER", single-session per username,
// map bounds checking from map1.json (width/height), stats_update pushes.

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// ---- Load map1 for bounds ----
let map1 = { width: 52, height: 100 };
try {
  const raw = fs.readFileSync('./map1.json', 'utf8');
  const m = JSON.parse(raw);
  if (m && m.width && m.height) map1 = m;
} catch (e) {
  console.warn('Could not load map1.json, using defaults 52x100.');
}

// ---- Very simple "DB" placeholders ----
// Replace these with your real DB calls.
const USERS = new Map(); // username -> record
function ensureUser(username, password) {
  if (!USERS.has(username)) {
    USERS.set(username, {
      username,
      password,     // DO NOT store plaintext in prod
      role: 'user', // or 'admin'
      map_id: 1,
      pos_x: 26, pos_y: 50,
      stamina: 100, max_stamina: 100,
      life: 100,    max_life: 100,
      magic: 30,    max_magic: 30,
      gold: 0,
      weapon: '', armor: '', hands: ''
    });
  }
  return USERS.get(username);
}
function authUser(username, password) {
  const u = USERS.get(username);
  if (!u) return null;
  if (u.password !== password) return null;
  return u;
}

// ---- Connections / sessions ----
const server = http.createServer();
const wss = new WebSocket.Server({ server });

let nextId = 1;
const clients = new Map();      // ws -> player
const byId = new Map();         // id -> { ... }
const byUsername = new Map();   // username -> ws

function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(s);
  });
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendStats(ws, p) {
  send(ws, {
    type: 'stats_update',
    stats: {
      stamina: p.stamina,
      max_stamina: p.max_stamina,
      life: p.life,
      max_life: p.max_life,
      magic: p.magic,
      max_magic: p.max_magic,
      gold: p.gold,
      weapon: p.weapon,
      armor: p.armor,
      hands: p.hands
    }
  });
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// very basic "naughty" filter (also blocks obvious SQL words/symbols)
const CHAT_MAX = 200;
const BAD_RE = /(--|;|\/\*|\*\/|\b(drop|delete|insert|update|select|union|alter|create|grant)\b)/i;

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data); } catch { return; }
    const me = clients.get(ws);

    // ---- login/signup ----
    if (msg.type === 'signup') {
      if (!msg.username || !msg.password) return;
      const u = ensureUser(msg.username, msg.password);
      // force logout any existing session with same user
      const old = byUsername.get(u.username);
      if (old && old !== ws) {
        const oldP = clients.get(old);
        try { send(old, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
        try { old.close(); } catch {}
      }

      const id = nextId++;
      const p = {
        id,
        username: u.username,
        role: u.role || 'user',
        map_id: u.map_id || 1,
        pos_x: u.pos_x || 26, pos_y: u.pos_y || 50,
        stamina: u.stamina, max_stamina: u.max_stamina,
        life: u.life,       max_life: u.max_life,
        magic: u.magic,     max_magic: u.max_magic,
        gold: u.gold,
        weapon: u.weapon, armor: u.armor, hands: u.hands
      };

      clients.set(ws, p);
      byId.set(p.id, p);
      byUsername.set(p.username, ws);

      send(ws, { type: 'signup_success', player: p });
      // announce to others
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'player_joined', player: { id: p.id, username: p.username, pos_x: p.pos_x, pos_y: p.pos_y } }));
        }
      });
      return;
    }

    if (msg.type === 'login') {
      if (!msg.username || !msg.password) return;
      const u = authUser(msg.username, msg.password);
      if (!u) { send(ws, { type: 'login_error', message: 'Invalid credentials' }); return; }

      // prevent multi-session: kick old
      const old = byUsername.get(u.username);
      if (old && old !== ws) {
        const oldP = clients.get(old);
        try { send(old, { type: 'chat', text: 'Disconnected: logged in from another game instance.' }); } catch {}
        try { old.close(); } catch {}
      }

      const id = nextId++;
      const p = {
        id,
        username: u.username,
        role: u.role || 'user',
        map_id: u.map_id || 1,
        pos_x: u.pos_x || 26, pos_y: u.pos_y || 50,
        stamina: u.stamina, max_stamina: u.max_stamina,
        life: u.life,       max_life: u.max_life,
        magic: u.magic,     max_magic: u.max_magic,
        gold: u.gold,
        weapon: u.weapon, armor: u.armor, hands: u.hands
      };

      clients.set(ws, p);
      byId.set(p.id, p);
      byUsername.set(p.username, ws);

      send(ws, { type: 'login_success', player: p });

      // tell others this player joined
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'player_joined', player: { id: p.id, username: p.username, pos_x: p.pos_x, pos_y: p.pos_y } }));
        }
      });
      return;
    }

    // everything below requires being logged in
    if (!me) return;

    if (msg.type === 'move') {
      const dx = Number(msg.dx) || 0;
      const dy = Number(msg.dy) || 0;

      // stamina gate (cost 1)
      if ((me.stamina || 0) <= 0) {
        send(ws, { type: 'stats_update', stats: { stamina: me.stamina, max_stamina: me.max_stamina } });
        return;
      }

      const nx = me.pos_x + dx;
      const ny = me.pos_y + dy;

      const w = map1.width || 52;
      const h = map1.height || 100;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;

      me.pos_x = nx; me.pos_y = ny;
      me.stamina = Math.max(0, me.stamina - 1);

      // echo to mover (pos + stamina), and broadcast movement
      send(ws, { type: 'player_moved', id: me.id, username: me.username, x: me.pos_x, y: me.pos_y });
      sendStats(ws, me);

      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'player_moved', id: me.id, username: me.username, x: me.pos_x, y: me.pos_y }));
        }
      });
      return;
    }

    if (msg.type === 'chat') {
      if (typeof msg.text !== 'string') return;
      const raw = msg.text.trim();

      // admin -refresh PLAYER
      if (raw.toLowerCase().startsWith('-refresh ')) {
        if ((me.role || '').toLowerCase() !== 'admin') {
          send(ws, { type: 'chat', text: '~ You are not authorized to take that action.' });
          return;
        }
        const targetName = raw.slice(9).trim();
        const tWs = byUsername.get(targetName);
        if (!tWs) { send(ws, { type: 'chat', text: `~ Could not find player "${targetName}" online.` }); return; }
        const tp = clients.get(tWs);
        if (!tp) { send(ws, { type: 'chat', text: `~ Could not find player "${targetName}" online.` }); return; }

        tp.stamina = tp.max_stamina;
        tp.life    = tp.max_life;
        tp.magic   = tp.max_magic;

        sendStats(tWs, tp);
        send(ws, { type: 'chat', text: `~ Refreshed ${tp.username}.` });
        return;
      }

      // normal chat validation
      if (raw.length === 0 || raw.length > CHAT_MAX || BAD_RE.test(raw)) {
        send(ws, { type: 'chat', text: '~ The game has rejected your message due to bad language.' });
        return;
      }

      // broadcast in "Player: msg" format
      const out = `${me.username}: ${raw}`;
      broadcast({ type: 'chat', text: out });
      return;
    }
  });

  ws.on('close', () => {
    const p = clients.get(ws);
    if (!p) return;
    clients.delete(ws);
    byId.delete(p.id);
    const curr = byUsername.get(p.username);
    if (curr === ws) byUsername.delete(p.username);
    broadcast({ type: 'player_left', id: p.id });
  });
});

// ---- REGEN TIMERS ----
setInterval(() => {
  // stamina +10% max every 3s (min +1)
  clients.forEach((p, ws) => {
    const inc = Math.max(1, Math.floor((p.max_stamina || 0) * 0.10));
    const before = p.stamina || 0;
    p.stamina = clamp(before + inc, 0, p.max_stamina || before);
    if (p.stamina !== before) sendStats(ws, p);
  });
}, 3000);

setInterval(() => {
  // life +5% max every 5s (min +1)
  clients.forEach((p, ws) => {
    const inc = Math.max(1, Math.floor((p.max_life || 0) * 0.05));
    const before = p.life || 0;
    p.life = clamp(before + inc, 0, p.max_life || before);
    if (p.life !== before) sendStats(ws, p);
  });
}, 5000);

setInterval(() => {
  // magic +5 every 30s
  clients.forEach((p, ws) => {
    const before = p.magic || 0;
    p.magic = clamp(before + 5, 0, p.max_magic || before);
    if (p.magic !== before) sendStats(ws, p);
  });
}, 30000);

server.listen(PORT, () => console.log('WS server on', PORT));
