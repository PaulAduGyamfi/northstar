import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webConfig } from "../../src/config";
import { InterviewsBody, NO_INTERVIEWS, waitingFirst } from "../../src/interviews";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";
import { InterviewList } from "./interview-list";

// Asked for on every request: a new detection or decision shows at once, behind Paul's session.
export const dynamic = "force-dynamic";

// Interviews found on Paul's calendar (NS-240 slice 5, CAL-002). An invite isn't authenticated,
// so each one is "not verified" until he confirms or dismisses it, and neither choice moves an
// application's status. Signed out redirects to sign-in. No nav link: the nav's five tabs are
// fixed; Today links here.
export default async function InterviewsPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [interviews, health] = await Promise.all([
    readApi(deps, "/interviews", InterviewsBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (interviews.kind === "signed_out") redirect("/sign-in");
  const lists = interviews.kind === "ok" ? waitingFirst(interviews.body.items) : null;
  return (
    <>
      <PillNav current="/interviews" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Interviews</h1>
          <p className="muted">
            Found on your calendar. An invite can come from anyone, so each one waits for you to
            confirm it.
          </p>
          {interviews.kind !== "ok" ? (
            <p className="muted">
              {interviews.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "Interviews can't be read right now."}
            </p>
          ) : interviews.body.items.length === 0 ? (
            <p className="muted">{NO_INTERVIEWS}</p>
          ) : null}
        </div>
        {lists === null || lists.waiting.length === 0 ? null : (
          <section className="card" aria-labelledby="waiting">
            <h2 id="waiting">Waiting for you</h2>
            <InterviewList items={lists.waiting} />
          </section>
        )}
        {lists === null || lists.decided.length === 0 ? null : (
          <section className="card" aria-labelledby="decided">
            <h2 id="decided">Decided</h2>
            <InterviewList items={lists.decided} />
          </section>
        )}
      </main>
    </>
  );
}
