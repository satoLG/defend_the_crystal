// Keep UI resolution untouched: these limits apply only to the WebGL canvas.
export function renderBudget({ coarsePointer = false, deviceMemory = 8, pixelRatio = 1 } = {}) {
  const compact = coarsePointer || deviceMemory <= 4;
  return {
    pixelRatio: Math.min(pixelRatio, compact ? 1.25 : 2),
    antialias: !compact,
    shadowSize: compact ? 512 : 1024,
    compact,
  };
}

// Spatial batches keep instancing while allowing normal frustum culling.
export function spatialBatches(items, size = 20) {
  const batches = new Map();
  for (const item of items) {
    const key = `${Math.floor(item.x / size)},${Math.floor(item.z / size)}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push(item);
  }
  return [...batches.values()];
}
