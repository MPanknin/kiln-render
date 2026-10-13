/**
 * Multi-channel viewer UI controls — dependency-free (Phase 3 of the
 * interface redesign; Tweakpane removed from user-facing UI entirely).
 */

import type { Renderer } from "@kiln/core/renderer.js";
import type { Camera, UpAxis } from "@kiln/core/camera.js";
import type { StreamingManager } from "@kiln/streaming/streaming-manager.js";
import type { VolumeMetadata } from "@kiln/data/data-provider.js";
import type { KilnViewer, VolumeRenderMode } from "kiln-render";
import { StatsPanel } from "../../../shared/stats-panel.js";
import {
  createPanel,
  createSwapRegion,
  createCollapsible,
  createToggle,
  createSlider,
  createRangeSlider,
  createSelect,
  createSegmentedControl,
  createSliderToggleRow,
  createColorSwatch,
} from "../../../shared/controls/widgets.js";
import { trackRenderMode } from "../../../shared/analytics.js";
import { normalizeWindow } from "@kiln/core/config.js";
import { channelDisplayName } from "../../../shared/channel-names.js";
import { percentileWindow, windowDomain, AUTO_CONTRAST_BINS } from "../../../shared/auto-contrast.js";
import { toRawValue, formatRawValue, isIntegerDtype, type ValueSpace } from "../../../shared/data-values.js";
import { createTimeSlider, createChannelPicker, withSlotSource, firstUnusedSource } from "../../../shared/source-controls.js";
import type { ApplySelection, TimeSlider } from "../../../shared/source-controls.js";

/** Only 'dvr' | 'mip' | 'slice' are selectable via the Mode segmented control — 'slice-lod' is a debug visualization, relocated to the "LOD Levels" Advanced toggle (applied on top of the base mode). */
type BaseRenderMode = "dvr" | "mip" | "slice";

// Default channel colors matching renderer defaults
const CHANNEL_COLOR_DEFAULTS = [
  { r: 0, g: 0, b: 255 }, // ch0: blue
  { r: 255, g: 255, b: 0 }, // ch1: yellow
  { r: 255, g: 0, b: 0 }, // ch2: red
  { r: 255, g: 255, b: 255 }, // ch3: white
];

export interface ChannelState {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
  a: number; // 0-1
  visible: boolean;
  min: number; // 0-1 normalized
  max: number; // 0-1 normalized
}

interface ChannelWidgets {
  toggle: ReturnType<typeof createToggle>;
  swatch: ReturnType<typeof createColorSwatch>;
  level: ReturnType<typeof createRangeSlider>;
  auto: HTMLButtonElement;
  row: HTMLElement;
}

export class MultichannelUI {
  private viewer: KilnViewer;
  private camera: Camera;
  private stats: StatsPanel;

  private params = {
    upAxis: "-y" as UpAxis,
    renderMode: "dvr" as BaseRenderMode,
    showLodLevels: false,
    renderScale: 0.5,
    showWireframe: false,
    showAxis: false,
    sliceX: 0,
    sliceY: 0,
    sliceZ: 0,
    showSliceX: true,
    showSliceY: true,
    showSliceZ: true,
  };

  // Per-channel params — populated dynamically in constructor
  private channelParams: Array<{
    color: { r: number; g: number; b: number; a: number };
    visible: boolean;
    level: { min: number; max: number };
  }> = [];
  private channelWidgets: ChannelWidgets[] = [];
  /** Base-level value histograms per slot (shader space); null until that channel has loaded. */
  private contrastHistograms: (Uint32Array | null)[] = [];

  private initialSlice?: {
    x: number;
    y: number;
    z: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
  };
  /** When true, auto-leveling from base LOD will not overwrite URL-restored channel windows. */
  private channelsRestoredFromURL = false;

  private modeControl!: ReturnType<typeof createSegmentedControl>;
  private modeSwap!: ReturnType<typeof createSwapRegion>;
  private sliceRows!: [
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
    ReturnType<typeof createSliderToggleRow>,
  ];
  private channelRackEl!: HTMLElement;
  private timeSlider: TimeSlider | null = null;
  /** Set by the app: applies a source selection in place or opens the other viewer. */
  applySelection?: ApplySelection;
  private upAxisSelect!: ReturnType<typeof createSelect>;
  private wireframeToggle!: ReturnType<typeof createToggle>;
  private axesToggle!: ReturnType<typeof createToggle>;
  private renderScaleSlider!: ReturnType<typeof createSlider>;
  private lodLevelsToggle!: ReturnType<typeof createToggle>;

  constructor(
    viewer: KilnViewer,
    initialChannels?: ChannelState[],
    initialSlice?: {
      x: number;
      y: number;
      z: number;
      showX: boolean;
      showY: boolean;
      showZ: boolean;
    },
  ) {
    this.viewer = viewer;
    this.camera = viewer.camera;

    // Sync initial values
    this.initialSlice = initialSlice;
    this.params.upAxis = this.camera.getUpAxis();
    this.decomposeRenderMode(this.renderer.volumeRenderMode);
    this.params.showWireframe = this.renderer.showWireframe;
    this.params.showAxis = this.renderer.showAxis;
    this.params.renderScale = this.renderer.renderScale;

    this.syncChannelParams(initialChannels);

    // Controls pane — top-left, below top bar
    const controlsContainer = document.createElement("div");
    controlsContainer.style.cssText =
      "position: fixed; left: 8px; top: 44px; z-index: 1000;";
    document.body.appendChild(controlsContainer);

    // Stats pane — bottom-left
    const statsContainer = document.createElement("div");
    statsContainer.style.cssText =
      "position: fixed; right: 8px; bottom: calc(36px + env(safe-area-inset-bottom, 0px)); z-index: 1000;";
    document.body.appendChild(statsContainer);
    this.stats = new StatsPanel(statsContainer);

    this.buildPanel(controlsContainer);
    this.initStreaming(viewer.streamingManager, viewer.metadata);
  }

  /** The viewer's renderer; replaced when the channel count changes, so never cache it. */
  private get renderer(): Renderer {
    return this.viewer.renderer;
  }

  /** Source channels/timepoint changed in place: rebuild the channel rack from the renderer. */
  onSourceSelectionChanged(): void {
    this.channelsRestoredFromURL = false;
    this.channelParams = [];
    this.channelWidgets = [];
    this.contrastHistograms = [];
    this.syncChannelParams();
    this.buildChannelRack();
    this.updateVisibility();
    this.timeSlider?.sync();
    this.initStreaming(this.viewer.streamingManager, this.viewer.metadata);
  }

  /** Per-channel params from renderer state (the engine applied metadata defaults) or URL-restored state. */
  private syncChannelParams(initialChannels?: ChannelState[]): void {
    if (initialChannels && initialChannels.length > 0) {
      this.channelsRestoredFromURL = true;
    }
    for (let i = 0; i < this.renderer.numChannels; i++) {
      const restored = initialChannels?.[i];
      if (restored) {
        this.channelParams.push({
          color: { r: restored.r, g: restored.g, b: restored.b, a: restored.a },
          visible: restored.visible,
          level: { min: restored.min, max: restored.max },
        });
        this.renderer.setChannelColor(
          i,
          restored.r / 255,
          restored.g / 255,
          restored.b / 255,
          restored.visible ? restored.a : 0,
        );
        this.renderer.setChannelWindow(
          i,
          (restored.min + restored.max) / 2,
          Math.max(0.001, restored.max - restored.min),
        );
      } else {
        const defaults = CHANNEL_COLOR_DEFAULTS[i] ?? {
          r: 255,
          g: 255,
          b: 255,
        };
        const base = i * 4;
        const center = this.renderer.channelWindowCenter[i]!;
        const width = this.renderer.channelWindowWidth[i]!;
        const [min, max] = [center - width / 2, center + width / 2];
        this.channelParams.push({
          color: {
            r: Math.round(
              (this.renderer.channelColors[base] ?? defaults.r / 255) * 255,
            ),
            g: Math.round(
              (this.renderer.channelColors[base + 1] ?? defaults.g / 255) * 255,
            ),
            b: Math.round(
              (this.renderer.channelColors[base + 2] ?? defaults.b / 255) * 255,
            ),
            a: 1.0,
          },
          // Alpha 0 means the engine hid the channel (OMERO active=false)
          visible: (this.renderer.channelColors[base + 3] ?? 1.0) > 0,
          level: { min, max },
        });
      }
    }
  }

  /** Decompose a (possibly debug) renderer mode into { base mode, showLodLevels }. */
  private decomposeRenderMode(mode: VolumeRenderMode): void {
    if (mode === "slice-lod") {
      this.params.renderMode = "slice";
      this.params.showLodLevels = true;
    } else if (mode === "dvr" || mode === "mip" || mode === "slice") {
      this.params.renderMode = mode;
      this.params.showLodLevels = false;
    } else {
      // 'iso'/'lod' were never reachable via this viewer's UI — fall back to dvr.
      this.params.renderMode = "dvr";
      this.params.showLodLevels = false;
    }
  }

  /** Apply { base mode, showLodLevels } onto the viewer's actual VolumeRenderMode. */
  private applyEffectiveMode(): void {
    const base = this.params.renderMode;
    const effective: VolumeRenderMode =
      this.params.showLodLevels && base === "slice" ? "slice-lod" : base;
    this.viewer.mode = effective;
    this.updateVisibility();
  }

  /** Switch base render mode and keep the Mode control in sync (keyboard shortcuts). */
  setBaseMode(mode: BaseRenderMode): void {
    this.params.renderMode = mode;
    this.modeControl.setValue(mode);
    this.applyEffectiveMode();
    trackRenderMode(mode);
  }

  private buildPanel(container: HTMLElement): void {
    const { el: panelEl, body } = createPanel("Controls", { defaultCollapsed: true });
    container.appendChild(panelEl);

    this.modeControl = createSegmentedControl({
      options: [
        { label: "DVR", value: "dvr" },
        { label: "MIP", value: "mip" },
        { label: "Slice", value: "slice" },
      ],
      value: this.params.renderMode,
      onChange: (v) => this.setBaseMode(v as BaseRenderMode),
    });
    body.appendChild(this.modeControl.el);

    // Time scrubber: mode-independent, directly above the channel rack it changes.
    this.timeSlider = createTimeSlider(this.viewer.metadata, (timepoint) => {
      const meta = this.viewer.metadata;
      this.applySelection?.({ sourceChannels: meta.sourceChannels ?? [0], timepoint });
    });
    if (this.timeSlider) body.appendChild(this.timeSlider.el);

    this.modeSwap = createSwapRegion();
    body.appendChild(this.modeSwap.el);
    this.buildChannelRack();
    this.buildSliceRows();

    // --- Scene section (collapsible, open by default) ---
    const { el: sceneEl, body: sceneSection } = createCollapsible(
      "Scene",
      true,
    );
    body.appendChild(sceneEl);

    this.upAxisSelect = createSelect({
      label: "Up Axis",
      options: [
        { label: "X", value: "x" },
        { label: "Y", value: "y" },
        { label: "Z", value: "z" },
        { label: "-X", value: "-x" },
        { label: "-Y", value: "-y" },
        { label: "-Z", value: "-z" },
      ],
      value: this.params.upAxis,
      onChange: (v) => {
        this.camera.setUpAxis(v as UpAxis);
        this.renderer.resetAccumulation();
      },
    });
    sceneSection.appendChild(this.upAxisSelect.el);

    this.wireframeToggle = createToggle({
      label: "Wireframe",
      value: this.params.showWireframe,
      onChange: (v) => {
        this.renderer.showWireframe = v;
        this.renderer.markDirty();
      },
    });
    sceneSection.appendChild(this.wireframeToggle.el);

    this.axesToggle = createToggle({
      label: "Axes",
      value: this.params.showAxis,
      onChange: (v) => {
        this.renderer.showAxis = v;
        this.renderer.markDirty();
      },
    });
    sceneSection.appendChild(this.axesToggle.el);

    // --- Advanced (collapsed by default) ---
    const { el: advancedEl, body: advancedBody } = createCollapsible(
      "Advanced",
      false,
    );
    body.appendChild(advancedEl);

    this.renderScaleSlider = createSlider({
      label: "Render Scale",
      min: 0.25,
      max: 1.0,
      step: 0.25,
      value: this.params.renderScale,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        this.viewer.renderScale = v;
      },
    });
    advancedBody.appendChild(this.renderScaleSlider.el);

    this.lodLevelsToggle = createToggle({
      label: "LOD Levels",
      value: this.params.showLodLevels,
      onChange: (v) => {
        this.params.showLodLevels = v;
        this.applyEffectiveMode();
      },
    });
    advancedBody.appendChild(this.lodLevelsToggle.el);

    this.updateVisibility();
  }

  private buildChannelRack(): void {
    this.channelRackEl = document.createElement("div");
    const meta = this.viewer.metadata;
    for (let ch = 0; ch < this.renderer.numChannels; ch++) {
      const chParam = this.channelParams[ch]!;
      const displayName = channelDisplayName(meta.channels?.[ch]?.label, meta.sourceChannels?.[ch] ?? ch);

      const row = document.createElement("div");
      row.className = "ctl-channel-row";

      const wrapper = document.createElement("div");
      wrapper.className = "ctl-channel-group";
      wrapper.classList.toggle("off", !chParam.visible);

      const toggle = createToggle({
        label: "",
        ariaLabel: `Show ${displayName}`,
        value: chParam.visible,
        onChange: (v) => {
          chParam.visible = v;
          wrapper.classList.toggle("off", !v);
          const c = chParam.color;
          this.renderer.setChannelColor(
            ch,
            c.r / 255,
            c.g / 255,
            c.b / 255,
            v ? c.a : 0,
          );
        },
      });

      const swatch = createColorSwatch({
        value: chParam.color,
        onChange: (rgb) => {
          chParam.color.r = rgb.r;
          chParam.color.g = rgb.g;
          chParam.color.b = rgb.b;
          const alpha = chParam.visible ? chParam.color.a : 0;
          this.renderer.setChannelColor(
            ch,
            rgb.r / 255,
            rgb.g / 255,
            rgb.b / 255,
            alpha,
          );
        },
      });

      swatch.el.setAttribute("aria-label", `${displayName} colour`);

      // The name doubles as the source-channel picker when the dataset offers a choice.
      // OMERO label when the dataset has one; the full text is in the tooltip
      // because long labels ("Alexa 488 – anti-tubulin") ellipsize in the row.
      let name: HTMLElement;
      if ((meta.sourceChannelCount ?? 1) > 1 && meta.sourceChannels) {
        name = createChannelPicker(meta, ch, (source) => this.pickSlotSource(ch, source));
      } else {
        name = document.createElement("span");
        name.className = "ctl-channel-name";
        name.textContent = displayName;
        name.title = displayName;
      }

      // Identity (swatch + name) reads left-to-right; the visibility toggle
      // right-aligns with every other control in the panel grid.
      row.appendChild(swatch.el);
      row.appendChild(name);
      row.appendChild(toggle.el);

      // No per-channel "Level" label — the strip layout makes it obvious, and
      // repeating the word four times was pure noise.
      // Raw data values on the label; the range is fitted to the data in applyDomain.
      const level = createRangeSlider({
        label: "",
        min: 0,
        max: 1,
        step: 0.01,
        valueMin: chParam.level.min,
        valueMax: chParam.level.max,
        format: (v) => this.formatRaw(v),
        onChange: (min, max) => this.setWindow(ch, min, max),
      });
      level.el.classList.add("ctl-channel-level");

      const auto = document.createElement("button");
      auto.type = "button";
      auto.className = "ctl-button ctl-button-compact";
      auto.textContent = "Auto";
      auto.title = `Fit the ${displayName} window to its data (A fits all)`;
      auto.disabled = !this.contrastHistograms[ch];
      auto.addEventListener("click", () => this.autoContrast(ch));
      level.el.appendChild(auto);

      wrapper.appendChild(row);
      wrapper.appendChild(level.el);

      this.channelWidgets.push({ toggle, swatch, level, auto, row: wrapper });
      this.applyDomain(ch);
      this.channelRackEl.appendChild(wrapper);
    }

    // Up to four display slots; offer another while the dataset has channels not yet shown.
    const unused = firstUnusedSource(meta);
    if (unused !== null && this.renderer.numChannels < 4) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "ctl-channel-add";
      add.textContent = "+ Add channel";
      add.addEventListener("click", () => this.changeSelection([...(meta.sourceChannels ?? []), unused]));
      this.channelRackEl.appendChild(add);
    }
  }

  /** Assign `source` to a display slot (null removes the slot); a channel shown elsewhere swaps in. */
  private pickSlotSource(slot: number, source: number | null): void {
    this.changeSelection(withSlotSource(this.viewer.metadata.sourceChannels ?? [], slot, source));
  }

  /** Switch channels in place through the app; rebuild the rack whether it succeeded or was refused. */
  private changeSelection(sourceChannels: number[]): void {
    const timepoint = this.viewer.metadata.timepoint ?? 0;
    try {
      if (this.applySelection?.({ sourceChannels, timepoint }) === false) return; // navigating away
    } catch (e) {
      console.warn("[Kiln] channel selection rejected:", e);
    }
    this.onSourceSelectionChanged();
  }

  /** Keyboard stepping through time (no-op without a time axis). */
  stepTimepoint(delta: number): void {
    this.timeSlider?.step(delta);
  }

  private buildSliceRows(): void {
    const sliceDims = this.viewer.metadata.dimensions;
    if (this.initialSlice) {
      this.params.sliceX = this.initialSlice.x;
      this.params.sliceY = this.initialSlice.y;
      this.params.sliceZ = this.initialSlice.z;
      this.params.showSliceX = this.initialSlice.showX;
      this.params.showSliceY = this.initialSlice.showY;
      this.params.showSliceZ = this.initialSlice.showZ;
      this.renderer.sliceX = this.initialSlice.x / sliceDims[0];
      this.renderer.sliceY = this.initialSlice.y / sliceDims[1];
      this.renderer.sliceZ = this.initialSlice.z / sliceDims[2];
      this.renderer.showSliceX = this.initialSlice.showX;
      this.renderer.showSliceY = this.initialSlice.showY;
      this.renderer.showSliceZ = this.initialSlice.showZ;
    } else {
      this.params.sliceX = Math.round(sliceDims[0] / 2);
      this.params.sliceY = Math.round(sliceDims[1] / 2);
      this.params.sliceZ = Math.round(sliceDims[2] / 2);
    }

    const sliceX = createSliderToggleRow({
      label: "X",
      min: 0,
      max: sliceDims[0],
      step: 1,
      value: this.params.sliceX,
      checked: this.params.showSliceX,
      onValueChange: (v) => {
        this.renderer.sliceX = v / sliceDims[0];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceX = v;
        this.renderer.markDirty();
      },
    });
    const sliceY = createSliderToggleRow({
      label: "Y",
      min: 0,
      max: sliceDims[1],
      step: 1,
      value: this.params.sliceY,
      checked: this.params.showSliceY,
      onValueChange: (v) => {
        this.renderer.sliceY = v / sliceDims[1];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceY = v;
        this.renderer.markDirty();
      },
    });
    const sliceZ = createSliderToggleRow({
      label: "Z",
      min: 0,
      max: sliceDims[2],
      step: 1,
      value: this.params.sliceZ,
      checked: this.params.showSliceZ,
      onValueChange: (v) => {
        this.renderer.sliceZ = v / sliceDims[2];
        this.renderer.markDirty();
      },
      onCheckedChange: (v) => {
        this.renderer.showSliceZ = v;
        this.renderer.markDirty();
      },
    });
    this.sliceRows = [sliceX, sliceY, sliceZ];
  }

  private initStreaming(
    manager: StreamingManager,
    metadata: VolumeMetadata,
  ): void {
    this.stats.setDatasetInfo(metadata, this.renderer.canvas.format, {
      fileSizeChannelMultiplier: metadata.numChannels,
    });
    manager.setBaseLodLoadedCallback(() => this.onBaseLodLoaded());
    this.stats.bindStreaming(manager, () => this.viewer.milestones);
  }

  /** Base level (re)loaded: per-channel histograms for Auto contrast and the slider ranges. */
  private onBaseLodLoaded(): void {
    const sm = this.viewer.streamingManager;
    for (let ch = 0; ch < this.channelParams.length; ch++) {
      this.contrastHistograms[ch] = sm.getChannelHistogram(ch, AUTO_CONTRAST_BINS);
      const w = this.channelWidgets[ch];
      if (w) w.auto.disabled = !this.contrastHistograms[ch];
      this.applyDomain(ch);
    }
  }

  /** The level slider spans the channel's data (or sits just above its window until it has loaded). */
  private applyDomain(ch: number): void {
    const widgets = this.channelWidgets[ch];
    const params = this.channelParams[ch];
    if (!widgets || !params) return;
    const d = windowDomain(this.contrastHistograms[ch] ?? null, params.level.max, this.valueSpace());
    widgets.level.setRange(0, d.max, d.step);
  }

  /** Fit a channel's window to its base-level values; all visible channels when none is given. */
  autoContrast(channel?: number): void {
    const channels = channel === undefined
      ? this.channelParams.map((_, i) => i).filter((i) => this.channelParams[i]!.visible)
      : [channel];
    for (const ch of channels) {
      const h = this.contrastHistograms[ch];
      const w = h && percentileWindow(h);
      if (!w) continue;
      this.setWindow(ch, w.center - w.width / 2, w.center + w.width / 2);
      this.channelWidgets[ch]?.level.setValue(this.channelParams[ch]!.level.min, this.channelParams[ch]!.level.max);
      this.applyDomain(ch);
    }
  }

  private setWindow(ch: number, min: number, max: number): void {
    const params = this.channelParams[ch]!;
    params.level.min = min;
    params.level.max = max;
    this.renderer.setChannelWindow(ch, (min + max) / 2, Math.max(0.001, max - min));
  }

  private valueSpace(): ValueSpace {
    const m = this.viewer.metadata;
    return { isFloat: m.isFloat ?? false, integer: isIntegerDtype(m.dtype), bitDepth: m.bitDepth, floatMin: this.renderer.floatMin, floatMax: this.renderer.floatMax };
  }

  /** Normalized (shader) value → raw data value text. */
  private formatRaw(n: number): string {
    const space = this.valueSpace();
    return formatRawValue(toRawValue(n, space), space);
  }

  /**
   * Re-read per-channel window/level from metadata and update the UI sliders.
   * Called when ranges are derived after base LOD loading.
   */
  refreshChannelWindows(): void {
    // Don't clobber URL-restored channel windows with auto-leveled values
    if (this.channelsRestoredFromURL) return;

    const windows = this.viewer.metadata.channelWindows;
    if (!windows) return;

    for (let i = 0; i < this.channelParams.length; i++) {
      const w = this.metadataWindow(i);
      if (!w) continue;
      this.setWindow(i, w.min, w.max);
      this.channelWidgets[i]?.level.setValue(w.min, w.max);
      this.applyDomain(i);
    }
  }

  /** Channel window from metadata in shader space (float: relative to the global dataRange). */
  private metadataWindow(ch: number): { min: number; max: number } | null {
    const m = this.viewer.metadata;
    const w = m.channelWindows?.[ch];
    return w ? normalizeWindow(w, m.isFloat ?? false, m.dataRange) : null;
  }

  getChannelState(): ChannelState[] {
    return this.channelParams.map((ch) => ({
      r: ch.color.r,
      g: ch.color.g,
      b: ch.color.b,
      a: ch.color.a,
      visible: ch.visible,
      min: ch.level.min,
      max: ch.level.max,
    }));
  }

  getSliceState(): {
    x: number;
    y: number;
    z: number;
    showX: boolean;
    showY: boolean;
    showZ: boolean;
  } {
    return {
      x: this.params.sliceX,
      y: this.params.sliceY,
      z: this.params.sliceZ,
      showX: this.params.showSliceX,
      showY: this.params.showSliceY,
      showZ: this.params.showSliceZ,
    };
  }

  recordFrame(): void {
    this.stats.recordFrame();
  }

  private updateVisibility(): void {
    // Channels are always shown; slice mode adds the plane sliders below them.
    const isSlice = this.params.renderMode === "slice";
    const children: HTMLElement[] = isSlice
      ? [this.channelRackEl, this.sliceRows[0].el, this.sliceRows[1].el, this.sliceRows[2].el]
      : [this.channelRackEl];
    this.modeSwap.setContent(children);
  }
}
