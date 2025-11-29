# Kiln

Brick-based WebGPU volume renderer with virtual texturing for out-of-core rendering.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:3000 in a WebGPU-enabled browser (Chrome 113+, Edge 113+).

## Features

- Proxy box geometry raycasting
- 512³ volume atlas with 64³ bricks
- Indirection table for virtual texturing
- Atlas slot allocator
- Arcball camera

## Console API

```javascript
loadBrick(vx, vy, vz, intensity, 'sphere'|'solid')
unloadBrick(vx, vy, vz)
clearAll()
fillAtlas()

renderer.useIndirection = false  // Debug: see raw atlas
```

## Testing

```bash
npm run test:run
```

## Documentation

- [PROJECT_GOALS.md](PROJECT_GOALS.md) - Vision and roadmap
- [PROGRESS.md](PROGRESS.md) - Implementation status

## License

MIT
