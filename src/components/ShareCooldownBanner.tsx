import { useEffect, useState } from "react";
import { computeShareRemainSec, type ShareStatus } from "@/lib/community/types";

type Props = {
  shareStatus: ShareStatus | null;
  /** 仅在用户触发过分享 UI 时展示 */
  revealed: boolean;
  onExpired?: () => void;
};

/** 独立秒表：避免父级整页每秒 re-render */
export function ShareCooldownBanner({ shareStatus, revealed, onExpired }: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  const active =
    revealed &&
    Boolean(shareStatus && shareStatus.cooldownSec > 0 && shareStatus.lastShareAt);

  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, shareStatus?.lastShareAt, shareStatus?.cooldownSec]);

  const remainSec =
    active && shareStatus
      ? computeShareRemainSec(shareStatus.cooldownSec, shareStatus.lastShareAt, nowMs)
      : 0;

  useEffect(() => {
    if (active && remainSec <= 0) onExpired?.();
  }, [active, remainSec, onExpired]);

  if (!active || remainSec <= 0) return null;

  return (
    <div className="studio-feedback studio-feedback-warn" role="status">
      <span className="studio-feedback-dot warn" aria-hidden />
      <span className="studio-feedback-text">
        分享冷却中 · 还剩 <strong>{remainSec}</strong> 秒
      </span>
    </div>
  );
}

export function isShareCooling(shareStatus: ShareStatus | null, nowMs = Date.now()): boolean {
  if (!shareStatus || shareStatus.cooldownSec <= 0 || !shareStatus.lastShareAt) return false;
  return computeShareRemainSec(shareStatus.cooldownSec, shareStatus.lastShareAt, nowMs) > 0;
}
