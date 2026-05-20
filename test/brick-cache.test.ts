import { describe, it, expect } from 'vitest';
import { BrickCache } from '../src/streaming/brick-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeData(bytes: number, fill = 0): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

// ---------------------------------------------------------------------------
// Basic get / put
// ---------------------------------------------------------------------------

describe('BrickCache — basic operations', () => {
  it('returns undefined for a missing key', () => {
    const cache = new BrickCache();
    expect(cache.get('0:0/0/0')).toBeUndefined();
  });

  it('stores and retrieves a single entry', () => {
    const cache = new BrickCache();
    const data = makeData(100, 7);
    cache.put('a', data);
    expect(cache.get('a')).toBe(data);
  });

  it('overwrites an existing entry with the same key', () => {
    const cache = new BrickCache();
    const first = makeData(100, 1);
    const second = makeData(200, 2);
    cache.put('a', first);
    cache.put('a', second);
    expect(cache.get('a')).toBe(second);
  });

  it('clear removes all entries', () => {
    const cache = new BrickCache();
    cache.put('a', makeData(100));
    cache.put('b', makeData(100));
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Byte budget / eviction
// ---------------------------------------------------------------------------

describe('BrickCache — byte budget', () => {
  it('evicts the oldest entry when budget is exceeded', () => {
    // Budget: 200 bytes, entries are 100 bytes each
    const cache = new BrickCache(200);
    cache.put('a', makeData(100));
    cache.put('b', makeData(100));
    // Adding 'c' (100 bytes) must evict 'a' (oldest)
    cache.put('c', makeData(100));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('evicts multiple oldest entries to make room', () => {
    const cache = new BrickCache(100);
    cache.put('a', makeData(40));
    cache.put('b', makeData(40));
    // Adding 80 bytes requires evicting both a and b (80 bytes)
    cache.put('c', makeData(80));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('updating a key with a larger value corrects byte accounting', () => {
    const cache = new BrickCache(200);
    cache.put('a', makeData(50));
    cache.put('b', makeData(50));
    // Replace 'a' with a 50-byte entry — total stays at 100, no eviction needed
    cache.put('a', makeData(50, 9));
    expect(cache.get('b')).toBeDefined();
  });

  it('a single entry larger than budget evicts everything else', () => {
    const cache = new BrickCache(100);
    cache.put('a', makeData(60));
    cache.put('b', makeData(60)); // triggers eviction of 'a', total = 60
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LRU ordering
// ---------------------------------------------------------------------------

describe('BrickCache — LRU promotion', () => {
  it('get promotes an entry so it is not the next eviction target', () => {
    const cache = new BrickCache(200);
    const a = makeData(100);
    const b = makeData(100);
    cache.put('a', a);
    cache.put('b', b);

    // Access 'a' — it becomes the most recently used
    cache.get('a');

    // Adding another 100-byte entry must evict 'b' (now the oldest), not 'a'
    cache.put('c', makeData(100));
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('multiple gets keep the accessed entry alive through several evictions', () => {
    const cache = new BrickCache(200);
    cache.put('a', makeData(100));
    cache.put('b', makeData(100));

    cache.get('a'); // promote a
    cache.put('c', makeData(100)); // evicts b
    cache.get('a'); // promote a again
    cache.put('d', makeData(100)); // evicts c

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
  });
});
