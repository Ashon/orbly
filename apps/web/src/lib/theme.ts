import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
const KEY = "verda.theme";

const readMode = (): ThemeMode => {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
};

/** Follows the system setting, and remembers the choice when picked manually. */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // Even if saving fails, it still applies for this session.
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
  const next = () =>
    setMode((current) =>
      current === "system" ? "light" : current === "light" ? "dark" : "system"
    );
  return { mode, next };
}
