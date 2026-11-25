import Link from "next/link";

// The five tabs from tokens.md (PillNav). Only Today exists yet; each other tab becomes a link
// when its page lands with its ticket, and until then says so instead of leading nowhere.
const TABS = [
  { label: "Today", href: "/" },
  { label: "Queue", href: null },
  { label: "Pipeline", href: null },
  { label: "Grow", href: null },
  { label: "Inbox", href: null },
] as const;

export function PillNav({ current }: { current: string }) {
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
    </nav>
  );
}
