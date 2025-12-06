/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { writeToCanvas } from './volume.js';
import { generateTestPyramid } from './generator.js';
import { Octree } from './octree.js';
import { BRICK_SIZE, DATASET_SIZE, DATASET_GRID } from './config.js';
import { AtlasSlot } from './atlas-allocator.js';
import { initConsoleTools, printStats } from './console-tools.js';
import { VisibilityManager } from './visibility-manager.js';
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

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1024 * 1024 * 1024),
    },
  });
  if (!device) {
    showError('WebGPU device creation failed');
    return;
  }

  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Create renderer
  const renderer = new Renderer(device, format);

  // Track loaded bricks: key -> atlas slot
  const loadedBricks = new Map<string, AtlasSlot>();

  // Generate test pyramid
  const pyramid = generateTestPyramid(DATASET_SIZE[0]!, DATASET_SIZE[1]!, DATASET_SIZE[2]!, BRICK_SIZE);

  console.log('\n📊 Test Pyramid Structure:');
  for (const [levelName, bricks] of Object.entries(pyramid)) {
    const keys = Array.from(bricks.keys());
    console.log(`  ${levelName}: ${bricks.size} bricks`);
    console.log(`    Keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}`);
  }

  // Create octree with brick loading callback
  const loadBrickAtLod = (lod: number, bx: number, by: number, bz: number): AtlasSlot | null => {
    const levelName = `scale${lod}`;
    const levelData = pyramid[levelName];
    if (!levelData) return null;

    const brickKey = `${bz}/${by}/${bx}`;
    const data = levelData.get(brickKey);
    if (!data) return null;

    const lodKey = `${levelName}:${brickKey}`;
    if (loadedBricks.has(lodKey)) {
      return loadedBricks.get(lodKey)!;
    }

    const slot = renderer.allocator.allocate();
    if (!slot) return null;

    const offset: [number, number, number] = [
      slot.x * BRICK_SIZE,
      slot.y * BRICK_SIZE,
      slot.z * BRICK_SIZE
    ];
    writeToCanvas(device, renderer.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

    const lodScale = Math.pow(2, lod);
    for (let dz = 0; dz < lodScale; dz++) {
      for (let dy = 0; dy < lodScale; dy++) {
        for (let dx = 0; dx < lodScale; dx++) {
          const vx = bx * lodScale + dx;
          const vy = by * lodScale + dy;
          const vz = bz * lodScale + dz;
          if (vx < DATASET_GRID[0]! && vy < DATASET_GRID[1]! && vz < DATASET_GRID[2]!) {
            renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
          }
        }
      }
    }

    loadedBricks.set(lodKey, slot);
    return slot;
  };

  const octree = new Octree(3, loadBrickAtLod);
  octree.loadRoot();

  // Create camera
  const camera = new Camera(canvas);

  // Indirection update callback for visibility manager (used when collapsing)
  const updateIndirection = (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => {
    const lodScale = Math.pow(2, lod);
    for (let dz = 0; dz < lodScale; dz++) {
      for (let dy = 0; dy < lodScale; dy++) {
        for (let dx = 0; dx < lodScale; dx++) {
          const vx = bx * lodScale + dx;
          const vy = by * lodScale + dy;
          const vz = bz * lodScale + dz;
          if (vx < DATASET_GRID[0]! && vy < DATASET_GRID[1]! && vz < DATASET_GRID[2]!) {
            renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
          }
        }
      }
    }
  };

  // Create visibility manager
  const visibilityManager = new VisibilityManager(
    octree,
    {
      // Distance thresholds: refine when camera is closer than these values
      lodThresholds: [5.0, 3.0, 1.0], // LOD 3→2 at 1.5, LOD 2→1 at 1.0, LOD 1→0 at 0.6
    },
    updateIndirection
  );

  // Auto-update visibility (can be toggled)
  let autoUpdateVisibility = true;

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
    // Update visibility based on camera position
    if (autoUpdateVisibility) {
      visibilityManager.update([
        camera.position[0]!,
        camera.position[1]!,
        camera.position[2]!
      ]);
    }

    const view = context.getCurrentTexture().createView();
    renderer.render(view, camera);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Initialize console tools
  initConsoleTools({
    renderer,
    camera,
    device,
    octree,
    pyramid,
    loadedBricks,
    visibilityManager,
    getAutoUpdate: () => autoUpdateVisibility,
    setAutoUpdate: (v: boolean) => { autoUpdateVisibility = v; },
  });

  printStats(renderer, loadedBricks);
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
