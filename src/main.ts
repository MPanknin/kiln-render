/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { writeToCanvas } from './volume.js';
import { generateTestPyramid } from './generator.js';
import { Octree } from './octree.js';
import { BRICK_SIZE, setDatasetSize, getDatasetGrid } from './config.js';
import { AtlasSlot } from './atlas-allocator.js';
import { initConsoleTools, printStats } from './console-tools.js';
import { VisibilityManager } from './visibility-manager.js';
import { loadBrickPyramid, BrickMetadata } from './brick-loader.js';
import './../test/snapshot-test.js';

// Volume source configuration
// Set to a path like '/volumes/bricks/stent' to load real data
// Set to null to use synthetic test pyramid
// const VOLUME_SOURCE: string | null = null;
const VOLUME_SOURCE = '/volumes/bricks/stagbeetle';

type Pyramid = Record<string, Map<string, Uint8Array>>;

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

  // Load volume data (either from disk or generate synthetic)
  let pyramid: Pyramid;
  let metadata: BrickMetadata | null = null;
  let maxLod: number;
  let rootGrid: [number, number, number];

  if (VOLUME_SOURCE) {
    console.log(`Loading volume from ${VOLUME_SOURCE}...`);
    const loaded = await loadBrickPyramid(VOLUME_SOURCE);
    pyramid = loaded.pyramid;
    metadata = loaded.metadata;

    // Configure dataset size and voxel spacing from loaded metadata
    const spacing = metadata.voxelSpacing as [number, number, number] | undefined;
    setDatasetSize(metadata.originalDimensions as [number, number, number], spacing);
    maxLod = metadata.maxLod;

    // Get root grid from coarsest LOD level
    const coarsestLevel = metadata.levels.find(l => l.lod === maxLod);
    rootGrid = coarsestLevel ? coarsestLevel.bricks as [number, number, number] : [1, 1, 1];

    console.log(`\n📦 Loaded Volume: ${metadata.name}`);
    console.log(`  Dimensions: ${metadata.originalDimensions.join('x')}`);
    if (metadata.voxelSpacing) {
      console.log(`  Voxel spacing: ${metadata.voxelSpacing.join(' x ')}`);
    }
    console.log(`  LOD levels: ${metadata.levels.length}`);
    for (const level of metadata.levels) {
      console.log(`    LOD ${level.lod}: ${level.bricks.join('x')} bricks (${level.brickCount} total)`);
    }
  } else {
    // Generate synthetic test pyramid
    const testSize: [number, number, number] = [512, 256, 512];
    setDatasetSize(testSize);
    pyramid = generateTestPyramid(testSize[0], testSize[1], testSize[2], BRICK_SIZE);
    maxLod = 3;
    rootGrid = [1, 1, 1]; // Single root for test pyramid

    console.log('\n📊 Test Pyramid Structure:');
    for (const [levelName, bricks] of Object.entries(pyramid)) {
      const keys = Array.from(bricks.keys());
      console.log(`  ${levelName}: ${bricks.size} bricks`);
      console.log(`    Keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}`);
    }
  }

  // Create renderer (must be after setDatasetSize for correct geometry)
  const renderer = new Renderer(device, format);

  // Track loaded bricks: key -> atlas slot
  const loadedBricks = new Map<string, AtlasSlot>();

  // Helper to update indirection for a brick
  const updateBrickIndirection = (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => {
    const datasetGrid = getDatasetGrid();
    const lodScale = Math.pow(2, lod);
    for (let dz = 0; dz < lodScale; dz++) {
      for (let dy = 0; dy < lodScale; dy++) {
        for (let dx = 0; dx < lodScale; dx++) {
          const vx = bx * lodScale + dx;
          const vy = by * lodScale + dy;
          const vz = bz * lodScale + dz;
          if (vx < datasetGrid[0] && vy < datasetGrid[1] && vz < datasetGrid[2]) {
            renderer.indirection.setBrick(vx, vy, vz, slot.x, slot.y, slot.z, lod);
          }
        }
      }
    }
  };

  // Create octree with brick loading callback
  const loadBrickAtLod = (lod: number, bx: number, by: number, bz: number): AtlasSlot | null => {
    const levelName = `scale${lod}`;
    const levelData = pyramid[levelName];
    if (!levelData) return null;

    const brickKey = `${bz}/${by}/${bx}`;
    const data = levelData.get(brickKey);
    if (!data) return null;

    const lodKey = `${levelName}:${brickKey}`;

    // Check if already loaded in atlas
    if (loadedBricks.has(lodKey)) {
      const slot = loadedBricks.get(lodKey)!;
      // Always update indirection (may have been changed by collapse)
      updateBrickIndirection(lod, bx, by, bz, slot);
      return slot;
    }

    // Allocate new slot and load data
    const slot = renderer.allocator.allocate();
    if (!slot) return null;

    const offset: [number, number, number] = [
      slot.x * BRICK_SIZE,
      slot.y * BRICK_SIZE,
      slot.z * BRICK_SIZE
    ];
    writeToCanvas(device, renderer.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

    // Update indirection
    updateBrickIndirection(lod, bx, by, bz, slot);

    loadedBricks.set(lodKey, slot);
    return slot;
  };

  const octree = new Octree(maxLod, loadBrickAtLod, rootGrid);
  octree.loadRoot();

  // Debug: print loaded bricks
  console.log(`\nLoaded bricks after octree init:`);
  for (const [key, slot] of loadedBricks) {
    console.log(`  ${key} -> atlas(${slot.x},${slot.y},${slot.z})`);
  }

  // Create camera
  const camera = new Camera(canvas);

  // Indirection update callback for visibility manager (used when collapsing)
  // Reuses the same helper function
  const updateIndirection = updateBrickIndirection;

  // Create visibility manager
  const visibilityManager = new VisibilityManager(
    octree,
    {
      // Distance thresholds: refine when camera is closer than these values
      lodThresholds: [5.0, 3.0, 1.0],
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
