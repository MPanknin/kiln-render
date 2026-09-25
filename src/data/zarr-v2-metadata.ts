/**
 * Zarr v2 `.zarray` → zarrita v3 ArrayMetadata, so arrays can be constructed
 * from JSON we already fetched (main thread and workers) instead of letting
 * zarrita probe zarr.json/.zattrs/.zarray per array over the network.
 *
 * Mirrors zarrita's internal v2_to_v3_array_metadata (MIT, not exported).
 */

import type { ArrayMetadata, DataType } from 'zarrita';

export interface ZarrV2ArrayJson {
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: ({ id: string } & Record<string, unknown>) | null;
  filters?: ({ id: string } & Record<string, unknown>)[] | null;
  fill_value: unknown;
  order?: 'C' | 'F';
  dimension_separator?: '.' | '/';
}

const DTYPES: Record<string, string> = {
  b1: 'bool', i1: 'int8', u1: 'uint8', i2: 'int16', u2: 'uint16', i4: 'int32', u4: 'uint32',
  i8: 'int64', u8: 'uint64', f2: 'float16', f4: 'float32', f8: 'float64',
};

function coerceDtype(dtype: string): { dataType: string; endian?: 'little' | 'big' } {
  if (dtype === '|O') return { dataType: 'v2:object' };
  const m = /^([<|>])(.*)$/.exec(dtype);
  if (!m) throw new Error(`Invalid dtype: ${dtype}`);
  const [, endian, rest] = m as unknown as [string, string, string];
  const dataType = DTYPES[rest] ?? (rest.startsWith('S') || rest.startsWith('U') ? `v2:${rest}` : undefined);
  if (!dataType) throw new Error(`Unsupported or unknown dtype: ${dtype}`);
  return endian === '|' ? { dataType } : { dataType, endian: endian === '<' ? 'little' : 'big' };
}

export function v2ToV3ArrayMetadata(meta: ZarrV2ArrayJson, attributes: Record<string, unknown> = {}): ArrayMetadata<DataType> {
  const codecs: { name: string; configuration?: Record<string, unknown> }[] = [];
  const dtype = coerceDtype(meta.dtype);
  if (meta.order === 'F') codecs.push({ name: 'transpose', configuration: { order: 'F' } });
  if (dtype.endian === 'big') codecs.push({ name: 'bytes', configuration: { endian: 'big' } });
  for (const { id, ...configuration } of meta.filters ?? []) codecs.push({ name: id, configuration });
  if (meta.compressor) {
    const { id, ...configuration } = meta.compressor;
    codecs.push({ name: id, configuration });
  }
  return {
    zarr_format: 3,
    node_type: 'array',
    shape: meta.shape,
    data_type: dtype.dataType as DataType,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: meta.chunks } },
    chunk_key_encoding: { name: 'v2', configuration: { separator: meta.dimension_separator ?? '.' } },
    codecs,
    fill_value: meta.fill_value as ArrayMetadata<DataType>['fill_value'],
    attributes,
  } as ArrayMetadata<DataType>;
}

/** Compression label for VolumeMetadata.compression from a v2 compressor entry. */
export function compressionLabel(compressor: ZarrV2ArrayJson['compressor']): string | undefined {
  if (!compressor) return undefined;
  return compressor.id === 'blosc' ? `blosc/${(compressor as { cname?: string }).cname ?? 'lz4'}` : String(compressor.id);
}
