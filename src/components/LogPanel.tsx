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

/** 仅站长控制台展示的运行日志面板（普通用户设置页不渲染） */
export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeLogs(setEntries), []);

  const errorCount = entries.filter((e) => e.level === "error").length;

  return (
    <section className="panel log-panel admin-log-panel" aria-label="运行日志">
      <div className="log-panel-head">
        <div>
          <div className="section-card-title">Diagnostics</div>
          <h3 className="admin-section-title">运行日志</h3>
          <p className="panel-desc admin-log-desc">
            {entries.length > 0
              ? `${entries.length} 条记录${errorCount > 0 ? ` · ${errorCount} 错误` : ""}`
              : "连接与创作请求会出现在这里"}
          </p>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={clearLogs}
            disabled={entries.length === 0}
          >
            清空
          </button>
        </div>
      </div>

      {open ? (
        entries.length === 0 ? (
          <div className="empty admin-log-empty">
            <span className="empty-title">暂无日志</span>
            测试连接或去创作页生成后再回来。
          </div>
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
