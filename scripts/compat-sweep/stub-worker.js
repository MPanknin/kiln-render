// Stand-in for the Vite-bundled chunk worker when the compatibility sweep runs
// Kiln's metadata code under bun: it answers setup messages and never loads bricks.
export default class StubWorker {
  onmessage = null;
  onerror = null;

  postMessage(message) {
    if (message.type === 'loadBrick' || message.type === 'cancel') return;
    queueMicrotask(() => this.onmessage?.({ data: { type: message.type, id: message.id } }));
  }

  terminate() {}
}
