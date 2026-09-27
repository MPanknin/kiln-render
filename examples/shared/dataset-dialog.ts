/** Shared dataset-loading dialog — markup injection, local/remote load wiring, error display. */

import {
  preValidateRemoteZarr,
  preValidateLocalZarr,
  promptForZarrDirectory,
  clearHandle,
} from 'kiln-render';

// Inline SVGs matching the toolbar icon style (V-3 — replaces emoji).
const FOLDER_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v.64c.57.265.94.876.856 1.546l-.64 5.124A2.5 2.5 0 0 1 12.733 15H3.266a2.5 2.5 0 0 1-2.481-2.19l-.64-5.124A1.5 1.5 0 0 1 1 6.14V3.5zM2 6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.629-2.174-1.154C6.374 3.334 5.82 3 5.264 3H2.5a.5.5 0 0 0-.5.5V6z"/></svg>';
const GLOBE_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14ZM8.5 2.06c.6.36 1.34 1.15 1.93 2.44H8.5V2.06Zm0 3.44h1.98c.19.6.32 1.28.34 2h-2.32v-2Zm0 3h2.32c-.02.72-.15 1.4-.34 2H8.5v-2Zm0 3h1.93c-.59 1.29-1.33 2.08-1.93 2.44v-2.44ZM7.5 13.94c-.6-.36-1.34-1.15-1.93-2.44H7.5v2.44Zm0-3.44H5.18a8.5 8.5 0 0 1-.34-2H7.5v2Zm0-3H5.16c.02-.72.15-1.4.34-2H7.5v2Zm0-3H5.57c.59-1.29 1.33-2.08 1.93-2.44V4.5ZM4.24 4.5A8.7 8.7 0 0 0 3.6 6.5H2.06A6 6 0 0 1 4.24 4.5ZM2.06 7.5H3.6c.04.7.16 1.38.34 2H2.06a6 6 0 0 1 0-2Zm.18 3H3.9a8.7 8.7 0 0 0 .74 2H2.24a6 6 0 0 1 0 0Zm9.62 0h1.64a6 6 0 0 1-2.38 2 8.6 8.6 0 0 0 .74-2Zm2.08-1h-1.98c.18-.62.3-1.3.34-2h1.54a6 6 0 0 1 .1 2Zm-.1-3h-1.54a8.5 8.5 0 0 0-.34-2h1.98c.09.32.15.66.18 1a6 6 0 0 1-.28 1Zm-1.9-3a8.7 8.7 0 0 0-.74-2 6 6 0 0 1 2.38 2h-1.64Z"/></svg>';

export interface DatasetDialogOptions {
  /** Description shown under "Remote URL" — differs slightly per viewer. */
  remoteDescription: string;
  /** Optional "Supported formats ↗" link in the dialog header. */
  docsLink?: string;
}

/** Injects the dialog markup into the document and wires up all its handlers. */
export function mountDatasetDialog(opts: DatasetDialogOptions): void {
  const docsLinkHTML = opts.docsLink
    ? `<a href="${opts.docsLink}" target="_blank" rel="noopener" class="dialog-docs-link">Supported formats ↗</a>`
    : '';

  const dialog = document.createElement('dialog');
  dialog.id = 'dataset-dialog';
  dialog.innerHTML = `
    <div class="dialog-header">
      <h3>Load Dataset</h3>
      ${docsLinkHTML}
    </div>
    <div class="dialog-content">
      <div class="load-option">
        <div class="load-option-title">${FOLDER_ICON_SVG}Local Zarr Directory</div>
        <div class="load-option-desc">Select a .zarr or .ome.zarr folder from your computer (Chrome/Edge only)</div>
        <button id="local-zarr-btn" class="load-btn">
          <span>Choose Directory</span>
        </button>
      </div>
      <div class="load-option">
        <div class="load-option-title">${GLOBE_ICON_SVG}Remote URL</div>
        <div class="load-option-desc">${opts.remoteDescription}</div>
        <div class="remote-input-group">
          <input type="text" id="remote-url-input" class="remote-input" placeholder="https://example.com/dataset.ome.zarr">
          <button id="remote-load-btn" class="load-btn" style="width: auto;">Load</button>
        </div>
      </div>
    </div>
    <div id="dialog-error" class="dialog-error"></div>
    <div class="dialog-footer">
      <button id="dialog-cancel-btn" class="cancel-btn">Cancel</button>
    </div>
  `;
  document.body.appendChild(dialog);

  const loadDatasetBtn = document.getElementById('load-dataset-btn');
  const localBtn = document.getElementById('local-zarr-btn') as HTMLButtonElement | null;
  const remoteInput = document.getElementById('remote-url-input') as HTMLInputElement | null;
  const remoteLoadBtn = document.getElementById('remote-load-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('dialog-cancel-btn');
  const errorEl = document.getElementById('dialog-error');

  if (!loadDatasetBtn) return;

  const clearError = () => {
    if (errorEl) errorEl.style.display = 'none';
  };

  loadDatasetBtn.addEventListener('click', () => {
    clearError();
    dialog.showModal();
  });

  cancelBtn?.addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right ||
        e.clientY < rect.top  || e.clientY > rect.bottom) {
      dialog.close();
    }
  });

  if (localBtn) {
    if (!('showDirectoryPicker' in window)) {
      localBtn.disabled = true;
      localBtn.textContent = 'Not supported in this browser';
    } else {
      localBtn.addEventListener('click', async () => {
        clearError();
        let handle: FileSystemDirectoryHandle;
        try {
          handle = await promptForZarrDirectory();
        } catch (e) {
          const msg = e instanceof Error ? e.message : '';
          if (!msg.includes('cancelled') && !msg.includes('aborted')) {
            showDialogError([msg || 'Failed to open directory']);
          }
          return;
        }

        const orig = localBtn.textContent ?? '';
        localBtn.disabled = true;
        localBtn.textContent = 'Checking…';
        try {
          const reasons = await preValidateLocalZarr(handle);
          if (reasons.length > 0) {
            await clearHandle();
            showDialogError(reasons);
            return;
          }
        } catch (_) {
          showDialogError(['Could not read dataset metadata — is this a valid .zarr directory?']);
          await clearHandle();
          return;
        } finally {
          localBtn.disabled = false;
          localBtn.textContent = orig;
        }

        window.location.href = window.location.pathname + '?local=true';
      });
    }
  }

  if (remoteInput && remoteLoadBtn) {
    const loadRemote = async () => {
      const url = remoteInput.value.trim();
      if (!url) return;
      clearError();

      if (url.includes('.zarr')) {
        const origText = remoteLoadBtn.textContent ?? 'Load';
        remoteLoadBtn.disabled = true;
        remoteLoadBtn.textContent = 'Checking…';
        try {
          const reasons = await preValidateRemoteZarr(url);
          if (reasons.length > 0) {
            showDialogError(reasons);
            return;
          }
        } catch (_) {
          showDialogError(['Could not reach dataset — check the URL is correct and publicly accessible']);
          return;
        } finally {
          remoteLoadBtn.disabled = false;
          remoteLoadBtn.textContent = origText;
        }
      }

      window.location.href = window.location.pathname + '?dataset=' + encodeURIComponent(url);
    };

    remoteLoadBtn.addEventListener('click', loadRemote);
    remoteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRemote(); });
  }
}

/** Shows a dataset-rejection error in the dialog (also opens it if not already open). */
export function showDialogError(reasons: string[], cleanUrl = false): void {
  if (cleanUrl) {
    const wasLocal = new URLSearchParams(window.location.search).get('local') === 'true';
    history.replaceState({}, '', window.location.pathname);
    if (wasLocal) clearHandle().catch(() => {});
  }

  const dialog = document.getElementById('dataset-dialog') as HTMLDialogElement | null;
  const errorEl = document.getElementById('dialog-error');
  if (!dialog || !errorEl) return;

  // Reasons echo dataset metadata (scale values, dimensions, axis names), which
  // anyone can put behind a ?dataset= link: render them as text, never as HTML.
  const heading = document.createElement('strong');
  heading.textContent = 'Dataset not supported';
  const list = document.createElement('ul');
  for (const reason of reasons) {
    const item = document.createElement('li');
    item.textContent = reason;
    list.appendChild(item);
  }
  errorEl.replaceChildren(heading, list);
  errorEl.style.display = 'block';

  if (!dialog.open) dialog.showModal();
}
