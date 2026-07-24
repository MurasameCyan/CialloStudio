import { Moon, Sun } from "lucide-react";
import { toggleTheme, type UiTheme } from "@/lib/theme";

type Props = {
  theme: UiTheme;
  onChange: (theme: UiTheme) => void;
};

export function ThemeToggle({ theme, onChange }: Props) {
  const next = toggleTheme(theme);
  const label = theme === "dark" ? "Dark" : "Light";
  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={() => onChange(next)}
      title={`当前 ${label} · 点击切换到 ${next === "dark" ? "Dark" : "Light"}`}
      aria-label={`当前主题 ${label}，点击切换到 ${next === "dark" ? "Dark" : "Light"}`}
    >
      {theme === "dark" ? <Moon size={15} strokeWidth={2.2} aria-hidden /> : <Sun size={15} strokeWidth={2.2} aria-hidden />}
      <span>{label}</span>
    </button>
  );
}
