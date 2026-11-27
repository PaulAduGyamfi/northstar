import { describe, expect, it } from "vitest";
import {
  archetypeOf,
  buildCareerDna,
  CAREER_DNA_RUBRIC,
  type CareerDnaEvidence,
  type CareerDnaReport,
  checkCareerDna,
  type DimensionScore,
  scoreDimensions,
} from "./index.js";

// Synthetic atoms and stories (invented work, public repo).
function atom(id: string, line: string) {
  return { id, what: line, how: [], sourceQuote: line };
}

const fourEngineering = [
  atom("a1", "Built a payments ledger in Java."),
  atom("a2", "Implemented retry queues for card captures."),
  atom("a3", "Shipped a claims triage service."),
  atom("a4", "Developed the partner onboarding client."),
];

function score(evidence: CareerDnaEvidence, key: string): DimensionScore {
  const found = scoreDimensions(evidence).find((d) => d.key === key);
  if (!found) throw new Error(`no dimension ${key}`);
  return found;
}

describe("scoreDimensions", () => {
  it("scores the six rubric dimensions in rubric order", () => {
    expect(scoreDimensions({ atoms: [], stories: [] }).map((d) => d.key)).toEqual([
      "engineering",
      "architecture",
      "infrastructure",
      "leadership",
      "communication",
      "problem_solving",
    ]);
  });

  it("reads a dimension with fewer than three cited items as not enough evidence, with no score", () => {
    const d = score({ atoms: fourEngineering.slice(0, 2), stories: [] }, "engineering");
    expect(d).toEqual({
      key: "engineering",
      label: "Engineering",
      band: "not_enough",
      points: null,
      evidenceCount: 2,
      cites: [
        { kind: "atom", id: "a1" },
        { kind: "atom", id: "a2" },
      ],
    });
  });

  it("gives one point per matching atom and a low band from three items", () => {
    const d = score({ atoms: fourEngineering.slice(0, 3), stories: [] }, "engineering");
    expect(d.band).toBe("low");
    expect(d.points).toBe(3);
  });

  it("lowers a dimension's points by exactly one when one cited atom is removed", () => {
    const before = score({ atoms: fourEngineering, stories: [] }, "engineering");
    const after = score({ atoms: fourEngineering.slice(1), stories: [] }, "engineering");
    expect(before.points).toBe(4);
    expect(after.points).toBe(3);
  });

  it("drops the score to none, not to two points, when removing an atom leaves two items", () => {
    const d = score({ atoms: fourEngineering.slice(1, 3), stories: [] }, "engineering");
    expect(d.band).toBe("not_enough");
    expect(d.points).toBeNull();
  });

  it("counts an atom id given twice as one item", () => {
    const evidence: CareerDnaEvidence = {
      atoms: [...fourEngineering.slice(0, 2), fourEngineering[0] ?? atom("x", "x")],
      stories: [],
    };
    expect(score(evidence, "engineering").evidenceCount).toBe(2);
  });

  it("gives an approved story two points toward each dimension its competencies map to, once", () => {
    const evidence: CareerDnaEvidence = {
      atoms: fourEngineering.slice(0, 2),
      stories: [{ id: "s1", competencies: ["technical-depth"] }],
    };
    const d = score(evidence, "engineering");
    expect(d.points).toBe(4);
    expect(d.evidenceCount).toBe(3);
    expect(d.cites).toContainEqual({ kind: "story", id: "s1" });
  });

  it("counts a story tagged with two competencies of the same dimension only once", () => {
    const evidence: CareerDnaEvidence = {
      atoms: [],
      stories: [{ id: "s1", competencies: ["leadership", "ownership"] }],
    };
    expect(score(evidence, "leadership").evidenceCount).toBe(1);
    expect(score(evidence, "leadership").cites).toEqual([{ kind: "story", id: "s1" }]);
  });

  it("counts an atom that names a dimension's terms twice only once", () => {
    const evidence: CareerDnaEvidence = {
      atoms: [atom("a1", "Built and shipped a ledger, then implemented its tests.")],
      stories: [],
    };
    expect(score(evidence, "engineering").evidenceCount).toBe(1);
  });

  it("matches terms as whole words only, so led is not found in filed", () => {
    const evidence: CareerDnaEvidence = {
      atoms: [atom("a1", "Filed weekly reports."), atom("a2", "Led a team of four.")],
      stories: [],
    };
    expect(score(evidence, "leadership").cites).toEqual([{ kind: "atom", id: "a2" }]);
  });

  it("matches terms regardless of case and in the atom's how list", () => {
    const evidence: CareerDnaEvidence = {
      atoms: [{ id: "a1", what: "Card capture service", how: ["Kubernetes"], sourceQuote: "x" }],
      stories: [],
    };
    expect(score(evidence, "infrastructure").cites).toEqual([{ kind: "atom", id: "a1" }]);
  });

  it("bands six to nine items as medium and ten or more as high", () => {
    const atoms = Array.from({ length: 10 }, (_, i) => atom(`a${i}`, "Built a service."));
    expect(score({ atoms: atoms.slice(0, 6), stories: [] }, "engineering").band).toBe("medium");
    expect(score({ atoms: atoms.slice(0, 9), stories: [] }, "engineering").band).toBe("medium");
    expect(score({ atoms, stories: [] }, "engineering").band).toBe("high");
  });

  it("uses rubric version one for software engineering", () => {
    expect(CAREER_DNA_RUBRIC.version).toBe(1);
    expect(CAREER_DNA_RUBRIC.family).toBe("software_engineering");
  });
});

// A dimension score with the given points, for the archetype's table.
function dim(key: string, points: number | null): DimensionScore {
  return {
    key,
    label: key,
    band: points === null ? "not_enough" : "low",
    points,
    evidenceCount: points ?? 0,
    cites: [{ kind: "atom", id: `${key}-atom` }],
  };
}

describe("archetypeOf", () => {
  it("is null when no dimension has enough evidence", () => {
    expect(archetypeOf([dim("engineering", null), dim("architecture", null)])).toBeNull();
  });

  it("maps the top two qualifying dimensions through the fixed table, with both dimensions' evidence", () => {
    const a = archetypeOf([
      dim("engineering", 5),
      dim("architecture", 4),
      dim("leadership", 3),
      dim("communication", null),
    ]);
    expect(a).toEqual({
      label: "The Systems Builder",
      dimensions: ["engineering", "architecture"],
      cites: [
        { kind: "atom", id: "engineering-atom" },
        { kind: "atom", id: "architecture-atom" },
      ],
    });
  });

  it("gives the same label whichever of the pair has more points", () => {
    const a = archetypeOf([dim("engineering", 3), dim("architecture", 8)]);
    expect(a?.label).toBe("The Systems Builder");
    expect(a?.dimensions).toEqual(["architecture", "engineering"]);
  });

  it("breaks a tie in points by rubric order", () => {
    const a = archetypeOf([dim("engineering", 4), dim("leadership", 4), dim("architecture", 4)]);
    expect(a?.dimensions).toEqual(["engineering", "architecture"]);
  });

  it("gives a single qualifying dimension its own label", () => {
    const a = archetypeOf([dim("leadership", 3), dim("engineering", null)]);
    expect(a).toEqual({
      label: "The Team Organizer",
      dimensions: ["leadership"],
      cites: [{ kind: "atom", id: "leadership-atom" }],
    });
  });

  it("never uses a job title as a label", () => {
    const keys = CAREER_DNA_RUBRIC.dimensions.map((d) => d.key);
    const labels = keys.flatMap((a) => [
      archetypeOf([dim(a, 3)])?.label,
      ...keys.filter((b) => b !== a).map((b) => archetypeOf([dim(a, 3), dim(b, 3)])?.label),
    ]);
    for (const label of labels) {
      expect(label).not.toMatch(/\b(Lead|Manager|Engineer|Architect|Director)\b/);
    }
  });

  it("has a label for every pair of rubric dimensions and every single one", () => {
    const keys = CAREER_DNA_RUBRIC.dimensions.map((d) => d.key);
    for (const a of keys) {
      expect(archetypeOf([dim(a, 3)])?.label).toMatch(/^The /);
      for (const b of keys) {
        if (a === b) continue;
        expect(archetypeOf([dim(a, 3), dim(b, 3)])?.label).toMatch(/^The /);
      }
    }
  });
});

describe("buildCareerDna", () => {
  const evidence: CareerDnaEvidence = {
    atoms: [
      ...fourEngineering,
      atom("a5", "Designed the ledger schema."),
      atom("a6", "Architected an event-driven pipeline."),
    ],
    stories: [{ id: "s1", competencies: ["scale"] }],
  };

  it("writes a strength line per scored dimension, a gap line per thin one, and the label line", () => {
    const report = buildCareerDna(evidence);
    expect(report.rubricVersion).toBe(1);
    expect(report.archetype?.label).toBe("The Systems Builder");
    expect(report.lines[0]).toEqual({
      kind: "label",
      text: "The Systems Builder: from Engineering and Architecture.",
      cites: report.archetype?.cites,
    });
    expect(report.lines).toContainEqual({
      kind: "strength",
      text: "Engineering: low confidence, 4 pieces of evidence.",
      points: 4,
      cites: [
        { kind: "atom", id: "a1" },
        { kind: "atom", id: "a2" },
        { kind: "atom", id: "a3" },
        { kind: "atom", id: "a4" },
      ],
    });
    expect(report.lines).toContainEqual({
      kind: "gap",
      text: "Leadership: not enough evidence yet.",
      points: null,
      cites: [],
    });
  });

  it("gives an empty profile six gap lines and no archetype", () => {
    const report = buildCareerDna({ atoms: [], stories: [] });
    expect(report.archetype).toBeNull();
    expect(report.lines.map((l) => l.kind)).toEqual(Array(6).fill("gap"));
  });

  it("passes its own citation check", () => {
    const report = buildCareerDna(evidence);
    expect(
      checkCareerDna(report, { atomIds: ["a1", "a2", "a3", "a4", "a5", "a6"], storyIds: ["s1"] }),
    ).toEqual([]);
  });
});

describe("checkCareerDna", () => {
  const known = { atomIds: ["a1"], storyIds: ["s1"] };
  const base: CareerDnaReport = {
    rubricVersion: 1,
    family: "software_engineering",
    dimensions: [],
    archetype: null,
    lines: [],
  };

  it("refuses a strength line with no citation", () => {
    const report: CareerDnaReport = {
      ...base,
      lines: [{ kind: "strength", text: "Engineering: low confidence.", points: 3, cites: [] }],
    };
    expect(checkCareerDna(report, known)).toEqual([{ kind: "uncited", line: 0 }]);
  });

  it("refuses a label line with no citation", () => {
    const report: CareerDnaReport = {
      ...base,
      lines: [{ kind: "label", text: "The Systems Builder.", cites: [] }],
    };
    expect(checkCareerDna(report, known)).toEqual([{ kind: "uncited", line: 0 }]);
  });

  it("refuses a citation to an atom or story it doesn't know", () => {
    const report: CareerDnaReport = {
      ...base,
      lines: [
        {
          kind: "strength",
          text: "Engineering.",
          points: 3,
          cites: [
            { kind: "atom", id: "a1" },
            { kind: "atom", id: "a9" },
            { kind: "story", id: "a1" },
          ],
        },
      ],
    };
    expect(checkCareerDna(report, known)).toEqual([
      { kind: "unknown_citation", line: 0, cite: { kind: "atom", id: "a9" } },
      { kind: "unknown_citation", line: 0, cite: { kind: "story", id: "a1" } },
    ]);
  });

  it("refuses a gap line that carries a score", () => {
    const report: CareerDnaReport = {
      ...base,
      lines: [{ kind: "gap", text: "Leadership: not enough evidence yet.", points: 1, cites: [] }],
    };
    expect(checkCareerDna(report, known)).toEqual([{ kind: "scored_gap", line: 0 }]);
  });
});
