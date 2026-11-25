import type { FitCliDeps } from "../cli.js";

// A fit dependency that has nothing to score (no resume imported), for CLI tests that don't
// exercise scoring. Tests that do override the parts they need.
export const noFit = (): FitCliDeps => ({
  preferences: async () => null,
  savePreferences: async () => ({ status: "unchanged", current: null }),
  score: async () => ({ status: "no_profile" }),
  recordRescore: async () => {},
  why: async () => null,
  atomTexts: async () => new Map(),
});
