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
import { buildCareerDna, type CareerDnaReport } from "./report.js";

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
};

export type RefreshedCareerDna = {
  report: CareerDnaReport;
  stored: boolean;
  version: number;
  // What changed since the previous stored version, in fixed sentences.
  changes: string[];
};

export type RefreshError = { kind: "NoProfile" } | SaveCareerDnaError;

const isCompetency = (c: string): c is Competency =>
  (COMPETENCIES as readonly string[]).includes(c);

export async function refreshCareerDna(
  ports: CareerDnaStorePorts,
): Promise<{ ok: true; value: RefreshedCareerDna } | { ok: false; error: RefreshError }> {
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
  const snapshot = careerDnaSnapshot(report);
  // The newest version before this save, so the diff compares against what Paul last saw.
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
