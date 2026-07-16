import { useEffect, useState, type FormEvent } from "react";
import type { CommunityUser } from "@/lib/community/types";

type Props = {
  user: CommunityUser | null;
  loading?: boolean;
  /** 需要展示登录表单（例如点赞时未登录） */
  forceAuth?: boolean;
  onForceAuthHandled?: () => void;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string, displayName?: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

/** 大厅内嵌：登录 / 注册 / 当前账号（替代独立「用户」分页） */
export function HallAuthPanel({
  user,
  loading,
  forceAuth,
  onForceAuthHandled,
  onLogin,
  onRegister,
  onLogout,
}: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (forceAuth && !user) {
      setOpen(true);
      setMode("login");
      onForceAuthHandled?.();
    }
  }, [forceAuth, user, onForceAuthHandled]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    setOk(null);
    try {
      if (mode === "login") {
        await onLogin(username.trim(), password);
        setMessage("登录成功");
      } else {
        await onRegister(username.trim(), password, displayName.trim() || undefined);
        setMessage("注册成功");
      }
      setOk(true);
      setPassword("");
      setOpen(false);
    } catch (err) {
      setOk(false);
      setMessage(err instanceof Error ? err.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="panel hall-auth-panel">
        <div className="empty empty-compact">
          <span className="empty-title">加载账号…</span>
        </div>
      </section>
    );
  }

  if (user) {
    return (
      <section className="panel hall-auth-panel">
        <div className="hall-auth-head">
          <div>
            <div className="section-card-title">Account</div>
            <h3 className="admin-section-title">已登录</h3>
            <p className="panel-desc hall-auth-desc">
              @{user.username} · {user.displayName}
              {user.role === "admin" ? " · 站长" : ""}
            </p>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onLogout()}>
              退出
            </button>
          </div>
        </div>
        {message ? (
          <div className={`status ${ok ? "ok" : "err"}`} role="status">
            {message}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="panel hall-auth-panel">
      <div className="hall-auth-head">
        <div>
          <div className="section-card-title">Account</div>
          <h3 className="admin-section-title">登录 / 注册</h3>
          <p className="panel-desc hall-auth-desc">登录后可点赞、点评、分享到大厅。</p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起" : "登录 / 注册"}
        </button>
      </div>

      {open ? (
        <div className="hall-auth-body">
          <div className="segmented" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={`chip ${mode === "login" ? "active" : ""}`}
              onClick={() => setMode("login")}
            >
              登录
            </button>
            <button
              type="button"
              className={`chip ${mode === "register" ? "active" : ""}`}
              onClick={() => setMode("register")}
            >
              注册
            </button>
          </div>
          <form className="admin-stack" onSubmit={(e) => void submit(e)}>
            <div className="field">
              <label htmlFor="hall-cu">用户名</label>
              <input
                id="hall-cu"
                className="control"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            {mode === "register" ? (
              <div className="field">
                <label htmlFor="hall-cdn">昵称（可选）</label>
                <input
                  id="hall-cdn"
                  className="control"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="hall-cp">密码</label>
              <input
                id="hall-cp"
                className="control"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
              />
            </div>
            {message ? (
              <div className={`status ${ok ? "ok" : "err"}`} role="status">
                {message}
              </div>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "提交中…" : mode === "login" ? "登录" : "注册"}
            </button>
          </form>
        </div>
      ) : null}
    </section>
  );
}
