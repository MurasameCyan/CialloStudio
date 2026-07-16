import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
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

function formatJoined(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function AccountPage({ user, loading, onLogin, onRegister, onLogout }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<CommunityUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "banned">("all");
  const [banBusyId, setBanBusyId] = useState<string | null>(null);
  const [apiMode, setApiMode] = useState(getCommunityMode());

  const loadUsers = useCallback(async () => {
    if (user?.role !== "admin") {
      setUsers([]);
      setUsersError("");
      return;
    }
    setUsersLoading(true);
    setUsersError("");
    try {
      const list = await communityApi.listUsers();
      setUsers(list);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setUsersError(text);
      log("warn", "拉取用户列表失败", text);
    } finally {
      setUsersLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (filter === "banned" && !u.banned) return false;
      if (filter === "active" && u.banned) return false;
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
      );
    });
  }, [users, userQuery, filter]);

  const userStats = useMemo(() => {
    const total = users.length;
    const banned = users.filter((u) => u.banned).length;
    const admins = users.filter((u) => u.role === "admin").length;
    return { total, banned, active: total - banned, admins };
  }, [users]);

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
    if (u.role === "admin") return;
    setBanBusyId(u.id);
    setMessage("");
    setOk(null);
    try {
      const next = await communityApi.setBanned(u.id, !u.banned);
      setUsers((prev) => prev.map((x) => (x.id === next.id ? next : x)));
      setOk(true);
      setMessage(
        next.banned
          ? `已禁用 @${next.username}，其登录会话已失效`
          : `已解禁 @${next.username}`,
      );
      log("ok", `${next.banned ? "已禁用" : "已解禁"} ${next.username}`);
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBanBusyId(null);
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
          注册 / 登录后可分享到大厅、点赞与点评。Mock 演示{" "}
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
              <strong className="admin-status-value">
                {user.role === "admin" ? "管理员" : "用户"}
              </strong>
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
        <section className="panel user-admin-panel">
          <div className="user-admin-head">
            <div>
              <div className="section-card-title">Admin</div>
              <h3 className="admin-section-title">用户管理</h3>
              <p className="panel-desc">禁用后无法登录 / 发帖 / 评论，已登录会话会被踢下线。</p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={usersLoading}
              onClick={() => void loadUsers()}
            >
              {usersLoading ? "刷新中…" : "刷新"}
            </button>
          </div>

          <div className="admin-status-row user-admin-stats">
            <div className="admin-status-card">
              <span className="admin-status-label">全部</span>
              <strong className="admin-status-value">{userStats.total}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">正常</span>
              <strong className="admin-status-value">{userStats.active}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">已禁用</span>
              <strong className="admin-status-value">{userStats.banned}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">管理员</span>
              <strong className="admin-status-value">{userStats.admins}</strong>
            </div>
          </div>

          <div className="user-admin-toolbar">
            <input
              className="control"
              type="search"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="搜索用户名 / 昵称"
              aria-label="搜索用户"
            />
            <div className="segmented">
              <button
                type="button"
                className={`chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={`chip ${filter === "active" ? "active" : ""}`}
                onClick={() => setFilter("active")}
              >
                正常
              </button>
              <button
                type="button"
                className={`chip ${filter === "banned" ? "active" : ""}`}
                onClick={() => setFilter("banned")}
              >
                已禁用
              </button>
            </div>
          </div>

          {usersError ? (
            <div className="status err" role="alert">
              {usersError}
            </div>
          ) : null}

          {usersLoading && users.length === 0 ? (
            <p className="footer-note">加载用户列表…</p>
          ) : filteredUsers.length === 0 ? (
            <p className="footer-note">{users.length === 0 ? "暂无用户" : "没有匹配的用户"}</p>
          ) : (
            <div className="user-table" role="list">
              {filteredUsers.map((u) => {
                const isSelf = u.id === user.id;
                const canBan = u.role !== "admin" && !isSelf;
                return (
                  <div
                    key={u.id}
                    className={`user-row ${u.banned ? "user-row-banned" : ""}`}
                    role="listitem"
                  >
                    <div className="user-row-main">
                      <div className="user-row-title">
                        <strong>{u.displayName}</strong>
                        <span className="user-badges">
                          <span className={`user-badge ${u.role === "admin" ? "admin" : "user"}`}>
                            {u.role === "admin" ? "管理员" : "用户"}
                          </span>
                          {u.banned ? <span className="user-badge banned">已禁用</span> : null}
                          {isSelf ? <span className="user-badge self">我</span> : null}
                        </span>
                      </div>
                      <div className="user-row-meta">
                        @{u.username} · 加入 {formatJoined(u.createdAt)}
                      </div>
                    </div>
                    {canBan ? (
                      <button
                        type="button"
                        className={`btn btn-sm ${u.banned ? "btn-secondary" : "btn-danger"}`}
                        disabled={banBusyId === u.id}
                        onClick={() => void toggleBan(u)}
                      >
                        {banBusyId === u.id ? "处理中…" : u.banned ? "解禁" : "禁用"}
                      </button>
                    ) : (
                      <span className="footer-note">{u.role === "admin" ? "管理员" : "当前账号"}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

      {message && user ? (
        <div className={`status ${ok ? "ok" : "err"}`} style={{ marginTop: 8 }} role="status">
          {message}
        </div>
      ) : null}
    </div>
  );
}
