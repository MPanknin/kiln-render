# Compositing modes

| Mode | Algorithm | Use Case |
|------|-----------|----------|
| **DVR** | Front-to-back alpha compositing with transfer function | General visualization |
| **MIP** | Maximum intensity along ray | Angiography, vessel detection |
| **ISO** | First surface at threshold + Phong shading | Surface extraction |
| **LOD** | Color-coded by resolution level | Debug LOD distribution |
| **Slice** | Three orthogonal planes sampling the atlas directly | Anatomical navigation |

DVR compositing uses the optical model with extinction:

```wgsl
fn composeSample(density, stepSize, color, alpha) {
    let tfColor = textureSample(transferFunction, density);
    let extinction = tfColor.a * stepSize * volumeScale;
    let sampleAlpha = 1.0 - exp(-extinction);

    // Front-to-back blending
    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
}
```

## Shading and boundary emphasis

Single-channel DVR shades each sample by its gradient. The gradient is a central difference read from the brick the ray is in, using the brick's one-voxel ghost border, so it needs no indirection lookups. Near a brick face the offsets are clamped to that border and the difference is divided by the shorter span. The differences are divided by their span in finest-level voxels, so a fixed density ramp has the same edge strength across LODs, including anisotropic pyramids. Conversion to world axes then keeps lighting normals correct on anisotropic voxels.

The gradient magnitude, in windowed density per finest-level voxel, gives an edge strength between 0 in flat regions and 1 at sharp boundaries:

```wgsl
let edge = 1.0 - exp2(-length(gradient) * edgeGain);
opacity *= mix(1.0, edge, gradientOpacity);                          // boundary emphasis
rgb = mix(rgb, shadeTwoSided(normal, -rayDir, rgb), shading * edge); // headlight shading
```

Weighting the shading by edge strength keeps noisy, homogeneous regions from turning into speckle. The light sits at the camera, and the diffuse term uses `|N·L|` because rays see boundaries from both sides. Samples that would add less than 0.2 % to the pixel skip the gradient unless boundary emphasis is on.

`shading` (default 0) and `gradientOpacity` (default 0) are renderer properties and viewer options; the demo exposes them as **Shading** and **Boundaries**, and as the `shade` and `boundary` URL parameters. Both effects are opt-in; existing links retain their unshaded appearance. Compare `shade=0` and `shade=1` with `bench=1` on your hardware before enabling shading by default. Multichannel DVR is not shaded yet.

The manual WebGPU regression at `test/dvr-gradient.html` checks a linear density ramp across isotropic and anisotropic LODs, including both ghost-border faces, and verifies the lighting normal. Serve the repository root with Vite (`configFile: false`, `optimizeDeps.entries: ['test/dvr-gradient.html']`) and open that page. It is separate from the Vitest suite.

## Multichannel compositing

For multichannel datasets (up to 4 channels), the rendering pipeline switches from transfer-function-based compositing to **additive per-channel blending**. Each channel is sampled from its own atlas texture, windowed independently, and coloured with a user-defined colour. The weighted contributions are summed:

```wgsl
// Per-channel: sample atlas, apply windowing, weight by channel colour
for (var ch = 0u; ch < numChannels; ch++) {
    let density = sampleAtlas(atlasTextures[ch], ...);
    let windowed = applyWindow(density, channelCenter[ch], channelWidth[ch]);
    channelColor += channelColors[ch].rgb * windowed * channelColors[ch].a;
    maxDensity = max(maxDensity, windowed);
}

// Composite the additive result into the ray
composeSampleAdditive(channelColor, maxDensity, ...);
```

The `composeSampleAdditive` function normalises the summed colour by the maximum density to avoid over-brightening, then applies front-to-back compositing (DVR) or tracks per-channel maximums (MIP).

Transfer functions are not used in multichannel mode. See [Multichannel](/rendering/multichannel) for per-mode behaviour and API details.
