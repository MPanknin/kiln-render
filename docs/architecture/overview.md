# System overview

Technical deep-dive into Kiln's virtual texturing system for volumetric data.

Kiln implements a **virtual texturing** system that decouples the logical volume address space from physical GPU memory. A bounded atlas cache holds only the currently needed bricks, while the rest of the dataset remains on the server and is streamed on demand.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Application Layer                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  StreamingManager           │  Camera + Frustum        │  UI / Controls     │
│  - Desired set computation  │  - View-projection       │  - Transfer func   │
│  - Priority queue           │  - Frustum planes        │  - Render mode     │
│  - Request lifecycle        │  - Distance calculation  │  - LOD thresholds  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              Residency Management                           │
├─────────────────────────────────────────────────────────────────────────────┤
│  AtlasAllocator             │  IndirectionTable        │  DataProviders     │
│  - LRU slot tracking        │  - Virtual→Physical map  │  - Sharded binary  │
│  - Eviction selection       │  - Multi-LOD support     │  - OME-Zarr        │
│  - Metadata bookkeeping     │  - Empty brick markers   │  - Worker pools    │
├─────────────────────────────────────────────────────────────────────────────┤
│                              GPU Resources                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Atlas Texture (3D)         │  Indirection Texture     │  Compute Pipeline  │
│  - ≤660³ r16float/r8unorm   │  - Grid³ rgba8uint       │  - Ray generation  │
│  - ≤10³ slots (budget-fit)  │  - Per-cell LOD + slot   │  - Brick traversal │
│  - 66³ per slot (w/ border) │  - 255 = empty marker    │  - Compositing     │
└─────────────────────────────────────────────────────────────────────────────┘
```

The rest of this section covers each layer in turn:

- **[Virtual texturing](/architecture/virtual-texturing)** — brick decomposition, the indirection table, and the atlas texture.
- **[Streaming manager](/architecture/streaming)** — desired-set computation, the priority queue, and LRU eviction.
- **[Network & formats](/architecture/network-formats)** — HTTP Range streaming, compression, and supported data types.
- **[Memory budget](/architecture/memory-budget)** — VRAM accounting.
- **[Design decisions](/architecture/design-decisions)** — the rationale behind the key choices.
