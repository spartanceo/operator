import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type OperatorSettings,
} from "@/lib/operator-storage";

interface SettingsContextValue {
  settings: OperatorSettings;
  update: (patch: Partial<OperatorSettings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<OperatorSettings>(() =>
    loadSettings(),
  );

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const update = useCallback((patch: Partial<OperatorSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, update, reset }),
    [settings, update, reset],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used inside a <SettingsProvider>.");
  }
  return ctx;
}
