import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadTheme, saveTheme, type ThemeMode } from "@/lib/operator-storage";

interface ThemeContextValue {
  theme: ThemeMode;
  toggle: () => void;
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "dark") {
    root.classList.add("dark");
    root.classList.remove("light");
  } else {
    root.classList.remove("dark");
    root.classList.add("light");
  }
  root.dataset["theme"] = mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => loadTheme());

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo(
    () => ({ theme, toggle, setTheme }),
    [theme, toggle, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside a <ThemeProvider>.");
  }
  return ctx;
}
