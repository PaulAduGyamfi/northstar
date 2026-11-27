import { CAREER_DNA_RUBRIC, careerDnaChangeLines, diffCareerDna } from "@northstar/profile";
import type { CareerDnaPorts } from "./career-dna.js";

// The Career DNA page's wording (NS-130 slice 8): the report's own diff in its own fixed sentences
// and the rubric's dimension names, from packages/profile (never a copy here). Kept apart from
// bin.ts so a test runs it on real snapshots: a swapped previous and next would be caught.
export function careerDnaWording(): Pick<CareerDnaPorts, "describe" | "labelOf"> {
  return {
    describe: (previous, next) => {
      const diff = diffCareerDna(previous, next);
      return { first: diff.first, changes: careerDnaChangeLines(diff) };
    },
    labelOf: (key) => CAREER_DNA_RUBRIC.dimensions.find((d) => d.key === key)?.label ?? null,
  };
}
