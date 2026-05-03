/**
 * Preload script — runs in the renderer context with Node.js access.
 *
 * Exposes a minimal `electronAPI` surface to the renderer via contextBridge.
 * Keeping this surface small is a security best-practice: only add methods
 * that the UI genuinely needs.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ElectronAPI {
  /** Returns the localhost port on which the embedded API server is listening. */
  getApiPort(): number | null;
  /**
   * Register a callback that fires when the tray menu triggers a navigation
   * action (e.g. "show"). Reserved for future tray-initiated UI navigation.
   */
  onTrayAction(callback: (action: string) => void): void;
}

contextBridge.exposeInMainWorld("electronAPI", {
  getApiPort(): number | null {
    const raw = process.env["ELECTRON_API_PORT"];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  onTrayAction(callback: (action: string) => void): void {
    ipcRenderer.on("tray-action", (_event, action: string) => {
      callback(action);
    });
  },
} satisfies ElectronAPI);
