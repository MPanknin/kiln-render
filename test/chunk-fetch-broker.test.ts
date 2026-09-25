import { describe, it, expect, vi } from 'vitest';
import { ChunkFetchBroker } from '../src/data/chunk-fetch-broker.js';
import type { AbsolutePath } from 'zarrita';

function deferredSource() {
  const pending = new Map<string, { resolve: (v: Uint8Array | undefined) => void; reject: (e: unknown) => void; signal?: AbortSignal }>();
  const calls: string[] = [];
  const source = {
    get: vi.fn((key: AbsolutePath, opts?: RequestInit) => new Promise<Uint8Array | undefined>((resolve, reject) => {
      calls.push(key);
      pending.set(key, { resolve, reject, signal: opts?.signal ?? undefined });
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })),
  };
  return { source, pending, calls };
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe('ChunkFetchBroker', () => {
  it('coalesces concurrent requests for the same key into one fetch', async () => {
    const { source, pending, calls } = deferredSource();
    const b = new ChunkFetchBroker(source, 16);
    const a = b.get('/0/1/2' as AbsolutePath);
    const c = b.get('/0/1/2' as AbsolutePath);
    await tick();
    expect(calls).toEqual(['/0/1/2']);
    pending.get('/0/1/2')!.resolve(new Uint8Array([7]));
    expect((await a)![0]).toBe(7);
    expect((await c)![0]).toBe(7);
  });

  it('bounds in-flight fetches and drains the queue in order', async () => {
    const { source, pending, calls } = deferredSource();
    const b = new ChunkFetchBroker(source, 2);
    const ps = ['a', 'b', 'c', 'd'].map(k => b.get(`/${k}` as AbsolutePath));
    await tick();
    expect(calls).toEqual(['/a', '/b']);
    pending.get('/a')!.resolve(new Uint8Array(1));
    await tick();
    expect(calls).toEqual(['/a', '/b', '/c']);
    pending.get('/b')!.resolve(undefined);
    await tick();
    expect(calls).toEqual(['/a', '/b', '/c', '/d']);
    pending.get('/c')!.resolve(new Uint8Array(1));
    pending.get('/d')!.resolve(new Uint8Array(1));
    await Promise.all(ps);
    expect(b.pending).toBe(0);
  });

  it('a queued request cancelled before it starts never hits the source', async () => {
    const { source, pending, calls } = deferredSource();
    const b = new ChunkFetchBroker(source, 1);
    const first = b.get('/a' as AbsolutePath);
    const ctl = new AbortController();
    const second = b.get('/b' as AbsolutePath, ctl.signal);
    ctl.abort();
    await expect(second).rejects.toThrow(/Aborted/);
    pending.get('/a')!.resolve(new Uint8Array(1));
    await first;
    await tick();
    expect(calls).toEqual(['/a']);
  });

  it('keeps a shared fetch alive while any waiter remains', async () => {
    const { source, pending } = deferredSource();
    const b = new ChunkFetchBroker(source, 4);
    const c1 = new AbortController();
    const p1 = b.get('/k' as AbsolutePath, c1.signal);
    const p2 = b.get('/k' as AbsolutePath);
    await tick();
    c1.abort();
    await tick();
    // one waiter left → the underlying fetch must not be aborted
    expect(pending.get('/k')!.signal!.aborted).toBe(false);
    pending.get('/k')!.resolve(new Uint8Array([1]));
    expect((await p2)![0]).toBe(1);
    await p1.catch(() => undefined); // the released waiter may settle either way
  });

  it('aborts the underlying fetch once the last waiter cancels', async () => {
    const { source, pending, calls } = deferredSource();
    const b = new ChunkFetchBroker(source, 4);
    const c1 = new AbortController();
    const p1 = b.get('/k' as AbsolutePath, c1.signal);
    await tick();
    expect(calls).toEqual(['/k']);
    c1.abort();
    await expect(p1).rejects.toThrow(/Aborted/);
    expect(pending.get('/k')!.signal!.aborted).toBe(true);
  });
});
