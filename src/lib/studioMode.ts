export type StudioMode = "console" | "chat";

const KEY = "ciallo.studio.mode.v1";

export function loadStudioMode(): StudioMode {
  try {
    return localStorage.getItem(KEY) === "chat" ? "chat" : "console";
  } catch {
    return "console";
  }
}

export function saveStudioMode(mode: StudioMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
}
