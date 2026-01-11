/**
 * Convert a raw volume file into binary sharded streaming format
 *
 * Decomposes the volume into a multi-LOD brick pyramid and packs into
 * binary sharded format (volume.json + lodN.bin + lodN_index.json).
 *
 * Usage: npx ts-node scripts/decompose-volume.ts <input.raw> <output-dir> [options]
 *   OR:  npx ts-node scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]
 *        (output dir defaults to public/datasets/<input-name>/)
 *
 * Examples:
 *   npx ts-node scripts/decompose-volume.ts data.raw public/datasets/mydata
 *   npx ts-node scripts/decompose-volume.ts data.raw 832 832 494 --bits 16
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
    console.error('Usage: npx ts-node scripts/decompose-volume.ts <input.raw> <output-dir> [options]');
    console.error('   OR: npx ts-node scripts/decompose-volume.ts <input.raw> <W> <H> <D> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --output DIR         Output directory (default: public/datasets/<name>)');
    console.error('  --dimensions WxHxD   Volume dimensions (default: parse from filename)');
    console.error('  --spacing X,Y,Z      Voxel spacing (default: 1,1,1)');
    console.error('  --header N           Header size in bytes (default: 0)');
    console.error('  --brick-size N       Brick size (default: 64)');
    console.error('  --max-lod N          Maximum LOD levels (default: auto)');
    console.error('  --bits N             Bit depth: 8 or 16 (default: 8)');
    process.exit(1);
  }

  const inputPath = args[0]!;
  const filename = path.basename(inputPath);
  const inputName = filename.replace(/\.[^.]+$/, '').replace(/_\d+x\d+x\d+.*$/, '').replace(/_uint\d+$/, '');

  // Check if args[1-3] are dimensions (all numeric) or if args[1] is output dir
  let outputDir: string;
  let dimensions: [number, number, number] | null = null;
  let argOffset = 2; // Where to start parsing options

  if (args.length >= 4 &&
      !isNaN(Number(args[1])) &&
      !isNaN(Number(args[2])) &&
      !isNaN(Number(args[3]))) {
    // Dimensions provided as positional args: <input> <W> <H> <D>
    dimensions = [parseInt(args[1]!), parseInt(args[2]!), parseInt(args[3]!)];
    outputDir = `public/datasets/${inputName}`;
    argOffset = 4;
  } else {
    // Output dir provided: <input> <output-dir>
    outputDir = args[1]!;
  }

  // Try to parse dimensions from filename if not already set (e.g., "name_1952x1817x751.vol")
  if (!dimensions) {
    const dimMatch = filename.match(/(\d+)x(\d+)x(\d+)/);
    if (dimMatch) {
      dimensions = [parseInt(dimMatch[1]!), parseInt(dimMatch[2]!), parseInt(dimMatch[3]!)];
    }
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
  if (filename.includes('_16_') || filename.includes('_16.') || filename.includes('16bit') || filename.includes('uint16')) {
    bitDepth = 16;
  } else if (filename.includes('_8_') || filename.includes('_8.') || filename.includes('8bit') || filename.includes('uint8')) {
    bitDepth = 8;
  }

  let headerSize = 0;
  let brickSize = 64;
  let maxLod = -1; // Auto

  for (let i = argOffset; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1]!;
      i++;
    } else if (args[i] === '--dimensions' && args[i + 1]) {
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
 * Extract a brick from a z-slice buffer with proper border handling
 * @param sliceData - The slice data buffer
 * @param dims - Volume dimensions [w, h, d]
 * @param zBufferStart - The actual start z of the slice buffer (clamped to 0)
 * @param zRequestedStart - The requested start z (may be -1 for first brick)
 * @param brickX, brickY, brickZ - Brick coordinates
 * @param brickSize - Logical brick size (64)
 */
function extractBrickFromSlicesWithBorder(
  sliceData: Uint8Array,
  dims: [number, number, number],
  zBufferStart: number,
  zRequestedStart: number,
  brickX: number,
  brickY: number,
  brickZ: number,
  brickSize: number
): Uint8Array {
  const physicalSize = brickSize + 2; // 66
  const brick = new Uint8Array(physicalSize ** 3);
  const [w, h, d] = dims;

  // Logical start in the volume
  const startX = brickX * brickSize;
  const startY = brickY * brickSize;
  const startZ = brickZ * brickSize;

  for (let lz = 0; lz < physicalSize; lz++) {
    // Map local 0..65 to global -1..64 relative to brick start
    const globalZ = startZ + lz - 1;
    for (let ly = 0; ly < physicalSize; ly++) {
      const globalY = startY + ly - 1;
      for (let lx = 0; lx < physicalSize; lx++) {
        const globalX = startX + lx - 1;

        // Clamp to volume edges for border voxels
        const cx = Math.max(0, Math.min(w - 1, globalX));
        const cy = Math.max(0, Math.min(h - 1, globalY));
        const cz = Math.max(0, Math.min(d - 1, globalZ));

        // localZ is relative to the buffer start, not the requested start
        const localZ = cz - zBufferStart;
        const sliceSize = w * h;
        brick[lx + ly * physicalSize + lz * physicalSize * physicalSize] =
          sliceData[cx + cy * w + localZ * sliceSize]!;
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

  const physicalSize = brickSize + 2;
  const sampleInput = (gx: number, gy: number, gz: number): number => {
    if (gx >= w || gy >= h || gz >= d) return 0;
    const bx = Math.floor(gx / brickSize);
    const by = Math.floor(gy / brickSize);
    const bz = Math.floor(gz / brickSize);
    const brick = loadBrick(bx, by, bz);
    if (!brick) return 0;
    // +1 to skip border
    const lx = (gx % brickSize) + 1;
    const ly = (gy % brickSize) + 1;
    const lz = (gz % brickSize) + 1;
    return brick[lx + ly * physicalSize + lz * physicalSize * physicalSize]!;
  };

  let savedCount = 0;
  const totalBricks = outBricksX * outBricksY * outBricksZ;

  const outPhysicalSize = brickSize + 2;

  for (let oz = 0; oz < outBricksZ; oz++) {
    // Clear cache between z-slabs to limit memory usage
    brickCache.clear();

    for (let oy = 0; oy < outBricksY; oy++) {
      for (let ox = 0; ox < outBricksX; ox++) {
        const outputBrick = new Uint8Array(outPhysicalSize ** 3);

        // Output physical brick includes 1-voxel border on each side
        for (let lz = 0; lz < outPhysicalSize; lz++) {
          for (let ly = 0; ly < outPhysicalSize; ly++) {
            for (let lx = 0; lx < outPhysicalSize; lx++) {
              // Map local 0..65 to global -1..64 relative to brick start
              const outVoxelX = ox * brickSize + (lx - 1);
              const outVoxelY = oy * brickSize + (ly - 1);
              const outVoxelZ = oz * brickSize + (lz - 1);

              const inVoxelX = outVoxelX * 2;
              const inVoxelY = outVoxelY * 2;
              const inVoxelZ = outVoxelZ * 2;

              // Average 2x2x2 block (sampleInput clamps out-of-bounds)
              let sum = 0;
              for (let dz = 0; dz < 2; dz++) {
                for (let dy = 0; dy < 2; dy++) {
                  for (let dx = 0; dx < 2; dx++) {
                    sum += sampleInput(
                      Math.max(0, Math.min(w - 1, inVoxelX + dx)),
                      Math.max(0, Math.min(h - 1, inVoxelY + dy)),
                      Math.max(0, Math.min(d - 1, inVoxelZ + dz))
                    );
                  }
                }
              }

              outputBrick[lx + ly * outPhysicalSize + lz * outPhysicalSize * outPhysicalSize] = Math.round(sum / 8);
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

function decompose(config: Config): { outputDir: string; lodInfo: { lod: number; dimensions: [number, number, number]; bricks: [number, number, number]; brickCount: number }[]; brickSize: number } {
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
  // Need to read extra slices for border (1 before, 1 after = physicalSize total)
  const physicalSize = brickSize + 2; // 66 for border
  let savedCount = 0;
  for (let bz = 0; bz < bricksZ; bz++) {
    // Read z-slices for this brick z-level, including border slices
    // We need slices from (bz * brickSize - 1) to (bz * brickSize + brickSize)
    const zStartRaw = bz * brickSize - 1;
    const zStart = Math.max(0, zStartRaw);
    const zEndRaw = bz * brickSize + brickSize + 1; // +1 for the far border
    const zEnd = Math.min(d, zEndRaw);
    const zCount = zEnd - zStart;
    const sliceData = readZSlice(fd, headerSize, dimensions, zStart, zCount, bitDepth, globalRange);

    for (let by = 0; by < bricksY; by++) {
      for (let bx = 0; bx < bricksX; bx++) {
        const brick = extractBrickFromSlicesWithBorder(sliceData, dimensions, zStart, zStartRaw, bx, by, bz, brickSize);
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

  // Return output dir and lodInfo for pack step
  return { outputDir, lodInfo, brickSize };
}

/**
 * Pack brick files into binary sharded format
 */
function packVolume(outputDir: string, lodInfo: { lod: number; bricks: [number, number, number] }[], brickSize: number): void {
  const physicalSize = brickSize + 2;
  const brickBytes = physicalSize ** 3;

  console.log('\n=== Packing into binary sharded format ===');

  for (const level of lodInfo) {
    const lod = level.lod;
    const [nx, ny, nz] = level.bricks;
    const totalBricks = nx * ny * nz;

    console.log(`\nPacking LOD ${lod}: ${nx}x${ny}x${nz} = ${totalBricks} bricks`);

    const lodInputDir = path.join(outputDir, `lod${lod}`);
    const binPath = path.join(outputDir, `lod${lod}.bin`);
    const indexPath = path.join(outputDir, `lod${lod}_index.json`);

    const fd = fs.openSync(binPath, 'w');

    const index = {
      lod,
      brickSize,
      physicalSize,
      bricks: level.bricks,
      totalBricks,
      totalBytes: 0,
      entries: {} as Record<string, { offset: number; size: number; min: number; max: number; avg: number }>,
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

          // Calculate stats for the 64³ logical core
          const logicalSize = physicalSize - 2;
          let min = 255, max = 0, sum = 0, count = 0;
          for (let lz = 1; lz <= logicalSize; lz++) {
            for (let ly = 1; ly <= logicalSize; ly++) {
              for (let lx = 1; lx <= logicalSize; lx++) {
                const idx = lx + ly * physicalSize + lz * physicalSize * physicalSize;
                const val = data[idx]!;
                if (val < min) min = val;
                if (val > max) max = val;
                sum += val;
                count++;
              }
            }
          }
          const avg = Math.round(sum / count);

          // Write to bin file
          fs.writeSync(fd, data, 0, data.length, offset);

          // Record in index
          index.entries[`${x}/${y}/${z}`] = { offset, size: brickBytes, min, max, avg };

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

    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`\n  Output: ${binPath} (${(offset / 1024 / 1024).toFixed(1)} MB)`);

    // Remove individual brick files
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const brickPath = path.join(lodInputDir, `brick-${x}-${y}-${z}.raw`);
          if (fs.existsSync(brickPath)) {
            fs.unlinkSync(brickPath);
          }
        }
      }
    }
    fs.rmdirSync(lodInputDir);
  }

  // Remove brick.json and write volume.json
  const brickJsonPath = path.join(outputDir, 'brick.json');
  const brickJson = JSON.parse(fs.readFileSync(brickJsonPath, 'utf-8'));

  const volumeJson = {
    name: brickJson.name,
    originalDimensions: brickJson.originalDimensions,
    voxelSpacing: brickJson.voxelSpacing || [1, 1, 1],
    brickSize: brickJson.brickSize,
    physicalSize,
    maxLod: brickJson.maxLod,
    levels: brickJson.levels.map((l: { lod: number; dimensions: number[]; bricks: number[]; brickCount: number }) => ({
      lod: l.lod,
      dimensions: l.dimensions,
      bricks: l.bricks,
      brickCount: l.brickCount,
      binFile: `lod${l.lod}.bin`,
      indexFile: `lod${l.lod}_index.json`,
    })),
    format: brickJson.format,
    packed: true,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outputDir, 'volume.json'), JSON.stringify(volumeJson, null, 2));
  fs.unlinkSync(brickJsonPath);

  console.log('\nPacking complete. Individual brick files removed.');
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

const result = decompose(config);
packVolume(result.outputDir, result.lodInfo, result.brickSize);
