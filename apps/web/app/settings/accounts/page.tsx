import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AccountsBody,
  accountRows,
  ConsentsBody,
  MARKETING_NOTE,
  noticeRows,
  PolicyBody,
} from "../../../src/accounts";
import { webConfig } from "../../../src/config";
import { PillNav } from "../../../src/pill-nav";
import { SESSION_COOKIE } from "../../../src/session";
import { dotStatus, HealthBody, readApi } from "../../../src/system";
import { ConsentPolicyForm } from "./consent-policy-form";
import { NoticeText } from "./notice-text";
import { RevealButton } from "./reveal-button";

// Asked for on every request: account statuses change as the gateway works, and it needs Paul's session.
export const dynamic = "force-dynamic";

// Settings → Accounts (NS-198, ACC-001, ACC-008): each employer account and its status in words,
// the consent policy, and the notices accepted for Paul. Never an account email; a password only
// when Paul reveals it with a fresh passkey check (NS-246), and a notice's text only on request.
// Signed out redirects to sign-in.
export default async function AccountsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [accounts, policy, consents, health] = await Promise.all([
    readApi(deps, "/accounts", AccountsBody),
    readApi(deps, "/settings/consent-policy", PolicyBody),
    readApi(deps, "/accounts/consents", ConsentsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (accounts.kind === "signed_out") redirect("/sign-in");
  // The API is down: say so and show nothing else (web.md), as the pipeline page does.
  if (accounts.kind === "unreachable") {
    return (
      <>
        <PillNav current="/settings/accounts" health={dotStatus(health)} />
        <main className="page">
          <div className="card">
            <h1>Accounts</h1>
            <p className="muted">
              The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start.
            </p>
          </div>
        </main>
      </>
    );
  }
  const rows = accounts.kind === "ok" ? accountRows(accounts.body.items) : [];
  const notices = consents.kind === "ok" ? noticeRows(consents.body.items) : [];
  return (
    <>
      <PillNav current="/settings/accounts" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Accounts</h1>
          {accounts.kind !== "ok" ? (
            <p className="muted">Your employer accounts can't be read right now.</p>
          ) : rows.length === 0 ? (
            <p className="muted">
              No employer accounts yet. One appears when an application needs a sign-up.
            </p>
          ) : (
            <ul className="switch-list">
              {rows.map((r) => (
                <li key={r.key}>
                  <span>
                    {r.key} <span className="muted">({r.ats})</span>
                  </span>
                  <span className="status-label">{r.status}</span>
                  <span className="muted">
                    added {r.created}, last changed {r.changed}
                  </span>
                  <RevealButton tenantKey={r.key} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Candidate terms and privacy notices</h2>
          {policy.kind === "ok" ? (
            <ConsentPolicyForm current={policy.body.policy} />
          ) : (
            <p className="muted">Your choice can't be read right now.</p>
          )}
          <p className="muted">{MARKETING_NOTE}</p>
        </div>
        <div className="card">
          <h2>Accepted notices</h2>
          {consents.kind !== "ok" ? (
            <p className="muted">The accepted notices can't be read right now.</p>
          ) : notices.length === 0 ? (
            <p className="muted">Nothing accepted yet.</p>
          ) : (
            <ul className="switch-list">
              {notices.map((n) => (
                <li key={n.recordId}>
                  <span>
                    {n.kind} on {n.tenant}
                  </span>
                  <span className="muted">accepted {n.accepted}</span>
                  {n.link ? (
                    <a href={n.link} target="_blank" rel="noopener noreferrer">
                      Open the notice
                    </a>
                  ) : null}
                  <NoticeText recordId={n.recordId} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
