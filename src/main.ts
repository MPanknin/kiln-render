/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { generateSphereVolume, generateSolidVolume } from './volume.js';
import { BRICK_SIZE } from './indirection.js';
import { AtlasSlot } from './atlas-allocator.js';
import './snapshot-test.js'; // Exposes captureSnapshot/compareSnapshot to console

async function main() {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Canvas not found');

  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    showError('WebGPU not supported');
    return;
  }

  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Create renderer (allocates empty 512³ canvas)
  const renderer = new Renderer(device, format);

  // Track loaded bricks: virtual position -> atlas slot
  const loadedBricks = new Map<string, AtlasSlot>();

  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

  // Demo: load 20 spheres at random virtual positions
  const testPositions: [number, number, number][] = [
    [0, 0, 0], [7, 7, 7], [4, 4, 4], [0, 7, 0], [7, 0, 7],
    [3, 3, 3], [5, 5, 5], [1, 6, 2], [6, 1, 5], [2, 4, 6],
    [0, 4, 0], [4, 0, 4], [7, 3, 1], [1, 3, 7], [3, 7, 3],
    [2, 2, 2], [6, 6, 6], [5, 1, 3], [3, 5, 1], [1, 1, 5],
  ];

  for (const [x, y, z] of testPositions) {
    const intensity = 120 + Math.floor(Math.random() * 135);
    const radius = 20 + Math.floor(Math.random() * 10);
    const data = generateSphereVolume(BRICK_SIZE, radius, intensity);
    const slot = renderer.loadBrick(x, y, z, data);
    if (slot) loadedBricks.set(key(x, y, z), slot);
  }

  console.log(`Loaded ${loadedBricks.size} test bricks. Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} used`);

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
  console.log('Kiln initialized - 512³ volume atlas ready');

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

  // Fill atlas with test bricks
  (window as any).fillAtlas = () => {
    for (let z = 0; z < 8; z++) {
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const k = key(x, y, z);
          if (loadedBricks.has(k)) continue;

          const intensity = 100 + Math.floor(Math.random() * 155);
          const data = generateSphereVolume(BRICK_SIZE, 20 + Math.floor(Math.random() * 10), intensity);
          const slot = renderer.loadBrick(x, y, z, data);
          if (slot) loadedBricks.set(k, slot);
        }
      }
    }
    console.log(`Atlas filled: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} used`);
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
