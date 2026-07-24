import { useEffect, useMemo, useState } from "react";
import { LogPanel } from "@/components/LogPanel";
import { UserPoolPanel } from "@/components/UserPoolPanel";
import {
  ApiError,
  listModels,
  rememberUpstreamOrigin,
  resolveBrowserApiBase,
  type OpenAIModel,
} from "@/lib/api";
import {
  checkForUpdate,
  resolveBuildInfo,
  type UpdateCheckResult,
} from "@/lib/buildInfo";
import type { CommunityUser } from "@/lib/community/types";
import { getImageModelCapability } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import {
  getMediaBase,
  getMediaUploadToken,
  pingMediaWorker,
  setMediaBase,
  setMediaUploadToken,
} from "@/lib/media/client";
import { getMasterUsername } from "@/lib/runtimeConfig";
import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS,
  RESOLUTIONS,
  type StudioSettings,
  clampConcurrency,
  normalizeBaseUrl,
  saveSettings,
} from "@/lib/settings";

type AdminSection = "api" | "users";

type Props = {
  settings: StudioSettings;
  onChange: (next: StudioSettings) => void;
  /** 已登录社区用户（App 保证已登录；role=admin 为站长） */
  communityUser?: CommunityUser | null;
  communityLoading?: boolean;
  onNeedLogin?: () => void;
};

export function SettingsPage({
  settings,
  onChange,
  communityUser = null,
  communityLoading = false,
  onNeedLogin,
}: Props) {
  const isStationMaster = communityUser?.role === "admin";
  const [section, setSection] = useState<AdminSection>("api");
  const [draft, setDraft] = useState<StudioSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...settings,
    baseUrl: settings?.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
    apiKey: settings?.apiKey ?? DEFAULT_SETTINGS.apiKey,
    model: settings?.model || DEFAULT_SETTINGS.model,
    aspectRatio: settings?.aspectRatio || DEFAULT_SETTINGS.aspectRatio,
    resolution: settings?.resolution === "2k" ? "2k" : "1k",
    concurrency: clampConcurrency(settings?.concurrency),
    promptOptimizeModel: settings?.promptOptimizeModel ?? DEFAULT_SETTINGS.promptOptimizeModel,
    promptOptimizeCustomUpstream: settings?.promptOptimizeCustomUpstream === true,
    promptOptimizeBaseUrl: settings?.promptOptimizeBaseUrl ?? DEFAULT_SETTINGS.promptOptimizeBaseUrl,
    promptOptimizeApiKey: settings?.promptOptimizeApiKey ?? DEFAULT_SETTINGS.promptOptimizeApiKey,
  }));
  const [showOptimizeKey, setShowOptimizeKey] = useState(false);
  const [models, setModels] = useState<OpenAIModel[]>([]);
  const [imageModelFilter, setImageModelFilter] = useState("");
  const [optimizeModelFilter, setOptimizeModelFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [mediaBase, setMediaBaseDraft] = useState("");
  const [mediaToken, setMediaTokenDraft] = useState("");
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaMsg, setMediaMsg] = useState("");
  const [mediaOk, setMediaOk] = useState<boolean | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const buildInfo = useMemo(() => resolveBuildInfo(), []);

  useEffect(() => {
    setMediaBaseDraft(getMediaBase());
    setMediaTokenDraft(getMediaUploadToken());
  }, []);

  async function handleCheckUpdate() {
    setUpdateBusy(true);
    setUpdateResult(null);
    try {
      const result = await checkForUpdate();
      setUpdateResult(result);
      if (result.error) {
        log("error", "版本检测失败", result.error);
      } else if (result.hasUpdate) {
        log("ok", "发现新版本", `${result.current} → ${result.latest}`);
      } else {
        log("ok", "已是最新", result.current);
      }
    } finally {
      setUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (!isStationMaster && section !== "api") {
      setSection("api");
    }
  }, [isStationMaster, section]);

  const apiKey = typeof draft.apiKey === "string" ? draft.apiKey : "";
  const baseUrl = typeof draft.baseUrl === "string" ? draft.baseUrl : "";
  const hasKey = Boolean(apiKey.trim());
  const requestBase = resolveBrowserApiBase(baseUrl);
  const modelCap = useMemo(
    () => getImageModelCapability(typeof draft.model === "string" ? draft.model : DEFAULT_SETTINGS.model),
    [draft.model],
  );

  const filteredImageModels = useMemo(() => {
    const q = imageModelFilter.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, imageModelFilter]);

  const filteredOptimizeModels = useMemo(() => {
    const q = optimizeModelFilter.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q));
  }, [models, optimizeModelFilter]);

  function update<K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function persist(next: StudioSettings) {
    // 全局并发槽仅站长可改；普通用户保存时保留已有 concurrency
    const concurrency = clampConcurrency(
      isStationMaster ? next.concurrency : (settings?.concurrency ?? DEFAULT_SETTINGS.concurrency),
    );
    const customUp = next.promptOptimizeCustomUpstream === true;
    const normalized: StudioSettings = {
      ...DEFAULT_SETTINGS,
      ...next,
      baseUrl: normalizeBaseUrl(typeof next.baseUrl === "string" ? next.baseUrl : baseUrl),
      apiKey: typeof next.apiKey === "string" ? next.apiKey : apiKey,
      model: (typeof next.model === "string" && next.model) || DEFAULT_SETTINGS.model,
      aspectRatio:
        (typeof next.aspectRatio === "string" && next.aspectRatio) || DEFAULT_SETTINGS.aspectRatio,
      resolution: next.resolution === "2k" ? "2k" : "1k",
      concurrency,
      promptOptimizeModel:
        typeof next.promptOptimizeModel === "string" ? next.promptOptimizeModel.trim() : "",
      promptOptimizeCustomUpstream: customUp,
      promptOptimizeBaseUrl: customUp
        ? normalizeBaseUrl(
            typeof next.promptOptimizeBaseUrl === "string" ? next.promptOptimizeBaseUrl : "",
          )
        : "",
      promptOptimizeApiKey: customUp
        ? typeof next.promptOptimizeApiKey === "string"
          ? next.promptOptimizeApiKey
          : ""
        : "",
    };
    saveSettings(normalized);
    rememberUpstreamOrigin(normalized.baseUrl);
    if (normalized.promptOptimizeCustomUpstream && normalized.promptOptimizeBaseUrl) {
      rememberUpstreamOrigin(normalized.promptOptimizeBaseUrl);
    }
    onChange(normalized);
    setDraft(normalized);
    return normalized;
  }

  async function handleTestAndLoadModels() {
    setBusy(true);
    setMessage("");
    setOk(null);
    try {
      const normalized = persist(draft);
      log("info", "设置页：测试连接", {
        baseUrl: normalized.baseUrl,
        requestBase: resolveBrowserApiBase(normalized.baseUrl),
        model: normalized.model,
        keyPrefix: normalized.apiKey.slice(0, 12),
      });
      const list = await listModels({
        baseUrl: normalized.baseUrl,
        apiKey: normalized.apiKey,
      });
      setModels(list);
      const preferred =
        list.find((m) => m.id === normalized.model)?.id ||
        list.find((m) => m.id.includes("imagine") || m.id.includes("image"))?.id ||
        list[0]?.id ||
        normalized.model;
      if (preferred !== normalized.model) {
        persist({ ...normalized, model: preferred });
      }
      setOk(true);
      setMessage(`连接成功 · ${list.length} 个模型 · 当前 ${preferred}`);
    } catch (error) {
      setOk(false);
      let text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "连接失败";
      if (/CORS|Failed to fetch|network|Load failed|NetworkError|proxy|502|503|504/i.test(text)) {
        text = [
          text,
          "",
          "排查：",
          "1) Base URL 填完整上游，如 https://your-gateway/v1（会经同源 /v1 代理，免 CORS）",
          "2) Docker：pull 最新镜像后 recreate；本地 dev 需 npm run dev",
          "3) 确认上游可访问、API Key 正确",
        ].join("\n");
      } else if (/missing_base_url|填写 API Base|缺少上游/i.test(text)) {
        text = `${text}\n\n在设置页「API Base URL」填：https://你的网关/v1 后保存再测`;
      }
      log("error", "设置页：测试连接失败", text);
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    if (!baseUrl.trim()) {
      setOk(false);
      setMessage("请填写 API Base URL（完整地址，如 https://your-gateway/v1）");
      return;
    }
    if (!apiKey.trim()) {
      setOk(false);
      setMessage("请填写 API Key");
      return;
    }
    const normalized = persist({
      ...draft,
      baseUrl,
      apiKey,
      model: typeof draft.model === "string" ? draft.model : DEFAULT_SETTINGS.model,
    });
    log("ok", "设置已保存", {
      baseUrl: normalized.baseUrl,
      requestBase: resolveBrowserApiBase(normalized.baseUrl),
      model: normalized.model,
      concurrency: normalized.concurrency,
    });
    setOk(true);
    setMessage(
      isStationMaster
        ? `已保存 · 模型 ${normalized.model} · 并发 ${normalized.concurrency}`
        : `已保存 · 模型 ${normalized.model}`,
    );
  }

  function handleReset() {
    setDraft({
      ...DEFAULT_SETTINGS,
      // 非站长不能通过恢复默认改掉并发槽
      concurrency: isStationMaster
        ? DEFAULT_SETTINGS.concurrency
        : clampConcurrency(settings?.concurrency ?? DEFAULT_SETTINGS.concurrency),
    });
    setModels([]);
    setOk(null);
    setMessage("已恢复默认值（尚未写入本地，需点保存）");
  }

  function handleSaveMedia() {
    setMediaBase(mediaBase.trim());
    setMediaUploadToken(mediaToken.trim());
    setMediaOk(true);
    setMediaMsg(
      mediaBase.trim()
        ? `已保存媒体 Worker：${mediaBase.trim().replace(/\/+$/, "")}`
        : "已清空 Media Base（分享将使用临时图链）",
    );
    log("ok", "媒体 Worker 配置已保存", { base: mediaBase.trim() || "(empty)" });
  }

  async function handleTestMedia() {
    const normalized = mediaBase.trim().replace(/\/+$/, "");
    setMediaBaseDraft(normalized);
    setMediaBase(normalized);
    setMediaUploadToken(mediaToken.trim());
    setMediaBusy(true);
    setMediaMsg("");
    setMediaOk(null);
    try {
      const res = await pingMediaWorker();
      setMediaOk(res.ok);
      setMediaMsg(res.ok ? `媒体正常 · ${res.detail}` : `媒体异常 · ${res.detail}`);
      log(res.ok ? "ok" : "error", "媒体 Worker 探测", res.detail);
    } finally {
      setMediaBusy(false);
    }
  }

  const connectionStatusRow = (
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
      {isStationMaster ? (
        <div className="admin-status-card">
          <span className="admin-status-label">并发</span>
          <strong className="admin-status-value">{draft.concurrency}</strong>
        </div>
      ) : null}
      <div className="admin-status-card">
        <span className="admin-status-label">请求通道</span>
        <strong className="admin-status-value mono-tight" title={requestBase}>
          {requestBase}
        </strong>
      </div>
    </div>
  );

  const updateStatusText = (() => {
    if (updateBusy) return "检查中…";
    if (!updateResult) return "";
    if (updateResult.error) return updateResult.error;
    if (updateResult.hasUpdate) {
      return `有更新 · ${updateResult.latest}${
        updateResult.publishedAt
          ? ` · ${new Date(updateResult.publishedAt).toLocaleDateString()}`
          : ""
      }`;
    }
    return `已是最新 · ${updateResult.latest || updateResult.current}`;
  })();

  return (
    <div className="page admin-layout">
      <section className="panel admin-hero">
        <div className="admin-hero-top admin-hero-top-row">
          <div>
            <div className="panel-kicker">{isStationMaster ? "Admin" : "Settings"}</div>
            <h2 className="panel-title">{isStationMaster ? "控制台" : "设置"}</h2>
            <p className="panel-desc" style={{ marginTop: 6 }}>
              {isStationMaster ? (
                <>站长 @{communityUser?.username ?? getMasterUsername()} · 接口 / 用户池 / 媒体</>
              ) : (
                <>@{communityUser?.username ?? "用户"} · 接口与生成</>
              )}
            </p>
          </div>
        </div>

        <div className="build-version-row" aria-label="版本信息">
          <div className="build-version-meta">
            <span className="admin-status-label">版本</span>
            <a
              className="build-version-hash mono-tight"
              href={buildInfo.commitUrl}
              target="_blank"
              rel="noreferrer"
              title={buildInfo.full || buildInfo.hash}
            >
              {buildInfo.hash}
            </a>
            {updateResult?.hasUpdate && updateResult.latest ? (
              <span className="build-version-ref footer-note">
                <a href={updateResult.htmlUrl} target="_blank" rel="noreferrer">
                  最新 {updateResult.latest}
                </a>
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-ghost build-version-check"
            disabled={updateBusy}
            onClick={() => void handleCheckUpdate()}
            title="对照 GitHub 跟踪分支 HEAD"
          >
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          {updateStatusText ? (
            <span
              className={`build-version-status footer-note${
                updateResult?.error
                  ? " build-version-status-err"
                  : updateResult?.hasUpdate
                    ? " build-version-status-new"
                    : ""
              }`}
              title={updateStatusText}
            >
              {updateStatusText}
            </span>
          ) : null}
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

        {isStationMaster && section === "users" ? (
          <p className="panel-desc admin-users-hint">
            管理社区账号池。站长账号由部署 <code>.env</code> 配置（
            <code>CIALLO_MASTER_USERNAME</code> / <code>CIALLO_MASTER_PASSWORD</code>）。
          </p>
        ) : (
          connectionStatusRow
        )}
      </section>

      {isStationMaster && section === "users" ? (
        <UserPoolPanel
          communityUser={communityUser}
          communityLoading={communityLoading}
          onNeedLogin={onNeedLogin}
        />
      ) : (
        <>
          <section className="panel admin-form-panel">
            <div className="admin-section admin-section-merged">
              <div className="admin-section-head">
                <div>
                  <div className="section-card-title">Settings</div>
                  <h3 className="admin-section-title">接口与生成</h3>
                </div>
              </div>

              <div className="admin-stack">
                {/* 左：生图 · 右：优化 — 对称顺序 */}
                <div className="admin-dual-cols">
                  <div className="admin-dual-col">
                    <div className="admin-block-label">当前模型</div>
                    <div className="admin-selected-models">
                      <span className="admin-selected-pill" title="生图模型">
                        生图 · <strong className="mono-tight">{draft.model || "未选"}</strong>
                      </span>
                    </div>

                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="baseUrl">API Base URL</label>
                      </div>
                      <input
                        id="baseUrl"
                        className="control mono"
                        value={baseUrl}
                        placeholder="https://your-gateway/v1"
                        onChange={(e) => update("baseUrl", e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="apiKey">API Key</label>
                        <button type="button" className="text-link" onClick={() => setShowKey((v) => !v)}>
                          {showKey ? "隐藏" : "显示"}
                        </button>
                      </div>
                      <input
                        id="apiKey"
                        className="control mono"
                        type={showKey ? "text" : "password"}
                        value={apiKey}
                        placeholder="g2a_..."
                        onChange={(e) => update("apiKey", e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    <div className="field">
                      <div className="label-row">
                        <label>默认宽高比</label>
                      </div>
                      <div className="segmented">
                        {ASPECT_RATIOS.map((ratio) => (
                          <button
                            key={ratio}
                            type="button"
                            className={`chip ${draft.aspectRatio === ratio ? "active" : ""}`}
                            onClick={() => update("aspectRatio", ratio)}
                          >
                            {ratio}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="field">
                      <div className="label-row">
                        <label>默认分辨率</label>
                      </div>
                      <div className="segmented">
                        {RESOLUTIONS.map((item) => {
                          const allowed = modelCap.allowedResolutions.includes(item);
                          return (
                            <button
                              key={item}
                              type="button"
                              className={`chip ${draft.resolution === item ? "active" : ""}`}
                              disabled={!allowed}
                              onClick={() => {
                                if (allowed) update("resolution", item);
                              }}
                            >
                              {item}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {isStationMaster ? (
                      <div className="field">
                        <div className="label-row">
                          <label htmlFor="concurrency">全局并发槽</label>
                        </div>
                        <input
                          id="concurrency"
                          className="control"
                          type="number"
                          min={1}
                          max={2}
                          value={draft.concurrency}
                          onChange={(e) => update("concurrency", Number(e.target.value))}
                        />
                      </div>
                    ) : null}

                    <div className="admin-model-picker-head">
                      <div className="admin-block-label admin-block-label-sub">点选生图模型</div>
                      <input
                        type="search"
                        className="control mono admin-model-filter"
                        value={imageModelFilter}
                        onChange={(e) => setImageModelFilter(e.target.value)}
                        placeholder="筛选…"
                        disabled={models.length === 0}
                        aria-label="筛选生图模型"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    {models.length > 0 ? (
                      filteredImageModels.length > 0 ? (
                        <div className="admin-model-grid" role="listbox" aria-label="生图模型">
                          {filteredImageModels.map((model) => (
                            <button
                              key={`img-${model.id}`}
                              type="button"
                              role="option"
                              aria-selected={draft.model === model.id}
                              title={model.id}
                              className={`chip admin-model-chip ${draft.model === model.id ? "active" : ""}`}
                              onClick={() => update("model", model.id)}
                            >
                              <span className="admin-model-chip-text">{model.id}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="footer-note">无匹配「{imageModelFilter.trim()}」</p>
                      )
                    ) : (
                      <p className="footer-note">点下方「测试连接」加载列表后点选</p>
                    )}
                  </div>

                  <div className="admin-dual-col">
                    <div className="admin-block-label">当前模型</div>
                    <div className="admin-selected-models">
                      <span className="admin-selected-pill" title="提示词优化模型">
                        优化 ·{" "}
                        <strong className="mono-tight">
                          {draft.promptOptimizeModel?.trim() || "未选"}
                        </strong>
                      </span>
                    </div>

                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="prompt-optimize-base">API Base URL</label>
                      </div>
                      <input
                        id="prompt-optimize-base"
                        className="control mono"
                        value={
                          draft.promptOptimizeCustomUpstream
                            ? typeof draft.promptOptimizeBaseUrl === "string"
                              ? draft.promptOptimizeBaseUrl
                              : ""
                            : baseUrl
                        }
                        onChange={(e) => {
                          if (draft.promptOptimizeCustomUpstream) {
                            update("promptOptimizeBaseUrl", e.target.value);
                          }
                        }}
                        placeholder="https://other-gateway/v1"
                        disabled={!draft.promptOptimizeCustomUpstream}
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="prompt-optimize-key">API Key</label>
                        {draft.promptOptimizeCustomUpstream ? (
                          <button
                            type="button"
                            className="text-link"
                            onClick={() => setShowOptimizeKey((v) => !v)}
                          >
                            {showOptimizeKey ? "隐藏" : "显示"}
                          </button>
                        ) : null}
                      </div>
                      <input
                        id="prompt-optimize-key"
                        className="control mono"
                        type={
                          draft.promptOptimizeCustomUpstream
                            ? showOptimizeKey
                              ? "text"
                              : "password"
                            : showKey
                              ? "text"
                              : "password"
                        }
                        value={
                          draft.promptOptimizeCustomUpstream
                            ? typeof draft.promptOptimizeApiKey === "string"
                              ? draft.promptOptimizeApiKey
                              : ""
                            : apiKey
                        }
                        onChange={(e) => {
                          if (draft.promptOptimizeCustomUpstream) {
                            update("promptOptimizeApiKey", e.target.value);
                          }
                        }}
                        placeholder={draft.promptOptimizeCustomUpstream ? "独立上游密钥" : "g2a_..."}
                        disabled={!draft.promptOptimizeCustomUpstream}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    <div className="field">
                      <div className="label-row">
                        <label>独立优化上游</label>
                      </div>
                      <div className="segmented">
                        <button
                          type="button"
                          className={`chip ${!draft.promptOptimizeCustomUpstream ? "active" : ""}`}
                          onClick={() => update("promptOptimizeCustomUpstream", false)}
                        >
                          复用生图
                        </button>
                        <button
                          type="button"
                          className={`chip ${draft.promptOptimizeCustomUpstream ? "active" : ""}`}
                          onClick={() => update("promptOptimizeCustomUpstream", true)}
                        >
                          单独设定
                        </button>
                      </div>
                      {!draft.promptOptimizeCustomUpstream ? (
                        <p className="footer-note" style={{ marginTop: 6 }}>
                          复用左侧生图接口（上方 URL / Key 只读同步）
                        </p>
                      ) : (
                        <p className="footer-note" style={{ marginTop: 6 }}>
                          已单独设定：请填写上方优化 API Base / Key
                        </p>
                      )}
                    </div>

                    <div className="admin-model-picker-head">
                      <div className="admin-block-label admin-block-label-sub">点选优化模型</div>
                      <input
                        type="search"
                        className="control mono admin-model-filter"
                        value={optimizeModelFilter}
                        onChange={(e) => setOptimizeModelFilter(e.target.value)}
                        placeholder="筛选…"
                        disabled={models.length === 0}
                        aria-label="筛选优化模型"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    {models.length > 0 ? (
                      filteredOptimizeModels.length > 0 ? (
                        <div className="admin-model-grid" role="listbox" aria-label="提示词优化模型">
                          {filteredOptimizeModels.map((model) => (
                            <button
                              key={`opt-${model.id}`}
                              type="button"
                              role="option"
                              aria-selected={draft.promptOptimizeModel === model.id}
                              title={model.id}
                              className={`chip admin-model-chip ${
                                draft.promptOptimizeModel === model.id ? "active" : ""
                              }`}
                              onClick={() => update("promptOptimizeModel", model.id)}
                            >
                              <span className="admin-model-chip-text">{model.id}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="footer-note">无匹配「{optimizeModelFilter.trim()}」</p>
                      )
                    ) : (
                      <p className="footer-note">
                        点下方「测试连接」加载列表（需支持 chat/completions）
                      </p>
                    )}
                  </div>
                </div>

                <div className="admin-actions admin-actions-inline">
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={handleTestAndLoadModels}>
                      {busy ? "测试中…" : "测试连接"}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleSave}>
                      保存设置
                    </button>
                    <button type="button" className="btn btn-danger" disabled={busy} onClick={handleReset}>
                      恢复默认
                    </button>
                  </div>
                  {message ? (
                    <div className={`status ${ok === true ? "ok" : ok === false ? "err" : ""}`}>{message}</div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          {isStationMaster ? (
            <section className="panel admin-form-panel">
              <div className="admin-section admin-section-merged">
                <div className="admin-section-head">
                  <div>
                    <div className="section-card-title">Media</div>
                    <h3 className="admin-section-title">图片存储（CF Worker → Telegram）</h3>
                  </div>
                </div>
                <div className="admin-stack">
                  <p className="footer-note">
                    推荐用 Cloudflare <strong>Pages</strong> 上传{" "}
                    <code>releases/ciallo-telegram-media-pages.zip</code>
                    。Base 填 <code>https://项目名.pages.dev</code>（须能打开 /healthz）。Bot Token 只放在
                    CF 环境变量，不要填本页。
                  </p>
                  <div className="admin-fields-2">
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="mediaBase">Media Base URL</label>
                      </div>
                      <input
                        id="mediaBase"
                        className="control mono"
                        value={mediaBase}
                        placeholder="https://ciallo-telegram-media.xxx.workers.dev"
                        onChange={(e) => setMediaBaseDraft(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="field">
                      <div className="label-row">
                        <label htmlFor="mediaToken">Upload Token（可选）</label>
                      </div>
                      <input
                        id="mediaToken"
                        className="control mono"
                        value={mediaToken}
                        placeholder="与 Worker UPLOAD_TOKEN 相同"
                        onChange={(e) => setMediaTokenDraft(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="admin-actions admin-actions-inline">
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={mediaBusy}
                        onClick={() => void handleTestMedia()}
                      >
                        {mediaBusy ? "探测中…" : "测试 Worker"}
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={mediaBusy} onClick={handleSaveMedia}>
                        保存媒体配置
                      </button>
                    </div>
                    {mediaMsg ? (
                      <div className={`status ${mediaOk === true ? "ok" : mediaOk === false ? "err" : ""}`}>
                        {mediaMsg}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {isStationMaster ? <LogPanel /> : null}
        </>
      )}
    </div>
  );
}
