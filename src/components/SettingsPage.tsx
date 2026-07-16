import { useMemo, useState } from "react";
import { LogPanel } from "@/components/LogPanel";
import { ApiError, listModels, resolveBrowserApiBase, type OpenAIModel } from "@/lib/api";
import { getImageModelCapability } from "@/lib/imageModels";
import { log } from "@/lib/logger";
import {
  ASPECT_RATIOS,
  DEFAULT_SETTINGS,
  RESOLUTIONS,
  type StudioSettings,
  clampConcurrency,
  normalizeBaseUrl,
  saveSettings,
} from "@/lib/settings";

type Props = {
  settings: StudioSettings;
  onChange: (next: StudioSettings) => void;
};

export function SettingsPage({ settings, onChange }: Props) {
  const [draft, setDraft] = useState<StudioSettings>(settings);
  const [models, setModels] = useState<OpenAIModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [showKey, setShowKey] = useState(false);

  const imageModels = useMemo(() => {
    const ids = models.map((m) => m.id);
    if (!ids.includes("grok-imagine-image")) {
      return ["grok-imagine-image", ...ids];
    }
    return ids;
  }, [models]);

  const hasKey = Boolean(draft.apiKey.trim());
  const requestBase = resolveBrowserApiBase(draft.baseUrl);
  const modelCap = useMemo(() => getImageModelCapability(draft.model), [draft.model]);

  function update<K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function persist(next: StudioSettings) {
    const normalized: StudioSettings = {
      ...next,
      baseUrl: normalizeBaseUrl(next.baseUrl),
      concurrency: clampConcurrency(next.concurrency),
    };
    saveSettings(normalized);
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
      log("info", "管理页：测试连接", {
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
      const text = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "连接失败";
      log("error", "管理页：测试连接失败", text);
      setMessage(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    const normalized = persist(draft);
    log("ok", "设置已保存", {
      baseUrl: normalized.baseUrl,
      requestBase: resolveBrowserApiBase(normalized.baseUrl),
      model: normalized.model,
      concurrency: normalized.concurrency,
    });
    setOk(true);
    setMessage(`已保存 · 模型 ${normalized.model} · 并发 ${normalized.concurrency}`);
  }

  function useSameOriginProxy() {
    update("baseUrl", "/v1");
    setMessage("已切换为同源代理 /v1，请保存或测试连接。");
    setOk(null);
  }

  function handleReset() {
    setDraft({ ...DEFAULT_SETTINGS });
    setModels([]);
    setOk(null);
    setMessage("已恢复默认值（尚未写入本地，需点保存）");
  }

  return (
    <div className="page admin-layout">
      <section className="panel admin-hero">
        <div className="admin-hero-top">
          <div className="panel-kicker">Admin</div>
          <h2 className="panel-title">控制台</h2>
          <p className="panel-desc">管理接口连接、默认生成参数，以及查看运行日志。</p>
        </div>

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
      </section>

      <section className="panel admin-form-panel">
        <div className="admin-section">
          <div className="admin-section-head">
            <div>
              <div className="section-card-title">Connection</div>
              <h3 className="admin-section-title">接口连接</h3>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={useSameOriginProxy}>
              使用 /v1
            </button>
          </div>

          <div className="admin-stack">
            <div className="field">
              <label htmlFor="baseUrl">API Base URL</label>
              <input
                id="baseUrl"
                className="control mono"
                value={draft.baseUrl}
                placeholder="/v1 或 https://host/v1"
                onChange={(e) => update("baseUrl", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="field-hint">推荐同源代理 `/v1`，可避免浏览器 CORS 问题。</div>
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
                value={draft.apiKey}
                placeholder="g2a_..."
                onChange={(e) => update("apiKey", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="field-hint">仅保存在本机浏览器，不会进入镜像或仓库。</div>
            </div>
          </div>
        </div>

        <div className="admin-section">
          <div className="admin-section-head">
            <div>
              <div className="section-card-title">Generation</div>
              <h3 className="admin-section-title">生成默认值</h3>
            </div>
          </div>

          <div className="admin-stack">
            <div className="field">
              <label htmlFor="model">模型</label>
              <input
                id="model"
                className="control mono"
                list="model-options"
                value={draft.model}
                onChange={(e) => update("model", e.target.value)}
                placeholder="grok-imagine-image"
                spellCheck={false}
              />
              <datalist id="model-options">
                {imageModels.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <div className="field-hint">生图默认模型，可从下方列表点选。</div>
            </div>

            <div className="field">
              <label htmlFor="concurrency">全局并发槽</label>
              <input
                id="concurrency"
                className="control"
                type="number"
                min={1}
                max={8}
                value={draft.concurrency}
                onChange={(e) => update("concurrency", Number(e.target.value))}
              />
              <div className="field-hint">1–8，同时最多多少个子任务请求上游。</div>
            </div>

            <div className="field">
              <label>默认宽高比</label>
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
              <label>默认分辨率</label>
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
              <div className="field-hint">{modelCap.note}</div>
            </div>
          </div>
        </div>

        {models.length > 0 ? (
          <div className="admin-section">
            <div className="admin-section-head">
              <div>
                <div className="section-card-title">Models</div>
                <h3 className="admin-section-title">可用模型</h3>
              </div>
            </div>
            <div className="segmented">
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`chip ${draft.model === model.id ? "active" : ""}`}
                  onClick={() => update("model", model.id)}
                >
                  {model.id}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="admin-actions">
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
          ) : (
            <div className="admin-actions-hint">先测试连接，确认模型列表后再回生图页使用。</div>
          )}
        </div>
      </section>

      <div className="admin-bottom-grid">
        <section className="panel admin-side-card">
          <div className="section-card-title">Quick Tips</div>
          <h3 className="admin-section-title">使用提示</h3>
          <ul className="admin-tips">
            <li>
              Base 优先填 <span className="mono">/v1</span>
            </li>
            <li>Key 只存浏览器本地</li>
            <li>并发槽控制 fan-out 同时请求数</li>
            <li>生图失败细节看右侧日志</li>
          </ul>
        </section>
        <LogPanel />
      </div>
    </div>
  );
}
