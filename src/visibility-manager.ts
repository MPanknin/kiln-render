/**
 * VisibilityManager - LOD selection based on camera distance
 *
 * Traverses the octree and refines/coarsens nodes based on distance to camera.
 * Simple center-distance metric, no async loading, processes all changes immediately.
 */

import { Octree, OctreeNode } from './octree.js';
import { AtlasSlot } from './atlas-allocator.js';
import { getNormalizedSize } from './config.js';

export interface VisibilityConfig {
  // Distance thresholds for each LOD transition (in normalized space)
  // lodThresholds[i] = distance at which LOD (maxLod - i) should refine to (maxLod - i - 1)
  // e.g., for maxLod=3: [0.8, 0.5, 0.3] means:
  //   - LOD 3 refines to LOD 2 when distance < 0.8
  //   - LOD 2 refines to LOD 1 when distance < 0.5
  //   - LOD 1 refines to LOD 0 when distance < 0.3
  lodThresholds: number[];
}

// Callback type for updating indirection when collapsing
type IndirectionUpdateFn = (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => void;

export class VisibilityManager {
  private octree: Octree;
  private config: VisibilityConfig;
  private onIndirectionUpdate: IndirectionUpdateFn;

  // Stats for debugging
  lastUpdateStats = {
    nodesVisited: 0,
    refinements: 0,
    coarsenings: 0,
  };

  constructor(
    octree: Octree,
    config: VisibilityConfig,
    onIndirectionUpdate: IndirectionUpdateFn
  ) {
    this.octree = octree;
    this.config = config;
    this.onIndirectionUpdate = onIndirectionUpdate;
  }

  /**
   * Update visibility based on camera position
   * Traverses octree and refines/coarsens as needed
   */
  update(cameraPos: [number, number, number]): void {
    this.lastUpdateStats = { nodesVisited: 0, refinements: 0, coarsenings: 0 };
    // Traverse all roots (supports multi-root octrees)
    for (const root of this.octree.roots) {
      this.updateNode(root, cameraPos);
    }
  }

  private updateNode(node: OctreeNode, cameraPos: [number, number, number]): void {
    this.lastUpdateStats.nodesVisited++;

    const distance = this.distanceToNode(node, cameraPos);
    const desiredLod = this.lodForDistance(distance);

    if (node.children) {
      // Internal node - check if we should collapse
      if (desiredLod >= node.lod) {
        // Camera is far enough, collapse children back to this node's LOD
        this.octree.collapse(node, this.onIndirectionUpdate);
        this.lastUpdateStats.coarsenings++;
      } else {
        // Keep children, recurse
        for (const child of node.children) {
          this.updateNode(child, cameraPos);
        }
      }
    } else {
      // Leaf node - check if we should refine
      if (desiredLod < node.lod && node.lod > 0) {
        // Camera is close enough, need finer LOD
        this.octree.subdivide(node);
        this.lastUpdateStats.refinements++;

        // Recurse into new children
        if (node.children) {
          for (const child of node.children) {
            this.updateNode(child, cameraPos);
          }
        }
      }
      // else: leaf at correct or finest LOD, nothing to do
    }
  }

  /**
   * Compute distance from camera to node center (in normalized space)
   */
  private distanceToNode(node: OctreeNode, cameraPos: [number, number, number]): number {
    const center = this.getNodeCenter(node);
    const dx = cameraPos[0] - center[0];
    const dy = cameraPos[1] - center[1];
    const dz = cameraPos[2] - center[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get the center of a node in normalized space
   */
  private getNodeCenter(node: OctreeNode): [number, number, number] {
    // Each LOD level covers a different extent
    // LOD 3: 1 brick covers entire volume
    // LOD 2: 1 brick covers 1/8 of volume (2x2x2 grid)
    // LOD 1: 1 brick covers 1/64 of volume (4x4x4 grid)
    // LOD 0: 1 brick covers 1/512 of volume (8x8x8 grid)

    const normalizedSize = getNormalizedSize();
    const bricksPerAxis = Math.pow(2, this.octree.maxLod - node.lod);

    // Size of one brick at this LOD in normalized space
    const brickSizeNorm: [number, number, number] = [
      normalizedSize[0] / bricksPerAxis,
      normalizedSize[1] / bricksPerAxis,
      normalizedSize[2] / bricksPerAxis,
    ];

    // Center of this brick (volume is centered at origin)
    const halfSize: [number, number, number] = [
      normalizedSize[0] * 0.5,
      normalizedSize[1] * 0.5,
      normalizedSize[2] * 0.5,
    ];

    return [
      -halfSize[0] + (node.bx + 0.5) * brickSizeNorm[0],
      -halfSize[1] + (node.by + 0.5) * brickSizeNorm[1],
      -halfSize[2] + (node.bz + 0.5) * brickSizeNorm[2],
    ];
  }

  /**
   * Determine desired LOD for a given distance
   * Returns the LOD level (0 = finest, maxLod = coarsest)
   */
  private lodForDistance(distance: number): number {
    const thresholds = this.config.lodThresholds;

    // Check thresholds from coarsest to finest
    for (let i = 0; i < thresholds.length; i++) {
      if (distance >= thresholds[i]!) {
        // Distance is beyond this threshold, use coarser LOD
        return this.octree.maxLod - i;
      }
    }

    // Distance is less than all thresholds, use finest LOD
    return 0;
  }

  /**
   * Get current LOD distribution for debugging
   */
  getLodDistribution(): Map<number, number> {
    const distribution = new Map<number, number>();
    for (const root of this.octree.roots) {
      this.countLods(root, distribution);
    }
    return distribution;
  }

  private countLods(node: OctreeNode, distribution: Map<number, number>): void {
    if (node.children) {
      for (const child of node.children) {
        this.countLods(child, distribution);
      }
    } else {
      const count = distribution.get(node.lod) || 0;
      distribution.set(node.lod, count + 1);
    }
  }
}
