import type { ApiResult } from "./system";

// Today's counts of what needs Paul (NS-207, DSH-003): each links to its page. A count comes
// from the same list its page shows, so the two always agree. A count that can't be read says
// so, never 0, and what isn't built yet says "not set up yet".

export type TodayCount = {
  label: string;
  // Where the count leads, or null while there's no page for it.
  href: string | null;
  value: string;
};

const NOT_SET_UP = "not set up yet";
const UNREADABLE = "can't be read right now";

const countOf = (list: ApiResult<{ items: unknown[] }>): string =>
  list.kind === "ok" ? String(list.body.items.length) : UNREADABLE;

export function todayCounts(
  approvals: ApiResult<{ items: unknown[] }>,
  handoffs: ApiResult<{ items: unknown[] }>,
): TodayCount[] {
  return [
    { label: "Approvals waiting", href: "/approvals", value: countOf(approvals) },
    { label: "Needs your hands", href: "#needs-your-hands", value: countOf(handoffs) },
    // Interviews (NS-169, NS-170), follow-ups (NS-166) and growth blocks (NS-210) aren't built.
    { label: "Interviews coming up", href: null, value: NOT_SET_UP },
    { label: "Follow-ups due", href: null, value: NOT_SET_UP },
    { label: "Today's growth block", href: null, value: NOT_SET_UP },
  ];
}
