/// <reference types="vite/client" />

declare module "mark.js" {
  class Mark {
    constructor(context: unknown);
    mark(keyword: string, options?: Record<string, unknown>): void;
    unmark(options?: Record<string, unknown>): void;
  }
  export default Mark;
}

type FileSystemPermissionMode = "read" | "readwrite";

interface FileSystemHandle {
  queryPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
  requestPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?: (options?: { mode?: FileSystemPermissionMode }) => Promise<FileSystemDirectoryHandle>;
}
