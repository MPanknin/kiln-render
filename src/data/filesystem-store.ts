/**
 * FileSystemStore - Zarrita store adapter for File System Access API
 */

export class FileSystemStore {
  constructor(private dirHandle: FileSystemDirectoryHandle) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const parts = key.split('/').filter(p => p);
      let currentHandle: FileSystemDirectoryHandle | FileSystemFileHandle = this.dirHandle;

      for (let i = 0; i < parts.length - 1; i++) {
        currentHandle = await (currentHandle as FileSystemDirectoryHandle).getDirectoryHandle(parts[i]!);
      }

      const fileHandle = await (currentHandle as FileSystemDirectoryHandle).getFileHandle(parts[parts.length - 1]!);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (e) {
      return undefined;
    }
  }

  async has(key: string): Promise<boolean> {
    const data = await this.get(key);
    return data !== undefined;
  }
}
