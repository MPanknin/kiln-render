# Resolution scaling & TAA

## Resolution scaling

The ray marcher renders at `renderScale` × the canvas size (0.25–1, default 0.5): at 0.5 a 1920 × 1080 canvas casts 960 × 540 rays, a quarter of the pixels. A blit pass upscales bilinearly. While the camera moves the scale drops to 0.25 and returns when the view settles (`KilnEngine.interactionRenderScale`; 0 disables the drop).

Overlays (wireframe, axis) and their depth buffer stay at full resolution.

## Jitter and accumulation

Fixed sample positions produce banding where surfaces align with sample planes. Kiln turns the banding into noise and then averages it away:

- **Jitter:** each ray's first sample is offset by a random fraction of a step, seeded with the frame index. The offset is applied at the first loaded brick, and after skipped bricks the samples advance by whole steps, so the pattern stays consistent along the ray.

  ```wgsl
  let jitterFrac = rand(rayToSeed(rayDir) + uniforms.frameIndex);
  tSample = t + jitterFrac * brick.stepSize; // at the first valid brick
  ```

- **Accumulation:** a compute pass averages each new frame into a history texture (ping-pong pair) with `weight = 1 / (frameCount + 1)`. After 64 frames the image counts as converged and rendering stops until something changes.

Accumulation restarts when:

- the camera moves
- a render setting changes (mode, transfer function, window, threshold, …)
- streamed bricks are committed, debounced to 100 ms after the last commit and at most 250 ms after the first, so a burst of bricks restarts it once
