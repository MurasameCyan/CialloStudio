import { useEffect, useState } from "react";
import { clearLogs, subscribeLogs, type LogEntry } from "@/lib/logger";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function levelClass(level: LogEntry["level"]): string {
  if (level === "ok") return "log-ok";
  if (level === "warn") return "log-warn";
  if (level === "error") return "log-error";
  return "log-info";
}

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => subscribeLogs(setEntries), []);

  return (
    <section className="panel log-panel">
      <div className="log-panel-head">
        <div>
          <h2 className="panel-title" style={{ marginBottom: 0 }}>
            运行日志
          </h2>
          <p className="panel-desc" style={{ marginBottom: 0 }}>
            每次请求的 URL、状态、改写结果都会记在这里。报错时请把红色日志发我。
          </p>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开"}
          </button>
          <button type="button" className="btn btn-danger" onClick={clearLogs} disabled={entries.length === 0}>
            清空
          </button>
        </div>
      </div>

      {open ? (
        entries.length === 0 ? (
          <div className="empty">还没有日志。去「管理」测试连接，或在「生图」发起一次生成。</div>
        ) : (
          <div className="log-list">
            {entries.map((entry) => (
              <article key={entry.id} className={`log-item ${levelClass(entry.level)}`}>
                <div className="log-meta">
                  <span className="log-level">{entry.level.toUpperCase()}</span>
                  <span className="log-time">{formatTime(entry.ts)}</span>
                </div>
                <div className="log-message">{entry.message}</div>
                {entry.detail ? <pre className="log-detail">{entry.detail}</pre> : null}
              </article>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}
