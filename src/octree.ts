/**
 * Simple Octree for LOD management
 *
 * Each node represents a brick at a specific LOD level.
 * Leaf nodes are rendered, internal nodes are subdivided.
 */

import { AtlasSlot } from './atlas-allocator.js';

export interface OctreeNode {
  // LOD level (0 = finest, 3 = coarsest)
  lod: number;

  // Brick coordinates at this LOD level
  bx: number;
  by: number;
  bz: number;

  // Atlas slot if loaded (null if not loaded)
  slot: AtlasSlot | null;

  // Children (null = leaf node, array of 8 = subdivided)
  children: OctreeNode[] | null;

  // Parent node (null for root)
  parent: OctreeNode | null;
}

export class Octree {
  root: OctreeNode;
  maxLod: number;

  // Callback to load a brick into the atlas
  private loadBrickFn: (lod: number, bx: number, by: number, bz: number) => AtlasSlot | null;

  constructor(
    maxLod: number,
    loadBrickFn: (lod: number, bx: number, by: number, bz: number) => AtlasSlot | null
  ) {
    this.maxLod = maxLod;
    this.loadBrickFn = loadBrickFn;

    // Create root node at coarsest LOD
    this.root = {
      lod: maxLod,
      bx: 0,
      by: 0,
      bz: 0,
      slot: null,
      children: null,
      parent: null,
    };
  }

  /**
   * Load the root node (coarsest LOD)
   */
  loadRoot(): void {
    if (!this.root.slot) {
      this.root.slot = this.loadBrickFn(this.root.lod, this.root.bx, this.root.by, this.root.bz);
      console.log(`Octree: Loaded root at LOD ${this.root.lod}`);
    }
  }

  /**
   * Get all leaf nodes (nodes that are currently rendered)
   */
  getLeaves(): OctreeNode[] {
    const leaves: OctreeNode[] = [];
    this.collectLeaves(this.root, leaves);
    return leaves;
  }

  private collectLeaves(node: OctreeNode, leaves: OctreeNode[]): void {
    if (node.children === null) {
      leaves.push(node);
    } else {
      for (const child of node.children) {
        this.collectLeaves(child, leaves);
      }
    }
  }

  /**
   * Subdivide a leaf node into 8 children
   * Returns the new children, or null if can't subdivide
   */
  subdivide(node: OctreeNode): OctreeNode[] | null {
    // Can't subdivide if already has children
    if (node.children !== null) {
      console.warn('Node already subdivided');
      return null;
    }

    // Can't subdivide LOD 0 (finest level)
    if (node.lod <= 0) {
      console.warn('Cannot subdivide LOD 0');
      return null;
    }

    const childLod = node.lod - 1;
    const children: OctreeNode[] = [];

    // Create 8 children (2x2x2)
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const child: OctreeNode = {
            lod: childLod,
            bx: node.bx * 2 + dx,
            by: node.by * 2 + dy,
            bz: node.bz * 2 + dz,
            slot: null,
            children: null,
            parent: node,
          };

          // Load the brick for this child
          child.slot = this.loadBrickFn(child.lod, child.bx, child.by, child.bz);
          children.push(child);
        }
      }
    }

    node.children = children;
    console.log(`Octree: Subdivided LOD ${node.lod} (${node.bx},${node.by},${node.bz}) into 8 LOD ${childLod} nodes`);

    return children;
  }

  /**
   * Find the leaf node closest to a point in normalized space [-0.5, 0.5]
   */
  findClosestLeaf(point: [number, number, number]): OctreeNode {
    const leaves = this.getLeaves();

    let closest = leaves[0]!;
    let minDist = Infinity;

    for (const leaf of leaves) {
      const center = this.getNodeCenter(leaf);
      const dx = point[0] - center[0];
      const dy = point[1] - center[1];
      const dz = point[2] - center[2];
      const dist = dx * dx + dy * dy + dz * dz;

      if (dist < minDist) {
        minDist = dist;
        closest = leaf;
      }
    }

    return closest;
  }

  /**
   * Get the center of a node in normalized space [-0.5, 0.5]
   */
  getNodeCenter(node: OctreeNode): [number, number, number] {
    // At LOD level, there are 2^(maxLod - lod) bricks per axis
    const bricksPerAxis = Math.pow(2, this.maxLod - node.lod);
    const brickSize = 1.0 / bricksPerAxis;

    return [
      (node.bx + 0.5) * brickSize - 0.5,
      (node.by + 0.5) * brickSize - 0.5,
      (node.bz + 0.5) * brickSize - 0.5,
    ];
  }

  /**
   * Get the size of a node in normalized space
   */
  getNodeSize(node: OctreeNode): number {
    const bricksPerAxis = Math.pow(2, this.maxLod - node.lod);
    return 1.0 / bricksPerAxis;
  }

  /**
   * Refine towards a point: find closest leaf and subdivide it
   */
  refineTowards(point: [number, number, number]): OctreeNode[] | null {
    const closest = this.findClosestLeaf(point);
    return this.subdivide(closest);
  }

  /**
   * Get stats about the octree
   */
  getStats(): { totalNodes: number; loadedNodes: number; leafNodes: number } {
    let totalNodes = 0;
    let loadedNodes = 0;

    const countNodes = (node: OctreeNode) => {
      totalNodes++;
      if (node.slot) loadedNodes++;
      if (node.children) {
        for (const child of node.children) {
          countNodes(child);
        }
      }
    };

    countNodes(this.root);
    const leaves = this.getLeaves();

    return {
      totalNodes,
      loadedNodes,
      leafNodes: leaves.length,
    };
  }

  /**
   * Find a leaf node by LOD and brick coordinates
   * Returns null if not found or if node is not a leaf
   */
  findLeaf(lod: number, bx: number, by: number, bz: number): OctreeNode | null {
    const leaves = this.getLeaves();
    for (const leaf of leaves) {
      if (leaf.lod === lod && leaf.bx === bx && leaf.by === by && leaf.bz === bz) {
        return leaf;
      }
    }
    return null;
  }

  /**
   * Collapse a node: remove children and point indirection back to parent
   * Requires a callback to update indirection entries
   */
  collapse(
    node: OctreeNode,
    updateIndirectionFn: (lod: number, bx: number, by: number, bz: number, slot: AtlasSlot) => void
  ): boolean {
    if (!node.children) {
      console.warn('Node has no children to collapse');
      return false;
    }

    if (!node.slot) {
      console.warn('Parent node has no slot loaded - cannot collapse');
      return false;
    }

    // Update indirection to point back to parent
    updateIndirectionFn(node.lod, node.bx, node.by, node.bz, node.slot);

    // Remove children (but don't free atlas slots - lazy cleanup)
    node.children = null;

    console.log(`Octree: Collapsed LOD ${node.lod} (${node.bx},${node.by},${node.bz})`);
    return true;
  }

  /**
   * Print the octree structure
   */
  print(): void {
    const printNode = (node: OctreeNode, indent: string) => {
      const loaded = node.slot ? '✓' : '○';
      const type = node.children ? '┬' : '─';
      const leaf = node.children ? '' : ' [leaf]';
      console.log(`${indent}${type} LOD${node.lod} (${node.bx},${node.by},${node.bz}) ${loaded}${leaf}`);

      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          const isLast = i === node.children.length - 1;
          const childIndent = indent + (isLast ? '  ' : '│ ');
          printNode(node.children[i]!, childIndent);
        }
      }
    };

    console.log('Octree structure:');
    printNode(this.root, '');

    const stats = this.getStats();
    console.log(`Total: ${stats.leafNodes} leaves, ${stats.loadedNodes} loaded`);
  }
}
