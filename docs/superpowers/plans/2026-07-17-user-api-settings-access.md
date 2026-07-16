# 普通用户开放「接口与生成」实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 登录后的普通用户可进入并配置「接口与生成」以便生图；用户池与媒体仍仅站长可见；游客不可进入配置页。

**架构：** 沿用现有 `tab === "settings"` + `SettingsPage`。`App.tsx` 将门禁从「仅站长」改为「已登录」；导航文案按角色区分（用户=设置 / 站长=管理 / 游客=管理🔒）。`SettingsPage` 按 `role === "admin"` 裁剪分区。生图页未配置 Key 时的跳转：未登录去大厅，已登录打开设置。

**技术栈：** React + TypeScript（Vite）、现有 community auth（`role: "admin" | "user"`）、localStorage settings。

**规格：** `docs/superpowers/specs/2026-07-17-user-api-settings-access-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 修改 `src/App.tsx` | 门禁：`isLoggedIn`；踢出未登录；导航文案；渲染 SettingsPage 给所有已登录用户 |
| 修改 `src/components/SettingsPage.tsx` | 非站长隐藏 Tab / 用户池 / 媒体；页头文案分级 |
| 修改 `src/components/StudioPage.tsx` | 未配置 Key 文案；`handleGenerate` / 设置入口：未登录 → `onNeedLogin`，已登录 → `onOpenSettings`（通过可选 prop 或在 App 包装回调） |

无新文件。不改 `settings.ts`、community API、用户池逻辑。

---

### 任务 1：App 门禁与导航

**文件：**
- 修改：`src/App.tsx`

- [ ] **步骤 1：更新身份判定与 openSettings / 踢出逻辑**

将「仅站长可进」改为「已登录可进」。保留 `isStationMaster` 供导航文案与后续 Settings 使用（若仍只在 Settings 内判断站长亦可，但导航需要）。

把相关片段替换为：

```tsx
  const ready = Boolean((typeof settings.apiKey === "string" ? settings.apiKey : "").trim());
  const isLoggedIn = Boolean(community.user);
  const isStationMaster = community.user?.role === "admin";

  function openHallAuth() {
    setTab("hall");
  }

  function openSettings() {
    if (community.loading) {
      setTab("settings");
      return;
    }
    if (!isLoggedIn) {
      log("warn", "配置页需先登录，请先在大厅登录");
      setTab("hall");
      return;
    }
    setTab("settings");
  }

  // 已在配置页时若退出登录，立即踢回大厅
  useEffect(() => {
    if (community.loading) return;
    if (tab === "settings" && !isLoggedIn) {
      setTab("hall");
    }
  }, [tab, isLoggedIn, community.loading]);
```

- [ ] **步骤 2：更新顶栏导航按钮**

```tsx
            <button
              type="button"
              className={`nav-pill ${tab === "settings" ? "active" : ""}`}
              onClick={openSettings}
              title={
                isStationMaster
                  ? "站长控制台"
                  : isLoggedIn
                    ? "接口与生成设置"
                    : "登录后可配置接口"
              }
            >
              {isStationMaster ? "管理" : isLoggedIn ? "设置" : "管理 🔒"}
            </button>
```

- [ ] **步骤 3：更新 main 区 settings 渲染**

加载中文案改为「校验登录…」；已登录（含普通用户）渲染 `SettingsPage`；未登录展示「需要登录」提示（不再写「仅站长」）。

```tsx
        ) : community.loading ? (
          <div className="page">
            <section className="panel">
              <div className="empty empty-compact">
                <span className="empty-title">校验登录…</span>
              </div>
            </section>
          </div>
        ) : isLoggedIn ? (
          <ErrorBoundary label={isStationMaster ? "管理页" : "设置页"}>
            <SettingsPage
              settings={settings}
              onChange={setSettings}
              communityUser={community.user}
              communityLoading={community.loading}
              onNeedLogin={openHallAuth}
            />
          </ErrorBoundary>
        ) : (
          <div className="page admin-layout">
            <section className="panel admin-hero">
              <div className="panel-kicker">Settings</div>
              <h2 className="panel-title">需要登录</h2>
              <p className="panel-desc">
                配置接口与生成参数前请先到「大厅」登录。登录后普通用户可配置接口；站长还可管理用户池与媒体。
              </p>
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-primary" onClick={openHallAuth}>
                  去大厅登录
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setTab("studio")}>
                  返回生图
                </button>
              </div>
            </section>
          </div>
        )}
```

可删除未再使用的 `isMasterConfigured` / `getMasterUsername` 导入（若本文件别处也不再引用）。

- [ ] **步骤 4：Commit**

```bash
git add src/App.tsx
git commit -m "feat: allow logged-in users to open API settings"
```

---

### 任务 2：SettingsPage 按角色裁剪

**文件：**
- 修改：`src/components/SettingsPage.tsx`

- [ ] **步骤 1：在组件内增加站长判定**

在 `SettingsPage` 函数体内、`section` state 附近加入：

```tsx
  const isStationMaster = communityUser?.role === "admin";
```

非站长进入时强制 `section` 保持 `"api"`（避免隐藏 Tab 后仍卡在 users）。在 `isStationMaster` 之后加 effect：

```tsx
  useEffect(() => {
    if (!isStationMaster && section !== "api") {
      setSection("api");
    }
  }, [isStationMaster, section]);
```

- [ ] **步骤 2：分级页头与分区 Tab**

替换 hero 区块标题/描述，并将分区 Tab 仅在站长时渲染：

```tsx
      <section className="panel admin-hero">
        <div className="admin-hero-top admin-hero-top-row">
          <div>
            <div className="panel-kicker">{isStationMaster ? "Admin" : "Settings"}</div>
            <h2 className="panel-title">{isStationMaster ? "控制台" : "设置"}</h2>
            <p className="panel-desc" style={{ marginTop: 6 }}>
              {isStationMaster ? (
                <>
                  站长 @{communityUser?.username ?? getMasterUsername()} · 接口 / 用户池 / 媒体
                </>
              ) : (
                <>
                  @{communityUser?.username ?? "用户"} · 接口与生成
                </>
              )}
            </p>
          </div>
        </div>

        {isStationMaster ? (
          <div className="admin-section-switch" role="tablist" aria-label="管理分区">
            <button
              type="button"
              role="tab"
              aria-selected={section === "api"}
              className={`admin-section-switch-btn ${section === "api" ? "active" : ""}`}
              onClick={() => setSection("api")}
            >
              接口设置
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === "users"}
              className={`admin-section-switch-btn ${section === "users" ? "active" : ""}`}
              onClick={() => setSection("users")}
            >
              用户池
            </button>
          </div>
        ) : null}

        {isStationMaster && section === "api" ? (
          <div className="admin-status-row">
            {/* 保持现有四个 status card 不变 */}
            ...
          </div>
        ) : isStationMaster && section === "users" ? (
          <p className="panel-desc admin-users-hint">
            管理社区账号池。站长账号由部署 <code>.env</code> 配置（
            <code>CIALLO_MASTER_USERNAME</code> / <code>CIALLO_MASTER_PASSWORD</code>）。
          </p>
        ) : !isStationMaster ? (
          <div className="admin-status-row">
            <div className="admin-status-card">
              <span className="admin-status-label">连接</span>
              <strong className="admin-status-value">
                <span className={`live-dot ${hasKey ? "" : "off"}`} />
                {hasKey ? "已配置 Key" : "未配置"}
              </strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">模型</span>
              <strong className="admin-status-value mono-tight" title={draft.model}>
                {draft.model || "—"}
              </strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">并发</span>
              <strong className="admin-status-value">{draft.concurrency}</strong>
            </div>
            <div className="admin-status-card">
              <span className="admin-status-label">请求通道</span>
              <strong className="admin-status-value mono-tight" title={requestBase}>
                {requestBase}
              </strong>
            </div>
          </div>
        ) : null}
      </section>
```

说明：普通用户也展示连接/模型状态卡（便于确认已配置）；站长在 api 分区保持原样。实现时可将 status-row 抽成局部 JSX 变量以避免重复，例如：

```tsx
  const connectionStatusRow = (
    <div className="admin-status-row">
      {/* 四个 card，与现有相同 */}
    </div>
  );
```

站长 `section === "api"` 与非站长共用该变量。

- [ ] **步骤 3：隐藏用户池与媒体**

主内容区逻辑改为：

```tsx
      {isStationMaster && section === "users" ? (
        <UserPoolPanel
          communityUser={communityUser}
          communityLoading={communityLoading}
          onNeedLogin={onNeedLogin}
        />
      ) : (
        <>
          {/* 现有「接口与生成」section 完整保留 */}
          ...

          {isStationMaster ? (
            <section className="panel admin-form-panel">
              {/* 现有「图片存储（CF Worker → Telegram）」完整保留 */}
              ...
            </section>
          ) : null}

          <LogPanel />
        </>
      )}
```

注意：非站长时永远不渲染 `UserPoolPanel` 与媒体 section；`LogPanel` 对普通用户可保留（便于排查连接问题）。

- [ ] **步骤 4：微调日志文案（可选、小改）**

`handleTestAndLoadModels` 中 `log("info", "管理页：测试连接", ...)` 可改为 `log("info", "设置页：测试连接", ...)`，失败/保存日志同理。非必须，改了更一致。

- [ ] **步骤 5：Commit**

```bash
git add src/components/SettingsPage.tsx
git commit -m "feat: show API settings only for non-admin users"
```

---

### 任务 3：生图页未配置时的跳转与文案

**文件：**
- 修改：`src/components/StudioPage.tsx`
- 修改：`src/App.tsx`（传入是否已登录，或包装回调）

规格：未配置 Key 时，未登录 → 大厅；已登录 → 设置。

- [ ] **步骤 1：为 StudioPage 增加可选登录态 prop**

在 `Props` 中增加：

```tsx
  /** 是否已登录社区账号（用于未配置 Key 时决定去登录还是去设置） */
  isLoggedIn?: boolean;
```

解构默认 `isLoggedIn = false`。

- [ ] **步骤 2：统一「打开配置」处理**

```tsx
  function openConfigOrLogin() {
    if (!isLoggedIn) {
      onNeedLogin?.();
      return;
    }
    onOpenSettings();
  }

  async function handleGenerate() {
    if (!configured) {
      openConfigOrLogin();
      return;
    }
    // ... 其余不变
  }
```

将「模型 xxx →」按钮的 `onClick` 改为 `openConfigOrLogin`（与规格一致：未登录先登录）。

- [ ] **步骤 3：更新未配置提示文案**

```tsx
        {!configured ? (
          <div className="status err" style={{ marginBottom: 14 }}>
            {isLoggedIn
              ? "还没有 API Key。请到「设置」页填写接口与密钥。"
              : "还没有 API Key。请先登录，再到「设置」页填写接口与密钥。"}
          </div>
        ) : null}
```

- [ ] **步骤 4：App 传入 isLoggedIn**

```tsx
          <StudioPage
            settings={settings}
            onOpenSettings={openSettings}
            onNeedLogin={openHallAuth}
            isLoggedIn={isLoggedIn}
            ...
          />
```

- [ ] **步骤 5：Commit**

```bash
git add src/components/StudioPage.tsx src/App.tsx
git commit -m "feat: route unconfigured studio to login or settings"
```

---

### 任务 4：验证与收尾

**文件：** 无新代码（或仅修编译错误）

- [ ] **步骤 1：类型检查 / 构建**

```bash
npm run build
```

预期：exit 0，无 TS 错误。

- [ ] **步骤 2：手动验收清单（实现者自测）**

| # | 场景 | 期望 |
|---|------|------|
| 1 | 游客点「管理 🔒」 | 进大厅，无法停留 settings |
| 2 | 用 demo/普通用户登录 | 顶栏为「设置」无锁 |
| 3 | 用户点「设置」 | 仅接口与生成；无用户池 Tab、无媒体区块 |
| 4 | 用户保存 Key 后生图 | 可启动生成 |
| 5 | 用户在设置页退出 | 踢回大厅 |
| 6 | 站长登录 | 顶栏「管理」；接口 / 用户池 / 媒体齐全 |
| 7 | 未登录在生图页点生成（无 Key） | 去大厅登录 |
| 8 | 已登录无 Key 点生成 | 打开设置 |

- [ ] **步骤 3：最终 commit（若有小修）**

```bash
git add -A
git commit -m "fix: polish user settings access edge cases"
```

若步骤 1–2 无改动则跳过本 commit。

- [ ] **步骤 4：推送（若用户偏好 push immediately）**

用户偏好：每次 commit 后 push。在本任务全部 commit 完成后：

```bash
git push
```

（若环境有 SOCKS/SSH 代理要求，沿用项目既有 Git 配置。）

---

## 自检对照规格

| 规格项 | 任务 |
|--------|------|
| 登录用户可进配置 | 任务 1 |
| 游客不可进 | 任务 1 |
| 用户仅接口与生成 | 任务 2 |
| 站长完整能力 | 任务 2 |
| 导航：设置 / 管理 / 锁 | 任务 1 |
| 生图页跳转 | 任务 3 |
| localStorage 不变 | 不改 settings.ts |
| 不开放用户池/媒体 | 任务 2 |

无占位符；类型名与现有 `CommunityUser.role` 一致。
