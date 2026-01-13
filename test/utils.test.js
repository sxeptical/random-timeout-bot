import { test } from "node:test";
import assert from "node:assert";
import { getLevelFromXp, getXpForLevel, getDataSafe } from "../utils.js";

test("getLevelFromXp calculates correct level", () => {
  // Test cases based on formula: Level = floor(0.1 * sqrt(XP)) + 1
  assert.strictEqual(getLevelFromXp(0), 1);
  assert.strictEqual(getLevelFromXp(99), 1);
  assert.strictEqual(getLevelFromXp(100), 2); // sqrt(100)=10, 0.1*10=1, +1=2
  assert.strictEqual(getLevelFromXp(399), 2);
  assert.strictEqual(getLevelFromXp(400), 3); // 20 * 0.1 = 2, +1 = 3
});

test("getXpForLevel calculates required XP", () => {
  // Formula inverse check
  assert.strictEqual(getXpForLevel(1), 0);
  assert.strictEqual(getXpForLevel(2), 100);
  assert.strictEqual(getXpForLevel(3), 400);
});

test("getDataSafe returns default for new user", () => {
  const map = new Map();
  const data = getDataSafe(map, "user1");
  assert.deepStrictEqual(data, { explosions: 0, xp: 0, level: 1 });
});

test("getDataSafe MIGRATE number to object", () => {
  const map = new Map();
  map.set("userOld", 50); // Old format: just a number

  const data = getDataSafe(map, "userOld");
  // Should convert to object
  assert.deepStrictEqual(data, { explosions: 50, xp: 0, level: 1 });

  // Should update the map in place
  const inMap = map.get("userOld");
  assert.deepStrictEqual(inMap, { explosions: 50, xp: 0, level: 1 });
});

test("getDataSafe returns existing object", () => {
  const map = new Map();
  const existing = { explosions: 10, xp: 500, level: 3 };
  map.set("userExisting", existing);

  const data = getDataSafe(map, "userExisting");
  assert.deepStrictEqual(data, existing);
});
