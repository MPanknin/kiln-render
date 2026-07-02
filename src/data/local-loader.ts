/**
 * Local Zarr file picker and loader
 */

import { storeHandle, getHandle, clearHandle } from './handle-storage.js';

export function isFileSystemAccessSupported(): boolean {
  return 'showDirectoryPicker' in window;
}

export async function promptForZarrDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API not supported');
  }

  const dirHandle = await (window as any).showDirectoryPicker({
    mode: 'read',
  });

  await storeHandle(dirHandle);
  return dirHandle;
}

export async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getHandle();
  if (!handle) return null;

  try {
    await (handle as any).queryPermission({ mode: 'read' });
    return handle;
  } catch {
    await clearHandle();
    return null;
  }
}

export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permission = await (handle as any).requestPermission({ mode: 'read' });
  return permission === 'granted';
}
