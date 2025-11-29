/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { generateSphereVolume, generateSolidVolume } from './volume.js';
import { BRICK_SIZE, GRID_SIZE, ATLAS_SIZE, DATASET_SIZE, DATASET_GRID, NORMALIZED_SIZE, CONFIG } from './config.js';
import { AtlasSlot } from './atlas-allocator.js';
import './../test/snapshot-test.js'; 

async function main() {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Canvas not found');

  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    showError('WebGPU not supported');
    return;
  }

  // Request device with higher buffer size limit for large 3D textures
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1024 * 1024 * 1024), // Request up to 1GB
    },
  });
  if (!device) {
    showError('WebGPU device creation failed');
    return;
  }

  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Create renderer (allocates empty volume canvas)
  const renderer = new Renderer(device, format);

  // Track loaded bricks: virtual position -> atlas slot
  const loadedBricks = new Map<string, AtlasSlot>();

  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

  // Demo: load spheres spread across the dataset volume
  // Positions are in brick coordinates within the dataset grid
  const [gx, gy, gz] = DATASET_GRID;
  const testPositions: [number, number, number][] = [
    [0, 0, 0],
    [gx - 1, gy - 1, gz - 1],
    [Math.floor(gx / 2), Math.floor(gy / 2), Math.floor(gz / 2)],
    [0, gy - 1, 0],
    [gx - 1, 0, gz - 1],
    [Math.floor(gx / 3), Math.floor(gy / 3), Math.floor(gz / 3)],
    [Math.floor(2 * gx / 3), Math.floor(2 * gy / 3), Math.floor(2 * gz / 3)],
    [1, Math.min(gy - 1, 5), 1],
    [Math.min(gx - 1, 5), 1, Math.min(gz - 1, 3)],
    [2, 4, Math.min(gz - 1, 2)],
  ];

  for (let i = 0; i < testPositions.length; i++) {
    const pos = testPositions[i]!;
    const [x, y, z] = pos;
    // Skip if out of bounds for current dataset
    if (x >= gx || y >= gy || z >= gz) continue;
    const intensity = 120 + (i * 17 % 135);
    const radius = 20 + (i * 7 % 10);
    const data = generateSphereVolume(BRICK_SIZE, radius, intensity);
    const slot = renderer.loadBrick(x, y, z, data);
    if (slot) loadedBricks.set(key(x, y, z), slot);
  }

  // Create camera
  const camera = new Camera(canvas);

  // Handle resize
  const resize = () => {
    const width = Math.max(1, Math.min(canvas.clientWidth, device.limits.maxTextureDimension2D));
    const height = Math.max(1, Math.min(canvas.clientHeight, device.limits.maxTextureDimension2D));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      renderer.resize(width, height);
    }
  };

  new ResizeObserver(resize).observe(canvas);
  resize();

  // Render loop
  function frame() {
    const view = context.getCurrentTexture().createView();
    renderer.render(view, camera);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Print initialization stats
  const atlasSizeMB = ((ATLAS_SIZE ** 3) / (1024 * 1024)).toFixed(1);
  const datasetSizeMB = ((DATASET_SIZE[0] * DATASET_SIZE[1] * DATASET_SIZE[2]) / (1024 * 1024)).toFixed(1);
  const brickSizeKB = ((BRICK_SIZE ** 3) / 1024).toFixed(1);
  const usagePercent = ((renderer.allocator.usedCount / renderer.allocator.totalSlots) * 100).toFixed(1);
  const datasetBricks = DATASET_GRID[0] * DATASET_GRID[1] * DATASET_GRID[2];

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       Kiln Volume Renderer Initialized                ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║ Dataset:         ${DATASET_SIZE[0]}×${DATASET_SIZE[1]}×${DATASET_SIZE[2]} (${datasetSizeMB} MB)`.padEnd(58) + '║');
  console.log(`║ Dataset Grid:    ${DATASET_GRID[0]}×${DATASET_GRID[1]}×${DATASET_GRID[2]} (${datasetBricks} bricks)`.padEnd(58) + '║');
  console.log(`║ Normalized:      ${NORMALIZED_SIZE[0].toFixed(2)}×${NORMALIZED_SIZE[1].toFixed(2)}×${NORMALIZED_SIZE[2].toFixed(2)}`.padEnd(58) + '║');
  console.log(`║ Atlas Size:      ${ATLAS_SIZE}³ (${atlasSizeMB} MB)`.padEnd(58) + '║');
  console.log(`║ Atlas Grid:      ${GRID_SIZE}×${GRID_SIZE}×${GRID_SIZE} (${CONFIG.TOTAL_BRICK_SLOTS} slots)`.padEnd(58) + '║');
  console.log(`║ Brick Size:      ${BRICK_SIZE}³ (${brickSizeKB} KB)`.padEnd(58) + '║');
  console.log(`║ Bricks Loaded:   ${loadedBricks.size}/${renderer.allocator.totalSlots} (${usagePercent}%)`.padEnd(58) + '║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Expose for debugging
  (window as any).renderer = renderer;
  (window as any).device = device;
  (window as any).loadedBricks = loadedBricks;

  // Load a brick at virtual position (allocator picks atlas slot)
  (window as any).loadBrick = (
    virtualX: number, virtualY: number, virtualZ: number,
    intensity: number = 255,
    type: 'sphere' | 'solid' = 'sphere'
  ) => {
    const k = key(virtualX, virtualY, virtualZ);
    if (loadedBricks.has(k)) {
      console.warn(`Brick already loaded at virtual[${virtualX},${virtualY},${virtualZ}]`);
      return;
    }

    const data = type === 'sphere'
      ? generateSphereVolume(BRICK_SIZE, 28, intensity)
      : generateSolidVolume([BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], intensity);

    const slot = renderer.loadBrick(virtualX, virtualY, virtualZ, data);
    if (slot) {
      loadedBricks.set(k, slot);
      console.log(`Loaded ${type} brick at virtual[${virtualX},${virtualY},${virtualZ}] -> atlas[${slot.x},${slot.y},${slot.z}]`);
      console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} used`);
    }
  };

  // Unload a brick from virtual position
  (window as any).unloadBrick = (virtualX: number, virtualY: number, virtualZ: number) => {
    const k = key(virtualX, virtualY, virtualZ);
    const slot = loadedBricks.get(k);
    if (!slot) {
      console.warn(`No brick loaded at virtual[${virtualX},${virtualY},${virtualZ}]`);
      return;
    }

    renderer.unloadBrick(virtualX, virtualY, virtualZ, slot);
    loadedBricks.delete(k);
    console.log(`Unloaded brick from virtual[${virtualX},${virtualY},${virtualZ}]`);
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} used`);
  };

  // Clear all bricks
  (window as any).clearAll = () => {
    renderer.clearAllBricks();
    loadedBricks.clear();
    console.log('Cleared all bricks');
  };

  // Fill dataset with test bricks
  (window as any).fillDataset = () => {
    let index = 0;
    for (let z = 0; z < DATASET_GRID[2]; z++) {
      for (let y = 0; y < DATASET_GRID[1]; y++) {
        for (let x = 0; x < DATASET_GRID[0]; x++) {
          const k = key(x, y, z);
          if (loadedBricks.has(k)) continue;

          const intensity = 100 + (index * 19 % 155);
          const radius = 20 + (index * 7 % 10);
          const data = generateSphereVolume(BRICK_SIZE, radius, intensity);
          const slot = renderer.loadBrick(x, y, z, data);
          if (slot) loadedBricks.set(k, slot);
          index++;
        }
      }
    }
    console.log(`Dataset filled: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} atlas slots used`);
  };
}

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
}

main().catch((e) => showError(e.message));
