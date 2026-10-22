# Compositing modes

| Mode | Algorithm |
|------|-----------|
| **DVR** | Front-to-back compositing through the transfer function |
| **MIP** | Maximum intensity along the ray, shown in the transfer function's colour |
| **ISO** | First crossing of the threshold, Phong-lit from the camera |
| **Slice** | Three orthogonal planes sampled from the atlas, opaque in the transfer function's colour |
| **LOD** | Colour per resolution level, for debugging (**LOD Levels** under Advanced, or `mode=lod`) |

## DVR

Opacity follows Beer–Lambert extinction, so it scales with the step length and coarse bricks with longer steps look the same. Rays stop once opacity passes 0.95.

```wgsl
fn composeSample(density: f32, extinctionScale: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(density, 0.5), 0.0);
    let sampleAlpha = 1.0 - exp2(-tfColor.a * extinctionScale); // stepSize × densityScale × volume size × log2(e)
    *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
    *alpha += sampleAlpha * (1.0 - *alpha);
}
```

### Shading and boundary emphasis

Both are off by default: `shading` and `gradientOpacity` (viewer options and renderer properties), **Shading** and **Boundaries** in the demo, `shade` and `boundary` in the URL. Single-channel only.

The gradient is a central difference inside the current brick, using its ghost border, so it needs no extra indirection lookups. Near a brick face the taps are clamped to the border. Differences are measured per finest-level voxel, so a given density ramp has the same edge strength at every LOD, anisotropic ones included. Normals are converted to world axes, so lighting stays correct on anisotropic voxels.

```wgsl
let edge = 1.0 - exp2(-length(gradient) * edgeGain);                 // 0 in flat regions, 1 at sharp boundaries
opacity *= mix(1.0, edge, gradientOpacity);                          // boundary emphasis
rgb = mix(rgb, shadeTwoSided(normal, -rayDir, rgb), shading * edge); // light at the camera, diffuse |N·L|
```

Weighting shading by edge strength keeps noisy homogeneous regions from turning into speckle. Samples that would add less than 0.2 % to the pixel skip the gradient unless boundary emphasis is on.

## Multichannel

Each channel is sampled from its own atlas, windowed, and weighted by its colour; the results are summed. There is no transfer function.

```wgsl
for (var ch = 0u; ch < numChannels; ch++) {
    let windowed = applyWindow(sampleAtlas(atlasTextures[ch], ...), channelCenter[ch], channelWidth[ch]);
    channelColor += channelColors[ch].rgb * windowed * channelColors[ch].a;
    maxDensity = max(maxDensity, windowed);
}
composeSampleAdditive(channelColor, maxDensity, ...);
```

`composeSampleAdditive` divides the sum by `maxDensity` to avoid over-brightening and takes the opacity from `maxDensity`. MIP keeps a maximum per channel instead. See [Multichannel](/rendering/multichannel).
