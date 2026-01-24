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
        let tfColor = textureSampleLevel(tfTexture, tfSampler, windowedDensity, 0.0);
        let extinction = tfColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}

// Compose a sample using transfer function lookup (no windowing - uses full range)
fn composeSample(density: f32, stepSize: f32, maxDim: f32, color: ptr<function, vec3f>, alpha: ptr<function, f32>) {
    if (density > 0.01) {
        let tfColor = textureSampleLevel(tfTexture, tfSampler, density, 0.0);
        let extinction = tfColor.a * stepSize * maxDim * 0.5;
        let sampleAlpha = 1.0 - exp(-extinction);
        *color += tfColor.rgb * sampleAlpha * (1.0 - *alpha);
        *alpha += sampleAlpha * (1.0 - *alpha);
    }
}
