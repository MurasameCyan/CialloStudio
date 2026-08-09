import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildTemplatePrompt,
  countTemplateItems,
  normalizeTemplateLibrary,
  randomTemplateSelection,
  saveTemplateLibrary,
  toggleTemplateSelection,
  type TemplateLibrary,
  type TemplateSelection,
} from "@/lib/promptTemplates";

type Props = {
  open: boolean;
  library: TemplateLibrary;
  onLibraryChange: (library: TemplateLibrary) => void;
  /** mode=replace 覆盖输入框，append 追加到末尾 */
  onApply: (text: string, mode: "replace" | "append") => void;
  onClose: () => void;
};

export function PromptTemplateDialog({
  open,
  library,
  onLibraryChange,
  onApply,
  onClose,
}: Props) {
  const [selection, setSelection] = useState<TemplateSelection>({});
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const total = countTemplateItems(library);
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

  if (!open) return null;

  const current = library.categories.find((c) => c.id === activeCat) ?? null;

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
    saveTemplateLibrary(next);
    onLibraryChange(next);
    setSelection({});
    setImportText("");
    setNotice({ ok: true, text: `已导入 ${next.categories.length} 个分类 / ${countTemplateItems(next)} 条` });
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
              <span className="tpl-manage-hint">
                本地词库 HTML 可用 <code>scripts/convert-prompt-library.mjs</code> 转成此格式
              </span>
            </div>
          </div>
        ) : null}

        {total ? (
          <div className="tpl-body">
            <div className="tpl-cats" role="tablist" aria-label="模板分类">
              {library.categories.map((cat) => {
                const n = selection[cat.id]?.length ?? 0;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    role="tab"
                    aria-selected={cat.id === activeCat}
                    className={`tpl-cat ${cat.id === activeCat ? "active" : ""}`}
                    onClick={() => setActiveCat(cat.id)}
                  >
                    <span className="tpl-cat-name">{cat.name}</span>
                    <span className="tpl-cat-count">{n > 0 ? n : cat.items.length}</span>
                  </button>
                );
              })}
            </div>

            <div className="tpl-items">
              {current ? (
                <>
                  <div className="tpl-items-head">
                    <span>{current.multi ? "可多选" : "单选"}</span>
                    {selection[current.id]?.length ? (
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
                      const on = selection[current.id]?.includes(item.id) ?? false;
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
          <div className="tpl-empty">
            词库还是空的。点右上角「词库」导入 JSON，或用{" "}
            <code>node scripts/convert-prompt-library.mjs &lt;词库.html&gt; out.json</code> 从本地词库生成。
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
