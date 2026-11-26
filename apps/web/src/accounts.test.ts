import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_WORDS,
  AccountsBody,
  accountRows,
  ConsentsBody,
  noticeRows,
} from "./accounts";

// Settings → Accounts (NS-198): the plain logic behind the page. Synthetic tenants only.

describe("accountRows", () => {
  it("shows each tenant's key, ATS, status in words and days, never an email or password", () => {
    const parsed = AccountsBody.parse({
      items: [
        {
          tenantKey: "workday:globex",
          ats: "workday",
          status: "needs_human",
          createdAt: "2026-11-25T12:00:00.000Z",
          changedAt: null,
          // A read that carried more must not put it on the page.
          accountEmail: "applicant@example.com",
          password: "not-a-real-password",
        },
      ],
    });
    const rows = accountRows(parsed.items);
    expect(rows).toEqual([
      {
        key: "workday:globex",
        ats: "workday",
        status: "needs your hands",
        created: "2026-11-25",
        changed: "never",
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/applicant@|not-a-real-password/);
  });

  it("has words for every account status", () => {
    expect(ACCOUNT_STATUSES.every((s) => ACCOUNT_WORDS[s].length > 0)).toBe(true);
  });

  it("refuses a status it has no words for", () => {
    const r = AccountsBody.safeParse({
      items: [
        {
          tenantKey: "workday:globex",
          ats: "workday",
          status: "suspended",
          createdAt: "2026-11-25T12:00:00.000Z",
          changedAt: null,
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe("noticeRows", () => {
  const notice = {
    recordId: "0b6f3f8e-6a55-4c7e-9a52-5d6b2f8a1c01",
    tenantKey: "workday:globex",
    kind: "privacy",
    noticeUrl: "https://globex.example.com/privacy",
    acceptedAt: "2026-11-25T12:00:00.000Z",
  };

  it("shows the tenant, the kind in words, the https link and the day", () => {
    expect(noticeRows(ConsentsBody.parse({ items: [notice] }).items)).toEqual([
      {
        recordId: notice.recordId,
        tenant: "workday:globex",
        kind: "Privacy notice",
        link: "https://globex.example.com/privacy",
        accepted: "2026-11-25",
      },
    ]);
  });

  it("drops a link that isn't https rather than linking it", () => {
    const rows = noticeRows([{ ...notice, noticeUrl: "javascript:alert(1)" }]);
    expect(rows[0]?.link).toBeNull();
  });
});
