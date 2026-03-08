const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const WORLD_W = 3000;
const WORLD_H = 3000;
const TICK_MS = 1000 / 30;
const BASE_PLAYER_SPEED = 3.2;
const BASE_PLAYER_ATTACK_CD = 620;
const MIN_PLAYER_ATTACK_CD = 260;
const PLAYER_RADIUS = 18;
const MAX_LEVEL = 50;
const STAT_POINTS_PER_LEVEL = 3;

const MAX_ORBS = 80;
const ORB_RADIUS = 7;
const ORB_SPAWN_MS = 1200;

const MAX_MONSTERS = 40;
const INVENTORY_LIMIT = 12;
const LOOT_RADIUS = 14;
const LOOT_DESPAWN_MS = 45000;
const DEATH_XP_LOSS_RATIO = 0.25;
const DEATH_POINT_LOSS = 1;
const DEFAULT_MAP_ID = 'field';
const MONO_MAP_ID = 'mono';
const PORTAL_RADIUS = 42;
const PORTAL_COOLDOWN_MS = 1200;
const MAX_RARITY = 10;

const SAVE_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(SAVE_DIR, 'profiles.json');

const MONSTER_TYPES = [
  { type: 'dot', hp: 20, speed: 1.2, r: 6, xp: 8, color: '#ef4444', dmg: 5, atkR: 22, atkCD: 1500 },
  { type: 'line', hp: 40, speed: 0.9, r: 14, xp: 18, color: '#8b5cf6', dmg: 10, atkR: 28, atkCD: 2000 },
  { type: 'triangle', hp: 70, speed: 0.7, r: 18, xp: 35, color: '#f59e0b', dmg: 18, atkR: 32, atkCD: 2500 },
  { type: 'square', hp: 120, speed: 0.5, r: 22, xp: 60, color: '#14b8a6', dmg: 28, atkR: 38, atkCD: 3000 },
];
const MONSTER_TYPE_MAP = Object.freeze(Object.fromEntries(MONSTER_TYPES.map(def => [def.type, def])));
const MONSTER_PROGRESS_RULES = Object.freeze({
  dot: { unlockByType: null, unlockKills: 0, spawnWeight: 1.2 },
  line: { unlockByType: 'dot', unlockKills: 12, spawnWeight: 0.72 },
  triangle: { unlockByType: 'line', unlockKills: 10, spawnWeight: 0.42 },
  square: { unlockByType: 'triangle', unlockKills: 8, spawnWeight: 0.24 },
});

const DEFAULT_STATS = Object.freeze({ str: 0, agi: 0, vit: 0, dex: 0, wis: 0, luk: 0 });
const EQUIP_SLOTS = Object.freeze(['weapon', 'armor', 'boots', 'gloves', 'charm']);
const MAP_DEFS = Object.freeze({
  [DEFAULT_MAP_ID]: {
    key: DEFAULT_MAP_ID,
    portal: {
      x: WORLD_W - 96,
      y: WORLD_H / 2,
      r: PORTAL_RADIUS,
      targetMapId: MONO_MAP_ID,
      targetX: 160,
      targetY: WORLD_H / 2,
    },
  },
  [MONO_MAP_ID]: {
    key: MONO_MAP_ID,
    portal: {
      x: 96,
      y: WORLD_H / 2,
      r: PORTAL_RADIUS,
      targetMapId: DEFAULT_MAP_ID,
      targetX: WORLD_W - 160,
      targetY: WORLD_H / 2,
    },
  },
});
const ITEM_DEFS = Object.freeze({
  iron_blade: {
    key: 'iron_blade',
    slot: 'weapon',
    color: '#b91c1c',
    bonuses: { str: 1, dex: 1 },
  },
  guard_armor: {
    key: 'guard_armor',
    slot: 'armor',
    color: '#475569',
    bonuses: { vit: 1, str: 1 },
  },
  wind_boots: {
    key: 'wind_boots',
    slot: 'boots',
    color: '#2563eb',
    bonuses: { agi: 1, luk: 1 },
  },
  focus_gloves: {
    key: 'focus_gloves',
    slot: 'gloves',
    color: '#7c3aed',
    bonuses: { dex: 1, wis: 1 },
  },
  lucky_charm: {
    key: 'lucky_charm',
    slot: 'charm',
    color: '#d97706',
    bonuses: { luk: 1, wis: 1 },
  },
});
const RARITY_DEFS = Object.freeze({
  1: { key: 1, color: '#9ca3af', bonusScale: 0, craftChance: 0.92 },
  2: { key: 2, color: '#f8fafc', bonusScale: 1, craftChance: 0.86 },
  3: { key: 3, color: '#22c55e', bonusScale: 2, craftChance: 0.78 },
  4: { key: 4, color: '#3b82f6', bonusScale: 3, craftChance: 0.68 },
  5: { key: 5, color: '#a855f7', bonusScale: 4, craftChance: 0.58 },
  6: { key: 6, color: '#f97316', bonusScale: 5, craftChance: 0.48 },
  7: { key: 7, color: '#ef4444', bonusScale: 6, craftChance: 0.38 },
  8: { key: 8, color: '#14b8a6', bonusScale: 7, craftChance: 0.28 },
  9: { key: 9, color: '#facc15', bonusScale: 8, craftChance: 0.18 },
  10: { key: 10, color: '#111111', bonusScale: 10, craftChance: 0 },
});
const MONSTER_RARITY_TABLES = Object.freeze({
  low: [
    { rarity: 1, weight: 0.42 },
    { rarity: 2, weight: 0.38 },
    { rarity: 3, weight: 0.15 },
    { rarity: 4, weight: 0.05 },
  ],
  mid: [
    { rarity: 1, weight: 0.28 },
    { rarity: 2, weight: 0.36 },
    { rarity: 3, weight: 0.22 },
    { rarity: 4, weight: 0.1 },
    { rarity: 5, weight: 0.04 },
  ],
  high: [
    { rarity: 1, weight: 0.18 },
    { rarity: 2, weight: 0.32 },
    { rarity: 3, weight: 0.25 },
    { rarity: 4, weight: 0.15 },
    { rarity: 5, weight: 0.08 },
    { rarity: 6, weight: 0.02 },
  ],
  elite: [
    { rarity: 1, weight: 0.08 },
    { rarity: 2, weight: 0.26 },
    { rarity: 3, weight: 0.28 },
    { rarity: 4, weight: 0.18 },
    { rarity: 5, weight: 0.11 },
    { rarity: 6, weight: 0.07 },
    { rarity: 7, weight: 0.02 },
  ],
});
const worldMonsterKills = Object.fromEntries(MONSTER_TYPES.map(def => [def.type, 0]));

let monsterIdCounter = 0;
let orbIdCounter = 0;
let lootIdCounter = 0;
let itemSerial = Date.now();

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

function normalizePlayerName(raw) {
  return (raw || 'Player').trim().slice(0, 16) || 'Player';
}

function playerNameKey(name) {
  return normalizePlayerName(name).toLowerCase();
}

function scheduleSaveProfiles() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(SAVE_FILE, JSON.stringify(savedProfiles, null, 2), () => {});
  }, 200);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function flushSaveProfilesSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  fs.writeFileSync(SAVE_FILE, JSON.stringify(savedProfiles, null, 2), 'utf8');
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeZeroStats() {
  return { str: 0, agi: 0, vit: 0, dex: 0, wis: 0, luk: 0 };
}

function randomPos(margin = 40) {
  return {
    x: clamp(margin + Math.random() * (WORLD_W - margin * 2), margin, WORLD_W - margin),
    y: clamp(margin + Math.random() * (WORLD_H - margin * 2), margin, WORLD_H - margin),
  };
}

function randomWander(cx, cy, spread = 300) {
  return {
    tx: clamp(cx + (Math.random() - 0.5) * spread, 50, WORLD_W - 50),
    ty: clamp(cy + (Math.random() - 0.5) * spread, 50, WORLD_H - 50),
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function xpToNextLevel(level) {
  return Math.floor(30 * Math.pow(1.2, level - 1));
}

function radiusForLevel() {
  return PLAYER_RADIUS;
}

function nextItemId() {
  itemSerial += 1;
  return `it_${itemSerial.toString(36)}`;
}

function normalizeRarity(raw) {
  return clamp(Math.round(Number(raw) || 2), 1, MAX_RARITY);
}

function rarityDef(rarity) {
  return RARITY_DEFS[normalizeRarity(rarity)] || RARITY_DEFS[2];
}

function rarityColor(rarity) {
  return rarityDef(rarity).color;
}

function rarityBonusScale(rarity) {
  return rarityDef(rarity).bonusScale;
}

function craftChanceForRarity(rarity) {
  return rarityDef(rarity).craftChance;
}

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

function normalizeMapId(raw) {
  return typeof raw === 'string' && MAP_DEFS[raw] ? raw : DEFAULT_MAP_ID;
}

function portalForMap(mapId) {
  return MAP_DEFS[normalizeMapId(mapId)]?.portal || null;
}

function addStats(target, bonus) {
  for (const stat of Object.keys(target)) {
    target[stat] += Number(bonus?.[stat]) || 0;
  }
  return target;
}

function getItemDef(key) {
  return ITEM_DEFS[key] || null;
}

function itemBonusesFor(def, rarity) {
  const bonuses = makeZeroStats();
  const scale = rarityBonusScale(rarity);
  for (const stat of Object.keys(bonuses)) {
    const base = def?.bonuses?.[stat] || 0;
    bonuses[stat] = Math.max(0, Math.round(base * scale));
  }
  return bonuses;
}

function inferRarityFromBonuses(def, bonuses) {
  if (!def || !bonuses || typeof bonuses !== 'object') return 2;
  let inferredScale = 0;
  for (const stat of Object.keys(def.bonuses)) {
    const base = Number(def.bonuses[stat]) || 0;
    if (base <= 0) continue;
    const value = Number(bonuses[stat]) || 0;
    inferredScale = Math.max(inferredScale, Math.round(value / base));
  }
  if (inferredScale <= 0) return 1;
  return clamp(inferredScale + 1, 1, MAX_RARITY);
}

function makeItemInstance(key, rarity = 2) {
  const def = getItemDef(key);
  if (!def) return null;
  const nextRarity = normalizeRarity(rarity);
  return {
    id: nextItemId(),
    key: def.key,
    slot: def.slot,
    color: rarityColor(nextRarity),
    rarity: nextRarity,
    bonuses: itemBonusesFor(def, nextRarity),
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = getItemDef(raw.key);
  if (!def) return null;
  const rarity = normalizeRarity(raw.rarity || inferRarityFromBonuses(def, raw.bonuses));
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nextItemId(),
    key: def.key,
    slot: def.slot,
    color: rarityColor(rarity),
    rarity,
    bonuses: itemBonusesFor(def, rarity),
  };
}

function normalizeInventory(raw = []) {
  if (!Array.isArray(raw)) return [];
  const inventory = [];
  for (const entry of raw) {
    const item = normalizeItem(entry);
    if (!item) continue;
    inventory.push(item);
    if (inventory.length >= INVENTORY_LIMIT) break;
  }
  return inventory;
}

function normalizeEquipment(raw = {}) {
  const equipment = {};
  for (const slot of EQUIP_SLOTS) {
    const item = normalizeItem(raw[slot]);
    equipment[slot] = item && item.slot === slot ? item : null;
  }
  return equipment;
}

function getEquipmentBonuses(p) {
  const bonuses = makeZeroStats();
  for (const slot of EQUIP_SLOTS) {
    const item = p.equipment?.[slot];
    if (item) addStats(bonuses, item.bonuses);
  }
  return bonuses;
}

function getTotalStats(p) {
  const total = normalizeStats(p.stats);
  return addStats(total, getEquipmentBonuses(p));
}

function recalcDerivedStats(p) {
  const total = getTotalStats(p);
  p.maxHp = 100 + total.vit * 20;
  p.hp = clamp(p.hp, 0, p.maxHp);
}

function applyEquipmentShift(p) {
  const prevMaxHp = p.maxHp;
  recalcDerivedStats(p);
  p.hp = clamp(p.hp + (p.maxHp - prevMaxHp), 0, p.maxHp);
}

function speedForPlayer(p) {
  return BASE_PLAYER_SPEED + getTotalStats(p).agi * 0.2;
}

function dodgeChanceForPlayer(p) {
  return Math.min(0.22, getTotalStats(p).agi * 0.01);
}

function damageForPlayer(p) {
  const total = getTotalStats(p);
  return 8 + (p.level - 1) * 2 + total.str * 2;
}

function attackRangeForPlayer(p) {
  return 34 + getTotalStats(p).dex * 1.25;
}

function attackCooldownForPlayer(p) {
  return Math.max(MIN_PLAYER_ATTACK_CD, BASE_PLAYER_ATTACK_CD - getTotalStats(p).dex * 22);
}

function critChanceForPlayer(p) {
  return Math.min(0.3, getTotalStats(p).luk * 0.015);
}

function critMultiplierForPlayer(p) {
  return 1.6 + getTotalStats(p).luk * 0.025;
}

function xpBonusForPlayer(p) {
  return 1 + getTotalStats(p).wis * 0.025;
}

function healFromOrbForPlayer(p, value) {
  return Math.ceil(value * (0.65 + getTotalStats(p).wis * 0.07));
}

function lootDropChanceForMonster(monster) {
  if (monster.xp >= 60) return 0.45;
  if (monster.xp >= 35) return 0.35;
  if (monster.xp >= 18) return 0.24;
  return 0.14;
}

function rarityTableForMonsterType(type) {
  const def = MONSTER_TYPE_MAP[type];
  if (!def) return MONSTER_RARITY_TABLES.low;
  if (def.xp >= 60) return MONSTER_RARITY_TABLES.elite;
  if (def.xp >= 35) return MONSTER_RARITY_TABLES.high;
  if (def.xp >= 18) return MONSTER_RARITY_TABLES.mid;
  return MONSTER_RARITY_TABLES.low;
}

function normalizeWeightedEntries(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return [];
  return entries.map(entry => ({
    rarity: entry.rarity,
    weight: entry.weight / total,
  }));
}

function rollWeighted(entries) {
  let roll = Math.random();
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.rarity;
  }
  return entries[entries.length - 1]?.rarity || 2;
}

function rollRarityForMonster(monster) {
  return rollWeighted(effectiveRarityTableForMonsterType(monster.type));
}

function monsterProgressRule(type) {
  return MONSTER_PROGRESS_RULES[type] || MONSTER_PROGRESS_RULES.dot;
}

function isMonsterTypeUnlocked(type) {
  const rule = monsterProgressRule(type);
  if (!rule.unlockByType) return true;
  return (worldMonsterKills[rule.unlockByType] || 0) >= rule.unlockKills;
}

function currentLootRarityCap() {
  return isMonsterTypeUnlocked('line') ? MAX_RARITY : 1;
}

function effectiveRarityTableForMonsterType(type) {
  const filtered = rarityTableForMonsterType(type).filter(entry => entry.rarity <= currentLootRarityCap());
  if (filtered.length === 0) return [{ rarity: 1, weight: 1 }];
  return normalizeWeightedEntries(filtered);
}

function availableMonsterSpawnEntries() {
  return MONSTER_TYPES
    .filter(def => isMonsterTypeUnlocked(def.type))
    .map(def => ({ def, weight: monsterProgressRule(def.type).spawnWeight || 1 }));
}

function pickMonsterTypeForSpawn() {
  const entries = availableMonsterSpawnEntries();
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return MONSTER_TYPES[0];
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry.def;
  }
  return entries[entries.length - 1]?.def || MONSTER_TYPES[0];
}

function currentMonsterSpawnChanceMap() {
  const entries = availableMonsterSpawnEntries();
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const chanceMap = {};
  for (const def of MONSTER_TYPES) {
    chanceMap[def.type] = 0;
  }
  if (total <= 0) return chanceMap;
  for (const entry of entries) {
    chanceMap[entry.def.type] = entry.weight / total;
  }
  return chanceMap;
}

function buildBestiaryState() {
  const spawnChanceMap = currentMonsterSpawnChanceMap();
  return {
    totalKills: Object.values(worldMonsterKills).reduce((sum, count) => sum + count, 0),
    entries: MONSTER_TYPES.map(def => {
      const rule = monsterProgressRule(def.type);
      return {
        type: def.type,
        hp: def.hp,
        speed: def.speed,
        xp: def.xp,
        dmg: def.dmg,
        dropChance: lootDropChanceForMonster(def),
        spawnChance: spawnChanceMap[def.type] || 0,
        unlocked: isMonsterTypeUnlocked(def.type),
        kills: worldMonsterKills[def.type] || 0,
        unlockByType: rule.unlockByType,
        unlockKills: rule.unlockKills || 0,
        unlockProgress: rule.unlockByType ? (worldMonsterKills[rule.unlockByType] || 0) : 0,
        rarityTable: effectiveRarityTableForMonsterType(def.type).map(entry => ({
          rarity: entry.rarity,
          chance: entry.weight,
        })),
      };
    }),
  };
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
    mapId: p.mapId,
    stats: p.stats,
    inventory: p.inventory,
    equipment: p.equipment,
  };
}

function readSavedProfile(name) {
  const normalized = normalizePlayerName(name);
  const key = playerNameKey(normalized);
  return savedProfiles[key] || savedProfiles[normalized] || null;
}

function persistPlayerProfile(p, { immediate = false } = {}) {
  const profile = serializePlayerProfile(p);
  const normalized = normalizePlayerName(p.name);
  const key = playerNameKey(normalized);
  savedProfiles[key] = profile;
  if (normalized !== key) savedProfiles[normalized] = profile;
  if (immediate) {
    flushSaveProfilesSync();
    return;
  }
  scheduleSaveProfiles();
}

function makePlayerState(socketId, name, saved = {}) {
  const normalizedName = normalizePlayerName(name);
  const stats = normalizeStats(saved.stats || DEFAULT_STATS);
  const inventory = normalizeInventory(saved.inventory);
  const equipment = normalizeEquipment(saved.equipment);
  const mapId = normalizeMapId(saved.mapId);
  const level = clamp(Number(saved.level) || 1, 1, MAX_LEVEL);
  const r = radiusForLevel(level);
  const defaultPos = randomPos(PLAYER_RADIUS);
  const pos = {
    x: clamp(Number.isFinite(Number(saved.x)) ? Number(saved.x) : defaultPos.x, r, WORLD_W - r),
    y: clamp(Number.isFinite(Number(saved.y)) ? Number(saved.y) : defaultPos.y, r, WORLD_H - r),
  };
  const p = {
    id: socketId,
    name: normalizedName,
    x: pos.x,
    y: pos.y,
    level,
    xp: clamp(Number(saved.xp) || 0, 0, level >= MAX_LEVEL ? 0 : xpToNextLevel(level)),
    hp: 100,
    maxHp: 100,
    statPoints: clamp(Number(saved.statPoints) || 0, 0, 9999),
    mapId,
    stats,
    inventory,
    equipment,
    lastAttackAt: 0,
    lastPortalAt: 0,
    keys: { up: false, down: false, left: false, right: false },
  };
  recalcDerivedStats(p);
  p.hp = clamp(Number(saved.hp) || p.maxHp, 1, p.maxHp);
  return p;
}

function applyLevelUp(p) {
  let gained = 0;
  while (p.level < MAX_LEVEL && p.xp >= xpToNextLevel(p.level)) {
    p.xp -= xpToNextLevel(p.level);
    p.level += 1;
    gained += 1;
  }
  if (p.level >= MAX_LEVEL) p.xp = 0;
  if (gained > 0) p.statPoints += gained * STAT_POINTS_PER_LEVEL;
  return gained;
}

function canAddInventoryItem(p) {
  return Array.isArray(p.inventory) && p.inventory.length < INVENTORY_LIMIT;
}

function addItemToInventory(p, item) {
  if (!item || !canAddInventoryItem(p)) return false;
  p.inventory.push(item);
  return true;
}

function rollItemForMonster(monster) {
  const itemKeys = Object.keys(ITEM_DEFS);
  const key = itemKeys[Math.floor(Math.random() * itemKeys.length)];
  return makeItemInstance(key, rollRarityForMonster(monster));
}

function canCraftItems(a, b) {
  return !!(
    a
    && b
    && a.id !== b.id
    && a.key === b.key
    && normalizeRarity(a.rarity) === normalizeRarity(b.rarity)
  );
}

function removeRandomOwnedItem(p) {
  const pool = [];
  for (let i = 0; i < p.inventory.length; i++) {
    pool.push({ kind: 'inventory', index: i, item: p.inventory[i] });
  }
  for (const slot of EQUIP_SLOTS) {
    if (p.equipment[slot]) pool.push({ kind: 'equipment', slot, item: p.equipment[slot] });
  }
  if (pool.length === 0) return null;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  if (selected.kind === 'inventory') {
    return p.inventory.splice(selected.index, 1)[0] || null;
  }
  const lostItem = p.equipment[selected.slot];
  p.equipment[selected.slot] = null;
  applyEquipmentShift(p);
  return lostItem;
}

function applyDeathPenalty(p) {
  const xpLost = Math.min(p.xp, p.xp > 0 ? Math.max(1, Math.ceil(p.xp * DEATH_XP_LOSS_RATIO)) : 0);
  p.xp = Math.max(0, p.xp - xpLost);
  const statPointsLost = Math.min(p.statPoints, DEATH_POINT_LOSS);
  p.statPoints -= statPointsLost;
  const lostItem = removeRandomOwnedItem(p);
  return { xpLost, statPointsLost, lostItem };
}

function buildSelfState(p, loots) {
  return {
    level: p.level,
    xp: p.xp,
    xpMax: xpToNextLevel(p.level),
    mapId: p.mapId,
    stats: getTotalStats(p),
    statPoints: p.statPoints,
    hp: p.hp,
    maxHp: p.maxHp,
    atkRange: attackRangeForPlayer(p),
    atkCd: attackCooldownForPlayer(p),
    inventory: p.inventory,
    equipment: p.equipment,
    inventoryLimit: INVENTORY_LIMIT,
    lootCount: loots.length,
    bestiary: buildBestiaryState(),
  };
}

function emitSelfState(socketId, p) {
  io.to(socketId).emit('selfSync', buildSelfState(p, playerLootsFor(p)));
}

const players = {};
const orbs = {};
const monsters = {};
const loots = {};
const activePlayersByName = {};

function removePlayer(socketId, { save = true } = {}) {
  const p = players[socketId];
  if (!p) return;
  if (save) persistPlayerProfile(p, { immediate: true });
  const key = playerNameKey(p.name);
  if (activePlayersByName[key] === socketId) delete activePlayersByName[key];
  delete players[socketId];
}

function spawnOrb(mapId = DEFAULT_MAP_ID) {
  if (Object.keys(orbs).length >= MAX_ORBS) return;
  const id = ++orbIdCounter;
  const pos = randomPos(30);
  orbs[id] = { id, mapId, x: pos.x, y: pos.y, value: 5 + Math.floor(Math.random() * 6) };
}

function spawnMonster(mapId = DEFAULT_MAP_ID) {
  if (Object.keys(monsters).length >= MAX_MONSTERS) return;
  const def = pickMonsterTypeForSpawn();
  const id = ++monsterIdCounter;
  const pos = randomPos(60);
  const wander = randomWander(pos.x, pos.y);
  monsters[id] = {
    id,
    mapId,
    type: def.type,
    color: def.color,
    x: pos.x,
    y: pos.y,
    hp: def.hp,
    maxHp: def.hp,
    speed: def.speed,
    r: def.r,
    xp: def.xp,
    dmg: def.dmg,
    atkR: def.atkR,
    atkCD: def.atkCD,
    tx: wander.tx,
    ty: wander.ty,
    facing: Math.atan2(wander.ty - pos.y, wander.tx - pos.x),
    lastAttack: {},
    aggroTarget: null,
  };
}

function serializeLoot(loot) {
  return {
    id: loot.id,
    mapId: loot.mapId,
    x: loot.x,
    y: loot.y,
    expiresAt: loot.expiresAt,
    item: loot.item,
  };
}

function playerLootsFor(player) {
  const ownerKey = playerNameKey(player.name);
  return Object.values(loots)
    .filter(loot => loot.ownerKey === ownerKey && loot.mapId === player.mapId)
    .map(serializeLoot);
}

function spawnLootForPlayer(player, monster) {
  if (Math.random() > lootDropChanceForMonster(monster)) return null;
  const item = rollItemForMonster(monster);
  if (!item) return null;
  const id = ++lootIdCounter;
  loots[id] = {
    id,
    ownerKey: playerNameKey(player.name),
    mapId: player.mapId,
    x: monster.x,
    y: monster.y,
    item,
    expiresAt: Date.now() + LOOT_DESPAWN_MS,
  };
  return loots[id];
}

for (let i = 0; i < MAX_ORBS; i++) spawnOrb(DEFAULT_MAP_ID);
for (let i = 0; i < MAX_MONSTERS; i++) spawnMonster(DEFAULT_MAP_ID);

setInterval(() => spawnOrb(DEFAULT_MAP_ID), ORB_SPAWN_MS);
setInterval(() => spawnMonster(DEFAULT_MAP_ID), 3000);

setInterval(() => {
  const now = Date.now();

  for (const lid in loots) {
    if (loots[lid].expiresAt <= now) delete loots[lid];
  }

  for (const id in players) {
    const p = players[id];
    let dx = 0;
    let dy = 0;

    if (p.keys.up) dy -= 1;
    if (p.keys.down) dy += 1;
    if (p.keys.left) dx -= 1;
    if (p.keys.right) dx += 1;
    if (dx !== 0 && dy !== 0) {
      dx *= 0.707;
      dy *= 0.707;
    }

    const r = PLAYER_RADIUS;
    const moveSpeed = speedForPlayer(p);
    p.x = clamp(p.x + dx * moveSpeed, r, WORLD_W - r);
    p.y = clamp(p.y + dy * moveSpeed, r, WORLD_H - r);

    const portal = portalForMap(p.mapId);
    if (portal && now - p.lastPortalAt >= PORTAL_COOLDOWN_MS && dist(p, portal) < r + portal.r) {
      p.mapId = portal.targetMapId;
      p.x = clamp(portal.targetX, r, WORLD_W - r);
      p.y = clamp(portal.targetY, r, WORLD_H - r);
      p.lastPortalAt = now;
      emitSelfState(p.id, p);
      persistPlayerProfile(p);
      io.to(p.id).emit('mapChanged', { mapId: p.mapId });
      continue;
    }

    const pickedOrbs = [];
    for (const oid in orbs) {
      if (orbs[oid].mapId !== p.mapId) continue;
      if (dist(p, orbs[oid]) < r + ORB_RADIUS) pickedOrbs.push(oid);
    }

    for (const oid of pickedOrbs) {
      if (!orbs[oid]) continue;
      const bonus = xpBonusForPlayer(p);
      p.xp += Math.round(orbs[oid].value * bonus);
      p.hp = clamp(p.hp + healFromOrbForPlayer(p, orbs[oid].value), 0, p.maxHp);
      delete orbs[oid];
    }

    const ownerKey = playerNameKey(p.name);
    const pickedLoots = [];
    for (const lid in loots) {
      const loot = loots[lid];
      if (loot.ownerKey !== ownerKey) continue;
      if (loot.mapId !== p.mapId) continue;
      if (dist(p, loot) >= r + LOOT_RADIUS) continue;
      if (!addItemToInventory(p, loot.item)) continue;
      pickedLoots.push(loot);
      delete loots[lid];
    }

    if (pickedLoots.length > 0) {
      for (const loot of pickedLoots) {
        io.to(p.id).emit('lootPicked', { item: loot.item });
      }
      emitSelfState(p.id, p);
      persistPlayerProfile(p);
    }

    if (pickedOrbs.length > 0) {
      const gained = applyLevelUp(p);
      if (gained > 0) {
        io.emit('levelUp', { id: p.id, level: p.level, name: p.name, gained, statPoints: p.statPoints });
      }
      persistPlayerProfile(p);
    } else if (dx !== 0 || dy !== 0) {
      persistPlayerProfile(p);
    }
  }

  const playerList = Object.values(players);
  for (const mid in monsters) {
    const m = monsters[mid];
    let nearest = null;
    let nearDist = 300;

    for (const p of playerList) {
      if (p.mapId !== m.mapId) continue;
      const d = dist(m, p);
      if (d < nearDist) {
        nearDist = d;
        nearest = p;
      }
    }

    m.aggroTarget = nearest ? nearest.id : null;

    if (nearest) {
      const dx = nearest.x - m.x;
      const dy = nearest.y - m.y;
      const d = Math.hypot(dx, dy) || 1;
      m.facing = Math.atan2(dy, dx);
      m.x += (dx / d) * m.speed;
      m.y += (dy / d) * m.speed;

      if (dist(m, nearest) < m.atkR + PLAYER_RADIUS) {
        const lastHit = m.lastAttack[nearest.id] || 0;
        if (now - lastHit > m.atkCD) {
          m.lastAttack[nearest.id] = now;
          if (Math.random() < dodgeChanceForPlayer(nearest)) {
            io.to(nearest.id).emit('dodged');
            continue;
          }
          nearest.hp -= m.dmg;
          io.to(nearest.id).emit('damaged', { dmg: m.dmg });

          if (nearest.hp <= 0) {
            const penalty = applyDeathPenalty(nearest);
            const pos = randomPos(PLAYER_RADIUS);
            nearest.x = pos.x;
            nearest.y = pos.y;
            recalcDerivedStats(nearest);
            nearest.hp = nearest.maxHp;
            emitSelfState(nearest.id, nearest);
            persistPlayerProfile(nearest);
            io.to(nearest.id).emit('died', penalty);
          }
        }
      }

      for (const pid of Object.keys(m.lastAttack)) {
        if (!players[pid]) delete m.lastAttack[pid];
      }
    } else {
      const dx = m.tx - m.x;
      const dy = m.ty - m.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 5) {
        const wander = randomWander(m.x, m.y);
        m.tx = wander.tx;
        m.ty = wander.ty;
        m.facing = Math.atan2(wander.ty - m.y, wander.tx - m.x);
      } else {
        m.facing = Math.atan2(dy, dx);
        m.x += (dx / d) * m.speed * 0.5;
        m.y += (dy / d) * m.speed * 0.5;
      }
    }

    m.x = clamp(m.x, m.r, WORLD_W - m.r);
    m.y = clamp(m.y, m.r, WORLD_H - m.r);
  }

  const sharedPlayers = playerList.map(p => ({
    id: p.id,
    x: p.x,
    y: p.y,
    name: p.name,
    r: PLAYER_RADIUS,
    level: p.level,
    xp: p.xp,
    xpMax: xpToNextLevel(p.level),
    mapId: p.mapId,
    hp: p.hp,
    maxHp: p.maxHp,
    atkRange: attackRangeForPlayer(p),
    atkCd: attackCooldownForPlayer(p),
    statPoints: p.statPoints,
    stats: getTotalStats(p),
  }));

  const sharedOrbs = Object.values(orbs);
  const sharedMonsters = Object.values(monsters).map(m => ({
    id: m.id,
    mapId: m.mapId,
    x: m.x,
    y: m.y,
    facing: m.facing,
    type: m.type,
    r: m.r,
    hp: m.hp,
    maxHp: m.maxHp,
    color: m.color,
  }));

  for (const p of playerList) {
    const privateLoots = playerLootsFor(p);
    const sameMapPlayers = sharedPlayers.filter(entry => entry.mapId === p.mapId);
    const sameMapOrbs = sharedOrbs.filter(entry => entry.mapId === p.mapId);
    const sameMapMonsters = sharedMonsters.filter(entry => entry.mapId === p.mapId);
    io.to(p.id).emit('state', {
      players: sameMapPlayers,
      orbs: sameMapOrbs,
      monsters: sameMapMonsters,
      loots: privateLoots,
      self: buildSelfState(p, privateLoots),
    });
  }
}, TICK_MS);

io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join', ({ name }) => {
    if (players[socket.id]) return;

    const trimmed = normalizePlayerName(name);
    const nameKey = playerNameKey(trimmed);
    const activeId = activePlayersByName[nameKey];
    let handoffProfile = readSavedProfile(trimmed) || {};

    if (activeId && activeId !== socket.id) {
      if (players[activeId]) handoffProfile = serializePlayerProfile(players[activeId]);
      const oldSocket = io.sockets.sockets.get(activeId);
      if (oldSocket) {
        oldSocket.emit('sessionReplaced');
        oldSocket.disconnect(true);
      }
      removePlayer(activeId, { save: true });
    }

    players[socket.id] = makePlayerState(socket.id, trimmed, handoffProfile);
    activePlayersByName[nameKey] = socket.id;
    persistPlayerProfile(players[socket.id]);
    socket.emit('welcome', { id: socket.id, worldW: WORLD_W, worldH: WORLD_H });
  });

  socket.on('keys', keys => {
    if (!players[socket.id]) return;
    players[socket.id].keys = {
      up: !!keys.up,
      down: !!keys.down,
      left: !!keys.left,
      right: !!keys.right,
    };
  });

  socket.on('attack', ({ monsterId }) => {
    const p = players[socket.id];
    const m = monsters[monsterId];
    if (!p || !m) return;
    if (p.mapId !== m.mapId) return;
    if (dist(p, m) > attackRangeForPlayer(p) + m.r) return;
    const now = Date.now();
    if (now - p.lastAttackAt < attackCooldownForPlayer(p)) return;
    p.lastAttackAt = now;

    const isCrit = Math.random() < critChanceForPlayer(p);
    const dmg = Math.round(damageForPlayer(p) * (isCrit ? critMultiplierForPlayer(p) : 1));
    m.hp -= dmg;
    socket.emit('attackResult', { monsterId, dmg, hp: m.hp, crit: isCrit });

    if (m.hp <= 0) {
      worldMonsterKills[m.type] = (worldMonsterKills[m.type] || 0) + 1;
      p.xp += Math.round(m.xp * xpBonusForPlayer(p));
      const gained = applyLevelUp(p);
      const loot = spawnLootForPlayer(p, m);
      if (gained > 0) {
        io.emit('levelUp', { id: p.id, level: p.level, name: p.name, gained, statPoints: p.statPoints });
      }
      persistPlayerProfile(p);
      io.emit('monsterDied', { monsterId, killerId: p.id, xp: m.xp });
      if (loot) socket.emit('lootDropped', { item: loot.item });
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
    persistPlayerProfile(p, { immediate: true });

    if (ack) {
      ack({
        ok: true,
        statPoints: p.statPoints,
        stats: getTotalStats(p),
        hp: p.hp,
        maxHp: p.maxHp,
      });
    }
  });

  socket.on('equipItem', ({ itemId }, ack) => {
    const p = players[socket.id];
    if (!p) return ack && ack({ ok: false, error: 'not_joined' });
    const index = p.inventory.findIndex(item => String(item.id) === String(itemId));
    if (index < 0) return ack && ack({ ok: false, error: 'item_missing' });

    const item = p.inventory[index];
    const current = p.equipment[item.slot];
    p.inventory.splice(index, 1);
    if (current) p.inventory.push(current);
    p.equipment[item.slot] = item;
    applyEquipmentShift(p);
    emitSelfState(socket.id, p);
    persistPlayerProfile(p);

    if (ack) {
      ack({
        ok: true,
        item,
        self: buildSelfState(p, playerLootsFor(p)),
      });
    }
  });

  socket.on('unequipItem', ({ slot }, ack) => {
    const p = players[socket.id];
    if (!p) return ack && ack({ ok: false, error: 'not_joined' });
    if (!EQUIP_SLOTS.includes(slot)) return ack && ack({ ok: false, error: 'bad_slot' });
    if (!p.equipment[slot]) return ack && ack({ ok: false, error: 'slot_empty' });
    if (!canAddInventoryItem(p)) return ack && ack({ ok: false, error: 'inventory_full' });

    const item = p.equipment[slot];
    p.equipment[slot] = null;
    p.inventory.push(item);
    applyEquipmentShift(p);
    emitSelfState(socket.id, p);
    persistPlayerProfile(p);

    if (ack) {
      ack({
        ok: true,
        item,
        self: buildSelfState(p, playerLootsFor(p)),
      });
    }
  });

  socket.on('craftItems', ({ itemIds }, ack) => {
    const p = players[socket.id];
    if (!p) return ack && ack({ ok: false, error: 'not_joined' });
    if (!Array.isArray(itemIds) || itemIds.length !== 2) return ack && ack({ ok: false, error: 'bad_recipe' });

    const ids = itemIds.map(id => String(id));
    if (ids[0] === ids[1]) return ack && ack({ ok: false, error: 'duplicate_item' });

    const firstIndex = p.inventory.findIndex(item => String(item.id) === ids[0]);
    const secondIndex = p.inventory.findIndex(item => String(item.id) === ids[1]);
    if (firstIndex < 0 || secondIndex < 0) return ack && ack({ ok: false, error: 'item_missing' });

    const firstItem = p.inventory[firstIndex];
    const secondItem = p.inventory[secondIndex];
    if (!canCraftItems(firstItem, secondItem)) return ack && ack({ ok: false, error: 'craft_mismatch' });
    if (normalizeRarity(firstItem.rarity) >= MAX_RARITY) return ack && ack({ ok: false, error: 'max_rarity' });

    const chance = craftChanceForRarity(firstItem.rarity);
    const removalOrder = [firstIndex, secondIndex].sort((a, b) => b - a);
    for (const index of removalOrder) {
      p.inventory.splice(index, 1);
    }

    const success = Math.random() < chance;
    let craftedItem = null;
    if (success) {
      craftedItem = makeItemInstance(firstItem.key, normalizeRarity(firstItem.rarity) + 1);
      p.inventory.push(craftedItem);
    }

    emitSelfState(socket.id, p);
    persistPlayerProfile(p);

    if (ack) {
      ack({
        ok: true,
        success,
        chance,
        item: craftedItem,
        consumed: [firstItem, secondItem],
        self: buildSelfState(p, playerLootsFor(p)),
      });
    }
  });

  socket.on('chat', raw => {
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      flushSaveProfilesSync();
    } finally {
      process.exit(0);
    }
  });
}

process.on('exit', () => {
  try {
    flushSaveProfilesSync();
  } catch {}
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`sphere.io @ http://localhost:${PORT}`));
