import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  CareerDnaBody,
  changeSummary,
  dimensionRow,
  NO_REPORT,
  versionLine,
} from "../../src/career-dna";
import { webConfig } from "../../src/config";
import { PillNav } from "../../src/pill-nav";
import { SESSION_COOKIE } from "../../src/session";
import { dotStatus, HealthBody, readApi } from "../../src/system";

// Asked for on every request: a rebuilt report shows at once, and it depends on Paul's session.
export const dynamic = "force-dynamic";

// The Career DNA page (NS-130 slice 8, DNA-001/008), read-only: the newest stored report in words
// (each dimension's band and how many items back it) and what changed since the last version.
// Signed out redirects to sign-in; nothing renders without his session. No chart yet (radar or
// bars is Paul's call), and no nav link: the nav's five tabs are fixed.
export default async function CareerDnaPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const deps = { apiOrigin: webConfig().apiOrigin, token, fetch };
  const [dna, health] = await Promise.all([
    readApi(deps, "/career-dna", CareerDnaBody),
    readApi(deps, "/system/health", HealthBody),
  ]);
  if (dna.kind === "signed_out") redirect("/sign-in");
  const report = dna.kind === "ok" ? dna.body.report : null;
  return (
    <>
      <PillNav current="/career-dna" health={dotStatus(health)} />
      <main className="page">
        <div className="card">
          <h1>Career DNA</h1>
          {dna.kind !== "ok" ? (
            <p className="muted">
              {dna.kind === "unreachable"
                ? "The Northstar API isn't answering. Start it with pnpm --filter @northstar/api start."
                : "Your Career DNA report can't be read right now."}
            </p>
          ) : report === null ? (
            <p className="muted">{NO_REPORT}</p>
          ) : (
            <>
              <p className="muted">{versionLine(report)}</p>
              {report.label === null ? null : <p>{report.label}</p>}
            </>
          )}
        </div>
        {report === null ? null : (
          <>
            <section className="card" aria-labelledby="dimensions">
              <h2 id="dimensions">Dimensions</h2>
              <ul>
                {report.dimensions.map(dimensionRow).map((d) => (
                  <li key={d.key}>
                    {d.name}: <span className="status-label">{d.band}</span> · {d.evidence}
                  </li>
                ))}
              </ul>
            </section>
            <section className="card" aria-labelledby="changes">
              <h2 id="changes">What changed</h2>
              <ul>
                {changeSummary(report).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </>
  );
}
