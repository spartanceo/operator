export type ThemeMode = "dark" | "light";

export interface OperatorSettings {
  ollamaUrl: string;
  defaultModel: string;
  cloudMode: boolean;
  workspacePath: string;
  // Voice interface (Task #9). All voice fields default to "off" so the
  // experience is opt-in and microphone permission is never requested
  // until the user explicitly enables it from the chat header or settings.
  voiceMode: boolean;
  voiceName: string;
  voiceSpeed: number;
  voiceAutoplay: boolean;
  wakeWordEnabled: boolean;
  wakeWordPhrase: string;
}

const THEME_KEY = "omninity.operator.theme";
const SETTINGS_KEY = "omninity.operator.settings";

export const DEFAULT_SETTINGS: OperatorSettings = {
  ollamaUrl: "http://127.0.0.1:11434",
  defaultModel: "llama3.1:8b",
  cloudMode: false,
  workspacePath: "~/Omninity/workspace",
  voiceMode: false,
  voiceName: "ember",
  voiceSpeed: 1,
  voiceAutoplay: true,
  wakeWordEnabled: false,
  wakeWordPhrase: "hey op",
};

function safeWindow(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadTheme(): ThemeMode {
  const ls = safeWindow();
  const value = ls?.getItem(THEME_KEY);
  return value === "light" ? "light" : "dark";
}

export function saveTheme(mode: ThemeMode): void {
  safeWindow()?.setItem(THEME_KEY, mode);
}

export function loadSettings(): OperatorSettings {
  const ls = safeWindow();
  const raw = ls?.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<OperatorSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: OperatorSettings): void {
  safeWindow()?.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
