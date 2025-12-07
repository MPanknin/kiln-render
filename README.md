# Kiln

Brick-based WebGPU volume renderer with virtual texturing for out-of-core rendering of large scale volumetric data.

<img width="1211" height="784" alt="image" src="https://github.com/user-attachments/assets/4a5af88e-e68e-469d-b111-9d2719a05953" />

## Features

- **Out-of-core streaming** - SSE-based LOD selection with priority queue loading
- **Multi-LOD support** - Hierarchical octree with automatic refinement/collapse
- **512³ volume atlas** - 8x8x8 brick slots (512 total) with 64³ voxels each
- **Indirection table** - Virtual texturing for seamless LOD transitions
- **Compute shader raycasting** - Front-to-back compositing with early exit

## Data Format

Kiln loads brick data from a directory structure:

```
/volumes/bricks/dataset/
├── metadata.json
└── lod0/
    ├── 0_0_0.raw
    ├── 0_0_1.raw
    └── ...
└── lod1/
    └── ...
```

The `metadata.json` describes the volume dimensions, LOD levels, and brick layout.

## Console API

```javascript
// Streaming
streamingManager.debugPrint()    // Print streaming stats

// Debug wireframe
wireframe.enabled = false        // Toggle LOD visualization

// Camera
camera.setUpAxis('-y')           // Set up axis
camera.resetPan()                // Reset pan to origin

// Renderer
renderer.useIndirection = false  // Debug: see raw atlas
```

## Testing

```bash
npm run test:run
```

## Documentation

- [progress.md](progress.md) - Implementation status and architecture

## License

MIT
