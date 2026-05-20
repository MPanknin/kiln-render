// Volume compositing functions (front-to-back blending)

// Compose a sample with explicit color
fn composeSampleWithColor(density: f32, stepSize: f32, maxDim: f32, sampleColor: vec4f, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (density > 0.01) {
        let extinction = sampleColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += sampleColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

// Compose a sample using transfer function lookup with windowing
fn composeSampleWindowed(density: f32, stepSize: f32, maxDim: f32, windowCenter: f32, windowWidth: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    // Apply windowing to remap density to visible range
    let windowedDensity = applyWindow(density, windowCenter, windowWidth);

    if (windowedDensity > 0.01) {
        // Sample 2D transfer function (256x1 texture) - use vec2f(coord, 0.5) for Safari compatibility
        let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(windowedDensity, 0.5), 0.0);
        let extinction = tfColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

// Compose a multi-channel additive sample (no TF — each channel has its own color/weight)
// channelColor: pre-weighted sum of per-channel colors * densities
// maxDensity: max across all channels (drives absorption)
fn composeSampleAdditive(channelColor: vec3f, maxDensity: f32, stepSize: f32, maxDim: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (maxDensity > 0.01) {
        let extinction = maxDensity * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        let normColor = channelColor / maxDensity; // normalise to avoid over-brightening
        *color += normColor * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

// Compose a sample using transfer function lookup (no windowing - uses full range)
fn composeSample(density: f32, stepSize: f32, maxDim: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (density > 0.01) {
        let tfColor = textureSampleLevel(tfTexture, tfSampler, vec2f(density, 0.5), 0.0);
        let extinction = tfColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}
