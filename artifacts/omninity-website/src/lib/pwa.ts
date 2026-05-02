/**
 * PWA helpers — service-worker registration and install-prompt capture.
 *
 * Only registers when the page is served over a secure context (https or
 * localhost) and skips entirely in unsupported browsers. The install prompt
 * is captured globally so the mobile dashboard can show its own
 * "Add to Home Screen" button instead of the browser's default banner.
 */

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(available: boolean) => void>();

export function initPwa(swPath: string = "/sw.js"): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  void navigator.serviceWorker
    .register(swPath, { scope: "/" })
    .catch(() => {
      // Registration failure is non-fatal — the dashboard still works.
    });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l(true));
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    listeners.forEach((l) => l(false));
  });
}

export function canInstallPwa(): boolean {
  return deferredPrompt !== null;
}

export function onInstallAvailable(cb: (available: boolean) => void): () => void {
  listeners.add(cb);
  cb(canInstallPwa());
  return () => {
    listeners.delete(cb);
  };
}

export async function promptInstallPwa(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  listeners.forEach((l) => l(false));
  return choice.outcome;
}

export function detectPlatform(): "ios" | "android" | "web" {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "web";
}
