const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ══════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════
const WORLD_W      = 3000;
const WORLD_H      = 3000;
const TICK_MS      = 1000 / 30;   // server physics: 30 Hz (independent of client fps)
const PLAYER_SPEED = 4;            // px per server tick
const BASE_RADIUS  = 18;
const MAX_LEVEL    = 50;

const MAX_ORBS     = 80;
const ORB_RADIUS   = 7;
const ORB_SPAWN_MS = 1200;

const MAX_MONSTERS = 40;
const MONSTER_TYPES = [
  { type:'dot',      hp:20,  speed:1.2, r:6,  xp:8,  color:'#e05050', dmg:5,  atkR:22, atkCD:1500 },
  { type:'line',     hp:40,  speed:0.9, r:14, xp:18, color:'#9050e0', dmg:10, atkR:28, atkCD:2000 },
  { type:'triangle', hp:70,  speed:0.7, r:18, xp:35, color:'#e07020', dmg:18, atkR:32, atkCD:2500 },
  { type:'square',   hp:120, speed:0.5, r:22, xp:60, color:'#205090', dmg:28, atkR:38, atkCD:3000 },
];
let monsterIdCounter = 0;
let orbIdCounter     = 0;

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function randomPos(margin = 40) {
  return {
    x: clamp(margin + Math.random() * (WORLD_W - margin * 2), margin, WORLD_W - margin),
    y: clamp(margin + Math.random() * (WORLD_H - margin * 2), margin, WORLD_H - margin),
  };
}
// [FIX #4] wander target always inside world
function randomWander(cx, cy, spread = 300) {
  return {
    tx: clamp(cx + (Math.random()-0.5)*spread, 50, WORLD_W-50),
    ty: clamp(cy + (Math.random()-0.5)*spread, 50, WORLD_H-50),
  };
}
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function xpToNextLevel(level) { return Math.floor(30 * Math.pow(1.4, level - 1)); }
function radiusForLevel(level) { return BASE_RADIUS + Math.floor((level - 1) * 1.5); }

function applyLevelUp(p) {
  let leveled = false;
  while (p.level < MAX_LEVEL && p.xp >= xpToNextLevel(p.level)) {
    p.xp    -= xpToNextLevel(p.level);
    p.level += 1;
    leveled  = true;
  }
  if (p.level >= MAX_LEVEL) p.xp = 0;
  return leveled;
}

// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
const players  = {};
const orbs     = {};
const monsters = {};

function spawnOrb() {
  if (Object.keys(orbs).length >= MAX_ORBS) return;
  const id = ++orbIdCounter;
  const pos = randomPos(30);
  orbs[id] = { id, x: pos.x, y: pos.y, value: 5 + Math.floor(Math.random() * 6) };
}
for (let i = 0; i < MAX_ORBS; i++) spawnOrb();
setInterval(spawnOrb, ORB_SPAWN_MS);

function spawnMonster() {
  if (Object.keys(monsters).length >= MAX_MONSTERS) return;
  const def = MONSTER_TYPES[Math.floor(Math.random() * MONSTER_TYPES.length)];
  const id  = ++monsterIdCounter;
  const pos = randomPos(60);
  const wander = randomWander(pos.x, pos.y);
  monsters[id] = {
    id, type: def.type, color: def.color,
    x: pos.x, y: pos.y,
    hp: def.hp, maxHp: def.hp,
    speed: def.speed, r: def.r, xp: def.xp,
    dmg: def.dmg, atkR: def.atkR, atkCD: def.atkCD,
    tx: wander.tx, ty: wander.ty,
    lastAttack: {},   // playerId → timestamp
    aggroTarget: null,
  };
}
for (let i = 0; i < MAX_MONSTERS; i++) spawnMonster();
setInterval(spawnMonster, 3000);

// ══════════════════════════════════════
//  GAME LOOP  (30 Hz physics)
// ══════════════════════════════════════
setInterval(() => {
  const now = Date.now();

  // ── Players ──
  for (const id in players) {
    const p = players[id];
    let dx = 0, dy = 0;
    if (p.keys.up)    dy -= 1;
    if (p.keys.down)  dy += 1;
    if (p.keys.left)  dx -= 1;
    if (p.keys.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
    const r = radiusForLevel(p.level);
    p.x = clamp(p.x + dx * PLAYER_SPEED, r, WORLD_W - r);
    p.y = clamp(p.y + dy * PLAYER_SPEED, r, WORLD_H - r);

    // Orb pickup — [FIX #3] collect IDs first, then delete outside loop
    const toDelete = [];
    for (const oid in orbs) {
      if (dist(p, orbs[oid]) < r + ORB_RADIUS) toDelete.push(oid);
    }
    for (const oid of toDelete) {
      if (!orbs[oid]) continue;  // already picked by someone else this tick
      p.xp += orbs[oid].value;
      delete orbs[oid];
    }
    if (toDelete.length > 0) {
      const leveled = applyLevelUp(p);
      if (leveled) io.emit('levelUp', { id: p.id, level: p.level, name: p.name });
    }
  }

  // ── Monsters ──
  const playerList = Object.values(players);
  for (const mid in monsters) {
    const m = monsters[mid];

    // Aggro: nearest player within 300px
    let nearest = null, nearDist = 300;
    for (const p of playerList) {
      const d = dist(m, p);
      if (d < nearDist) { nearDist = d; nearest = p; }
    }
    m.aggroTarget = nearest ? nearest.id : null;

    if (nearest) {
      const dx = nearest.x - m.x, dy = nearest.y - m.y;
      const d  = Math.hypot(dx, dy) || 1;
      m.x += (dx / d) * m.speed;
      m.y += (dy / d) * m.speed;

      // Attack
      if (dist(m, nearest) < m.atkR + radiusForLevel(nearest.level)) {
        const lastHit = m.lastAttack[nearest.id] || 0;
        if (now - lastHit > m.atkCD) {
          m.lastAttack[nearest.id] = now;
          nearest.hp -= m.dmg;
          io.to(nearest.id).emit('damaged', { dmg: m.dmg });

          if (nearest.hp <= 0) {
            nearest.hp = nearest.maxHp;
            const pos  = randomPos(BASE_RADIUS);
            nearest.x  = pos.x;
            nearest.y  = pos.y;
            nearest.xp = Math.floor(nearest.xp * 0.9);
            io.to(nearest.id).emit('died');
          }
        }
      }
      // [FIX #2] clean up lastAttack for players that have left
      for (const pid of Object.keys(m.lastAttack)) {
        if (!players[pid]) delete m.lastAttack[pid];
      }
    } else {
      // Wander
      const dx = m.tx - m.x, dy = m.ty - m.y;
      const d  = Math.hypot(dx, dy) || 1;
      if (d < 5) {
        const w = randomWander(m.x, m.y);  // [FIX #4] clamped wander target
        m.tx = w.tx; m.ty = w.ty;
      } else {
        m.x += (dx / d) * m.speed * 0.5;
        m.y += (dy / d) * m.speed * 0.5;
      }
    }
    m.x = clamp(m.x, m.r, WORLD_W - m.r);
    m.y = clamp(m.y, m.r, WORLD_H - m.r);
  }

  // ── Broadcast ──
  const snapPlayers  = playerList.map(p => ({
    id: p.id, x: p.x, y: p.y, name: p.name,
    r: radiusForLevel(p.level), level: p.level,
    xp: p.xp, xpMax: xpToNextLevel(p.level),
    hp: p.hp, maxHp: p.maxHp,
  }));
  const snapOrbs     = Object.values(orbs);
  const snapMonsters = Object.values(monsters).map(m => ({
    id: m.id, x: m.x, y: m.y, type: m.type,
    r: m.r, hp: m.hp, maxHp: m.maxHp, color: m.color,
  }));

  io.emit('state', { players: snapPlayers, orbs: snapOrbs, monsters: snapMonsters });
}, TICK_MS);

// ══════════════════════════════════════
//  SOCKETS
// ══════════════════════════════════════
io.on('connection', (socket) => {
  console.log('[+]', socket.id);

  socket.on('join', ({ name }) => {
    if (players[socket.id]) return;
    const trimmed = (name || 'Player').trim().slice(0, 16) || 'Player';
    const pos = randomPos(BASE_RADIUS);
    players[socket.id] = {
      id: socket.id, name: trimmed,
      x: pos.x, y: pos.y,
      level: 1, xp: 0,
      hp: 100, maxHp: 100,
      keys: { up:false, down:false, left:false, right:false },
    };
    socket.emit('welcome', { id: socket.id, worldW: WORLD_W, worldH: WORLD_H });
  });

  socket.on('keys', (keys) => {
    if (!players[socket.id]) return;
    players[socket.id].keys = {
      up: !!keys.up, down: !!keys.down,
      left: !!keys.left, right: !!keys.right,
    };
  });

  socket.on('attack', ({ monsterId }) => {
    const p = players[socket.id];
    const m = monsters[monsterId];
    if (!p || !m) return;
    if (dist(p, m) > radiusForLevel(p.level) + m.r + 10) return;
    const dmg = 10 + (p.level - 1) * 3;
    m.hp -= dmg;
    socket.emit('attackResult', { monsterId, dmg, hp: m.hp });
    if (m.hp <= 0) {
      p.xp += m.xp;
      const leveled = applyLevelUp(p);
      if (leveled) io.emit('levelUp', { id: p.id, level: p.level, name: p.name });
      io.emit('monsterDied', { monsterId, killerId: p.id, xp: m.xp });
      delete monsters[monsterId];
    }
  });

  socket.on('chat', (raw) => {
    const p = players[socket.id];
    if (!p) return;
    const text = String(raw).trim().slice(0, 80);
    if (!text) return;
    io.emit('chat', { id: p.id, name: p.name, text });
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`◉ sphere.io → http://localhost:${PORT}`));