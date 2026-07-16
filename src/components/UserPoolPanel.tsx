import { useCallback, useEffect, useMemo, useState } from "react";
import { communityApi } from "@/lib/community/client";
import type { CommunityUser } from "@/lib/community/types";
import { log } from "@/lib/logger";
import { getMasterUsername, isMasterConfigured } from "@/lib/runtimeConfig";

type Props = {
  /** 社区登录用户；管理员可管用户池，非管理员显示引导 */
  communityUser: CommunityUser | null;
  communityLoading?: boolean;
  onNeedLogin?: () => void;
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

/** 管理页「用户池」：列表 / 搜索 / 禁用解禁（需社区 admin 角色） */
export function UserPoolPanel({ communityUser, communityLoading, onNeedLogin }: Props) {
  const [users, setUsers] = useState<CommunityUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "banned">("all");
  const [banBusyId, setBanBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);

  const isAdmin = communityUser?.role === "admin";

  const loadUsers = useCallback(async () => {
    if (!isAdmin) {
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
      log("warn", "拉取用户池失败", text);
    } finally {
      setUsersLoading(false);
    }
  }, [isAdmin]);

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

  if (communityLoading) {
    return (
      <section className="panel user-admin-panel">
        <div className="empty empty-compact">
          <span className="empty-title">加载用户池…</span>
        </div>
      </section>
    );
  }

  if (!communityUser) {
    return (
      <section className="panel user-admin-panel">
        <div className="user-admin-head">
          <div>
            <div className="section-card-title">Users</div>
            <h3 className="admin-section-title">用户池</h3>
            <p className="panel-desc">管理社区账号：禁用后无法登录 / 发帖 / 评论。</p>
          </div>
        </div>
        <div className="status err" role="status">
          请先在「用户」页以站长账号登录
          {isMasterConfigured()
            ? `（.env：${getMasterUsername()}）`
            : "（Mock：admin / admin123）"}
          。
        </div>
        {onNeedLogin ? (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={onNeedLogin}>
              去登录
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  if (!isAdmin) {
    return (
      <section className="panel user-admin-panel">
        <div className="user-admin-head">
          <div>
            <div className="section-card-title">Users</div>
            <h3 className="admin-section-title">用户池</h3>
            <p className="panel-desc">当前登录账号没有社区管理员权限。</p>
          </div>
        </div>
        <div className="status" role="status">
          已登录 <strong>@{communityUser.username}</strong>（{communityUser.displayName}），角色为用户。
          请改用站长账号
          {isMasterConfigured() ? (
            <>
              {" "}
              <code>{getMasterUsername()}</code>
            </>
          ) : (
            <>
              {" "}
              <code>admin / admin123</code>
            </>
          )}
          。
        </div>
        {onNeedLogin ? (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-secondary" onClick={onNeedLogin}>
              切换账号
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="panel user-admin-panel">
      <div className="user-admin-head">
        <div>
          <div className="section-card-title">Users</div>
          <h3 className="admin-section-title">用户池</h3>
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

      {message ? (
        <div className={`status ${ok ? "ok" : "err"}`} role="status">
          {message}
        </div>
      ) : null}

      {usersLoading && users.length === 0 ? (
        <p className="footer-note">加载用户列表…</p>
      ) : filteredUsers.length === 0 ? (
        <p className="footer-note">{users.length === 0 ? "暂无用户" : "没有匹配的用户"}</p>
      ) : (
        <div className="user-table" role="list">
          {filteredUsers.map((u) => {
            const isSelf = u.id === communityUser.id;
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
  );
}
