import { useState, type FormEvent } from "react";
import { tryUnlockAdmin } from "@/lib/runtimeConfig";

type Props = {
  onUnlocked: () => void;
  onCancel: () => void;
};

export function AdminUnlock({ onUnlocked, onCancel }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const ok = await tryUnlockAdmin(password);
      if (ok) {
        onUnlocked();
        return;
      }
      setError("密码不正确");
    } catch {
      setError("校验失败（浏览器需支持 Web Crypto / HTTPS 或 localhost）");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page admin-layout">
      <section className="panel admin-hero" style={{ maxWidth: 480, margin: "0 auto" }}>
        <div className="admin-hero-top">
          <div className="panel-kicker">Admin</div>
          <h2 className="panel-title">管理解锁</h2>
          <p className="panel-desc">
            部署时在 <code>.env</code> 配置了 <code>CIALLO_ADMIN_PASSWORD</code>。请输入密码进入管理页。
          </p>
        </div>

        <form className="admin-stack" onSubmit={handleSubmit} style={{ marginTop: 18 }}>
          <div className="field">
            <label htmlFor="adminPassword">管理员密码</label>
            <input
              id="adminPassword"
              className="control"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="来自服务器 .env"
              disabled={busy}
              autoFocus
            />
          </div>

          {error ? (
            <div className="status err" role="alert">
              {error}
            </div>
          ) : null}

          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || !password.trim()}>
              {busy ? "校验中…" : "解锁管理"}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
              返回生图
            </button>
          </div>

          <p className="footer-note">
            解锁状态保存在当前浏览器会话（关闭标签后需重新输入）。密码不会提交到上游 API。
          </p>
        </form>
      </section>
    </div>
  );
}
