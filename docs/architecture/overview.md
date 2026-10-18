# System overview

Kiln separates the volume's address space from GPU memory, as in virtual texturing: a fixed-size atlas holds the bricks the current view needs, and the rest stays on the server until it is needed.

![Kiln’s three layers: application, residency management and GPU resources](../diagrams/overview-layers.svg)

- **[Virtual texturing](/architecture/virtual-texturing)**: bricks, indirection table, atlas
- **[Streaming manager](/architecture/streaming)**: which bricks to load, in what order, and what to evict
- **[Network & formats](/architecture/network-formats)**: HTTP Range streaming, compression, data types
- **[Memory budget](/architecture/memory-budget)**: VRAM accounting
- **[Design decisions](/architecture/design-decisions)**: why it is built this way
