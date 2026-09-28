<script setup lang="ts">
// Bespoke landing sections below the hero — hairline-ruled, no card boxes,
// one ember accent. Copy is kept in sync with docs/architecture.md.
import { withBase } from 'vitepress';

// Capabilities, ordered data-format-first ("does it read my data" is the first
// question for half the audience); rendering internals follow.
const features = [
  {
    title: 'OME-Zarr, no conversion needed',
    body: 'Compatible multiscale OME-Zarr (NGFF v0.4/v0.5) datasets stream directly from a URL or the local filesystem, with no Kiln-specific conversion. Other volumes can be converted to Kiln’s compressed sharded binary format.',
  },
  {
    title: 'Bounded GPU residency',
    body: 'Kiln streams into a bounded GPU residency/atlas cache sized to a configurable budget, resolved through virtual-texture indirection —',
    link: { text: 'see Architecture for the design', href: '/architecture/overview' },
  },
  {
    title: 'Bounded VRAM',
    body: 'An LRU brick cache capped at a configurable budget (~1.3 GiB by default). With more channels, the atlas is subdivided so total usage stays within budget on constrained GPUs.',
  },
  {
    title: 'Screen-space error LOD',
    body: 'Bricks are refined only when their projected voxel error exceeds a pixel threshold, adapting to resolution, field of view, and viewing distance.',
  },
  {
    title: 'Sharded-format range streaming',
    body: 'Kiln’s sharded binary format fetches individual bricks with HTTP Range requests. Bricks known to be empty from index statistics are never requested.',
  },
  {
    title: 'Compute-shader raymarching',
    body: 'Brick-aware DVR, MIP, isosurface, and slice rendering on a WebGPU compute pipeline, with temporal accumulation to reduce sampling noise.',
  },
  {
    title: 'uint8, uint16, int16, float32 input',
    body: 'Everything except uint8 is stored as r16float on the GPU, with window/level controls. Up to 4 channels (beta) with per-channel color and windowing.',
  },
];

const pipeline = [
  { n: '01', title: 'Select', body: 'Frustum-cull and rank bricks by screen-space error.' },
  { n: '02', title: 'Fetch', body: 'Range-request missing bricks (Kiln’s sharded format), closest first.' },
  { n: '03', title: 'Assemble', body: 'Workers decompress and re-chunk into 66³ bordered bricks.' },
  { n: '04', title: 'Reside', body: 'Upload to an atlas slot and update the indirection table.' },
  { n: '05', title: 'March', body: 'One compute thread per pixel traverses the resident bricks.' },
];

const snippet = `import { KilnViewer } from 'kiln-render';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');

try {
  const viewer = await KilnViewer.create(
    canvas,
    'https://ome-zarr-scivis.s3.us-east-1.amazonaws.com/v0.5/96x2/beechnut.ome.zarr',
  );
  status.textContent = \`rendering — mode: \${viewer.mode}\`;
  window.viewer = viewer;
} catch (err) {
  status.textContent = \`failed: \${err.message}\`;
  console.error(err);
}`;
</script>

<template>
  <div class="kiln-home">
    <p class="kiln-audience">
      Stream and explore OME-Zarr volumes directly in the browser—no installation required.
    </p>

    <section class="kiln-section">
      <div class="kiln-eyebrow-sm">Capabilities</div>
      <div class="kiln-feat-grid">
        <div v-for="f in features" :key="f.title" class="kiln-feat">
          <h3>{{ f.title }}</h3>
          <p>
            {{ f.body }}
            <a v-if="f.link" :href="withBase(f.link.href)">{{ f.link.text }}</a>
          </p>
        </div>
      </div>
    </section>

    <section class="kiln-section">
      <div class="kiln-eyebrow-sm">Under the hood</div>
      <h2 class="kiln-h2">The streaming loop</h2>
      <p class="kiln-intro">
        Each frame, the streaming manager computes the set of bricks that should
        be resident and moves them through a worker pipeline into the atlas;
        requests for bricks that leave the desired set are cancelled. The full
        design is described in
        <a :href="withBase('/architecture/overview')">Architecture</a>.
      </p>
      <div class="kiln-pipe">
        <div v-for="p in pipeline" :key="p.n" class="kiln-pstep">
          <div class="kiln-pn">{{ p.n }}</div>
          <h4>{{ p.title }}</h4>
          <p>{{ p.body }}</p>
        </div>
      </div>
    </section>

    <section class="kiln-section kiln-cta">
      <div class="kiln-eyebrow-sm">Getting started</div>
      <p class="kiln-intro">
        Kiln is distributed as an npm package. A minimal viewer is a canvas, a
        dataset URL, and a <code>KilnViewer.create</code> call:
      </p>
      <pre class="kiln-code"><code>{{ snippet }}</code></pre>
      <div class="kiln-cta-row">
        <a class="kiln-btn kiln-btn-primary" :href="withBase('/guide/quick-start')">Read the guide</a>
        <a class="kiln-btn kiln-btn-ghost" :href="withBase('/gallery')">Browse the gallery</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.kiln-home {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}
.kiln-section {
  padding: 64px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.kiln-audience {
  max-width: 60ch;
  margin: 40px 0 0;
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.6;
}

.kiln-eyebrow-sm {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin-bottom: 12px;
}
.kiln-h2 {
  font-weight: 600;
  color: var(--vp-c-text-1);
  font-size: clamp(1.4rem, 3vw, 1.8rem);
  letter-spacing: -0.01em;
  margin: 0 0 10px;
  border: none;
  padding: 0;
}
.kiln-intro {
  color: var(--vp-c-text-2);
  max-width: 60ch;
  margin: 0 0 40px;
}
.kiln-intro code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85em;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  padding: 1px 5px;
  border-radius: 4px;
}

/* Feature grid — hairline top-rule, no boxes. */
.kiln-feat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 36px 32px;
}
@media (max-width: 800px) {
  .kiln-feat-grid { grid-template-columns: 1fr; gap: 28px; }
}
.kiln-feat {
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 16px;
}
.kiln-feat h3 {
  font-size: 0.95rem;
  color: var(--vp-c-text-1);
  font-weight: 600;
  margin: 0 0 6px;
}
.kiln-feat p {
  font-size: 0.9rem;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.6;
}
.kiln-feat p a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

/* Pipeline — numbered, ember index. */
.kiln-pipe {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;
}
@media (max-width: 820px) {
  .kiln-pipe { grid-template-columns: 1fr; gap: 20px; }
}
.kiln-pstep {
  border-top: 1px solid var(--vp-c-divider);
  padding-top: 14px;
}
.kiln-pn {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  color: var(--vp-c-brand-1);
  margin-bottom: 8px;
}
.kiln-pstep h4 {
  font-size: 0.92rem;
  color: var(--vp-c-text-1);
  font-weight: 600;
  margin: 0 0 4px;
}
.kiln-pstep p {
  font-size: 0.82rem;
  color: var(--vp-c-text-2);
  margin: 0;
  line-height: 1.55;
}

/* Code block (plain, monospace — no token highlighting in-component). */
.kiln-code {
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 18px 20px;
  overflow-x: auto;
  margin: 0 0 28px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
.kiln-code code {
  background: none;
  border: none;
  padding: 0;
  white-space: pre;
}

/* CTA. */
.kiln-cta-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.kiln-btn {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  padding: 10px 18px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.kiln-btn-primary {
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
  font-weight: 600;
}
.kiln-btn-primary:hover {
  background: var(--vp-c-brand-2);
}
.kiln-btn-ghost {
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.kiln-btn-ghost:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
}
</style>
