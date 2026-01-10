/**
 * Compress an existing uncompressed dataset
 *
 * Takes an existing packed dataset (with lod*.bin files) and creates
 * a compressed version with gzip-compressed bricks.
 *
 * Usage: npx ts-node scripts/compress-dataset.ts <input-dir> <output-dir>
 *
 * Example:
 *   npx ts-node scripts/compress-dataset.ts public/datasets/stag_beetle public/datasets/stag_beetle_compressed
 */

import * as fs from 'fs';
import * as path from 'path';
import { gzipSync } from 'zlib';

interface LodIndex {
  lod: number;
  brickSize: number;
  physicalSize: number;
  bricks: [number, number, number];
  totalBricks: number;
  totalBytes: number;
  compressed?: boolean;
  entries: Record<string, { offset: number; size: number; min: number; max: number; avg: number }>;
}

interface VolumeMetadata {
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
  packed: boolean;
  compressed?: boolean;
  createdAt: string;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx ts-node scripts/compress-dataset.ts <input-dir> <output-dir>');
    process.exit(1);
  }

  const inputDir = args[0]!;
  const outputDir = args[1]!;

  // Load volume.json
  const volumePath = path.join(inputDir, 'volume.json');
  if (!fs.existsSync(volumePath)) {
    console.error(`Error: ${volumePath} not found`);
    process.exit(1);
  }

  const volume: VolumeMetadata = JSON.parse(fs.readFileSync(volumePath, 'utf-8'));

  if (volume.compressed) {
    console.error('Dataset is already compressed');
    process.exit(1);
  }

  console.log(`Compressing dataset: ${volume.name}`);
  console.log(`  Dimensions: ${volume.originalDimensions.join('x')}`);
  console.log(`  LOD levels: ${volume.maxLod + 1}`);

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const physicalSize = volume.physicalSize;
  const uncompressedBrickBytes = physicalSize ** 3;

  let totalUncompressed = 0;
  let totalCompressed = 0;

  // Process each LOD level
  for (const level of volume.levels) {
    const lod = level.lod;
    console.log(`\nProcessing LOD ${lod}...`);

    // Load index
    const indexPath = path.join(inputDir, level.indexFile);
    const index: LodIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

    // Open input bin file
    const inputBinPath = path.join(inputDir, level.binFile);
    const inputFd = fs.openSync(inputBinPath, 'r');

    // Create output bin file
    const outputBinPath = path.join(outputDir, level.binFile);
    const outputFd = fs.openSync(outputBinPath, 'w');

    // New index with compressed entries
    const newIndex: LodIndex = {
      ...index,
      compressed: true,
      totalBytes: 0,
      entries: {},
    };

    let outputOffset = 0;
    let processed = 0;
    let lodUncompressed = 0;
    let lodCompressed = 0;
    const totalBricks = Object.keys(index.entries).length;

    // Process each brick
    for (const [key, entry] of Object.entries(index.entries)) {
      // Read uncompressed brick
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(inputFd, buffer, 0, entry.size, entry.offset);

      // Compress with gzip level 6
      const compressed = gzipSync(buffer, { level: 6 });
      const compressedSize = compressed.length;

      // Write to output
      fs.writeSync(outputFd, compressed, 0, compressedSize, outputOffset);

      // Update index entry
      newIndex.entries[key] = {
        ...entry,
        offset: outputOffset,
        size: compressedSize,
      };

      outputOffset += compressedSize;
      lodUncompressed += uncompressedBrickBytes;
      lodCompressed += compressedSize;
      processed++;

      if (processed % 100 === 0 || processed === totalBricks) {
        process.stdout.write(`\r  Compressed ${processed}/${totalBricks} bricks`);
      }
    }

    fs.closeSync(inputFd);
    fs.closeSync(outputFd);

    newIndex.totalBytes = outputOffset;

    totalUncompressed += lodUncompressed;
    totalCompressed += lodCompressed;

    const ratio = ((1 - lodCompressed / lodUncompressed) * 100).toFixed(1);

    // Write new index
    const outputIndexPath = path.join(outputDir, level.indexFile);
    fs.writeFileSync(outputIndexPath, JSON.stringify(newIndex, null, 2));

    console.log(`\n  Input:  ${(lodUncompressed / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Output: ${(lodCompressed / 1024 / 1024).toFixed(1)} MB (${ratio}% reduction)`);
  }

  // Write new volume.json
  const newVolume: VolumeMetadata = {
    ...volume,
    name: volume.name + '_compressed',
    compressed: true,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outputDir, 'volume.json'), JSON.stringify(newVolume, null, 2));

  // Print summary
  const totalRatio = ((1 - totalCompressed / totalUncompressed) * 100).toFixed(1);
  console.log(`\n=== Compression Summary ===`);
  console.log(`  Total uncompressed: ${(totalUncompressed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Total compressed:   ${(totalCompressed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Reduction:          ${totalRatio}%`);
  console.log(`\nOutput written to: ${outputDir}`);
}

main();
