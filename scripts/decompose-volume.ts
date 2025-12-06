/**
 * Decompose a raw volume file into LOD brick pyramid
 * Uses streaming to handle large files (>2GB)
 *
 * Usage: npx ts-node scripts/decompose-volume.ts <input.vol> <outputDir> [options]
 *
 * Example: npx ts-node scripts/decompose-volume.ts public/volumes/stent_16_512x512x174.raw public/volumes/bricks/stent
 */

import * as fs from 'fs';
import * as path from 'path';

interface Config {
  inputPath: string;
  outputDir: string;
  dimensions: [number, number, number];
  voxelSpacing: [number, number, number];
  headerSize: number;
  brickSize: number;
  maxLod: number;
  bitDepth: 8 | 16;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: npx ts-node scripts/decompose-volume.ts <input.vol> <outputDir> [options]');
    console.error('Options:');
    console.error('  --dimensions WxHxD   Volume dimensions (default: parse from filename)');
    console.error('  --spacing X,Y,Z      Voxel spacing (default: parse from filename or 1,1,1)');
    console.error('  --header N           Header size in bytes (default: 0)');
    console.error('  --brick-size N       Brick size (default: 64)');
    console.error('  --max-lod N          Maximum LOD levels (default: auto)');
    console.error('  --bits N             Bit depth: 8 or 16 (default: parse from filename or 8)');
    process.exit(1);
  }

  const inputPath = args[0]!;
  const outputDir = args[1]!;
  const filename = path.basename(inputPath);

  // Try to parse dimensions from filename (e.g., "name_1952x1817x751.vol")
  let dimensions: [number, number, number] | null = null;
  const dimMatch = filename.match(/(\d+)x(\d+)x(\d+)/);
  if (dimMatch) {
    dimensions = [parseInt(dimMatch[1]!), parseInt(dimMatch[2]!), parseInt(dimMatch[3]!)];
  }

  // Try to parse voxel spacing from filename (e.g., "name_0,83x0,82x3,2.raw")
  // Format uses comma as decimal separator
  let voxelSpacing: [number, number, number] = [1, 1, 1];
  const spacingMatch = filename.match(/(\d+,\d+)x(\d+,\d+)x(\d+,\d+)/);
  if (spacingMatch) {
    voxelSpacing = [
      parseFloat(spacingMatch[1]!.replace(',', '.')),
      parseFloat(spacingMatch[2]!.replace(',', '.')),
      parseFloat(spacingMatch[3]!.replace(',', '.'))
    ];
  }

  // Try to parse bit depth from filename (e.g., "name_16_512x512x174.raw")
  let bitDepth: 8 | 16 = 8;
  if (filename.includes('_16_') || filename.includes('_16.') || filename.includes('16bit')) {
    bitDepth = 16;
  } else if (filename.includes('_8_') || filename.includes('_8.') || filename.includes('8bit')) {
    bitDepth = 8;
  }

  let headerSize = 0;
  let brickSize = 64;
  let maxLod = -1; // Auto

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--dimensions' && args[i + 1]) {
      const parts = args[i + 1]!.split('x').map(Number);
      if (parts.length === 3) {
        dimensions = [parts[0]!, parts[1]!, parts[2]!];
      }
      i++;
    } else if (args[i] === '--spacing' && args[i + 1]) {
      const parts = args[i + 1]!.split(',').map(Number);
      if (parts.length === 3) {
        voxelSpacing = [parts[0]!, parts[1]!, parts[2]!];
      }
      i++;
    } else if (args[i] === '--header' && args[i + 1]) {
      headerSize = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === '--brick-size' && args[i + 1]) {
      brickSize = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === '--max-lod' && args[i + 1]) {
      maxLod = parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === '--bits' && args[i + 1]) {
      const bits = parseInt(args[i + 1]!);
      if (bits === 8 || bits === 16) bitDepth = bits;
      i++;
    }
  }

  if (!dimensions) {
    console.error('Could not determine dimensions. Use --dimensions WxHxD');
    process.exit(1);
  }

  // Calculate max LOD if not specified
  if (maxLod < 0) {
    const minDim = Math.min(...dimensions);
    maxLod = Math.floor(Math.log2(minDim / brickSize));
    maxLod = Math.max(0, Math.min(maxLod, 4)); // Cap at 4 levels
  }

  return { inputPath, outputDir, dimensions, voxelSpacing, headerSize, brickSize, maxLod, bitDepth };
}

/**
 * Find global min/max values in a 16-bit volume
 */
function findGlobalMinMax(
  fd: number,
  headerSize: number,
  dims: [number, number, number]
): { min: number; max: number } {
  const [w, h, d] = dims;
  const sliceSize = w * h;
  const sliceBytes = sliceSize * 2;
  const buffer = Buffer.alloc(sliceBytes);

  let globalMin = 65535;
  let globalMax = 0;

  console.log('  Scanning for global min/max...');
  for (let z = 0; z < d; z++) {
    const offset = headerSize + z * sliceBytes;
    fs.readSync(fd, buffer, 0, sliceBytes, offset);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

    for (let i = 0; i < sliceSize; i++) {
      const val = view.getUint16(i * 2, true);
      if (val < globalMin) globalMin = val;
      if (val > globalMax) globalMax = val;
    }

    if (z % 50 === 0) {
      process.stdout.write(`\r  Scanned ${z + 1}/${d} slices`);
    }
  }
  console.log(`\r  Global range: ${globalMin} - ${globalMax}                `);

  return { min: globalMin, max: globalMax };
}

/**
 * Read a slice of z-planes from the volume file (supports 8 and 16 bit)
 * For 16-bit, uses provided global min/max for consistent normalization
 */
function readZSlice(
  fd: number,
  headerSize: number,
  dims: [number, number, number],
  zStart: number,
  zCount: number,
  bitDepth: 8 | 16,
  globalRange?: { min: number; max: number }
): Uint8Array {
  const [w, h, _d] = dims;
  const sliceSize = w * h;
  const bytesPerVoxel = bitDepth === 16 ? 2 : 1;
  const totalVoxels = sliceSize * zCount;
  const totalBytes = totalVoxels * bytesPerVoxel;
  const buffer = Buffer.alloc(totalBytes);
  const offset = headerSize + zStart * sliceSize * bytesPerVoxel;

  fs.readSync(fd, buffer, 0, totalBytes, offset);

  if (bitDepth === 8) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
  }

  // Convert 16-bit to 8-bit using global min/max
  const result = new Uint8Array(totalVoxels);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);

  const min = globalRange?.min ?? 0;
  const max = globalRange?.max ?? 65535;
  const range = max - min || 1;

  for (let i = 0; i < totalVoxels; i++) {
    const val = view.getUint16(i * 2, true); // little-endian
    // Clamp and normalize to 8-bit
    const normalized = Math.max(0, Math.min(255, Math.round(((val - min) / range) * 255)));
    result[i] = normalized;
  }

  return result;
}

/**
 * Extract a brick from a z-slice buffer
 */
function extractBrickFromSlices(
  sliceData: Uint8Array,
  dims: [number, number, number],
  zOffset: number,
  brickX: number,
  brickY: number,
  brickZ: number,
  brickSize: number
): Uint8Array {
  const brick = new Uint8Array(brickSize * brickSize * brickSize);
  const [w, h, d] = dims;
  const startX = brickX * brickSize;
  const startY = brickY * brickSize;
  const startZ = brickZ * brickSize;
  const sliceSize = w * h;

  for (let z = 0; z < brickSize; z++) {
    const globalZ = startZ + z;
    const localZ = globalZ - zOffset;

    for (let y = 0; y < brickSize; y++) {
      const globalY = startY + y;

      for (let x = 0; x < brickSize; x++) {
        const globalX = startX + x;

        let value = 0;
        if (globalX < w && globalY < h && globalZ < d && localZ >= 0 && localZ * sliceSize < sliceData.length) {
          value = sliceData[globalX + globalY * w + localZ * sliceSize]!;
        }
        brick[x + y * brickSize + z * brickSize * brickSize] = value;
      }
    }
  }

  return brick;
}

/**
 * Optimized downsample that caches input bricks
 */
function downsampleVolumeOptimized(
  inputDir: string,
  inputDims: [number, number, number],
  outputDir: string,
  brickSize: number
): [number, number, number] {
  const [w, h, d] = inputDims;
  const newDims: [number, number, number] = [Math.ceil(w / 2), Math.ceil(h / 2), Math.ceil(d / 2)];
  const [nw, nh, nd] = newDims;

  const inBricksX = Math.ceil(w / brickSize);
  const inBricksY = Math.ceil(h / brickSize);
  const inBricksZ = Math.ceil(d / brickSize);

  const outBricksX = Math.ceil(nw / brickSize);
  const outBricksY = Math.ceil(nh / brickSize);
  const outBricksZ = Math.ceil(nd / brickSize);

  console.log(`  Input bricks: ${inBricksX}x${inBricksY}x${inBricksZ}`);
  console.log(`  Output bricks: ${outBricksX}x${outBricksY}x${outBricksZ}`);

  // Brick cache
  const brickCache = new Map<string, Uint8Array>();

  const loadBrick = (bx: number, by: number, bz: number): Uint8Array | null => {
    const key = `${bx}-${by}-${bz}`;
    if (brickCache.has(key)) {
      return brickCache.get(key)!;
    }
    const brickPath = path.join(inputDir, `brick-${bx}-${by}-${bz}.raw`);
    if (fs.existsSync(brickPath)) {
      const data = new Uint8Array(fs.readFileSync(brickPath));
      brickCache.set(key, data);
      return data;
    }
    return null;
  };

  const sampleInput = (gx: number, gy: number, gz: number): number => {
    if (gx >= w || gy >= h || gz >= d) return 0;
    const bx = Math.floor(gx / brickSize);
    const by = Math.floor(gy / brickSize);
    const bz = Math.floor(gz / brickSize);
    const brick = loadBrick(bx, by, bz);
    if (!brick) return 0;
    const lx = gx % brickSize;
    const ly = gy % brickSize;
    const lz = gz % brickSize;
    return brick[lx + ly * brickSize + lz * brickSize * brickSize]!;
  };

  let savedCount = 0;
  const totalBricks = outBricksX * outBricksY * outBricksZ;

  for (let oz = 0; oz < outBricksZ; oz++) {
    // Clear cache between z-slabs to limit memory usage
    brickCache.clear();

    for (let oy = 0; oy < outBricksY; oy++) {
      for (let ox = 0; ox < outBricksX; ox++) {
        const outputBrick = new Uint8Array(brickSize * brickSize * brickSize);

        for (let z = 0; z < brickSize; z++) {
          for (let y = 0; y < brickSize; y++) {
            for (let x = 0; x < brickSize; x++) {
              const outVoxelX = ox * brickSize + x;
              const outVoxelY = oy * brickSize + y;
              const outVoxelZ = oz * brickSize + z;

              const inVoxelX = outVoxelX * 2;
              const inVoxelY = outVoxelY * 2;
              const inVoxelZ = outVoxelZ * 2;

              // Average 2x2x2 block
              let sum = 0;
              let count = 0;
              for (let dz = 0; dz < 2; dz++) {
                for (let dy = 0; dy < 2; dy++) {
                  for (let dx = 0; dx < 2; dx++) {
                    const v = sampleInput(inVoxelX + dx, inVoxelY + dy, inVoxelZ + dz);
                    sum += v;
                    count++;
                  }
                }
              }

              outputBrick[x + y * brickSize + z * brickSize * brickSize] = Math.round(sum / count);
            }
          }
        }

        const outBrickPath = path.join(outputDir, `brick-${ox}-${oy}-${oz}.raw`);
        fs.writeFileSync(outBrickPath, outputBrick);
        savedCount++;
        process.stdout.write(`\r  Saved ${savedCount}/${totalBricks} bricks`);
      }
    }
  }
  console.log('');

  return newDims;
}

function decompose(config: Config): void {
  const { inputPath, outputDir, dimensions, voxelSpacing, headerSize, brickSize, maxLod, bitDepth } = config;

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  const [w, h, d] = dimensions;
  console.log(`\nVolume size: ${w}x${h}x${d}`);
  console.log(`Voxel spacing: ${voxelSpacing.join(' x ')}`);
  console.log(`Bit depth: ${bitDepth}`);

  const lodInfo: Array<{
    lod: number;
    dimensions: [number, number, number];
    bricks: [number, number, number];
    brickCount: number;
  }> = [];

  // Open file for reading
  const fd = fs.openSync(inputPath, 'r');

  // For 16-bit data, find global min/max first for consistent normalization
  let globalRange: { min: number; max: number } | undefined;
  if (bitDepth === 16) {
    globalRange = findGlobalMinMax(fd, headerSize, dimensions);
  }

  // Process LOD 0 (full resolution) - read directly from volume file
  console.log(`\nProcessing LOD 0 (full resolution)...`);
  const lod0Dir = path.join(outputDir, 'lod0');
  fs.mkdirSync(lod0Dir, { recursive: true });

  const bricksX = Math.ceil(w / brickSize);
  const bricksY = Math.ceil(h / brickSize);
  const bricksZ = Math.ceil(d / brickSize);
  const totalBricks = bricksX * bricksY * bricksZ;

  console.log(`  Bricks: ${bricksX}x${bricksY}x${bricksZ} = ${totalBricks}`);

  lodInfo.push({
    lod: 0,
    dimensions: [...dimensions] as [number, number, number],
    bricks: [bricksX, bricksY, bricksZ],
    brickCount: totalBricks,
  });

  // Process bricks z-slab by z-slab to limit memory usage
  let savedCount = 0;
  for (let bz = 0; bz < bricksZ; bz++) {
    // Read z-slices for this brick z-level
    const zStart = bz * brickSize;
    const zCount = Math.min(brickSize, d - zStart);
    const sliceData = readZSlice(fd, headerSize, dimensions, zStart, zCount, bitDepth, globalRange);

    for (let by = 0; by < bricksY; by++) {
      for (let bx = 0; bx < bricksX; bx++) {
        const brick = extractBrickFromSlices(sliceData, dimensions, zStart, bx, by, bz, brickSize);
        const brickPath = path.join(lod0Dir, `brick-${bx}-${by}-${bz}.raw`);
        fs.writeFileSync(brickPath, brick);
        savedCount++;
      }
    }
    process.stdout.write(`\r  Saved ${savedCount}/${totalBricks} bricks`);
  }
  console.log('');

  fs.closeSync(fd);

  // Process higher LOD levels by downsampling previous level
  let currentDims = dimensions;
  let prevLodDir = lod0Dir;

  for (let lod = 1; lod <= maxLod; lod++) {
    console.log(`\nProcessing LOD ${lod}...`);

    const lodDir = path.join(outputDir, `lod${lod}`);
    fs.mkdirSync(lodDir, { recursive: true });

    const newDims = downsampleVolumeOptimized(prevLodDir, currentDims, lodDir, brickSize);

    const newBricksX = Math.ceil(newDims[0] / brickSize);
    const newBricksY = Math.ceil(newDims[1] / brickSize);
    const newBricksZ = Math.ceil(newDims[2] / brickSize);

    lodInfo.push({
      lod,
      dimensions: newDims,
      bricks: [newBricksX, newBricksY, newBricksZ],
      brickCount: newBricksX * newBricksY * newBricksZ,
    });

    currentDims = newDims;
    prevLodDir = lodDir;
  }

  // Write metadata
  const metadata = {
    name: path.basename(outputDir),
    originalDimensions: dimensions,
    voxelSpacing,
    brickSize,
    maxLod,
    levels: lodInfo,
    format: 'uint8',
    inputFormat: bitDepth === 16 ? 'uint16' : 'uint8',
    createdAt: new Date().toISOString(),
  };

  const metadataPath = path.join(outputDir, 'brick.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`\nMetadata written to ${metadataPath}`);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Output directory: ${outputDir}`);
  console.log(`LOD levels: ${maxLod + 1}`);
  let totalFiles = 0;
  let totalSize = 0;
  for (const info of lodInfo) {
    console.log(`  LOD ${info.lod}: ${info.dimensions.join('x')} -> ${info.bricks.join('x')} bricks (${info.brickCount})`);
    totalFiles += info.brickCount;
    totalSize += info.brickCount * brickSize * brickSize * brickSize;
  }
  console.log(`Total bricks: ${totalFiles}`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

// Main
const config = parseArgs();
console.log('Configuration:');
console.log(`  Input: ${config.inputPath}`);
console.log(`  Output: ${config.outputDir}`);
console.log(`  Dimensions: ${config.dimensions.join('x')}`);
console.log(`  Voxel spacing: ${config.voxelSpacing.join(', ')}`);
console.log(`  Header size: ${config.headerSize}`);
console.log(`  Brick size: ${config.brickSize}`);
console.log(`  Max LOD: ${config.maxLod}`);
console.log(`  Bit depth: ${config.bitDepth}`);

decompose(config);
