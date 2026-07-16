import { loadRoster, saveRoster } from './character.js';

// ============================================================
// TEST-ONLY seeding, meant for the throwaway Vercel PREVIEW build.
// When active it drops four ready-made heroes (one per class) each
// with 999 gold coins and a starter pet, so every shop/weapon/pet
// flow can be exercised without grinding. Delete this file and its
// import in main.js to remove it.
// ============================================================

// active on Vercel preview deploys (*.vercel.app) or with ?test in the URL
export const TEST_MODE =
  /\.vercel\.app$/.test(location.hostname) ||
  new URLSearchParams(location.search).has('test');

const SEED = [
  { id: 'seed-berserker', name: 'Test Zerk', cls: 'berserker', activeWeapon: 'axe' },
  { id: 'seed-tanker', name: 'Test Tank', cls: 'tanker', activeWeapon: 'sword', activeShield: 'shield' },
  { id: 'seed-archer', name: 'Test Arch', cls: 'archer', activeWeapon: 'bow' },
  { id: 'seed-mage', name: 'Test Mage', cls: 'mage', activeWeapon: 'staff' },
];

// add the four test heroes (once) — idempotent, keyed by their fixed
// ids so it never duplicates them across reloads. sanitize() in
// saveRoster grants the class's free starter weapons & validates pets.
export function seedTestHeroes() {
  if (!TEST_MODE) return;
  const { chars } = loadRoster();
  const have = new Set(chars.map((c) => c.id));
  const missing = SEED.filter((s) => !have.has(s.id));
  if (!missing.length) return;
  const built = missing.map((s) => ({
    ...s,
    colors: {},
    pets: { dog: { lvl: 1, xp: 0, name: 'Rex' } },
    activePet: 'dog',
    coins: 999,
  }));
  const next = [...chars, ...built];
  saveRoster(next, next[0].id);
}
