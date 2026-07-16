import { useCallback, useEffect, useMemo, useState } from "react";
import { communityApi } from "@/lib/community/client";
import type { CommunityUser, ShareCooldownConfig, UserRole } from "@/lib/community/types";
import { DEFAULT_SHARE_COOLDOWN, roleLabel } from "@/lib/community/types";
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
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [cooldown, setCooldown] = useState<ShareCooldownConfig>({ ...DEFAULT_SHARE_COOLDOWN });
  const [cooldownDraft, setCooldownDraft] = useState<ShareCooldownConfig>({ ...DEFAULT_SHARE_COOLDOWN });
  const [cooldownBusy, setCooldownBusy] = useState(false);

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
      const [list, cd] = await Promise.all([
        communityApi.listUsers(),
        communityApi.getShareCooldown(),
      ]);
      setUsers(list);
      setCooldown(cd);
      setCooldownDraft(cd);
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
    const vips = users.filter((u) => u.role === "vip").length;
    return { total, banned, active: total - banned, admins, vips };
  }, [users]);

  async function saveCooldown() {
    setCooldownBusy(true);
    setMessage("");
    setOk(null);
    try {
      const next = await communityApi.setShareCooldown(cooldownDraft);
      setCooldown(next);
      setCooldownDraft(next);
      setOk(true);
      setMessage(`已保存分享冷却：普通 ${next.user}s · VIP ${next.vip}s`);
      log("ok", "分享冷却已保存", next);
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setCooldownBusy(false);
    }
  }

  async function changeRole(u: CommunityUser, role: UserRole) {
    if (u.role === "admin" || role === "admin") return;
    if (u.role === role) return;
    setRoleBusyId(u.id);
    setMessage("");
    setOk(null);
    try {
      const next = await communityApi.setUserRole(u.id, role);
      setUsers((prev) => prev.map((x) => (x.id === next.id ? next : x)));
      setOk(true);
      setMessage(`已将 @${next.username} 设为 ${roleLabel(next.role)}`);
      log("ok", `用户分组 ${next.username} → ${next.role}`);
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "设置分组失败");
    } finally {
      setRoleBusyId(null);
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

  async function removeUser(u: CommunityUser) {
    if (u.role === "admin") return;
    if (u.id === communityUser?.id) return;
    const okConfirm = window.confirm(
      `确定删除用户 @${u.username}（${u.displayName}）？\n删除后无法登录，会话立即失效。`,
    );
    if (!okConfirm) return;
    setDeleteBusyId(u.id);
    setMessage("");
    setOk(null);
    try {
      await communityApi.deleteUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      setOk(true);
      setMessage(`已删除 @${u.username}`);
      log("ok", `已删除用户 ${u.username}`);
    } catch (e) {
      setOk(false);
      setMessage(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleteBusyId(null);
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
          请先在「大厅」登录站长账号
          {isMasterConfigured() ? `（.env：${getMasterUsername()}）` : ""}
          。
        </div>
        {onNeedLogin ? (
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={onNeedLogin}>
              去大厅登录
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
          ) : null}
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
          <span className="admin-status-label">VIP</span>
          <strong className="admin-status-value">{userStats.vips}</strong>
        </div>
        <div className="admin-status-card">
          <span className="admin-status-label">已禁用</span>
          <strong className="admin-status-value">{userStats.banned}</strong>
        </div>
      </div>

      <div className="user-cooldown-card">
        <div className="user-cooldown-head">
          <div>
            <div className="admin-block-label">分享冷却（秒）</div>
            <p className="footer-note" style={{ marginTop: 4 }}>
              各用户组分享到大厅的最小间隔。站长不限。当前生效：普通 {cooldown.user}s · VIP {cooldown.vip}s
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={cooldownBusy}
            onClick={() => void saveCooldown()}
          >
            {cooldownBusy ? "保存中…" : "保存冷却"}
          </button>
        </div>
        <div className="admin-fields-2" style={{ marginTop: 10 }}>
          <div className="field">
            <div className="label-row">
              <label htmlFor="cd-user">普通用户</label>
            </div>
            <input
              id="cd-user"
              className="control"
              type="number"
              min={0}
              max={86400}
              value={cooldownDraft.user}
              onChange={(e) =>
                setCooldownDraft((p) => ({ ...p, user: Number(e.target.value) }))
              }
            />
          </div>
          <div className="field">
            <div className="label-row">
              <label htmlFor="cd-vip">VIP</label>
            </div>
            <input
              id="cd-vip"
              className="control"
              type="number"
              min={0}
              max={86400}
              value={cooldownDraft.vip}
              onChange={(e) =>
                setCooldownDraft((p) => ({ ...p, vip: Number(e.target.value) }))
              }
            />
          </div>
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
            const canManage = u.role !== "admin" && !isSelf;
            const rowBusy =
              banBusyId === u.id || deleteBusyId === u.id || roleBusyId === u.id;
            const badgeClass =
              u.role === "admin" ? "admin" : u.role === "vip" ? "vip" : "user";
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
                      <span className={`user-badge ${badgeClass}`}>{roleLabel(u.role)}</span>
                      {u.banned ? <span className="user-badge banned">已禁用</span> : null}
                      {isSelf ? <span className="user-badge self">我</span> : null}
                    </span>
                  </div>
                  <div className="user-row-meta">
                    @{u.username} · 加入 {formatJoined(u.createdAt)}
                    {u.role !== "admin"
                      ? ` · 冷却 ${u.role === "vip" ? cooldown.vip : cooldown.user}s`
                      : " · 冷却不限"}
                  </div>
                </div>
                {canManage ? (
                  <div className="user-row-actions">
                    <div
                      className="segmented user-role-segmented"
                      role="group"
                      aria-label={`分组 @${u.username}`}
                    >
                      <button
                        type="button"
                        className={`chip user-role-chip ${u.role !== "vip" ? "active" : ""}`}
                        disabled={rowBusy || u.role === "user"}
                        aria-pressed={u.role !== "vip"}
                        onClick={() => void changeRole(u, "user")}
                      >
                        普通
                      </button>
                      <button
                        type="button"
                        className={`chip user-role-chip user-role-chip-vip ${u.role === "vip" ? "active" : ""}`}
                        disabled={rowBusy || u.role === "vip"}
                        aria-pressed={u.role === "vip"}
                        onClick={() => void changeRole(u, "vip")}
                      >
                        VIP
                      </button>
                    </div>
                    <button
                      type="button"
                      className={`btn btn-sm ${u.banned ? "btn-secondary" : "btn-ghost"}`}
                      disabled={rowBusy}
                      onClick={() => void toggleBan(u)}
                    >
                      {banBusyId === u.id ? "处理中…" : u.banned ? "解禁" : "禁用"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={rowBusy}
                      onClick={() => void removeUser(u)}
                    >
                      {deleteBusyId === u.id ? "删除中…" : "删除"}
                    </button>
                  </div>
                ) : (
                  <span className="footer-note">{u.role === "admin" ? "站长" : "当前账号"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
