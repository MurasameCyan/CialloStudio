import type { StudioMode } from "@/lib/studioMode";

type Props = {
  mode: StudioMode;
  onChange: (mode: StudioMode) => void;
};

export function StudioModeSwitch({ mode, onChange }: Props) {
  return (
    <div className="studio-mode-switch studio-view-switch" role="tablist" aria-label="创作工作台模式">
      <button
        type="button"
        role="tab"
        aria-selected={mode === "console"}
        className={`studio-mode-tab ${mode === "console" ? "active" : ""}`}
        onClick={() => onChange("console")}
      >
        控制台
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "chat"}
        className={`studio-mode-tab ${mode === "chat" ? "active" : ""}`}
        onClick={() => onChange("chat")}
      >
        对话
      </button>
    </div>
  );
}
