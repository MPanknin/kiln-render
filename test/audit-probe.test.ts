// Reproduction probes from docs/audits/Kiln-Streaming-Audit-and-Handover.md (Appendix A).
//
// Unless a probe says otherwise, its assertions pin the CURRENT, KNOWN-WRONG behaviour so
// the defect stays reproducible. When you fix a finding, flip that probe to assert the
// correct result and keep the scenario. Probes that already assert correct behaviour are
// marked "FIXED" in their title.

import { describe, it, expect, vi } from 'vitest';
import { computeBrickChunkFootprint, estimateBrickChunkFanout, clampedLutEntry } from '../src/data/chunk-math.js';
import { DatasetConfig, computeAtlasGrid } from '../src/core/config.js';
import { StreamingManager } from '../src/streaming/streaming-manager.js';
import { AtlasAllocator } from '../src/streaming/atlas-allocator.js';
import { LocalZarrDataProvider } from '../src/data/local-zarr-provider.js';
import { ZarrWorkerPool } from '../src/data/zarr-worker-pool.js';
import { IndirectionTable } from '../src/core/indirection.js';
import { ShardedDataProvider } from '../src/data/sharded-provider.js';
import { open, root } from 'zarrita';
import { gzipSync } from 'fflate';

describe('Audit probes: assertions describe current behavior, not desired behavior', () => {
  it('FIXED: chunk fanout estimate is never below the exact footprint (was 8 for 64³ chunks, exact is 27)', () => {
    for (const cs of [64, 96, 128]) {
      const p = {scaleX:1,scaleY:1,scaleZ:1,actualDimX:1024,actualDimY:1024,actualDimZ:1024,csx:cs,csy:cs,csz:cs};
      let max=0;
      for(let b=0;b<16;b++) {
        const f=computeBrickChunkFootprint(p,b,b,b,64,66);
        max=Math.max(max,(f.maxCx-f.minCx+1)*(f.maxCy-f.minCy+1)*(f.maxCz-f.minCz+1));
      }
      const estimate=estimateBrickChunkFanout(p,66);
      console.log('FANOUT',JSON.stringify({cs,estimate,actualMax:max}));
      expect(max).toBe(cs===64?27:8);
      expect(estimate).toBe(max);
    }
  });
  it('measures a whole-plane source footprint and worker routing', () => {
    const p={scaleX:1,scaleY:1,scaleZ:1,actualDimX:2048,actualDimY:2048,actualDimZ:35,csx:2048,csy:2048,csz:1};
    const f=computeBrickChunkFootprint(p,12,12,0,64,66);
    expect(f.maxCz-f.minCz+1).toBe(35);
    const pool:any=Object.create(ZarrWorkerPool.prototype);
    pool.workers=Array(8).fill({}); pool.lodParams=[p];pool.logicalBrickSize=64;
    const workers=Array.from({length:4},(_,ch)=>pool.workerIndexFor(0,12,12,0,ch));
    console.log('SLAB',JSON.stringify({chunks:35,decodedMiB:35*2048*2048*2/2**20,usefulCoreMiB:64*64*35*2/2**20,workers}));
    expect(pool.workerIndexFor(0,0,0,0,0)).toBe(pool.workerIndexFor(0,31,31,0,0));
  });
  it('FIXED: non-multiple-of-64 AABB ends at voxel 64, not at the volume centre (was 0)', () => {
    const s:any=Object.create(StreamingManager.prototype);
    s.config=new DatasetConfig([100,100,100]);s.levelsByLod=[{brickGrid:[2,2,2]}];
    const a=s.getBrickAABB(0,0,0,0);
    console.log('AABB',JSON.stringify({current:a.max[0],expected:64/100-0.5}));
    expect(a.max[0]).toBeCloseTo(64/100-0.5);
  });
  it('FIXED: anisotropic SSE uses the largest physical voxel (was 10x too small)', () => {
    const s:any=Object.create(StreamingManager.prototype);
    s.config=new DatasetConfig([2048,2048,35],[1,1,10]);s.metadata={dimensions:[2048,2048,35]};
    console.log('SSE',JSON.stringify({current:s.getVoxelWorldSize(0),largestVoxel:10/2048,ratio:(10/2048)/s.getVoxelWorldSize(0)}));
    expect((10/2048)/s.getVoxelWorldSize(0)).toBeCloseTo(1);
  });
  it('shows fixed isotropic virtual z resamples an XY-only pyramid', () => {
    const coords=Array.from({length:5},(_,i)=>clampedLutEntry(i,7,35,1,0,34).chunkIdx);
    console.log('Z_CORE_SAMPLES',JSON.stringify(coords));
    expect(coords).toEqual([0,7,14,21,28]);
  });
  it('FIXED: continuous arrivals cannot postpone the redraw notification past the max wait (was 5050 ms)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const s:any=Object.create(StreamingManager.prototype);
      s.resetAccumulationTimer=null;s.firstPendingResetAt=null;s.contentVersionCounter=0;
      const times:number[]=[];s.onResetAccumulation=vi.fn(()=>times.push(performance.now()));
      for(let i=0;i<100;i++){s.notifyContentChanged();vi.advanceTimersByTime(50);}
      console.log('DEBOUNCE',JSON.stringify({arrivals:100,spacingMs:50,firstCallbackMs:times[0],callbacks:times.length}));
      expect(times[0]).toBeLessThanOrEqual(250);
      expect(times.length).toBe(20);
      expect(s.contentVersion).toBe(100);
    } finally {vi.useRealTimers();}
  });
  it('shows live desired slots remain unevictable indefinitely', () => {
    const a=new AtlasAllocator(2);
    for(let i=0;i<8;i++)expect(a.allocate(0)).not.toBeNull();
    for(let f=10;f<=600;f+=10) {
      for(let i=0;i<8;i++)a.touch(i,f);
      expect(a.hasEvictableSlot(f)).toBe(false);
    }
    console.log('CAPACITY',JSON.stringify({capacity:8,frames:600,evictable:false}));
  });
  it('shows a small configured atlas budget is exceeded by the minimum grid', () => {
    const a=computeAtlasGrid(4,2,128*2**20);
    const bytes=4*2*a.atlasSize**3;
    expect(bytes).toBeGreaterThan(128*2**20);
    console.log('BUDGET',JSON.stringify({...a,requestedMiB:128,actualMiB:bytes/2**20}));
  });
  it('FIXED: packed channel chunks address chunk 0 at the channel offset (was chunk 1, value 0)', async () => {
    const p:any=new LocalZarrDataProvider({name:'packed.zarr'} as any);
    p.metadata={name:'packed',dimensions:[1,1,1],brickSize:64,physicalBrickSize:66,maxLod:0,levels:[{lod:0,brickGrid:[1,1,1]}],bitDepth:8,numChannels:2};
    p.lodParams=[{scaleX:1,scaleY:1,scaleZ:1,actualDimX:1,actualDimY:1,actualDimZ:1,csx:1,csy:1,csz:1,shapePrefixLength:1,channelAxisIdx:0,channelChunkSize:2}];
    const getChunk=vi.fn(async (coords:number[])=>({shape:[2,1,1,1],stride:[1,1,1,1],data:coords[0]===0?new Uint8Array([11,99]):new Uint8Array([0,0])}));
    p.arrays=[{getChunk}];
    const result=await p.loadBrick(0,0,0,0,1);
    expect(getChunk).toHaveBeenCalledWith([0,0,0,0]);
    expect(result.data[0]).toBe(99);
    console.log('PACKED_CHANNEL',JSON.stringify({actual:result.data[0],expected:99,requested:getChunk.mock.calls[0]}));
  });
  it('FIXED: a fine empty marker supersedes a coarser mapping (was left at w=2)', () => {
    vi.stubGlobal('GPUTextureUsage',{TEXTURE_BINDING:4,COPY_DST:2});
    try {
      const d:any={createTexture:()=>({}),queue:{writeTexture:()=>{}}};
      const t:any=new IndirectionTable(d,new DatasetConfig([128,128,128]));
      t.setBrick(0,0,0,0,0,0,1);t.setEmpty(0,0,0,0);
      expect(t.data[3]).toBe(255);
      console.log('EMPTY_FINE',JSON.stringify({actualW:t.data[3],emptyW:255}));
    }finally{vi.unstubAllGlobals();}
  });
  it('FIXED: native strides of a real Zarrita F-order array are honoured (was 100)', async () => {
    const store=new Map<string,Uint8Array>();const enc=new TextEncoder();
    store.set('/.zarray',enc.encode(JSON.stringify({zarr_format:2,shape:[2,2,2],chunks:[2,2,2],dtype:'|u1',compressor:null,fill_value:0,order:'F',filters:null})));
    store.set('/0.0.0',new Uint8Array([0,100,10,110,1,101,11,111]));
    const arr=await open(root(store),{kind:'array'});
    const p:any=new LocalZarrDataProvider({name:'f.zarr'} as any);
    p.metadata={name:'f',dimensions:[2,2,2],brickSize:64,physicalBrickSize:66,maxLod:0,levels:[{lod:0,brickGrid:[1,1,1]}],bitDepth:8,numChannels:1};
    p.lodParams=[{scaleX:1,scaleY:1,scaleZ:1,actualDimX:2,actualDimY:2,actualDimZ:2,csx:2,csy:2,csz:2,shapePrefixLength:0,channelAxisIdx:-1,channelChunkSize:1}];p.arrays=[arr];
    const result=await p.loadBrick(0,0,0,0);
    const actual=result.data[1*66*66+1*66+2];
    console.log('STRIDE',JSON.stringify({actual,expected:1}));expect(actual).toBe(1);
  });
  it('reproduces concurrent duplicate binary index requests', async () => {
    const p:any=new ShardedDataProvider('https://fixture.invalid');
    p.rawMetadata={levels:[{lod:0,indexFile:'i.json'}]};
    let release!:()=>void; const gate=new Promise<void>(r=>release=r);
    const fetch=vi.fn(async()=>{await gate;return {ok:true,json:async()=>({entries:{}})};});vi.stubGlobal('fetch',fetch);
    try{
      const jobs=Array.from({length:8},()=>p.getBrickStats(0,0,0,0));
      expect(fetch).toHaveBeenCalledTimes(8);release();await Promise.all(jobs);
      console.log('INDEX_FETCHES',JSON.stringify({concurrentCallers:8,actual:fetch.mock.calls.length,desired:1}));
    }finally{vi.unstubAllGlobals();}
  });
  it('reproduces corruption of even-length gzip uint8 data', async () => {
    const postMessage=vi.fn();const worker:any={postMessage};vi.stubGlobal('self',worker);
    try {
      await import('../src/data/decompression-worker.js');
      const compressed=gzipSync(new Uint8Array([1,2,3,4]));
      worker.onmessage({data:{id:1,data:compressed.buffer,targetFormat:'r8unorm'}});
      const data=Array.from(new Uint8Array(postMessage.mock.calls[0][0].data));
      console.log('UINT8_GZIP',JSON.stringify({actual:data,expected:[1,2,3,4]}));
      expect(data).toEqual([2,4]);
    }finally{vi.unstubAllGlobals();}
  });
});
