import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { JobsBody, jobRow, MORE_JOBS, NO_JOBS, NO_ROLE_JOBS, roleHeading } from "../../src/jobs";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";

// Asked for on every request: a new or re-scored job shows at once, behind Paul's session.
export const dynamic = "force-dynamic";

// The jobs page (NS-130 slice 10, SRC-013): ready jobs in the queue's order, freshest and
// best-fitting first, each with where it is, how fresh, how well it fits and a link to the posting.
// `?role=` narrows it to one role family; each direction on /career-dna links here. Read-only.
// Since slice 11 each job lists why it scored as it did (UX-014), under its score.
// Signed out redirects to sign-in. No nav link: the nav's five tabs are fixed.
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).role;
  const role = typeof raw === "string" && raw !== "" ? raw : null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const path = role === null ? "/jobs" : `/jobs?role=${encodeURIComponent(role)}`;
  const [jobs, health] = await Promise.all([
    readApi(deps, path, JobsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (jobs.kind === "signed_out") redirect("/sign-in");
  const list = jobs.kind === "ok" ? jobs.body.jobs : [];
  return (
    <>
      <PillNav current="/jobs" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>{role === null ? "Jobs" : roleHeading(role)}</h1>
          {role === null ? null : (
            <p>
              <a href="/jobs">All jobs</a>
            </p>
          )}
          {jobs.kind !== "ok" ? (
            <p className="muted">
              {jobs.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "Your jobs can't be read right now."}
            </p>
          ) : list.length === 0 ? (
            <p className="muted">{role === null ? NO_JOBS : NO_ROLE_JOBS}</p>
          ) : jobs.body.more ? (
            <p className="muted">{MORE_JOBS}</p>
          ) : null}
        </div>
        {list.length === 0 ? null : (
          <section className="card" aria-label="Jobs">
            <ul>
              {list.map(jobRow).map((j) => (
                <li key={j.key}>
                  {j.link === null ? (
                    <strong>{j.title}</strong>
                  ) : (
                    <a href={j.link} target="_blank" rel="noopener noreferrer">
                      <strong>{j.title}</strong>
                    </a>
                  )}
                  <br />
                  <span className="muted">
                    {j.where} · {j.posted}
                  </span>{" "}
                  · <span className="status-label">{j.fit}</span>
                  {j.why.length === 0 ? null : (
                    <ul className="muted" aria-label="Why this score">
                      {j.why.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
