import Link from "next/link";
import type { DotStatus } from "./system";

// The five tabs from tokens.md (PillNav). Today, Queue (the approval queue, NS-139) and Pipeline
// (NS-168) exist; each other tab becomes a link when its page lands with its ticket, and until then
// says so instead of leading nowhere.
const TABS = [
  { label: "Today", href: "/" },
  { label: "Queue", href: "/approvals" },
  { label: "Pipeline", href: "/pipeline" },
  { label: "Grow", href: null },
  { label: "Inbox", href: null },
] as const;

// The HealthDot (tokens.md, RES-013): the overall status as a dot, with words for screen readers.
const DOT_LABEL: Record<DotStatus, string> = {
  healthy: "System health: all working",
  degraded: "System health: something needs a look",
  down: "System health: can't be read",
};

export function PillNav({ current, health }: { current: string; health?: DotStatus | null }) {
  return (
    <nav className="pill-nav" aria-label="Main">
      {TABS.map((tab) =>
        tab.href === null ? (
          <span key={tab.label} aria-disabled="true" title="Not built yet">
            {tab.label}
          </span>
        ) : (
          <Link
            key={tab.label}
            href={tab.href}
            aria-current={tab.href === current ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ),
      )}
      {health ? (
        <Link
          href="/health"
          className="health-dot"
          data-status={health}
          aria-label={DOT_LABEL[health]}
          title={DOT_LABEL[health]}
        >
          <span aria-hidden="true">●</span>
        </Link>
      ) : null}
    </nav>
  );
}
