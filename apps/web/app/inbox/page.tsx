import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import {
  applicationTitle,
  type GradeView,
  InboxBody,
  LinkTargetsBody,
  originBadge,
  queuedRows,
  statusWord,
  threadRows,
} from "../../src/inbox";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";
import { QueueActions } from "./queue-actions";
import { RegradeControl } from "./regrade-control";

// Asked for on every request: mail is linked as it arrives, and it depends on Paul's session.
export const dynamic = "force-dynamic";

// The unified job inbox (NS-165, INB-006): Paul's linked job-mail threads by application, and the
// threads waiting for him to link, each with Link and Dismiss (NS-262). Signed out redirects to
// sign-in; nothing renders without his session. Each thread opens in Gmail; its text never comes
// through Northstar.
export default async function InboxPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [inbox, health, targets] = await Promise.all([
    readApi(deps, "/inbox", InboxBody),
    readApi(deps, "/system/health", HealthBody),
    readApi(deps, "/inbox/link-targets", LinkTargetsBody),
  ]);
  // No targets read means no Link choice, never a guess: Dismiss still works.
  const linkTargets = targets.kind === "ok" ? targets.body.items : [];
  if (inbox.kind === "signed_out") redirect("/sign-in");
  const now = Date.now();
  return (
    <>
      <PillNav current="/inbox" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Inbox</h1>
          {inbox.kind !== "ok" ? (
            <p className="muted">
              {inbox.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "The inbox can't be read right now."}
            </p>
          ) : inbox.body.applications.length === 0 && inbox.body.queued.length === 0 ? (
            <p className="muted">No job mail linked yet.</p>
          ) : null}
        </div>
        {inbox.kind === "ok" && inbox.body.queued.length > 0 ? (
          <section className="card" aria-labelledby="needs-link">
            <h2 id="needs-link">Needs you to link it</h2>
            <p className="muted">
              Link each to the application it belongs to, or dismiss it. Linking never changes a
              status.
            </p>
            <ul>
              {queuedRows(inbox.body.queued, now).map((q, i) => (
                <li key={q.key}>
                  {q.why} · {q.messages}, {q.received}
                  {q.grade ? ` · ${q.grade}` : ""}
                  {q.paulGrade ? ` · ${q.paulGrade}` : ""}
                  {q.href ? (
                    <>
                      {" · "}
                      <a href={q.href} target="_blank" rel="noopener noreferrer">
                        Open in Gmail
                      </a>
                    </>
                  ) : null}{" "}
                  <QueueActions gmailThreadId={q.key} targets={linkTargets} label={q.why} />
                  <Regrade
                    gmailThreadId={q.key}
                    grade={inbox.body.queued[i]?.recruiterGrade}
                    label={q.why}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {inbox.kind === "ok"
          ? inbox.body.applications.map((a) => (
              <section key={a.applicationId} className="card">
                <h2>
                  <Link href={`/pipeline/${a.applicationId}`}>{applicationTitle(a)}</Link>
                </h2>
                <p>
                  <span className="status-label">{statusWord(a)}</span> · {originBadge(a)}
                </p>
                <ul>
                  {threadRows(a, now).map((t, i) => (
                    <li key={t.key}>
                      {t.kind} · {t.messages}, {t.received} · {t.linked}
                      {t.unverified ? ` · ${t.unverified}` : ""}
                      {t.grade ? ` · ${t.grade}` : ""}
                      {t.paulGrade ? ` · ${t.paulGrade}` : ""}
                      {t.href ? (
                        <>
                          {" · "}
                          <a href={t.href} target="_blank" rel="noopener noreferrer">
                            Open in Gmail
                          </a>
                        </>
                      ) : null}{" "}
                      <Regrade
                        gmailThreadId={t.key}
                        grade={a.threads[i]?.recruiterGrade}
                        label={t.kind}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          : null}
      </main>
    </>
  );
}

// The Regrade control, only on a graded thread (NS-238 item 3): it starts at Paul's own letter, else
// the system's.
function Regrade({
  gmailThreadId,
  grade,
  label,
}: {
  gmailThreadId: string;
  grade: GradeView | undefined;
  label: string;
}) {
  if (!grade) return null;
  return (
    <RegradeControl
      gmailThreadId={gmailThreadId}
      current={grade.paulGrade ?? grade.grade}
      label={label}
    />
  );
}
