/**
 * Kiln - Brick-based WebGPU Volume Renderer
 * Clean, minimal volume renderer using proxy box geometry and virtual texturing
 */

import { Renderer, VolumeRenderMode } from './core/renderer.js';
import { Camera, UpAxis, extractFrustumPlanes, isAABBInFrustum, multiplyMatrices } from './core/camera.js';
import { writeToCanvas } from './core/volume.js';
import { PHYSICAL_BRICK_SIZE, setDatasetSize, getNormalizedSize } from './core/config.js';
import { AtlasSlot } from './streaming/atlas-allocator.js';
import { BrickLoader } from './streaming/brick-loader.js';
import { TransferFunction } from './core/transfer-function.js';
import { VolumeUI } from './ui/volume-ui.js';
import { StreamingManager } from './streaming/streaming-manager.js';

// Volume source configuration
// const VOLUME_SOURCE = '/volumes/bricks/stagbeetle';
// const VOLUME_SOURCE = '/datasets/chameleon';
// const VOLUME_SOURCE = 'https://kiln-samples.s3.eu-central-1.amazonaws.com/stagbeetle-binary';
const VOLUME_SOURCE = 'https://kiln-samples.s3.eu-central-1.amazonaws.com/chameleon-binary';

// Capture page load start time for time-to-first-render metric
const PAGE_LOAD_START = performance.now();

async function main() {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
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

  // Create streaming manager (pass page load start time for accurate time-to-first-render)
  const streamingManager = new StreamingManager(renderer, brickLoader, metadata, device, PAGE_LOAD_START);

  // Streaming mode toggle - enabled by default
  let streamingEnabled = true;

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

  // Create UI
  const ui = new VolumeUI(renderer, camera, transferFunction);
  ui.setStreamingManager(streamingManager, metadata);

  // Render loop
  function frame() {
    frameCount++;

    // Record frame timing for stats
    ui.recordFrame();

    // Update streaming manager if enabled
    if (streamingEnabled) {
      streamingManager.update(camera, canvas!);
    }

    const view = context.getCurrentTexture().createView();
    renderer.render(view, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Streaming control functions
  function startStreaming(): void {
    if (streamingEnabled) {
      console.log('Streaming already enabled');
      return;
    }
    streamingEnabled = true;
    streamingManager.forceUpdate(camera, canvas!);
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
    console.log(`  Cancelled: ${stats.cancelledCount} bricks (stale)`);
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

  // Keyboard shortcut for quick testing
  window.addEventListener('keydown', (e) => {
    if (e.key === 't' && !e.ctrlKey && !e.metaKey) {
      streamingStats();
    }
  });

  console.log('\n🎮 Controls available in UI panel (top-right)');
  console.log('Console API: loadLod(), clearLod(), setRenderMode(), setIsoValue()');
  console.log('\n🔄 Streaming:');
  console.log('  startStreaming()         - Enable continuous streaming (auto-loads as you navigate)');
  console.log('  stopStreaming()          - Disable streaming');
  console.log('  streamingStats()         - Print streaming statistics (or press T)');
  console.log('\n🧪 Manual test helpers:');
  console.log('  testMultiLod()           - Load LOD2, then manually add LOD0 brick');
  console.log('  loadSingleBrick(lod,x,y,z) - Load one brick at specific LOD');
  console.log('  dumpIndirection(z)       - Print indirection table slice');
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
