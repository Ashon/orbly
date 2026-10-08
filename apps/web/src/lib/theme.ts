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

/** 시스템 설정을 따르고, 직접 고르면 그 값을 기억한다. */
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
      // 저장하지 못해도 이번 실행에서는 적용된다.
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
