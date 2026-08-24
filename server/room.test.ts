import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPosition, createRoom, needlePosition, safeText, surfaceHeight } from './room.js';

test('room names and chat payloads are normalized', () => {
  assert.equal(safeText('  <b>Гуси</b>\u0000  ', 12), 'bГуси/b');
  assert.equal(safeText('', 10, 'Стог'), 'Стог');
  assert.equal(createRoom('  Вечерний стог  ').name, 'Вечерний стог');
  assert.equal(safeText('РљР°РїРёС‚Р°РЅ РЎРµРЅР°', 18), 'Капитан Сена');
});

test('positions remain inside the arena', () => {
  const position = clampPosition({ x: 50, y: 999, z: 0 });
  assert.equal(position.x, 15.5);
  assert.equal(position.y, 7.5);
});

test('needle placement is deterministic and inside the haystack volume', () => {
  assert.deepEqual(needlePosition(12345), needlePosition(12345));
  const needle = needlePosition(12345);
  assert.ok(Math.hypot(needle.x, needle.z) < 8.5);
  assert.ok(needle.y > 0);
  assert.ok(needle.y < surfaceHeight(needle.x, needle.z) * 0.75);
});
