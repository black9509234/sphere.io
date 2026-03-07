const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const fs      = require('fs');
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
const BASE_PLAYER_SPEED = 4;       // px per server tick
const BASE_RADIUS  = 18;
const MAX_LEVEL    = 50;
const STAT_POINTS_PER_LEVEL = 3;

const MAX_ORBS     = 80;
const ORB_RADIUS   = 7;
const ORB_SPAWN_MS = 1200;

const MAX_MONSTERS = 40;
const SAVE_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(SAVE_DIR, 'profiles.json');
const MONSTER_TYPES = [
  { type:'dot',      hp:20,  speed:1.2, r:6,  xp:8,  color:'#ef4444', dmg:5,  atkR:22, atkCD:1500 },
  { type:'line',     hp:40,  speed:0.9, r:14, xp:18, color:'#8b5cf6', dmg:10, atkR:28, atkCD:2000 },
  { type:'triangle', hp:70,  speed:0.7, r:18, xp:35, color:'#f59e0b', dmg:18, atkR:32, atkCD:2500 },
  { type:'square',   hp:120, speed:0.5, r:22, xp:60, color:'#14b8a6', dmg:28, atkR:38, atkCD:3000 },
];
let monsterIdCounter = 0;
let orbIdCounter     = 0;
const DEFAULT_STATS = Object.freeze({ str: 0, agi: 0, vit: 0, dex: 0, wis: 0, luk: 0 });

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
if (!fs.existsSync(SAVE_FILE)) fs.writeFileSync(SAVE_FILE, '{}', 'utf8');

function loadProfiles() {
  try {
    return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

let savedProfiles = loadProfiles();
let saveTimer = null;

function scheduleSaveProfiles() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(SAVE_FILE, JSON.stringify(savedProfiles, null, 2), () => {});
  }, 200);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

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
function speedForPlayer(p) { return BASE_PLAYER_SPEED + p.stats.agi * 0.22; }
function damageForPlayer(p) { return 10 + (p.level - 1) * 3 + p.stats.str * 2; }
function attackRangeForPlayer(p) { return radiusForLevel(p.level) + 26 + p.stats.str * 1.5; }
function critChanceForPlayer(p) { return Math.min(0.35, p.stats.luk * 0.02); }
function critMultiplierForPlayer(p) { return 1.7 + p.stats.luk * 0.03; }
function orbBonusForPlayer(p) { return 1 + p.stats.wis * 0.04; }
function normalizeStats(raw = {}) {
  return {
    str: clamp(Number(raw.str) || 0, 0, 999),
    agi: clamp(Number(raw.agi) || 0, 0, 999),
    vit: clamp(Number(raw.vit) || 0, 0, 999),
    dex: clamp(Number(raw.dex) || 0, 0, 999),
    wis: clamp(Number(raw.wis) || 0, 0, 999),
    luk: clamp(Number(raw.luk) || 0, 0, 999),
  };
}
function recalcDerivedStats(p) {
  p.maxHp = 100 + p.stats.vit * 20;
  p.hp = clamp(p.hp, 0, p.maxHp);
}
function serializePlayerProfile(p) {
  return {
    name: p.name,
    x: Math.round(p.x),
    y: Math.round(p.y),
    level: p.level,
    xp: p.xp,
    hp: p.hp,
    statPoints: p.statPoints,
    stats: p.stats,
  };
}
function persistPlayerProfile(p) {
  savedProfiles[p.name] = serializePlayerProfile(p);
  scheduleSaveProfiles();
}
function makePlayerState(socketId, name, saved = {}) {
  const stats = normalizeStats(saved.stats || DEFAULT_STATS);
  const level = clamp(Number(saved.level) || 1, 1, MAX_LEVEL);
  const r = radiusForLevel(level);
  const defaultPos = randomPos(BASE_RADIUS);
  const pos = {
    x: clamp(Number.isFinite(Number(saved.x)) ? Number(saved.x) : defaultPos.x, r, WORLD_W - r),
    y: clamp(Number.isFinite(Number(saved.y)) ? Number(saved.y) : defaultPos.y, r, WORLD_H - r),
  };
  const p = {
    id: socketId,
    name,
    x: pos.x,
    y: pos.y,
    level,
    xp: clamp(Number(saved.xp) || 0, 0, level >= MAX_LEVEL ? 0 : xpToNextLevel(level)),
    hp: 100,
    maxHp: 100,
    statPoints: clamp(Number(saved.statPoints) || 0, 0, 9999),
    stats,
    keys: { up:false, down:false, left:false, right:false },
  };
  recalcDerivedStats(p);
  p.hp = clamp(Number(saved.hp) || p.maxHp, 1, p.maxHp);
  return p;
}

function applyLevelUp(p) {
  let gained = 0;
  while (p.level < MAX_LEVEL && p.xp >= xpToNextLevel(p.level)) {
    p.xp    -= xpToNextLevel(p.level);
    p.level += 1;
    gained += 1;
  }
  if (p.level >= MAX_LEVEL) p.xp = 0;
  if (gained > 0) p.statPoints += gained * STAT_POINTS_PER_LEVEL;
  return gained;
}

// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
const players  = {};
const orbs     = {};
const monsters = {};
const activePlayersByName = {};

function removePlayer(socketId, { save = true } = {}) {
  const p = players[socketId];
  if (!p) return;
  if (save) persistPlayerProfile(p);
  if (activePlayersByName[p.name] === socketId) delete activePlayersByName[p.name];
  delete players[socketId];
}

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
    const moveSpeed = speedForPlayer(p);
    p.x = clamp(p.x + dx * moveSpeed, r, WORLD_W - r);
    p.y = clamp(p.y + dy * moveSpeed, r, WORLD_H - r);

    // Orb pickup — [FIX #3] collect IDs first, then delete outside loop
    const toDelete = [];
    for (const oid in orbs) {
      if (dist(p, orbs[oid]) < r + ORB_RADIUS) toDelete.push(oid);
    }
    for (const oid of toDelete) {
      if (!orbs[oid]) continue;  // already picked by someone else this tick
      const bonus = orbBonusForPlayer(p);
      p.xp += Math.round(orbs[oid].value * bonus);
      p.hp = clamp(p.hp + Math.ceil(orbs[oid].value * (0.8 + p.stats.wis * 0.1)), 0, p.maxHp);
      delete orbs[oid];
    }
    if (toDelete.length > 0) {
      const gained = applyLevelUp(p);
      if (gained > 0) io.emit('levelUp', { id: p.id, level: p.level, name: p.name, gained, statPoints: p.statPoints });
      persistPlayerProfile(p);
    } else if (dx !== 0 || dy !== 0) {
      persistPlayerProfile(p);
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
            persistPlayerProfile(nearest);
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
    atkRange: attackRangeForPlayer(p),
    statPoints: p.statPoints, stats: p.stats,
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
    const activeId = activePlayersByName[trimmed];
    if (activeId && activeId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(activeId);
      if (oldSocket) {
        oldSocket.emit('sessionReplaced');
        oldSocket.disconnect(true);
      }
      removePlayer(activeId, { save: true });
    }
    players[socket.id] = makePlayerState(socket.id, trimmed, savedProfiles[trimmed]);
    activePlayersByName[trimmed] = socket.id;
    persistPlayerProfile(players[socket.id]);
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
    if (dist(p, m) > attackRangeForPlayer(p) + m.r) return;
    const isCrit = Math.random() < critChanceForPlayer(p);
    const dmg = Math.round(damageForPlayer(p) * (isCrit ? critMultiplierForPlayer(p) : 1));
    m.hp -= dmg;
    socket.emit('attackResult', { monsterId, dmg, hp: m.hp, crit: isCrit });
    if (m.hp <= 0) {
      p.xp += Math.round(m.xp * orbBonusForPlayer(p));
      const gained = applyLevelUp(p);
      if (gained > 0) io.emit('levelUp', { id: p.id, level: p.level, name: p.name, gained, statPoints: p.statPoints });
      persistPlayerProfile(p);
      io.emit('monsterDied', { monsterId, killerId: p.id, xp: m.xp });
      delete monsters[monsterId];
    }
  });

  socket.on('allocateStat', ({ stat }, ack) => {
    const p = players[socket.id];
    if (!p) return ack && ack({ ok: false, error: 'not_joined' });
    if (!['str', 'agi', 'vit', 'dex', 'wis', 'luk'].includes(stat)) return ack && ack({ ok: false, error: 'bad_stat' });
    if (p.statPoints <= 0) return ack && ack({ ok: false, error: 'no_points' });
    const prevMaxHp = p.maxHp;
    p.statPoints -= 1;
    p.stats[stat] += 1;
    recalcDerivedStats(p);
    if (stat === 'vit') p.hp = clamp(p.hp + (p.maxHp - prevMaxHp), 0, p.maxHp);
    persistPlayerProfile(p);
    if (ack) ack({ ok: true, statPoints: p.statPoints, stats: p.stats, hp: p.hp, maxHp: p.maxHp });
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
    removePlayer(socket.id, { save: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`◉ sphere.io → http://localhost:${PORT}`));
