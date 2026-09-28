<script setup lang="ts">
// Minimal landing: full-viewport, centered wordmark + three links, with an
// understated meta line and copyright pinned to the bottom. No chrome.
import { withBase } from 'vitepress';
</script>

<template>
  <main class="kiln-landing">
    <div class="kiln-landing-inner">
      <h1 class="kiln-wordmark">Kiln</h1>
      <p class="kiln-tagline">WebGPU-native out-of-core volume rendering system</p>
      <nav class="kiln-links">
        <a :href="withBase('/gallery')">Examples</a>
        <a :href="withBase('/guide/introduction')">Documentation</a>
        <a href="https://github.com/MPanknin/kiln-render" target="_blank" rel="noreferrer">GitHub</a>
      </nav>
    </div>

    <footer class="kiln-footer">
      <p class="kiln-version">v0.5.0</p>
      <p class="kiln-copyright">© 2026 mpanknin</p>
    </footer>
  </main>
</template>

<style scoped>
.kiln-landing {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--vp-c-bg);
}

.kiln-landing-inner {
  text-align: center;
}

.kiln-wordmark {
  margin: 0 0 1.25rem;
  font-weight: 300;
  font-size: clamp(3.25rem, 13vw, 8rem);
  line-height: 1;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--vp-c-text-1);
  text-indent: 0.16em;
}

.kiln-tagline {
  margin: 0 0 2.75rem;
  font-size: 0.95rem;
  font-weight: 400;
  letter-spacing: 0.01em;
  color: var(--vp-c-text-2);
}

.kiln-links {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 2.25rem;
}

.kiln-links a {
  font-size: 0.9rem;
  letter-spacing: 0.05em;
  color: var(--vp-c-text-3);
  text-decoration: none;
  transition: color 0.15s;
}

.kiln-links a:hover {
  color: var(--vp-c-text-1);
}

.kiln-footer {
  position: absolute;
  bottom: 26px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 0 24px;
}

.kiln-version {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  letter-spacing: 0.02em;
  color: var(--vp-c-text-3);
}

.kiln-copyright {
  margin: 0;
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
}

@media (max-width: 480px) {
  .kiln-links { gap: 1.5rem; }
}
</style>
