interface MockPyramid {
  [level: string]: Map<string, Uint8Array>;
}

/**
 * Generates a mock Zarr-like pyramid for testing.
 * @param sx, sy, sz - The total physical dimensions in voxels (at LOD 0)
 * @param brickSize - Usually 64
 */
export function generateTestPyramid(sx: number, sy: number, sz: number, brickSize: number = 64): MockPyramid {
  const pyramid: MockPyramid = {};
  const levels = [
    { name: 'scale0', downsample: 1, intensity: 250 },
    { name: 'scale1', downsample: 2, intensity: 200 },
    { name: 'scale2', downsample: 4, intensity: 150 },
    { name: 'scale3', downsample: 8, intensity: 120 }
  ];

  levels.forEach(level => {
    const levelMap = new Map<string, Uint8Array>();
    
    // Calculate volume dimensions at this specific LOD
    const curX = Math.ceil(sx / level.downsample);
    const curY = Math.ceil(sy / level.downsample);
    const curZ = Math.ceil(sz / level.downsample);

    // Calculate how many bricks we need for this LOD
    const bricksX = Math.ceil(curX / brickSize);
    const bricksY = Math.ceil(curY / brickSize);
    const bricksZ = Math.ceil(curZ / brickSize);

    // Create a single reusable buffer for this intensity level to save memory
    const brickData = new Uint8Array(brickSize * brickSize * brickSize).fill(level.intensity);

    for (let z = 0; z < bricksZ; z++) {
      for (let y = 0; y < bricksY; y++) {
        for (let x = 0; x < bricksX; x++) {
          // Key format matches Zarr: "z/y/x"
          const key = `${z}/${y}/${x}`;
          levelMap.set(key, new Uint8Array(brickData)); 
        }
      }
    }

    pyramid[level.name] = levelMap;
    console.log(`Generated ${level.name}: ${bricksX}x${bricksY}x${bricksZ} bricks at intensity ${level.intensity}`);
  });

  return pyramid;
}