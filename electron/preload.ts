import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('spotifyImporter', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getDefaultClientId: () => ipcRenderer.invoke('get-default-client-id'),
  getDroppedPath: (file: File) => webUtils.getPathForFile(file),
  pauseImport: () => ipcRenderer.invoke('pause-import'),
  cancelImport: () => ipcRenderer.invoke('cancel-import'),
  startImport: (options: { folder: string; playlistName: string; playlistDescription: string; clientId: string }) => (
    ipcRenderer.invoke('start-import', options)
  ),
  onEvent: (callback: (event: ImportEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ImportEvent) => callback(payload);
    ipcRenderer.on('import-event', listener);
    return () => ipcRenderer.removeListener('import-event', listener);
  },
});

type ImportEvent = {
  type: 'files' | 'status' | 'message' | 'complete' | 'error';
  files?: ImportFile[];
  file?: ImportFile;
  message?: string;
  playlistUrl?: string;
  reportPath?: string;
};

type ImportFile = {
  path: string;
  name: string;
  status: 'not imported yet' | 'matched' | 'imported' | 'failed';
  detail?: string;
};

declare global {
  interface Window {
    spotifyImporter: {
      chooseFolder: () => Promise<string | null>;
      getDefaultClientId: () => Promise<string>;
      getDroppedPath: (file: File) => string;
      pauseImport: () => Promise<void>;
      cancelImport: () => Promise<void>;
      startImport: (options: { folder: string; playlistName: string; playlistDescription: string; clientId: string }) => Promise<void>;
      onEvent: (callback: (event: ImportEvent) => void) => () => void;
    };
  }
}
