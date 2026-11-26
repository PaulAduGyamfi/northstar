import { describe, expect, it } from "vitest";
import { todayCounts } from "./today";

// Today's counts (NS-207, DSH-003), from the same lists the Queue and the handoff card show.

const list = (n: number) => ({ kind: "ok" as const, body: { items: Array.from({ length: n }) } });

describe("todayCounts", () => {
  it("counts the Queue's and the handoffs' own lists and links to them", () => {
    const rows = todayCounts(list(3), list(1));
    expect(rows.slice(0, 2)).toEqual([
      { label: "Approvals waiting", href: "/approvals", value: "3" },
      { label: "Needs your hands", href: "#needs-your-hands", value: "1" },
    ]);
  });

  it("says a count can't be read rather than showing 0", () => {
    const rows = todayCounts({ kind: "error", status: 503 }, { kind: "unreachable" });
    expect(rows.slice(0, 2).map((r) => r.value)).toEqual([
      "can't be read right now",
      "can't be read right now",
    ]);
  });

  it("shows what isn't built yet as not set up, with no link", () => {
    expect(todayCounts(list(0), list(0)).slice(2)).toEqual([
      { label: "Interviews coming up", href: null, value: "not set up yet" },
      { label: "Follow-ups due", href: null, value: "not set up yet" },
      { label: "Today's growth block", href: null, value: "not set up yet" },
    ]);
  });
});
