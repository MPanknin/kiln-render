/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { generateSphereVolume, generateSolidVolume, writeToCanvas } from './volume.js';
import { generateTestPyramid } from './generator.js';
import { Octree } from './octree.js';
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

  // Generate test pyramid and log its structure
  const pyramid = generateTestPyramid(DATASET_SIZE[0], DATASET_SIZE[1], DATASET_SIZE[2], BRICK_SIZE);

  // LOD name to level mapping
  const lodMap: Record<string, number> = {
    'scale0': 0,
    'scale1': 1,
    'scale2': 2,
    'scale3': 3,
  };

  console.log('\n📊 Test Pyramid Structure:');
  for (const [levelName, bricks] of Object.entries(pyramid)) {
    const keys = Array.from(bricks.keys());
    console.log(`  ${levelName}: ${bricks.size} bricks`);
    console.log(`    Keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}`);
  }

  /**
   * Load a LOD level into the renderer (additive - doesn't clear existing bricks)
   * For lower LODs, one brick covers multiple virtual brick positions
   * so we fill multiple indirection entries pointing to the same atlas slot
   */
  const loadLevel = (levelName: string) => {
    const levelData = pyramid[levelName];
    const lod = lodMap[levelName];
    if (!levelData || lod === undefined) {
      console.warn(`Unknown level: ${levelName}`);
      return;
    }

    // LOD scale: how many full-res bricks one LOD brick covers per axis
    const lodScale = Math.pow(2, lod);
    let loadedCount = 0;

    for (const [brickKey, data] of levelData) {
      const [bz, by, bx] = brickKey.split('/').map(Number);

      // Check if this LOD brick is already loaded
      const lodKey = `${levelName}:${brickKey}`;
      if (loadedBricks.has(lodKey)) {
        continue;
      }

      // Allocate atlas slot and write brick data
      const slot = renderer.allocator.allocate();
      if (!slot) {
        console.warn('Atlas full');
        break;
      }

      // Write to atlas
      const offset: [number, number, number] = [
        slot.x * BRICK_SIZE,
        slot.y * BRICK_SIZE,
        slot.z * BRICK_SIZE
      ];
      writeToCanvas(device, renderer.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

      // Fill all indirection entries this brick covers
      // e.g., LOD 3 brick at (0,0,0) fills positions (0-7, 0-7, 0-7) in the 8x8x8 grid
      for (let dz = 0; dz < lodScale; dz++) {
        for (let dy = 0; dy < lodScale; dy++) {
          for (let dx = 0; dx < lodScale; dx++) {
            const vx = bx * lodScale + dx;
            const vy = by * lodScale + dy;
            const vz = bz * lodScale + dz;
            if (vx < DATASET_GRID[0] && vy < DATASET_GRID[1] && vz < DATASET_GRID[2]) {
              renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
            }
          }
        }
      }

      loadedBricks.set(lodKey, slot);
      loadedCount++;
    }

    console.log(`Loaded ${levelName} (LOD ${lod}): ${loadedCount} new bricks, ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} atlas slots used`);
  };

  /**
   * Clear all bricks and reset
   */
  const clearAll = () => {
    renderer.clearAllBricks();
    loadedBricks.clear();
    console.log('Cleared all bricks');
  };

  /**
   * Load a single brick from a specific LOD level
   * @param lod - LOD level (0-3)
   * @param bx, by, bz - Brick coordinates at that LOD level
   */
  const loadBrickAtLod = (lod: number, bx: number, by: number, bz: number) => {
    const levelName = `scale${lod}`;
    const levelData = pyramid[levelName];
    if (!levelData) {
      console.warn(`Unknown LOD: ${lod}`);
      return null;
    }

    const brickKey = `${bz}/${by}/${bx}`;
    const data = levelData.get(brickKey);
    if (!data) {
      console.warn(`Brick ${brickKey} not found in ${levelName}`);
      return null;
    }

    const lodKey = `${levelName}:${brickKey}`;
    if (loadedBricks.has(lodKey)) {
      console.log(`Brick ${lodKey} already loaded`);
      return loadedBricks.get(lodKey);
    }

    // Allocate atlas slot
    const slot = renderer.allocator.allocate();
    if (!slot) {
      console.warn('Atlas full');
      return null;
    }

    // Write to atlas
    const offset: [number, number, number] = [
      slot.x * BRICK_SIZE,
      slot.y * BRICK_SIZE,
      slot.z * BRICK_SIZE
    ];
    writeToCanvas(device, renderer.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

    // Fill indirection entries this brick covers
    const lodScale = Math.pow(2, lod);
    for (let dz = 0; dz < lodScale; dz++) {
      for (let dy = 0; dy < lodScale; dy++) {
        for (let dx = 0; dx < lodScale; dx++) {
          const vx = bx * lodScale + dx;
          const vy = by * lodScale + dy;
          const vz = bz * lodScale + dz;
          if (vx < DATASET_GRID[0] && vy < DATASET_GRID[1] && vz < DATASET_GRID[2]) {
            renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
          }
        }
      }
    }

    loadedBricks.set(lodKey, slot);
    console.log(`Loaded ${lodKey} -> atlas[${slot.x},${slot.y},${slot.z}]`);
    return slot;
  };

  /**
   * Subdivide a brick: replace one LOD brick with 8 children from the next finer LOD
   * @param lod - Current LOD level of the brick to subdivide (must be > 0)
   * @param bx, by, bz - Brick coordinates at current LOD level
   */
  const subdivide = (lod: number, bx: number, by: number, bz: number) => {
    if (lod <= 0) {
      console.warn('Cannot subdivide LOD 0 - already at finest level');
      return;
    }

    const childLod = lod - 1;
    const childScale = 2; // Each parent brick becomes 2x2x2 children

    console.log(`Subdividing LOD ${lod} brick (${bx},${by},${bz}) into 8 LOD ${childLod} bricks`);

    // Load all 8 children
    for (let dz = 0; dz < childScale; dz++) {
      for (let dy = 0; dy < childScale; dy++) {
        for (let dx = 0; dx < childScale; dx++) {
          const cx = bx * childScale + dx;
          const cy = by * childScale + dy;
          const cz = bz * childScale + dz;
          loadBrickAtLod(childLod, cx, cy, cz);
        }
      }
    }

    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  };

  // Create octree for LOD management
  const octree = new Octree(3, loadBrickAtLod);

  // Helper to update indirection when collapsing
  const updateIndirectionForNode = (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => {
    const lodScale = Math.pow(2, lod);
    for (let dz = 0; dz < lodScale; dz++) {
      for (let dy = 0; dy < lodScale; dy++) {
        for (let dx = 0; dx < lodScale; dx++) {
          const vx = bx * lodScale + dx;
          const vy = by * lodScale + dy;
          const vz = bz * lodScale + dz;
          if (vx < DATASET_GRID[0] && vy < DATASET_GRID[1] && vz < DATASET_GRID[2]) {
            renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
          }
        }
      }
    }
  };

  /**
   * Split a leaf node into 8 children (refine)
   * @param lod - LOD level of the leaf to split
   * @param bx, by, bz - Brick coordinates at that LOD
   */
  const split = (lod: number, bx: number, by: number, bz: number) => {
    const leaf = octree.findLeaf(lod, bx, by, bz);
    if (!leaf) {
      console.warn(`No leaf found at LOD ${lod} (${bx},${by},${bz})`);
      return;
    }
    octree.subdivide(leaf);
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  };

  /**
   * Merge 8 children back into parent (coarsen)
   * @param lod - LOD level of the parent (not the children)
   * @param bx, by, bz - Brick coordinates of the parent
   */
  const merge = (lod: number, bx: number, by: number, bz: number) => {
    // Find the parent node that has these children
    const findNode = (node: OctreeNode): OctreeNode | null => {
      if (node.lod === lod && node.bx === bx && node.by === by && node.bz === bz) {
        return node;
      }
      if (node.children) {
        for (const child of node.children) {
          const found = findNode(child);
          if (found) return found;
        }
      }
      return null;
    };

    const node = findNode(octree.root);
    if (!node) {
      console.warn(`No node found at LOD ${lod} (${bx},${by},${bz})`);
      return;
    }
    octree.collapse(node, updateIndirectionForNode);
  };

  /**
   * Refine towards camera position
   */
  const refine = () => {
    // Camera position is in world space, convert to normalized volume space
    const camPos: [number, number, number] = [
      camera.position[0],
      camera.position[1],
      camera.position[2]
    ];
    octree.refineTowards(camPos);
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  };

  // Load root (LOD 3)
  octree.loadRoot();

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
  (window as any).pyramid = pyramid;
  (window as any).loadLevel = loadLevel;
  (window as any).clearAll = clearAll;
  (window as any).loadBrickAtLod = loadBrickAtLod;
  (window as any).subdivide = subdivide;
  (window as any).octree = octree;
  (window as any).split = split;
  (window as any).merge = merge;
  (window as any).refine = refine;

  // Toggle render mode between 'fragment' and 'compute'
  (window as any).setRenderMode = (mode: 'fragment' | 'compute') => {
    renderer.renderMode = mode;
    console.log(`Render mode set to: ${mode}`);
  };

  (window as any).toggleRenderMode = () => {
    renderer.renderMode = renderer.renderMode === 'fragment' ? 'compute' : 'fragment';
    console.log(`Render mode toggled to: ${renderer.renderMode}`);
  };

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
