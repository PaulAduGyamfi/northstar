import {
  type CareerDnaSnapshot,
  COMPETENCIES,
  type Competency,
  type SaveCareerDnaError,
  type ScoringProfile,
  type StoredCareerDna,
  type StoryView,
  type ThesisProfile,
} from "@northstar/db";
import { careerDnaSnapshot, changeLines, diffCareerDna } from "./history.js";
import {
  buildCareerDna,
  type CareerDnaFailure,
  type CareerDnaReport,
  checkCareerDna,
} from "./report.js";

// Building the Career DNA report from Paul's stored profile and saving it (NS-130 slice 5,
// DNA-008). Plain code over ports, so it runs on fakes in tests and on @northstar/db in bin.ts.

export type CareerDnaStorePorts = {
  readScoringProfile: () => Promise<ScoringProfile | null>;
  readThesisProfile: () => Promise<ThesisProfile | null>;
  readStories: () => Promise<StoryView[]>;
  readCareerDnaHistory: () => Promise<StoredCareerDna[]>;
  saveCareerDnaReport: (
    snapshot: CareerDnaSnapshot,
  ) => Promise<
    | { ok: true; value: { stored: boolean; version: number; reportId: string } }
    | { ok: false; error: SaveCareerDnaError }
  >;
  // The DNA-001 citation check; tests may swap it to prove a failing report is never saved.
  checkReport?: typeof checkCareerDna;
};

export type RefreshedCareerDna = {
  report: CareerDnaReport;
  stored: boolean;
  version: number;
  // What changed since the previous stored version, in fixed sentences.
  changes: string[];
};

export type RefreshError =
  | { kind: "NoProfile" }
  | { kind: "CheckFailed"; failures: CareerDnaFailure[] }
  | SaveCareerDnaError;

const isCompetency = (c: string): c is Competency =>
  (COMPETENCIES as readonly string[]).includes(c);

export async function refreshCareerDna(
  ports: CareerDnaStorePorts,
): Promise<{ ok: true; value: RefreshedCareerDna } | { ok: false; error: RefreshError }> {
  // Two reads of the same current import; a reimport in between only leaves quotes unjoined (""),
  // which scores on what/how alone. Rare for a command Paul runs by hand.
  const profile = await ports.readScoringProfile();
  if (profile === null) return { ok: false, error: { kind: "NoProfile" } };
  // The imported quote, by atom id, so a term in the resume line counts as it does in scoring.
  const quotes = new Map(
    ((await ports.readThesisProfile())?.atoms ?? []).map((a) => [a.id, a.quote]),
  );
  const stories = (await ports.readStories()).map((s) => ({
    id: s.id,
    competencies: s.competencies.filter(isCompetency),
  }));
  const report = buildCareerDna({
    atoms: profile.atoms.map((a) => ({
      id: a.id,
      what: a.what,
      how: a.how,
      sourceQuote: quotes.get(a.id) ?? "",
    })),
    stories,
  });
  // DNA-001 / ADR-0004: every line must cite an atom or story of the current profile before the
  // report is shown or stored. A failure stores nothing.
  const failures = (ports.checkReport ?? checkCareerDna)(report, {
    atomIds: profile.atoms.map((a) => a.id),
    storyIds: stories.map((s) => s.id),
  });
  if (failures.length > 0) return { ok: false, error: { kind: "CheckFailed", failures } };
  const snapshot = careerDnaSnapshot(report);
  // The newest version before this save, so the diff compares against what Paul last saw. It is
  // read outside the save's lock: two racing runs could word the diff against an older version,
  // but storage stays correct.
  const [previous] = await ports.readCareerDnaHistory();
  const saved = await ports.saveCareerDnaReport(snapshot);
  if (!saved.ok) return saved;
  return {
    ok: true,
    value: {
      report,
      stored: saved.value.stored,
      version: saved.value.version,
      changes: changeLines(diffCareerDna(previous ?? null, snapshot)),
    },
  };
}
