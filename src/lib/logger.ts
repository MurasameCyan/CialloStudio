export type LogLevel = "info" | "ok" | "warn" | "error";

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
  detail?: string;
};

type Listener = (entries: LogEntry[]) => void;

const MAX_LOGS = 200;
const listeners = new Set<Listener>();
let entries: LogEntry[] = [];

function emit(): void {
  const snapshot = entries.slice();
  for (const listener of listeners) listener(snapshot);
}

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(entries.slice());
  return () => {
    listeners.delete(listener);
  };
}

export function clearLogs(): void {
  entries = [];
  emit();
}

export function getLogs(): LogEntry[] {
  return entries.slice();
}

export function log(level: LogLevel, message: string, detail?: unknown): void {
  let detailText: string | undefined;
  if (detail !== undefined && detail !== null) {
    if (typeof detail === "string") {
      detailText = detail;
    } else if (detail instanceof Error) {
      detailText = `${detail.name}: ${detail.message}`;
    } else {
      try {
        detailText = JSON.stringify(detail, null, 2);
      } catch {
        detailText = String(detail);
      }
    }
  }

  entries = [
    {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
      level,
      message,
      detail: detailText,
    },
    ...entries,
  ].slice(0, MAX_LOGS);
  emit();

  const line = detailText ? `${message} | ${detailText}` : message;
  if (level === "error") console.error(`[Ciallo] ${line}`);
  else if (level === "warn") console.warn(`[Ciallo] ${line}`);
  else console.log(`[Ciallo] ${line}`);
}
