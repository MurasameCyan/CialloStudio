import { useState, type FormEvent } from "react";
import { getCommunityMode, setCommunityMode } from "@/lib/community/client";
import type { CommunityUser } from "@/lib/community/types";
import { getMasterUsername, isMasterConfigured } from "@/lib/runtimeConfig";

type Props = {
  user: CommunityUser | null;
  loading: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string, displayName?: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

/** 用户页：仅注册 / 登录 / 当前账号；用户池在「管理 → 用户池」 */
export function AccountPage({ user, loading, onLogin, onRegister, onLogout }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiMode, setApiMode] = useState(getCommunityMode());

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
    } catch (err) {
      setOk(false);
      setMessage(err instanceof Error ? err.message : "失败");
    } finally {
      setBusy(false);
    }
  }

  function switchApiMode(next: "mock" | "http") {
    setCommunityMode(next);
    setApiMode(next);
    setMessage(`社区 API 模式：${next === "mock" ? "Mock 本地" : "HTTP（需后端）"}。请刷新或重新登录。`);
    setOk(true);
  }

  if (loading) {
    return (
      <div className="page">
        <section className="panel">
          <div className="empty empty-compact">
            <span className="empty-title">加载账号…</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page admin-layout">
      <section className="panel admin-hero">
        <div className="panel-kicker">Account</div>
        <h2 className="panel-title">用户</h2>
        <p className="panel-desc">
          注册 / 登录后可分享到大厅、点赞与点评。站长登录后可在「管理 → 用户池」管理账号。
          {isMasterConfigured() ? (
            <>
              {" "}
              站长账号 <code>{getMasterUsername()}</code>（密码见部署 .env）。
            </>
          ) : (
            <>
              {" "}
              本地 Mock：站长 <code>admin / admin123</code>，演示 <code>demo / demo123</code>。
            </>
          )}
        </p>
      </section>

      <section className="panel">
        <div className="admin-section-head">
          <h3 className="admin-section-title">API 模式</h3>
        </div>
        <div className="segmented" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={`chip ${apiMode === "mock" ? "active" : ""}`}
            onClick={() => switchApiMode("mock")}
          >
            Mock
          </button>
          <button
            type="button"
            className={`chip ${apiMode === "http" ? "active" : ""}`}
            onClick={() => switchApiMode("http")}
          >
            HTTP
          </button>
        </div>
        <p className="footer-note">
          后端就绪后切 HTTP，请求走 <code>/api/community/*</code>（契约见 docs）。
        </p>
      </section>

      {user ? (
        <section className="panel">
          <h3 className="admin-section-title">当前用户</h3>
          <div className="admin-status-row" style={{ marginTop: 12 }}>
            <div className="admin-status-card">
              <span className="admin-status-label">用户名</span>
              <strong className="admin-status-value">{user.username}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">昵称</span>
              <strong className="admin-status-value">{user.displayName}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">角色</span>
              <strong className="admin-status-value">
                {user.role === "admin" ? "管理员" : "用户"}
              </strong>
            </div>
          </div>
          {user.role === "admin" ? (
            <p className="footer-note" style={{ marginTop: 12 }}>
              你是站长：可直接进入「管理 → 用户池」与接口设置（无需单独管理密码）。
            </p>
          ) : null}
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-secondary" onClick={() => void onLogout()}>
              退出登录
            </button>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="segmented" style={{ marginBottom: 16 }}>
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
              <label htmlFor="cu">用户名</label>
              <input
                id="cu"
                className="control"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            {mode === "register" ? (
              <div className="field">
                <label htmlFor="cdn">昵称（可选）</label>
                <input
                  id="cdn"
                  className="control"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="cp">密码</label>
              <input
                id="cp"
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
        </section>
      )}

      {message && user ? (
        <div className={`status ${ok ? "ok" : "err"}`} style={{ marginTop: 8 }} role="status">
          {message}
        </div>
      ) : null}
    </div>
  );
}
