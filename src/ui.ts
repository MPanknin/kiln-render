/**
 * Volume Renderer UI Controls using Tweakpane
 */

// @ts-expect-error - Tweakpane types don't fully export FolderApi methods
import { Pane, FolderApi } from 'tweakpane';
import { TransferFunction, TFPreset } from './transfer-function.js';
import { Renderer, VolumeRenderMode } from './renderer.js';
import { Camera, UpAxis } from './camera.js';

export interface UICallbacks {
  onLoadLod: (level: number) => void;
  onClearLod: () => void;
}

export class VolumeUI {
  private pane: Pane;
  private renderer: Renderer;
  private camera: Camera;
  private transferFunction: TransferFunction;
  private callbacks: UICallbacks;

  private tfCanvas: HTMLCanvasElement;
  private isDraggingPoint = false;
  private dragPointIndex = -1;

  // Tweakpane params object
  private params = {
    renderMode: 'dvr' as VolumeRenderMode,
    isoValue: 0.5,
    tfPreset: 'coolwarm' as TFPreset,
    upAxis: 'y' as UpAxis,
    useIndirection: true,
    showWireframe: true,
    showAxis: true,
  };

  // Folder references for visibility toggling
  private isoFolder: FolderApi | null = null;
  private tfFolder: FolderApi | null = null;

  constructor(
    renderer: Renderer,
    camera: Camera,
    transferFunction: TransferFunction,
    callbacks: UICallbacks
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.transferFunction = transferFunction;
    this.callbacks = callbacks;

    // Sync initial values from camera/renderer
    this.params.upAxis = camera.getUpAxis();
    this.params.useIndirection = renderer.useIndirection;
    this.params.showWireframe = renderer.showWireframe;
    this.params.showAxis = renderer.showAxis;

    this.pane = new Pane({
      title: 'Volume Controls',
    });

    this.tfCanvas = document.createElement('canvas');
    this.tfCanvas.width = 256;
    this.tfCanvas.height = 80;

    this.setupControls();
    this.setupTFCanvasEvents();
    this.updateTFPreview();
    this.updateVisibility();
  }

  private setupControls(): void {
    // Render Mode
    this.pane.addBinding(this.params, 'renderMode', {
      label: 'Mode',
      options: {
        DVR: 'dvr',
        MIP: 'mip',
        ISO: 'iso',
        LOD: 'lod',
      },
    }).on('change', (ev) => {
      this.renderer.volumeRenderMode = ev.value;
      this.updateVisibility();
    });

    // Camera Up Axis
    this.pane.addBinding(this.params, 'upAxis', {
      label: 'Up Axis',
      options: {
        'X': 'x',
        'Y': 'y',
        'Z': 'z',
        '-X': '-x',
        '-Y': '-y',
        '-Z': '-z',
      },
    }).on('change', (ev) => {
      this.camera.setUpAxis(ev.value);
    });

    // Indirection toggle
    this.pane.addBinding(this.params, 'useIndirection', {
      label: 'Indirection',
    }).on('change', (ev) => {
      this.renderer.useIndirection = ev.value;
    });

    // Wireframe toggle
    this.pane.addBinding(this.params, 'showWireframe', {
      label: 'Wireframe',
    }).on('change', (ev) => {
      this.renderer.showWireframe = ev.value;
    });

    // Axis toggle
    this.pane.addBinding(this.params, 'showAxis', {
      label: 'Axis',
    }).on('change', (ev) => {
      this.renderer.showAxis = ev.value;
    });

    // Isosurface folder
    this.isoFolder = this.pane.addFolder({
      title: 'Isosurface',
    });

    this.isoFolder.addBinding(this.params, 'isoValue', {
      label: 'ISO Value',
      min: 0,
      max: 1,
      step: 0.01,
    }).on('change', (ev) => {
      this.renderer.isoValue = ev.value;
    });

    // Transfer Function folder
    this.tfFolder = this.pane.addFolder({
      title: 'Transfer Function',
    });

    this.tfFolder.addBinding(this.params, 'tfPreset', {
      label: 'Preset',
      options: {
        'Cool-Warm': 'coolwarm',
        'Grayscale': 'grayscale',
        'Hot': 'hot',
        'Cool': 'cool',
        'Viridis': 'viridis',
        'Plasma': 'plasma',
      },
    }).on('change', (ev) => {
      this.transferFunction.setPreset(ev.value);
      this.updateTFPreview();
    });

    // Add canvas as a blade element
    const canvasContainer = document.createElement('div');
    canvasContainer.style.cssText = 'padding: 4px 0;';

    this.tfCanvas.style.cssText = `
      width: 100%;
      height: 80px;
      border: 1px solid #555;
      border-radius: 4px;
      cursor: crosshair;
      box-sizing: border-box;
    `;
    canvasContainer.appendChild(this.tfCanvas);

    const helpText = document.createElement('div');
    helpText.textContent = 'Click to add, drag to move, dbl-click to remove';
    helpText.style.cssText = 'font-size: 10px; color: #666; margin-top: 4px;';
    canvasContainer.appendChild(helpText);

    // Inject canvas into the TF folder
    const tfFolderElement = this.tfFolder.element;
    const containerEl = tfFolderElement.querySelector('.tp-fldv_c');
    if (containerEl) {
      containerEl.appendChild(canvasContainer);
    }

    // LOD folder
    const lodFolder = this.pane.addFolder({
      title: 'LOD Level',
    });

    // LOD buttons using blade API
    const lodContainer = document.createElement('div');
    lodContainer.style.cssText = 'display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 4px 0;';

    for (let i = 0; i <= 3; i++) {
      const btn = document.createElement('button');
      btn.textContent = String(i);
      btn.style.cssText = `
        padding: 6px;
        background: #363636;
        border: 1px solid #4a4a4a;
        border-radius: 4px;
        color: #b0b0b0;
        font-size: 12px;
        cursor: pointer;
      `;
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#4a4a4a';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = '#363636';
      });
      btn.addEventListener('click', () => {
        this.callbacks.onLoadLod(i);
      });
      lodContainer.appendChild(btn);
    }

    // Clear button spans 2 columns
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = `
      grid-column: span 2;
      padding: 6px;
      background: #4a3636;
      border: 1px solid #5a4444;
      border-radius: 4px;
      color: #b0b0b0;
      font-size: 12px;
      cursor: pointer;
    `;
    clearBtn.addEventListener('mouseenter', () => {
      clearBtn.style.background = '#5a4444';
    });
    clearBtn.addEventListener('mouseleave', () => {
      clearBtn.style.background = '#4a3636';
    });
    clearBtn.addEventListener('click', () => {
      this.callbacks.onClearLod();
    });
    lodContainer.appendChild(clearBtn);

    // Inject LOD buttons into folder
    const lodFolderElement = lodFolder.element;
    const lodContainerEl = lodFolderElement.querySelector('.tp-fldv_c');
    if (lodContainerEl) {
      lodContainerEl.appendChild(lodContainer);
    }
  }

  private setupTFCanvasEvents(): void {
    const canvas = this.tfCanvas;
    let lastClickTime = 0;

    const getPointAt = (x: number, y: number): number => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (x - rect.left) * scaleX;
      const canvasY = (y - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      for (let i = 0; i < points.length; i++) {
        const px = points[i]!.x * canvas.width;
        const py = canvas.height - points[i]!.y * canvas.height;
        const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
        if (dist < 10) return i;
      }
      return -1;
    };

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const now = Date.now();
      const isDoubleClick = now - lastClickTime < 300;
      lastClickTime = now;

      const pointIndex = getPointAt(e.clientX, e.clientY);

      if (isDoubleClick && pointIndex > 0 && pointIndex < this.transferFunction.getOpacityPoints().length - 1) {
        // Double click on non-endpoint: remove point
        const points = this.transferFunction.getOpacityPoints();
        points.splice(pointIndex, 1);
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      } else if (pointIndex >= 0) {
        // Start dragging existing point
        this.isDraggingPoint = true;
        this.dragPointIndex = pointIndex;
      } else {
        // Add new point
        const x = canvasX / canvas.width;
        const y = 1 - canvasY / canvas.height;
        const points = this.transferFunction.getOpacityPoints();
        points.push({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
        this.transferFunction.setOpacityPoints(points);
        this.updateTFPreview();
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.isDraggingPoint) return;

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const points = this.transferFunction.getOpacityPoints();
      const point = points[this.dragPointIndex];
      if (!point) return;

      // Endpoints can only move vertically
      if (this.dragPointIndex === 0) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else if (this.dragPointIndex === points.length - 1) {
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      } else {
        point.x = Math.max(0.01, Math.min(0.99, canvasX / canvas.width));
        point.y = Math.max(0, Math.min(1, 1 - canvasY / canvas.height));
      }

      this.transferFunction.setOpacityPoints(points);
      this.updateTFPreview();
    });

    const stopDrag = () => {
      this.isDraggingPoint = false;
      this.dragPointIndex = -1;
    };

    canvas.addEventListener('mouseup', stopDrag);
    canvas.addEventListener('mouseleave', stopDrag);
  }

  private updateTFPreview(): void {
    this.transferFunction.renderPreview(this.tfCanvas);
  }

  private updateVisibility(): void {
    const mode = this.params.renderMode;

    // ISO section only visible in ISO mode
    if (this.isoFolder) {
      this.isoFolder.hidden = mode !== 'iso';
    }

    // TF section visible in DVR and MIP modes
    if (this.tfFolder) {
      this.tfFolder.hidden = mode === 'iso';
    }
  }
}
