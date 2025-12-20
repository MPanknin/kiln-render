/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer, VolumeRenderMode } from './renderer.js';
import { Camera, UpAxis, extractFrustumPlanes, isAABBInFrustum, multiplyMatrices } from './camera.js';
import { writeToCanvas } from './volume.js';
import { PHYSICAL_BRICK_SIZE, setDatasetSize, getDatasetGrid, getNormalizedSize } from './config.js';
import { AtlasSlot } from './atlas-allocator.js';
import { BrickLoader } from './brick-loader.js';
import { TransferFunction } from './transfer-function.js';
import { VolumeUI } from './ui.js';
import { StreamingManager } from './streaming-manager.js';

// Volume source configuration
// const VOLUME_SOURCE = '/volumes/bricks/stagbeetle';
// const VOLUME_SOURCE = '/datasets/chameleon';
const VOLUME_SOURCE = 'https://kiln-samples.s3.eu-central-1.amazonaws.com/stagbeetle-binary';
// const VOLUME_SOURCE = 'https://kiln-samples.s3.eu-central-1.amazonaws.com/chameleon-binary';

async function main() {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('Canvas not found');

  // Initialize WebGPU
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    showError('WebGPU not supported');
    return;
  }

  const device = await adapter.requestDevice();
  if (!device) {
    showError('WebGPU device creation failed');
    return;
  }

  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format });

  // Load volume metadata
  console.log(`Loading volume metadata from ${VOLUME_SOURCE}...`);
  const brickLoader = new BrickLoader(VOLUME_SOURCE);
  const metadata = await brickLoader.loadMetadata();

  // Configure dataset size from metadata
  const spacing = metadata.voxelSpacing as [number, number, number] | undefined;
  setDatasetSize(metadata.originalDimensions as [number, number, number], spacing);

  console.log(`\n📦 Volume: ${metadata.name}`);
  console.log(`  Dimensions: ${metadata.originalDimensions.join('x')}`);
  console.log(`  LOD levels: ${metadata.levels.length}`);
  for (const level of metadata.levels) {
    console.log(`    LOD ${level.lod}: ${level.bricks.join('x')} bricks (${level.brickCount} total)`);
  }

  // Create renderer
  const renderer = new Renderer(device, format);

  // Create transfer function and connect to renderer
  const transferFunction = new TransferFunction(device);
  renderer.setTransferFunction(transferFunction);

  // Create camera
  const camera = new Camera(canvas);

  // Create streaming manager
  const streamingManager = new StreamingManager(renderer, brickLoader, metadata, device);

  // Streaming mode toggle
  let streamingEnabled = false;

  /**
   * Set camera up axis
   */
  function setCameraUp(axis: UpAxis): void {
    camera.setUpAxis(axis);
    console.log(`Camera up axis set to: ${axis.toUpperCase()}`);
  }

  /**
   * Set volume render mode: 'dvr', 'mip', or 'iso'
   */
  function setRenderMode(mode: VolumeRenderMode): void {
    renderer.volumeRenderMode = mode;
    console.log(`Render mode set to: ${mode.toUpperCase()}`);
  }

  /**
   * Set ISO surface threshold (0-1)
   */
  function setIsoValue(value: number): void {
    renderer.isoValue = Math.max(0, Math.min(1, value));
    console.log(`ISO value set to: ${renderer.isoValue}`);
  }

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

  // Track loaded bricks: key -> { slot, slotIndex }
  const loadedBricks = new Map<string, { slot: AtlasSlot; slotIndex: number }>();

  // Frame counter for LRU tracking
  let frameCount = 0;

  /**
   * Clear all loaded bricks - empties atlas and resets indirection
   */
  function clearLod(): void {
    // Free all atlas slots
    for (const entry of loadedBricks.values()) {
      renderer.allocator.free(entry.slot);
    }
    loadedBricks.clear();

    // Reset indirection table
    renderer.indirection.clearAll();

    console.log('Cleared all bricks');
  }

  /**
   * Load bricks from a specific LOD level, sorted by distance to camera
   * Only loads bricks inside the camera frustum
   * Fills atlas until full
   */
  async function loadLod(lod: number): Promise<void> {
    const level = metadata.levels.find(l => l.lod === lod);
    if (!level) {
      console.error(`LOD ${lod} not found`);
      return;
    }

    const [gridX, gridY, gridZ] = level.bricks as [number, number, number];
    const normalizedSize = getNormalizedSize();
    const datasetGrid = getDatasetGrid();

    // Get camera position
    const cameraPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!
    ];

    // Get frustum planes for culling
    const aspect = canvas!.width / canvas!.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    const viewProj = multiplyMatrices(projMatrix, viewMatrix);
    const frustum = extractFrustumPlanes(viewProj);

    // Collect visible bricks with their distance to camera
    const bricks: { bx: number; by: number; bz: number; distance: number }[] = [];
    let culledCount = 0;

    for (let bz = 0; bz < gridZ; bz++) {
      for (let by = 0; by < gridY; by++) {
        for (let bx = 0; bx < gridX; bx++) {
          // Calculate brick bounds in normalized space
          const brickSize: [number, number, number] = [
            normalizedSize[0] / gridX,
            normalizedSize[1] / gridY,
            normalizedSize[2] / gridZ,
          ];
          const brickMin: [number, number, number] = [
            -normalizedSize[0] * 0.5 + bx * brickSize[0],
            -normalizedSize[1] * 0.5 + by * brickSize[1],
            -normalizedSize[2] * 0.5 + bz * brickSize[2],
          ];
          const brickMax: [number, number, number] = [
            brickMin[0] + brickSize[0],
            brickMin[1] + brickSize[1],
            brickMin[2] + brickSize[2],
          ];

          // Frustum culling - skip bricks outside view
          if (!isAABBInFrustum(brickMin, brickMax, frustum)) {
            culledCount++;
            continue;
          }

          // Calculate brick center for distance sorting
          const center: [number, number, number] = [
            brickMin[0] + brickSize[0] * 0.5,
            brickMin[1] + brickSize[1] * 0.5,
            brickMin[2] + brickSize[2] * 0.5,
          ];

          // Distance to camera
          const dx = cameraPos[0] - center[0];
          const dy = cameraPos[1] - center[1];
          const dz = cameraPos[2] - center[2];
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

          bricks.push({ bx, by, bz, distance });
        }
      }
    }

    // Sort by distance (closest first)
    bricks.sort((a, b) => a.distance - b.distance);

    console.log(`LOD ${lod}: ${bricks.length} visible, ${culledCount} culled`);

    console.log(`Loading LOD ${lod}: ${bricks.length} bricks available, sorted by distance`);

    let loaded = 0;
    let evicted = 0;
    let skippedEmpty = 0;
    for (const brick of bricks) {
      const key = `lod${lod}:${brick.bz}/${brick.by}/${brick.bx}`;

      // Skip if already loaded
      if (loadedBricks.has(key)) {
        continue;
      }

      // Skip empty bricks (min=0, max=0, avg=0) - mark as empty in indirection
      if (await brickLoader.isBrickEmpty(lod, brick.bx, brick.by, brick.bz)) {
        renderer.indirection.setEmpty(brick.bx, brick.by, brick.bz, lod);
        skippedEmpty++;
        continue;
      }

      // Allocate slot (will evict LRU if full)
      const result = renderer.allocator.allocate(frameCount);
      if (!result) {
        console.log(`Allocation failed after ${loaded} bricks`);
        break;
      }

      // Handle eviction: clear old brick from indirection table
      if (result.evicted) {
        renderer.indirection.clearBrick(
          result.evicted.bx, result.evicted.by, result.evicted.bz,
          result.evicted.lod
        );
        loadedBricks.delete(result.evicted.key);
        evicted++;
      }

      // Load brick data
      const data = await brickLoader.loadBrick(lod, brick.bx, brick.by, brick.bz);
      if (!data) {
        renderer.allocator.free(result.slot);
        continue;
      }

      // Upload to atlas (use physical brick size for positioning)
      const offset: [number, number, number] = [
        result.slot.x * PHYSICAL_BRICK_SIZE,
        result.slot.y * PHYSICAL_BRICK_SIZE,
        result.slot.z * PHYSICAL_BRICK_SIZE
      ];
      writeToCanvas(device, renderer.canvas, data, [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE], offset);

      // Update indirection - setBrick handles multi-cell fill for coarse LODs
      renderer.indirection.setBrick(brick.bx, brick.by, brick.bz, result.slot.x, result.slot.y, result.slot.z, lod);

      // Set metadata for future eviction
      renderer.allocator.setMetadata(result.slotIndex, { lod, bx: brick.bx, by: brick.by, bz: brick.bz, key });

      // Track
      loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });
      loaded++;
    }

    console.log(`Loaded ${loaded} bricks at LOD ${lod} (evicted ${evicted}, skipped ${skippedEmpty} empty)`);
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  }

  // Render loop
  function frame() {
    frameCount++;

    // Update streaming manager if enabled
    if (streamingEnabled) {
      streamingManager.update(camera, canvas);
    }

    const view = context.getCurrentTexture().createView();
    renderer.render(view, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Create UI
  const ui = new VolumeUI(renderer, camera, transferFunction, {
    onLoadLod: loadLod,
    onClearLod: clearLod,
  });

  // Streaming control functions
  function startStreaming(): void {
    if (streamingEnabled) {
      console.log('Streaming already enabled');
      return;
    }
    streamingEnabled = true;
    streamingManager.forceUpdate(camera, canvas);
    console.log('Streaming enabled - bricks will load automatically as you navigate');
  }

  function stopStreaming(): void {
    streamingEnabled = false;
    console.log('Streaming disabled');
  }

  function streamingStats(): void {
    const stats = streamingManager.getStats();
    console.log('=== Streaming Stats ===');
    console.log(`  Desired: ${stats.desiredCount} bricks`);
    console.log(`  Loaded: ${stats.loadedCount} bricks`);
    console.log(`  Pending: ${stats.pendingCount} bricks`);
    console.log(`  Culled: ${stats.culledCount} bricks (frustum)`);
    console.log(`  Empty: ${stats.emptyCount} bricks (skipped)`);
    console.log(`  Evicted: ${stats.evictedCount} bricks`);
    console.log(`  Atlas: ${stats.atlasUsage}/${stats.atlasCapacity} slots`);
  }

  // Expose API
  (window as any).loadLod = loadLod;
  (window as any).clearLod = clearLod;
  (window as any).setCameraUp = setCameraUp;
  (window as any).setRenderMode = setRenderMode;
  (window as any).setIsoValue = setIsoValue;
  (window as any).renderer = renderer;
  (window as any).camera = camera;
  (window as any).metadata = metadata;
  (window as any).transferFunction = transferFunction;
  (window as any).ui = ui;
  (window as any).loader = brickLoader;
  (window as any).streamingManager = streamingManager;
  (window as any).startStreaming = startStreaming;
  (window as any).stopStreaming = stopStreaming;
  (window as any).streamingStats = streamingStats;

  // Test helpers for multi-LOD indirection
  (window as any).testMultiLod = async () => {
    console.log('=== Multi-LOD Test ===');
    console.log('1. Clearing all bricks...');
    clearLod();

    console.log('2. Loading LOD 2 (coarse, covers 4x4x4 LOD0 cells per brick)...');
    await loadLod(2);

    console.log('3. Now load a single LOD 0 brick to punch a high-res hole:');
    console.log('   Run: loadSingleBrick(0, 0, 0, 0)');
  };

  (window as any).loadSingleBrick = async (lod: number, bx: number, by: number, bz: number) => {
    console.log(`Loading brick: LOD ${lod} at (${bx},${by},${bz})`);
    const key = `lod${lod}:${bz}/${by}/${bx}`;

    // Already loaded?
    if (loadedBricks.has(key)) {
      console.log('Brick already loaded');
      return;
    }

    try {
      const data = await brickLoader.loadBrick(lod, bx, by, bz);
      if (!data) {
        console.error('Failed to load brick data');
        return;
      }

      // Allocate with LRU eviction
      const result = renderer.allocator.allocate(frameCount);
      if (!result) {
        console.error('Allocation failed!');
        return;
      }

      // Handle eviction
      if (result.evicted) {
        console.log(`Evicted: LOD ${result.evicted.lod} brick (${result.evicted.bx},${result.evicted.by},${result.evicted.bz})`);
        renderer.indirection.clearBrick(
          result.evicted.bx, result.evicted.by, result.evicted.bz,
          result.evicted.lod
        );
        loadedBricks.delete(result.evicted.key);
      }

      // Upload to atlas
      const offset: [number, number, number] = [
        result.slot.x * PHYSICAL_BRICK_SIZE,
        result.slot.y * PHYSICAL_BRICK_SIZE,
        result.slot.z * PHYSICAL_BRICK_SIZE
      ];
      writeToCanvas(device, renderer.canvas, data, [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE], offset);

      // Update indirection table - this now fills multiple cells for coarse LODs
      renderer.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, lod);

      // Set metadata for future eviction
      renderer.allocator.setMetadata(result.slotIndex, { lod, bx, by, bz, key });

      // Track
      loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });

      console.log(`Loaded LOD ${lod} brick (${bx},${by},${bz}) into atlas slot (${result.slot.x},${result.slot.y},${result.slot.z})`);
      console.log(`This brick covers ${Math.pow(2, lod)}³ = ${Math.pow(Math.pow(2, lod), 3)} cells in the indirection table`);
    } catch (e) {
      console.error('Failed to load brick:', e);
    }
  };

  (window as any).dumpIndirection = (z: number = 0) => {
    const grid = renderer.indirection as any;
    const data = grid.data;
    const gridX = grid.gridX;
    const gridY = grid.gridY;

    console.log(`Indirection table slice Z=${z} (format: [atlasX,atlasY,atlasZ,lod] where lod=0 means empty):`);
    for (let y = 0; y < Math.min(gridY, 8); y++) {
      let row = '';
      for (let x = 0; x < Math.min(gridX, 8); x++) {
        const idx = (x + y * gridX + z * gridX * gridY) * 4;
        const lod = data[idx + 3];
        row += lod === 0 ? ' . ' : ` ${lod - 1} `;
      }
      console.log(row);
    }
  };

  // LOD selection test - coarse-to-fine traversal based on distance + frustum
  // Now with differential updates - doesn't clear, just loads what's needed and evicts what's not
  (window as any).testLodSelection = async (clear: boolean = false) => {
    console.log('=== LOD Selection Test (Coarse-to-Fine with LRU) ===');
    console.log('Switch to LOD render mode to see the results clearly');

    // Optionally clear (default: differential update)
    if (clear) {
      clearLod();
      console.log('Cleared atlas for fresh start');
    } else {
      console.log('Differential update mode - keeping existing bricks');
    }

    // Get the actual LOD range from metadata
    const maxLod = Math.max(...metadata.levels.map(l => l.lod));
    const minLod = Math.min(...metadata.levels.map(l => l.lod));

    // Distance thresholds for splitting each LOD level
    // Index 0 = threshold to split from LOD 1 to LOD 0
    // Index 1 = threshold to split from LOD 2 to LOD 1, etc.
    // Hand-tuned for visible LOD bands: green close, then yellow-green, yellow, orange, red
    const lodThresholds = [0.3, 0.5, 0.8, 1.2, 2.0]; // LOD1→0, LOD2→1, LOD3→2, LOD4→3, LOD5→4
    console.log(`LOD thresholds: ${lodThresholds.slice(0, maxLod).map((t, i) => `LOD${i + 1}→${i}: ${t.toFixed(2)}`).join(', ')}`);

    // Get camera state
    const cameraPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!
    ];
    console.log(`Camera position: (${cameraPos.map(v => v.toFixed(2)).join(', ')})`);

    // Get frustum for culling
    const aspect = canvas!.width / canvas!.height;
    const viewMatrix = camera.getViewMatrix();
    const projMatrix = camera.getProjectionMatrix(aspect);
    const viewProj = multiplyMatrices(projMatrix, viewMatrix);
    const frustum = extractFrustumPlanes(viewProj);

    const normalizedSize = getNormalizedSize();

    // Stats
    let totalLoaded = 0;
    let totalCulled = 0;
    const lodCounts: Record<number, number> = {};
    for (let i = minLod; i <= maxLod; i++) lodCounts[i] = 0;

    // Helper: get brick AABB in normalized coordinates
    const getBrickAABB = (bx: number, by: number, bz: number, lod: number): { min: [number, number, number], max: [number, number, number] } => {
      const level = metadata.levels.find(l => l.lod === lod);
      if (!level) return { min: [0, 0, 0], max: [0, 0, 0] };

      const [gridX, gridY, gridZ] = level.bricks as [number, number, number];
      const brickSize: [number, number, number] = [
        normalizedSize[0] / gridX,
        normalizedSize[1] / gridY,
        normalizedSize[2] / gridZ,
      ];

      const min: [number, number, number] = [
        -normalizedSize[0] * 0.5 + bx * brickSize[0],
        -normalizedSize[1] * 0.5 + by * brickSize[1],
        -normalizedSize[2] * 0.5 + bz * brickSize[2],
      ];
      const max: [number, number, number] = [
        min[0] + brickSize[0],
        min[1] + brickSize[1],
        min[2] + brickSize[2],
      ];

      return { min, max };
    };

    // Helper: get AABB center
    const getAABBCenter = (aabb: { min: [number, number, number], max: [number, number, number] }): [number, number, number] => {
      return [
        (aabb.min[0] + aabb.max[0]) * 0.5,
        (aabb.min[1] + aabb.max[1]) * 0.5,
        (aabb.min[2] + aabb.max[2]) * 0.5,
      ];
    };

    // Helper: distance between two points
    const distance = (a: [number, number, number], b: [number, number, number]): number => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    // Stats for eviction
    let totalEvicted = 0;
    let totalSkippedEmpty = 0;

    // Load a single brick (with LRU eviction support)
    const loadBrickWithEviction = async (bx: number, by: number, bz: number, lod: number): Promise<boolean> => {
      const key = `lod${lod}:${bz}/${by}/${bx}`;

      // Already loaded? Just touch it
      if (loadedBricks.has(key)) {
        const entry = loadedBricks.get(key)!;
        renderer.allocator.touch(entry.slotIndex, frameCount);
        return true;
      }

      // Skip empty bricks (min=0, max=0, avg=0) - mark as empty in indirection
      const isEmpty = await brickLoader.isBrickEmpty(lod, bx, by, bz);
      if (isEmpty) {
        renderer.indirection.setEmpty(bx, by, bz, lod);
        totalSkippedEmpty++;
        return true; // Consider it "loaded" - nothing to display
      }

      // Allocate slot (will evict LRU if full)
      const result = renderer.allocator.allocate(frameCount);
      if (!result) {
        console.warn('Allocation failed!');
        return false;
      }

      // Handle eviction: clear old brick from indirection table
      if (result.evicted) {
        renderer.indirection.clearBrick(
          result.evicted.bx, result.evicted.by, result.evicted.bz,
          result.evicted.lod
        );
        loadedBricks.delete(result.evicted.key);
        totalEvicted++;
      }

      // Load brick data
      const data = await brickLoader.loadBrick(lod, bx, by, bz);
      if (!data) {
        renderer.allocator.free(result.slot);
        return false;
      }

      // Upload to atlas
      const offset: [number, number, number] = [
        result.slot.x * PHYSICAL_BRICK_SIZE,
        result.slot.y * PHYSICAL_BRICK_SIZE,
        result.slot.z * PHYSICAL_BRICK_SIZE
      ];
      writeToCanvas(device, renderer.canvas, data, [PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE, PHYSICAL_BRICK_SIZE], offset);

      // Update indirection
      renderer.indirection.setBrick(bx, by, bz, result.slot.x, result.slot.y, result.slot.z, lod);

      // Set metadata for future eviction
      renderer.allocator.setMetadata(result.slotIndex, { lod, bx, by, bz, key });

      // Track
      loadedBricks.set(key, { slot: result.slot, slotIndex: result.slotIndex });

      return true;
    };

    // Recursive traversal: coarse-to-fine
    const traverse = async (bx: number, by: number, bz: number, lod: number): Promise<void> => {
      const level = metadata.levels.find(l => l.lod === lod);
      if (!level) return;

      const [gridX, gridY, gridZ] = level.bricks as [number, number, number];

      // Bounds check
      if (bx >= gridX || by >= gridY || bz >= gridZ) return;

      // Get brick AABB
      const aabb = getBrickAABB(bx, by, bz, lod);

      // 1. Frustum culling - if not visible, skip entire branch
      if (!isAABBInFrustum(aabb.min, aabb.max, frustum)) {
        totalCulled++;
        return;
      }

      // 2. Distance check
      const center = getAABBCenter(aabb);
      const dist = distance(cameraPos, center);

      // 3. Decision: load this LOD or split to finer?
      const shouldSplit = lod > 0 && dist < lodThresholds[lod - 1]!;

      if (shouldSplit) {
        // Recurse to 8 children at finer LOD
        const nextLod = lod - 1;
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const cx = bx * 2 + dx;
              const cy = by * 2 + dy;
              const cz = bz * 2 + dz;
              await traverse(cx, cy, cz, nextLod);
            }
          }
        }
      } else {
        // Load this brick (with eviction support)
        if (await loadBrickWithEviction(bx, by, bz, lod)) {
          totalLoaded++;
          lodCounts[lod] = (lodCounts[lod] || 0) + 1;
        }
      }
    };

    // Start from coarsest LOD
    const rootLevel = metadata.levels.find(l => l.lod === maxLod);

    if (rootLevel) {
      console.log(`Starting traversal from LOD ${maxLod}...`);
      const [gridX, gridY, gridZ] = rootLevel.bricks as [number, number, number];

      for (let bz = 0; bz < gridZ; bz++) {
        for (let by = 0; by < gridY; by++) {
          for (let bx = 0; bx < gridX; bx++) {
            await traverse(bx, by, bz, maxLod);
          }
        }
      }
    }

    console.log('=== Results ===');
    console.log(`Total loaded: ${totalLoaded} bricks (${totalEvicted} evicted, ${totalSkippedEmpty} empty skipped)`);
    console.log(`Total culled: ${totalCulled} bricks (frustum)`);
    const lodSummary = Object.entries(lodCounts).map(([lod, count]) => `LOD${lod}=${count}`).join(', ');
    console.log(`By LOD: ${lodSummary}`);
    console.log(`Atlas usage: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots}`);
  };

  // Keyboard shortcut for quick testing
  window.addEventListener('keydown', (e) => {
    if (e.key === 't' && !e.ctrlKey && !e.metaKey) {
      (window as any).testLodSelection();
    }
  });

  console.log('\n🎮 Controls available in UI panel (top-right)');
  console.log('Console API: loadLod(), clearLod(), setRenderMode(), setIsoValue()');
  console.log('\n🔄 Streaming:');
  console.log('  startStreaming()         - Enable continuous streaming (auto-loads as you navigate)');
  console.log('  stopStreaming()          - Disable streaming');
  console.log('  streamingStats()         - Print streaming statistics');
  console.log('\n🧪 Manual test helpers:');
  console.log('  testMultiLod()           - Load LOD2, then manually add LOD0 brick');
  console.log('  loadSingleBrick(lod,x,y,z) - Load one brick at specific LOD');
  console.log('  dumpIndirection(z)       - Print indirection table slice');
  console.log('  testLodSelection()       - One-shot coarse-to-fine LOD selection (or press T)');
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
