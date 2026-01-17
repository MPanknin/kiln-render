/**
 * Pack Volume - Converts individual brick files into a binary sharded format
 *
 * Usage: npx ts-node scripts/pack-volume.ts <input-dir> [--output <output-dir>]
 *
 * Input: Directory with brick.json and lod0/, lod1/, etc. folders containing brick-X-Y-Z.raw files
 * Output: Creates lodN.bin and lodN_index.json for each LOD level
 *
 * The index contains byte offsets and per-brick statistics (min, max, avg density)
 * for efficient streaming and empty-space skipping.
 */

import * as fs from 'fs';
import * as path from 'path';

interface BrickMetadata {
  name: string;
  originalDimensions: [number, number, number];
  voxelSpacing?: [number, number, number];
  brickSize: number;
  maxLod: number;
  levels: {
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
  }[];
  format: string;
  createdAt: string;
}

interface BrickStats {
  offset: number;
  size: number;
  min: number;
  max: number;
  avg: number;
}

interface LodIndex {
  lod: number;
  brickSize: number;
  physicalSize: number;
  bricks: [number, number, number];
  totalBricks: number;
  totalBytes: number;
  entries: Record<string, BrickStats>;
}

interface PackedMetadata {
  name: string;
  originalDimensions: [number, number, number];
  voxelSpacing: [number, number, number];
  brickSize: number;
  physicalSize: number;
  maxLod: number;
  levels: {
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
    binFile: string;
    indexFile: string;
  }[];
  format: string;
  packed: true;
  createdAt: string;
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: npx ts-node scripts/pack-volume.ts <input-dir> [--output <output-dir>]');
    console.error('');
    console.error('Example: npx ts-node scripts/pack-volume.ts public/datasets/stagbeetle');
    process.exit(1);
  }

  const inputDir = args[0]!;
  let outputDir = inputDir; // Default: pack in place

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1]!;
      i++;
    }
  }

  return { inputDir, outputDir };
}

/**
 * Calculate min, max, and average for the logical 64³ core of a brick
 * The brick is 66³ with 1-voxel border on each side
 */
function calculateBrickStats(data: Uint8Array, physicalSize: number): { min: number; max: number; avg: number } {
  const logicalSize = physicalSize - 2; // 64 for physicalSize=66
  let min = 255;
  let max = 0;
  let sum = 0;
  let count = 0;

  // Only process the 64³ logical core (skip border voxels)
  for (let z = 1; z <= logicalSize; z++) {
    for (let y = 1; y <= logicalSize; y++) {
      for (let x = 1; x <= logicalSize; x++) {
        const idx = x + y * physicalSize + z * physicalSize * physicalSize;
        const val = data[idx]!;
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
        count++;
      }
    }
  }

  const avg = Math.round(sum / count);
  return { min, max, avg };
}

/**
 * Pack a single LOD level into a .bin file with an index
 */
function packLodLevel(
  inputDir: string,
  outputDir: string,
  lod: number,
  bricks: [number, number, number],
  brickSize: number
): LodIndex {
  const physicalSize = brickSize + 2; // 66 for brickSize=64
  const brickBytes = physicalSize ** 3;
  const [nx, ny, nz] = bricks;
  const totalBricks = nx * ny * nz;

  console.log(`\nPacking LOD ${lod}: ${nx}x${ny}x${nz} = ${totalBricks} bricks`);

  const lodInputDir = path.join(inputDir, `lod${lod}`);
  const binPath = path.join(outputDir, `lod${lod}.bin`);
  const indexPath = path.join(outputDir, `lod${lod}_index.json`);

  // Open output file for writing
  const fd = fs.openSync(binPath, 'w');

  const index: LodIndex = {
    lod,
    brickSize,
    physicalSize,
    bricks,
    totalBricks,
    totalBytes: 0,
    entries: {},
  };

  let offset = 0;
  let processed = 0;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const brickPath = path.join(lodInputDir, `brick-${x}-${y}-${z}.raw`);

        if (!fs.existsSync(brickPath)) {
          console.warn(`  Warning: Missing brick ${x}-${y}-${z}`);
          continue;
        }

        const data = new Uint8Array(fs.readFileSync(brickPath));

        if (data.length !== brickBytes) {
          console.warn(`  Warning: Brick ${x}-${y}-${z} has wrong size: ${data.length} vs expected ${brickBytes}`);
          continue;
        }

        // Calculate stats for this brick
        const stats = calculateBrickStats(data, physicalSize);

        // Write to bin file
        fs.writeSync(fd, data, 0, data.length, offset);

        // Record in index
        const key = `${x}/${y}/${z}`;
        index.entries[key] = {
          offset,
          size: brickBytes,
          min: stats.min,
          max: stats.max,
          avg: stats.avg,
        };

        offset += brickBytes;
        processed++;

        if (processed % 100 === 0 || processed === totalBricks) {
          process.stdout.write(`\r  Packed ${processed}/${totalBricks} bricks`);
        }
      }
    }
  }

  fs.closeSync(fd);

  index.totalBytes = offset;

  // Write index
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  console.log(`\n  Output: ${binPath} (${(offset / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  Index: ${indexPath}`);

  return index;
}

function pack(inputDir: string, outputDir: string) {
  // Read existing metadata
  const metadataPath = path.join(inputDir, 'brick.json');
  if (!fs.existsSync(metadataPath)) {
    console.error(`Error: brick.json not found in ${inputDir}`);
    process.exit(1);
  }

  const metadata: BrickMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

  console.log(`Packing volume: ${metadata.name}`);
  console.log(`  Original dimensions: ${metadata.originalDimensions.join('x')}`);
  console.log(`  Brick size: ${metadata.brickSize}`);
  console.log(`  LOD levels: ${metadata.maxLod + 1}`);

  // Create output directory if different from input
  if (outputDir !== inputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const physicalSize = metadata.brickSize + 2;

  // Pack each LOD level
  const packedLevels: PackedMetadata['levels'] = [];

  for (const level of metadata.levels) {
    const index = packLodLevel(
      inputDir,
      outputDir,
      level.lod,
      level.bricks,
      metadata.brickSize
    );

    packedLevels.push({
      lod: level.lod,
      dimensions: level.dimensions,
      bricks: level.bricks,
      brickCount: level.brickCount,
      binFile: `lod${level.lod}.bin`,
      indexFile: `lod${level.lod}_index.json`,
    });
  }

  // Write new packed metadata
  const packedMetadata: PackedMetadata = {
    name: metadata.name,
    originalDimensions: metadata.originalDimensions,
    voxelSpacing: metadata.voxelSpacing || [1, 1, 1],
    brickSize: metadata.brickSize,
    physicalSize,
    maxLod: metadata.maxLod,
    levels: packedLevels,
    format: metadata.format,
    packed: true,
    createdAt: new Date().toISOString(),
  };

  const packedMetadataPath = path.join(outputDir, 'volume.json');
  fs.writeFileSync(packedMetadataPath, JSON.stringify(packedMetadata, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Packed metadata: ${packedMetadataPath}`);

  let totalSize = 0;
  for (const level of packedLevels) {
    const binPath = path.join(outputDir, level.binFile);
    const stat = fs.statSync(binPath);
    totalSize += stat.size;
    console.log(`  LOD ${level.lod}: ${level.binFile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`Total packed size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

// Main
const { inputDir, outputDir } = parseArgs();
console.log(`Input: ${inputDir}`);
console.log(`Output: ${outputDir}`);
pack(inputDir, outputDir);
