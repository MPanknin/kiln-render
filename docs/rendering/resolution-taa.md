# Resolution scaling & TAA

## Resolution scaling

The compute shader can render at a reduced resolution to decrease the number of rays cast per frame. A configurable `renderScale` factor (0.25-1.0, default 0.5) multiplies the canvas dimensions to produce a smaller compute output texture. The blit pass then upscales this to the full canvas using bilinear filtering.

```
Canvas: 1920 × 1080
renderScale: 0.5
Compute texture: 960 × 540  (75% fewer pixels)
Blit: bilinear upscale back to 1920 × 1080
```

While the camera moves, the engine drops to a render scale of 0.25 and returns to `renderScale` when the view settles (`KilnEngine.interactionRenderScale`; 0 disables the drop).

The depth texture remains at full resolution for geometry overlays (wireframe, axis). The scaled dimensions are passed into the shader as `screenSize` so that ray generation and thread dispatch use the correct coordinate space.

## Temporal jitter and accumulation

Raymarching with fixed step offsets produces banding artifacts where iso-surfaces align with sample planes. Kiln addresses this in two stages:

**Stochastic jitter**: Each ray's starting offset is randomized per frame using the frame index as part of the seed. The jitter is drawn once per ray and starts the sampling comb at the first loaded brick; after skipped bricks the comb advances by whole steps, so its phase is kept along the ray:

```wgsl
let jitterFrac = rand(rayToSeed(rayDir) + uniforms.frameIndex);
// first valid brick
tSample = t + jitterFrac * brick.stepSize;
```

This converts structured banding into high-frequency noise that varies every frame.

**Temporal accumulation**: A compute pass blends the current frame with a history buffer as a running average. Two ping-pong textures alternate as read and write targets to avoid read-write hazards:

```wgsl
let weight = 1.0 / (frameCount + 1);  // Progressive average
let blended = mix(history, current, weight);
```

On frame 0, `weight = 1.0` shows the raw noisy frame. By frame 10, each pixel averages 11 samples, substantially reducing noise. After 64 frames the image counts as converged and rendering stops until something changes.

The accumulation resets automatically when:
- The camera moves (detected by comparing the view-projection matrix between frames)
- Rendering parameters change (render mode, transfer function, window/level, ISO threshold)
- Newly streamed bricks are committed to the atlas. These resets are debounced (100 ms after the last commit, at most 250 ms after the first), so a burst of arriving bricks restarts accumulation once, not per brick

This gives immediate visual feedback during interaction, with progressive refinement when the view is still.
