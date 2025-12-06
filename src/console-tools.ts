/**
 * Console tools for debugging and testing
 * Exposes functions to window for interactive use in browser console
 */

import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Octree, OctreeNode } from './octree.js';
import { AtlasSlot } from './atlas-allocator.js';
import { generateSphereVolume, generateSolidVolume, writeToCanvas } from './volume.js';
import { BRICK_SIZE, DATASET_SIZE, DATASET_GRID, NORMALIZED_SIZE, ATLAS_SIZE, CONFIG } from './config.js';
import { VisibilityManager } from './visibility-manager.js';

type Pyramid = { [level: string]: Map<string, Uint8Array> };

interface ConsoleToolsContext {
  renderer: Renderer;
  camera: Camera;
  device: GPUDevice;
  octree: Octree;
  pyramid: Pyramid;
  loadedBricks: Map<string, AtlasSlot>;
  visibilityManager: VisibilityManager;
  getAutoUpdate: () => boolean;
  setAutoUpdate: (v: boolean) => void;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

const lodMap: Record<string, number> = {
  'scale0': 0,
  'scale1': 1,
  'scale2': 2,
  'scale3': 3,
};

/**
 * Initialize console tools and expose them to window
 */
export function initConsoleTools(ctx: ConsoleToolsContext): void {
  const { renderer, camera, device, octree, pyramid, loadedBricks, visibilityManager, getAutoUpdate, setAutoUpdate } = ctx;

  // ========== LOD Loading Functions ==========

  /**
   * Load a LOD level into the renderer (additive - doesn't clear existing bricks)
   */
  const loadLevel = (levelName: string) => {
    const levelData = pyramid[levelName];
    const lod = lodMap[levelName];
    if (!levelData || lod === undefined) {
      console.warn(`Unknown level: ${levelName}`);
      return;
    }

    const lodScale = Math.pow(2, lod);
    let loadedCount = 0;

    for (const [brickKey, data] of levelData) {
      const [bz, by, bx] = brickKey.split('/').map(Number);

      const lodKey = `${levelName}:${brickKey}`;
      if (loadedBricks.has(lodKey)) {
        continue;
      }

      const slot = renderer.allocator.allocate();
      if (!slot) {
        console.warn('Atlas full');
        break;
      }

      const offset: [number, number, number] = [
        slot.x * BRICK_SIZE,
        slot.y * BRICK_SIZE,
        slot.z * BRICK_SIZE
      ];
      writeToCanvas(device, renderer.canvas, data, [BRICK_SIZE, BRICK_SIZE, BRICK_SIZE], offset);

      for (let dz = 0; dz < lodScale; dz++) {
        for (let dy = 0; dy < lodScale; dy++) {
          for (let dx = 0; dx < lodScale; dx++) {
            const vx = bx! * lodScale + dx;
            const vy = by! * lodScale + dy;
            const vz = bz! * lodScale + dz;
            if (vx < DATASET_GRID[0]! && vy < DATASET_GRID[1]! && vz < DATASET_GRID[2]!) {
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
   * Load a single brick from a specific LOD level
   */
  const loadBrickAtLod = (lod: number, bx: number, by: number, bz: number): AtlasSlot | null => {
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
      return loadedBricks.get(lodKey)!;
    }

    const slot = renderer.allocator.allocate();
    if (!slot) {
      console.warn('Atlas full');
      return null;
    }

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
    console.log(`Loaded ${lodKey} -> atlas[${slot.x},${slot.y},${slot.z}]`);
    return slot;
  };

  /**
   * Subdivide a brick: replace one LOD brick with 8 children from the next finer LOD
   */
  const subdivide = (lod: number, bx: number, by: number, bz: number) => {
    if (lod <= 0) {
      console.warn('Cannot subdivide LOD 0 - already at finest level');
      return;
    }

    const childLod = lod - 1;
    const childScale = 2;

    console.log(`Subdividing LOD ${lod} brick (${bx},${by},${bz}) into 8 LOD ${childLod} bricks`);

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

  /**
   * Clear all bricks and reset
   */
  const clearAll = () => {
    renderer.clearAllBricks();
    loadedBricks.clear();
    console.log('Cleared all bricks');
  };

  // ========== Octree Functions ==========

  const updateIndirectionForNode = (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => {
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

  /**
   * Split a leaf node into 8 children (refine)
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
   */
  const merge = (lod: number, bx: number, by: number, bz: number) => {
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
    const camPos: [number, number, number] = [
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!
    ];
    octree.refineTowards(camPos);
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  };

  // ========== Render Mode ==========

  const setRenderMode = (mode: 'fragment' | 'compute') => {
    renderer.renderMode = mode;
    console.log(`Render mode set to: ${mode}`);
  };

  const toggleRenderMode = () => {
    renderer.renderMode = renderer.renderMode === 'fragment' ? 'compute' : 'fragment';
    console.log(`Render mode toggled to: ${renderer.renderMode}`);
  };

  // ========== Manual Brick Loading ==========

  const loadBrick = (
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

  const unloadBrick = (virtualX: number, virtualY: number, virtualZ: number) => {
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

  const fillDataset = () => {
    let index = 0;
    for (let z = 0; z < DATASET_GRID[2]!; z++) {
      for (let y = 0; y < DATASET_GRID[1]!; y++) {
        for (let x = 0; x < DATASET_GRID[0]!; x++) {
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

  // ========== Visibility Manager Functions ==========

  const toggleAutoUpdate = () => {
    const newValue = !getAutoUpdate();
    setAutoUpdate(newValue);
    console.log(`Auto visibility update: ${newValue ? 'enabled' : 'disabled'}`);
  };

  const updateVisibility = () => {
    visibilityManager.update([
      camera.position[0]!,
      camera.position[1]!,
      camera.position[2]!
    ]);
    const stats = visibilityManager.lastUpdateStats;
    console.log(`Visibility update: ${stats.nodesVisited} nodes, ${stats.refinements} refinements, ${stats.coarsenings} coarsenings`);
  };

  const showLodDistribution = () => {
    const dist = visibilityManager.getLodDistribution();
    console.log('LOD Distribution:');
    for (let lod = 3; lod >= 0; lod--) {
      const count = dist.get(lod) || 0;
      console.log(`  LOD ${lod}: ${count} nodes`);
    }
    console.log(`Atlas: ${renderer.allocator.usedCount}/${renderer.allocator.totalSlots} slots used`);
  };

  // ========== Expose to Window ==========

  const w = window as any;

  // Core objects
  w.renderer = renderer;
  w.device = device;
  w.camera = camera;
  w.octree = octree;
  w.pyramid = pyramid;
  w.loadedBricks = loadedBricks;
  w.visibilityManager = visibilityManager;

  // LOD functions
  w.loadLevel = loadLevel;
  w.loadBrickAtLod = loadBrickAtLod;
  w.subdivide = subdivide;
  w.clearAll = clearAll;

  // Octree functions
  w.split = split;
  w.merge = merge;
  w.refine = refine;

  // Render mode
  w.setRenderMode = setRenderMode;
  w.toggleRenderMode = toggleRenderMode;

  // Visibility manager
  w.toggleAutoUpdate = toggleAutoUpdate;
  w.updateVisibility = updateVisibility;
  w.showLodDistribution = showLodDistribution;

  // Manual brick loading
  w.loadBrick = loadBrick;
  w.unloadBrick = unloadBrick;
  w.fillDataset = fillDataset;
}

/**
 * Print initialization stats to console
 */
export function printStats(renderer: Renderer, loadedBricks: Map<string, AtlasSlot>): void {
  const atlasSizeMB = ((ATLAS_SIZE ** 3) / (1024 * 1024)).toFixed(1);
  const datasetSizeMB = ((DATASET_SIZE[0]! * DATASET_SIZE[1]! * DATASET_SIZE[2]!) / (1024 * 1024)).toFixed(1);
  const brickSizeKB = ((BRICK_SIZE ** 3) / 1024).toFixed(1);
  const usagePercent = ((renderer.allocator.usedCount / renderer.allocator.totalSlots) * 100).toFixed(1);
  const datasetBricks = DATASET_GRID[0]! * DATASET_GRID[1]! * DATASET_GRID[2]!;

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       Kiln Volume Renderer Initialized                ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║ Dataset:         ${DATASET_SIZE[0]}×${DATASET_SIZE[1]}×${DATASET_SIZE[2]} (${datasetSizeMB} MB)`.padEnd(58) + '║');
  console.log(`║ Dataset Grid:    ${DATASET_GRID[0]}×${DATASET_GRID[1]}×${DATASET_GRID[2]} (${datasetBricks} bricks)`.padEnd(58) + '║');
  console.log(`║ Normalized:      ${NORMALIZED_SIZE[0]!.toFixed(2)}×${NORMALIZED_SIZE[1]!.toFixed(2)}×${NORMALIZED_SIZE[2]!.toFixed(2)}`.padEnd(58) + '║');
  console.log(`║ Atlas Size:      ${ATLAS_SIZE}³ (${atlasSizeMB} MB)`.padEnd(58) + '║');
  console.log(`║ Atlas Grid:      ${CONFIG.GRID_SIZE}×${CONFIG.GRID_SIZE}×${CONFIG.GRID_SIZE} (${CONFIG.TOTAL_BRICK_SLOTS} slots)`.padEnd(58) + '║');
  console.log(`║ Brick Size:      ${BRICK_SIZE}³ (${brickSizeKB} KB)`.padEnd(58) + '║');
  console.log(`║ Bricks Loaded:   ${loadedBricks.size}/${renderer.allocator.totalSlots} (${usagePercent}%)`.padEnd(58) + '║');
  console.log('╚═══════════════════════════════════════════════════════╝');
}
