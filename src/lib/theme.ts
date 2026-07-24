export type UiTheme = "dark" | "light";

const STORAGE_KEY = "ciallo-studio.theme.v2";
const LEGACY_KEY = "ciallo-studio.theme.v1";

export function normalizeTheme(raw: string | null | undefined): UiTheme {
  if (raw === "light" || raw === "graphite-light" || raw === "classic") return "light";
  // theme2 / atelier / softlab / dark / null → dark
  return "dark";
}

export function loadTheme(): UiTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
    return normalizeTheme(raw);
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", theme === "dark" ? "#0f1115" : "#f4f6fa");
  }
}

export function saveTheme(theme: UiTheme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function toggleTheme(theme: UiTheme): UiTheme {
  return theme === "dark" ? "light" : "dark";
}
