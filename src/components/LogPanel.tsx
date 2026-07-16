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

type Props = {
  /** 受控展开状态：由顶栏/App 控制，两个页面共用 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function LogPanel({ open, onOpenChange }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => subscribeLogs(setEntries), []);

  const errorCount = entries.filter((e) => e.level === "error").length;
  const latest = entries[0];

  return (
    <section className={`log-dock ${open ? "open" : "collapsed"}`} aria-label="运行日志">
      <div className="log-dock-bar">
        <div className="log-dock-summary">
          <strong>运行日志</strong>
          <span className="log-dock-count">
            {entries.length} 条{errorCount > 0 ? ` · ${errorCount} 错误` : ""}
          </span>
          {latest ? (
            <span className={`log-dock-latest ${levelClass(latest.level)}`}>
              {latest.message}
            </span>
          ) : (
            <span className="log-dock-latest">暂无记录</span>
          )}
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(!open)}>
            {open ? "收起" : "展开"}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={clearLogs}
            disabled={entries.length === 0}
          >
            清空
          </button>
        </div>
      </div>

      {open ? (
        entries.length === 0 ? (
          <div className="empty" style={{ margin: "0 12px 12px" }}>
            还没有日志。在「管理」测试连接，或在「生图」发起一次生成。
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
