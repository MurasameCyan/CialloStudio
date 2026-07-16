import { useEffect, useState, type FormEvent } from "react";
import { communityApi, getCommunityMode, setCommunityMode } from "@/lib/community/client";
import type { CommunityUser } from "@/lib/community/types";
import { log } from "@/lib/logger";

type Props = {
  user: CommunityUser | null;
  loading: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string, displayName?: string) => Promise<void>;
  onLogout: () => Promise<void>;
};

export function AccountPage({ user, loading, onLogin, onRegister, onLogout }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<CommunityUser[]>([]);
  const [apiMode, setApiMode] = useState(getCommunityMode());

  useEffect(() => {
    if (user?.role === "admin") {
      void communityApi
        .listUsers()
        .then(setUsers)
        .catch((e) => log("warn", "拉取用户列表失败", e instanceof Error ? e.message : String(e)));
    } else {
      setUsers([]);
    }
  }, [user]);

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

  async function toggleBan(u: CommunityUser) {
    try {
      const next = await communityApi.setBanned(u.id, !u.banned);
      setUsers((prev) => prev.map((x) => (x.id === next.id ? next : x)));
      log("ok", `${next.banned ? "已禁用" : "已解禁"} ${next.username}`);
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "操作失败");
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
          轻量账号：注册 / 登录后可分享到大厅、点赞与点评。Mock 演示账号{" "}
          <code>demo / demo123</code>，管理员 <code>admin / admin123</code>。
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
              <strong className="admin-status-value">{user.role}</strong>
            </div>
          </div>
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

      {user?.role === "admin" ? (
        <section className="panel">
          <h3 className="admin-section-title">用户管理</h3>
          <p className="panel-desc">禁用后无法登录 / 发帖 / 评论。</p>
          {users.length === 0 ? (
            <p className="footer-note">暂无用户</p>
          ) : (
            <div className="user-table">
              {users.map((u) => (
                <div key={u.id} className="user-row">
                  <div>
                    <strong>{u.displayName}</strong>
                    <span className="footer-note">
                      {" "}
                      @{u.username} · {u.role}
                      {u.banned ? " · 已禁用" : ""}
                    </span>
                  </div>
                  {u.role !== "admin" ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void toggleBan(u)}>
                      {u.banned ? "解禁" : "禁用"}
                    </button>
                  ) : (
                    <span className="footer-note">管理员</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {message && user ? (
        <div className={`status ${ok ? "ok" : "err"}`} style={{ marginTop: 8 }}>
          {message}
        </div>
      ) : null}
    </div>
  );
}
