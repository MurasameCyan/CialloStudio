import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import {
  buildTemplatePrompt,
  canApplyDefaultTemplate,
  countTemplateItems,
  fetchDefaultTemplateLibrary,
  groupTemplateCategories,
  hasTriedDefaultLibrary,
  markTriedDefaultLibrary,
  normalizeTemplateLibrary,
  randomTemplateSelection,
  saveTemplateLibrary,
  toggleTemplateSelection,
  type TemplateCategoryLeaf,
  type TemplateLibrary,
  type TemplateSelection,
} from "@/lib/promptTemplates";
import { DEFAULT_PROMPT_TEMPLATES_URL, getPromptTemplatesSource } from "@/lib/runtimeConfig";

type Props = {
  open: boolean;
  library: TemplateLibrary;
  onLibraryChange: (library: TemplateLibrary) => void;
  /** mode=replace 覆盖输入框，append 追加到末尾 */
  onApply: (text: string, mode: "replace" | "append") => void;
  onClose: () => void;
};

function sourceExpansionKey(sourceKey: string): string {
  return `source:${sourceKey}`;
}

function subgroupExpansionKey(subgroupKey: string): string {
  return `subgroup:${subgroupKey}`;
}

function selectedIds(selection: TemplateSelection, categoryId: string): string[] {
  const ids = Object.prototype.hasOwnProperty.call(selection, categoryId)
    ? selection[categoryId]
    : undefined;
  return Array.isArray(ids) ? ids : [];
}

export function PromptTemplateDialog({
  open,
  library,
  onLibraryChange,
  onApply,
  onClose,
}: Props) {
  const [selection, setSelection] = useState<TemplateSelection>({});
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [expandedCatGroups, setExpandedCatGroups] = useState<Set<string>>(() => new Set());
  const [manageOpen, setManageOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadingDefault, setLoadingDefault] = useState(false);
  /** 约定路径探测不到词库：这部署就是没提供，空态不必给重试按钮 */
  const [implicitMissing, setImplicitMissing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** 同一次挂载内只自动拉一次；localStorage 标记跨刷新，这个 ref 防 StrictMode 双跑 */
  const fetchOnceRef = useRef(false);
  const mountedRef = useRef(true);
  const defaultLoadTokenRef = useRef(0);
  const libraryRef = useRef(library);

  const total = countTemplateItems(library);
  const categoryGroups = useMemo(() => groupTemplateCategories(library), [library]);
  const categoryLeafIndex = useMemo(() => {
    const index = new Map<
      string,
      {
        leaf: TemplateCategoryLeaf;
        sourceKey: string;
        subgroupKey: string | null;
      }
    >();
    for (const source of categoryGroups) {
      for (const leaf of source.categories) {
        index.set(leaf.category.id, { leaf, sourceKey: source.key, subgroupKey: null });
      }
      for (const subgroup of source.subgroups) {
        for (const leaf of subgroup.categories) {
          index.set(leaf.category.id, {
            leaf,
            sourceKey: source.key,
            subgroupKey: subgroup.key,
          });
        }
      }
    }
    return index;
  }, [categoryGroups]);
  const currentLocation = activeCat ? categoryLeafIndex.get(activeCat) ?? null : null;
  const currentLeaf = currentLocation?.leaf ?? null;
  const preview = useMemo(() => buildTemplatePrompt(library, selection), [library, selection]);
  const pickedCount = useMemo(
    () => Object.values(selection).reduce((sum, ids) => sum + ids.length, 0),
    [selection],
  );

  // 打开时聚焦关闭按钮，Esc 关闭；与大图预览同一套交互
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 库变化（导入、首次加载）后校正当前分类，避免指向已不存在的 id
  useEffect(() => {
    const ids = library.categories.map((c) => c.id);
    if (!ids.length) setActiveCat(null);
    else if (!activeCat || !ids.includes(activeCat)) setActiveCat(ids[0]!);
  }, [library, activeCat]);

  // 切换分类或词库时展开当前路径；用户仍可手动收起当前组，右侧内容保持不变。
  useEffect(() => {
    if (!currentLocation) return;
    const required = [sourceExpansionKey(currentLocation.sourceKey)];
    if (currentLocation.subgroupKey) {
      required.push(subgroupExpansionKey(currentLocation.subgroupKey));
    }
    setExpandedCatGroups((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const key of required) {
        if (next.has(key)) continue;
        next.add(key);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [activeCat, categoryLeafIndex, currentLocation]);

  /**
   * 拉取站长配置的默认词库。自动路径（首次打开且本地为空）尊重 FETCHED 标记，
   * 失败后不再反复烦用户；手动路径（空态按钮）无视标记，站长改好配置能立刻重试。
   */
  const loadDefault = useCallback(
    async (manual: boolean) => {
      const requestToken = ++defaultLoadTokenRef.current;
      const hadExistingLibrary = libraryRef.current.categories.length > 0;
      const { url, explicit } = getPromptTemplatesSource();
      setLoadingDefault(true);
      const res = await fetchDefaultTemplateLibrary(url);
      if (!mountedRef.current) return;
      if (!canApplyDefaultTemplate(manual, requestToken, defaultLoadTokenRef.current, libraryRef.current)) {
        if (requestToken === defaultLoadTokenRef.current) setLoadingDefault(false);
        return;
      }
      setLoadingDefault(false);
      if (res.ok) {
        const persisted = saveTemplateLibrary(res.library);
        // 只有真的落盘了才打标记：写不下时留着自动路径，下次打开还能再拉一次，
        // 否则本地是空库、标记又拦住自动拉取，用户就只剩一个空词库。
        if (persisted) markTriedDefaultLibrary();
        onLibraryChange(res.library);
        setSelection({});
        const summary = `${res.library.categories.length} 个分类 / ${countTemplateItems(res.library)} 条`;
        // 空库写不进时下次会重拉；已有库写不进时保留旧缓存，不能误报会自动更新
        const persistenceHint = hadExistingLibrary ? "刷新后仍保留之前的词库" : "下次打开会重新载入";
        setNotice(
          persisted
            ? { ok: true, text: `已载入默认词库 ${summary}` }
            : { ok: false, text: `已载入 ${summary}，但浏览器存储写不下，${persistenceHint}` },
        );
        return;
      }

      // 走约定路径的自动探测拉不到，只说明站长没提供词库，不是故障，不该弹错误。
      // 也不打 FETCHED 标记——站长以后挂上文件，用户下次进来就能自动拿到。
      if (!explicit && !manual && res.definitive) {
        setImplicitMissing(true);
        return;
      }

      // 地址/内容问题重试无意义，打标记不再自动重试；网络问题留着下次打开再试
      // （弹窗关闭时组件不卸载，所以要手动放开这道闸，否则得刷新页面才会重试）
      if (res.definitive) markTriedDefaultLibrary();
      else fetchOnceRef.current = false;
      setNotice({ ok: false, text: `默认词库加载失败：${res.error}` });
    },
    [onLibraryChange],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    libraryRef.current = library;
  }, [library]);

  /** 首次打开且本地词库为空时自动拉一次；用户导入过或主动清空过都不碰 */
  useEffect(() => {
    if (!open || library.categories.length || fetchOnceRef.current) return;
    if (hasTriedDefaultLibrary()) return;
    fetchOnceRef.current = true;
    void loadDefault(false);
  }, [open, library.categories.length, loadDefault]);

  if (!open) return null;

  const current = currentLeaf?.category ?? null;

  function applyImport(raw: string) {
    const text = raw.trim();
    if (!text) {
      setNotice({ ok: false, text: "请先粘贴词库 JSON" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setNotice({ ok: false, text: "JSON 解析失败，请检查内容" });
      return;
    }
    const next = normalizeTemplateLibrary(parsed);
    if (!next.categories.length) {
      setNotice({ ok: false, text: "没有解析出任何有效条目" });
      return;
    }
    defaultLoadTokenRef.current += 1;
    setLoadingDefault(false);
    const persisted = saveTemplateLibrary(next);
    onLibraryChange(next);
    setSelection({});
    setImportText("");
    const summary = `${next.categories.length} 个分类 / ${countTemplateItems(next)} 条`;
    setNotice(
      persisted
        ? { ok: true, text: `已导入 ${summary}` }
        : { ok: false, text: `已导入 ${summary}，但浏览器存储写不下，下次打开需重新导入` },
    );
  }

  function handleExport() {
    if (!total) {
      setNotice({ ok: false, text: "词库为空，无可导出内容" });
      return;
    }
    const blob = new Blob([JSON.stringify(library, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ciallo-prompt-templates.json";
    a.click();
    URL.revokeObjectURL(url);
    setNotice({ ok: true, text: "已导出词库 JSON" });
  }

  function handlePickFile(file: File | undefined) {
    if (!file) return;
    defaultLoadTokenRef.current += 1;
    setLoadingDefault(false);
    void file
      .text()
      .then(applyImport)
      .catch(() => setNotice({ ok: false, text: "文件读取失败" }));
  }

  function handleApply(mode: "replace" | "append") {
    if (!preview) {
      setNotice({ ok: false, text: "请先勾选至少一项" });
      return;
    }
    onApply(preview, mode);
    onClose();
  }

  function toggleCategoryGroup(key: string) {
    setExpandedCatGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderCategoryLeaf(leaf: TemplateCategoryLeaf) {
    const cat = leaf.category;
    const selectedCount = selectedIds(selection, cat.id).length;
    const active = cat.id === activeCat;
    return (
      <button
        key={`category:${cat.id}`}
        type="button"
        aria-current={active ? "page" : undefined}
        className={`tpl-cat ${active ? "active" : ""}`}
        title={cat.name}
        onClick={() => setActiveCat(cat.id)}
      >
        <span className="tpl-cat-name">{leaf.label}</span>
        <span className="tpl-cat-count">{selectedCount > 0 ? selectedCount : cat.items.length}</span>
      </button>
    );
  }

  return createPortal(
    <div className="studio-lightbox-backdrop" role="presentation" onClick={onClose}>
      <div
        className="tpl-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="提示词模板"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tpl-head">
          <div className="tpl-title">
            <strong>提示词模板</strong>
            <span className="tpl-sub">
              {total ? `${library.categories.length} 个分类 · ${total} 条` : "词库为空 · 先导入"}
            </span>
          </div>
          <div className="tpl-head-actions">
            <button
              type="button"
              className={`hall-chip ${manageOpen ? "tpl-chip-on" : ""}`}
              aria-expanded={manageOpen}
              onClick={() => setManageOpen((v) => !v)}
            >
              词库
            </button>
            <button
              ref={closeRef}
              type="button"
              className="studio-lightbox-close"
              aria-label="关闭模板"
              title="关闭（Esc）"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        {manageOpen ? (
          <div className="tpl-manage">
            <label className="tpl-manage-label" htmlFor="tpl-import">
              粘贴词库 JSON（分类数组，条目支持 <code>text</code> 或 <code>core</code> 字段）
            </label>
            <textarea
              id="tpl-import"
              className="textarea tpl-manage-input"
              rows={4}
              spellCheck={false}
              placeholder={'[{"name":"姿势","items":[{"name":"后入","text":"塌腰翘臀"}]}]'}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <div className="tpl-manage-row">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => applyImport(importText)}>
                导入并覆盖
              </button>
              <label className="hall-chip tpl-file">
                选择文件
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    handlePickFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <button type="button" className="hall-chip" onClick={handleExport}>
                导出
              </button>
              <button
                type="button"
                className="hall-chip"
                disabled={loadingDefault}
                onClick={() => void loadDefault(true)}
              >
                {loadingDefault ? "载入中…" : "载入默认词库并覆盖"}
              </button>
              <span className="tpl-manage-hint">
                本地词库 HTML 可用 <code>scripts/convert-prompt-library.mjs</code> 转成此格式
              </span>
            </div>
          </div>
        ) : null}

        {total ? (
          <div className="tpl-body">
            <nav className="tpl-cat-tree" aria-label="模板分类">
              {categoryGroups.map((source) => {
                const sourceStateKey = sourceExpansionKey(source.key);
                const sourceOpen = expandedCatGroups.has(sourceStateKey);
                const sourceActive = currentLocation?.sourceKey === source.key;
                const sourcePanelId = `tpl-cat-source-${source.key}`;
                const sourceCount =
                  source.categories.length +
                  source.subgroups.reduce((sum, subgroup) => sum + subgroup.categories.length, 0);
                return (
                  <section key={`source:${source.key}`} className="tpl-cat-group">
                    <button
                      type="button"
                      className="tpl-cat-group-toggle"
                      aria-expanded={sourceOpen}
                      aria-controls={sourceOpen ? sourcePanelId : undefined}
                      data-level="source"
                      data-active={sourceActive ? "true" : undefined}
                      onClick={() => toggleCategoryGroup(sourceStateKey)}
                    >
                      <ChevronRight className="tpl-cat-group-chevron" aria-hidden="true" />
                      <span className="tpl-cat-group-label">{source.label}</span>
                      <span className="tpl-cat-group-count">{sourceCount}</span>
                    </button>
                    {sourceOpen ? (
                      <div id={sourcePanelId} className="tpl-cat-group-list">
                        {source.subgroups.map((subgroup, subgroupIndex) => {
                          const subgroupStateKey = subgroupExpansionKey(subgroup.key);
                          const subgroupOpen = expandedCatGroups.has(subgroupStateKey);
                          const subgroupActive = currentLocation?.subgroupKey === subgroup.key;
                          const subgroupPanelId = `tpl-cat-subgroup-${source.key}-${subgroupIndex}`;
                          return (
                            <div key={`subgroup:${subgroup.key}`} className="tpl-cat-subgroup">
                              <button
                                type="button"
                                className="tpl-cat-group-toggle"
                                aria-expanded={subgroupOpen}
                                aria-controls={subgroupOpen ? subgroupPanelId : undefined}
                                data-level="topic"
                                data-active={subgroupActive ? "true" : undefined}
                                onClick={() => toggleCategoryGroup(subgroupStateKey)}
                              >
                                <ChevronRight className="tpl-cat-group-chevron" aria-hidden="true" />
                                <span className="tpl-cat-group-label">{subgroup.label}</span>
                                <span className="tpl-cat-group-count">{subgroup.categories.length}</span>
                              </button>
                              {subgroupOpen ? (
                                <div id={subgroupPanelId} className="tpl-cat-leaves">
                                  {subgroup.categories.map(renderCategoryLeaf)}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {source.categories.map(renderCategoryLeaf)}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </nav>

            <label className="tpl-cat-mobile">
              <select
                className="control tpl-cat-select"
                aria-label="模板分类"
                value={activeCat ?? ""}
                onChange={(event) => setActiveCat(event.target.value)}
              >
                {categoryGroups.flatMap((source) => [
                  ...source.subgroups.map((subgroup) => (
                    <optgroup
                      key={`subgroup:${subgroup.key}`}
                      label={`${source.label} / ${subgroup.label}`}
                    >
                      {subgroup.categories.map((leaf) => (
                        <option key={`category:${leaf.category.id}`} value={leaf.category.id}>
                          {leaf.label}
                        </option>
                      ))}
                    </optgroup>
                  )),
                  source.categories.length ? (
                    <optgroup key={`direct:${source.key}`} label={source.label}>
                      {source.categories.map((leaf) => (
                        <option key={`category:${leaf.category.id}`} value={leaf.category.id}>
                          {leaf.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null,
                ])}
              </select>
            </label>

            <div className="tpl-items">
              {current ? (
                <>
                  <div className="tpl-items-head">
                    <div className="tpl-items-head-main">
                      <strong className="tpl-current-title" title={current.name}>
                        {currentLeaf ? currentLeaf.path.join(" / ") : current.name}
                      </strong>
                      <span className="tpl-items-mode">{current.multi ? "可多选" : "单选"}</span>
                    </div>
                    {selectedIds(selection, current.id).length ? (
                      <button
                        type="button"
                        className="tpl-link"
                        onClick={() =>
                          setSelection((prev) => {
                            const next = { ...prev };
                            delete next[current.id];
                            return next;
                          })
                        }
                      >
                        清除本类
                      </button>
                    ) : null}
                  </div>
                  <div className="tpl-items-grid">
                    {current.items.map((item) => {
                      const on = selectedIds(selection, current.id).includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`chip tpl-item ${on ? "active" : ""}`}
                          aria-pressed={on}
                          title={item.text}
                          onClick={() =>
                            setSelection((prev) => toggleTemplateSelection(prev, current, item.id))
                          }
                        >
                          {item.name}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="tpl-empty" aria-busy={loadingDefault}>
            {loadingDefault ? (
              "正在获取默认词库…"
            ) : (
              <>
                词库还是空的。点右上角「词库」导入 JSON，或用{" "}
                <code>node scripts/convert-prompt-library.mjs &lt;词库.html&gt; out.json</code>{" "}
                从本地词库生成。
                {/* 探测不到就别给按钮，点了必然还是失败；其余情况留手动入口，
                    因为 definitive 失败打了标记后自动路径不会再跑 */}
                {implicitMissing ? (
                  <div className="tpl-empty-hint">
                    这个站点没有提供默认词库。站长可把 JSON 挂到{" "}
                    <code>{DEFAULT_PROMPT_TEMPLATES_URL}</code> 即自动生效。
                  </div>
                ) : (
                  <div className="tpl-empty-actions">
                    <button type="button" className="hall-chip" onClick={() => void loadDefault(true)}>
                      载入默认词库
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="tpl-preview">
          <div className="tpl-preview-head">
            <span>预览</span>
            <span className="tpl-preview-count">
              {pickedCount > 0 ? `已选 ${pickedCount} 项 · ${preview.length} 字` : "未选择"}
            </span>
          </div>
          <div className="tpl-preview-text">{preview || "勾选条目后在此预览拼接结果"}</div>
        </div>

        <div className="tpl-foot">
          {notice ? (
            <span className={`tpl-notice ${notice.ok ? "ok" : "bad"}`}>{notice.text}</span>
          ) : (
            <span className="tpl-notice" />
          )}
          <div className="tpl-foot-actions">
            <button
              type="button"
              className="hall-chip"
              disabled={!total}
              onClick={() => setSelection(randomTemplateSelection(library))}
            >
              随机
            </button>
            <button
              type="button"
              className="hall-chip"
              disabled={!pickedCount}
              onClick={() => setSelection({})}
            >
              清空
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!preview}
              onClick={() => handleApply("append")}
            >
              追加
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!preview}
              onClick={() => handleApply("replace")}
            >
              写入输入框
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
