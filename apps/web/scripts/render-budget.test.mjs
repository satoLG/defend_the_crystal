import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBudget, spatialBatches } from '../src/render/render-budget.js';

test('touch and low-memory devices use a bounded 3D budget, not viewport width', () => {
  const phone = renderBudget({ coarsePointer: true, pixelRatio: 3 });
  assert.equal(phone.pixelRatio, 1.25);
  assert.equal(phone.antialias, false);
  assert.equal(phone.shadowSize, 512);
  assert.equal(renderBudget({ deviceMemory: 4, pixelRatio: 2 }).compact, true);
  assert.equal(renderBudget({ coarsePointer: true, pixelRatio: 1 }).pixelRatio, 1);
  assert.deepEqual(renderBudget({ pixelRatio: 3 }), {
    pixelRatio: 2, antialias: true, shadowSize: 1024, compact: false,
  });
});

test('forest batches preserve every instance and separate distant/negative coordinates', () => {
  const items = [{ x: -1, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 1 }, { x: 1, z: 41 }];
  const batches = spatialBatches(items);
  assert.deepEqual(batches.map(b => b.length), [1, 2, 1]);
  assert.equal(new Set(batches.flat()).size, items.length);
  assert.deepEqual(spatialBatches([]), []);
});
