/** Keyboard shortcuts plus a '?' overlay listing them (also opened via #help-btn). */

export interface Shortcut {
  /** KeyboardEvent.key values that trigger it (case-sensitive, so list 'a' and 'A') */
  keys: string[];
  /** Key text shown in the help overlay */
  display: string;
  label: string;
  /** Omit for keys handled elsewhere that should still be listed */
  run?: (e: KeyboardEvent) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function mountShortcuts(shortcuts: Shortcut[]): void {
  const overlay = document.createElement('div');
  overlay.className = 'shortcut-help';
  overlay.hidden = true;
  const rows = shortcuts
    .map((s) => `<div class="shortcut-row"><kbd>${s.display}</kbd><span>${s.label}</span></div>`)
    .join('');
  overlay.innerHTML = `<div class="shortcut-help-panel"><div class="ctl-eyebrow">Keyboard shortcuts</div>${rows}` +
    `<div class="shortcut-row"><kbd>?</kbd><span>Show / hide this help</span></div></div>`;
  document.body.appendChild(overlay);

  const toggleHelp = (show = overlay.hidden) => { overlay.hidden = !show; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) toggleHelp(false); });
  document.getElementById('help-btn')?.addEventListener('click', () => toggleHelp());

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === '?') return toggleHelp();
    if (e.key === 'Escape') return toggleHelp(false);
    const shortcut = shortcuts.find((s) => s.run && s.keys.includes(e.key));
    if (!shortcut) return;
    e.preventDefault();
    shortcut.run!(e);
  });
}

/** Axis snap handler shared by both viewers: x/y/z = from +axis, Shift = from −axis. */
export function axisSnapShortcut(snap: (dir: [number, number, number]) => void): Shortcut {
  return {
    keys: ['x', 'y', 'z', 'X', 'Y', 'Z'],
    display: 'X Y Z',
    label: 'View from +axis (Shift: −axis)',
    run: (e) => {
      const s = e.shiftKey ? -1 : 1;
      const i = 'xyz'.indexOf(e.key.toLowerCase());
      snap([i === 0 ? s : 0, i === 1 ? s : 0, i === 2 ? s : 0]);
    },
  };
}
