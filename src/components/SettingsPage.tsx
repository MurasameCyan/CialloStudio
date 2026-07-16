import { useMemo, useState } from "react";
import { ApiError, listModels, resolveBrowserApiBase, type OpenAIModel } from "@/lib/api";
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

  const imageModels = useMemo(() => {
    const ids = models.map((m) => m.id);
    if (!ids.includes("grok-imagine-image")) {
      return ["grok-imagine-image", ...ids];
    }
    return ids;
  }, [models]);

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
      setMessage(
        `连接成功，共 ${list.length} 个模型。请求基址：${resolveBrowserApiBase(normalized.baseUrl)} · 模型：${preferred}`,
      );
    } catch (error) {
      setOk(false);
      const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "连接失败";
      log("error", "管理页：测试连接失败", message);
      setMessage(message);
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
    setMessage(
      `已保存。配置 Base: ${normalized.baseUrl} · 实际请求: ${resolveBrowserApiBase(normalized.baseUrl)} · Model: ${normalized.model}`,
    );
  }

  function useSameOriginProxy() {
    update("baseUrl", "/v1");
    setMessage("已切换为同源代理 /v1（推荐）。请再点保存 / 测试连接。");
    setOk(null);
  }

  function handleReset() {
    setDraft({ ...DEFAULT_SETTINGS });
    setModels([]);
    setOk(null);
    setMessage("已恢复默认值（尚未写入本地，需点保存）");
  }

  return (
    <div className="page">
      <section className="panel">
        <h2 className="panel-title">管理</h2>
        <p className="panel-desc">
          填写 OpenAI 兼容接口的 Base URL 与 API Key。推荐使用同源代理路径 <span className="mono">/v1</span>
          ；也可直接填写完整地址，例如 <span className="mono">https://your-host/v1</span>。
        </p>

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
          <div className="field-hint">
            推荐填 <span className="mono">/v1</span>（同源代理，可避开 CORS）。
            若填完整域名，前端也会自动改走 <span className="mono">/v1</span>。
            页面底部有运行日志，失败时请看红色条目。
          </div>
        </div>

        <div className="field">
          <label htmlFor="apiKey">API Key</label>
          <input
            id="apiKey"
            className="control mono"
            type="password"
            value={draft.apiKey}
            placeholder="g2a_..."
            onChange={(e) => update("apiKey", e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="field-hint">仅保存在浏览器 localStorage，不会写入镜像或仓库。</div>
        </div>

        <div className="row">
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
          </div>
          <div className="field">
            <label htmlFor="concurrency">多并发数</label>
            <input
              id="concurrency"
              className="control"
              type="number"
              min={1}
              max={8}
              value={draft.concurrency}
              onChange={(e) => update("concurrency", Number(e.target.value))}
            />
            <div className="field-hint">
              1–8。全局并发槽：同一时间最多多少个「子任务」在请求上游。
              生图页「每条张数」会 fan-out 出多个子任务。
            </div>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>默认宽高比</label>
            <div className="chip-row">
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
            <div className="chip-row">
              {RESOLUTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`chip ${draft.resolution === item ? "active" : ""}`}
                  onClick={() => update("resolution", item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={handleTestAndLoadModels}>
            {busy ? "测试中…" : "测试连接并拉取模型"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={handleSave}>
            保存设置
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={useSameOriginProxy}>
            使用同源代理 /v1
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={handleReset}>
            恢复默认
          </button>
        </div>

        {message ? <div className={`status ${ok === true ? "ok" : ok === false ? "err" : ""}`}>{message}</div> : null}

        {models.length > 0 ? (
          <div className="field" style={{ marginTop: 16, marginBottom: 0 }}>
            <label>已拉取模型</label>
            <div className="chip-row">
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

        <p className="footer-note">
          目标接口：OpenAI 兼容 <span className="mono">GET /models</span> 与{" "}
          <span className="mono">POST /images/generations</span>。默认模型{" "}
          <span className="mono">grok-imagine-image</span>。
        </p>
      </section>
    </div>
  );
}
