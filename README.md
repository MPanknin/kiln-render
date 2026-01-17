# Kiln

Brick-based WebGPU volume renderer with virtual texturing for out-of-core rendering of large scale volumetric data.

<img width="1722" height="901" alt="image" src="https://github.com/user-attachments/assets/09d05232-2e45-463c-9f95-8dec4f80bb90" />

## Features

- **Out-of-core streaming** - Distance-based LOD selection with LRU eviction
- **Multi-LOD support** - Coarse-to-fine octree traversal with automatic refinement
- **512³ volume atlas** - 8x8x8 brick slots (512 total) with 64³ logical / 66³ physical voxels (1-voxel overlap for seamless filtering)
- **Indirection table** - Virtual texturing mapping virtual brick coords to atlas positions
- **Compute shader raycasting** - Front-to-back compositing with early exit
- **Empty brick skipping** - Skips loading bricks with no data based on index stats
- **Frustum culling** - Only loads visible bricks
- **Multiple render modes** - DVR, MIP, Isosurface, LOD visualization

## Data Format

Kiln supports two brick data formats:

### Binary Sharded Format (Recommended)

```
/datasets/volume/
├── volume.json           # Volume metadata
├── lod0.bin              # Concatenated brick data
├── lod0_index.json       # Brick offsets, sizes, and stats (min/max/avg)
├── lod1.bin
├── lod1_index.json
└── ...
```

Uses HTTP Range requests for efficient streaming of individual bricks.

### Legacy Format

```
/volumes/bricks/dataset/
├── brick.json
└── lod0/
    ├── brick-0-0-0.raw
    ├── brick-0-0-1.raw
    └── ...
└── lod1/
    └── ...
```

## UI Controls

- **Mode** - DVR, MIP, ISO, LOD (LOD shows colored bricks by resolution level)
- **Up Axis** - Camera up vector (X, Y, Z, -X, -Y, -Z)
- **Indirection** - Toggle virtual texturing on/off
- **Wireframe** - Toggle bounding box wireframe
- **Axis** - Toggle axis helper
- **Transfer Function** - Preset selection and interactive opacity curve editing
- **LOD Buttons** - Manually load specific LOD levels

## Console API

```javascript
// LOD selection with coarse-to-fine traversal
testLodSelection()         // Differential update (keeps existing bricks)
testLodSelection(true)     // Clear and reload

// Manual LOD loading
loadLod(0)                 // Load LOD 0 (finest)
clearLod()                 // Clear all loaded bricks

// Single brick loading
loadSingleBrick(0, 5, 5, 5)  // Load specific brick at LOD 0

// Debug
dumpIndirection(0)         // Print indirection table slice at Z=0

// Render mode
setRenderMode('dvr')       // 'dvr', 'mip', 'iso', 'lod'
setIsoValue(0.5)           // ISO surface threshold

// Camera
setCameraUp('y')           // Set up axis

// Renderer
renderer.useIndirection    // Toggle indirection (true/false)
renderer.showWireframe     // Toggle wireframe box
renderer.showAxis          // Toggle axis helper
```

## Development

```bash
npm install
npm run dev      # Start dev server
npm run build    # Build for production
npm run test     # Run tests
```

## License

MIT
