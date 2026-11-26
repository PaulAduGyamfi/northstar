import { describe, expect, it } from "vitest";
import { nameCandidates, nameParts } from "./names.js";

describe("nameParts", () => {
  it("takes a capitalised word as a name, as before", () => {
    expect(nameParts("Globex")).toEqual(["Globex"]);
  });

  it("takes a mixed-case word as a name", () => {
    expect([nameParts("iOS"), nameParts("eBay"), nameParts("iPhone")]).toEqual([
      ["iOS"],
      ["eBay"],
      ["iPhone"],
    ]);
  });

  it("checks each piece of a hyphen- or slash-joined word", () => {
    expect([
      nameParts("ex-Globex"),
      nameParts("planner/Globex"),
      nameParts("Example-Freight"),
    ]).toEqual([["Globex"], ["Globex"], ["Example", "Freight"]]);
  });

  it("takes a word that starts with a digit and holds a capital as a name", () => {
    expect([nameParts("3M"), nameParts("5G")]).toEqual([["3M"], ["5G"]]);
  });

  it("leaves numbers, units and ordinary lower-case words alone", () => {
    expect([
      nameParts("12%"),
      nameParts("10k"),
      nameParts("24h"),
      nameParts("planner"),
      nameParts("re-run"),
    ]).toEqual([[], [], [], [], []]);
  });

  it("never takes I or its contractions as a name", () => {
    expect([nameParts("I"), nameParts("I've"), nameParts("I’m")]).toEqual([[], [], []]);
  });

  it("cuts a word at any character that can't be part of a name", () => {
    expect([
      nameParts("l'Oréal"),
      nameParts("x.AI"),
      nameParts("ex_Globex"),
      nameParts("ex&Globex"),
      nameParts("ex(Globex)"),
    ]).toEqual([["Oréal"], ["AI"], ["Globex"], ["Globex"], ["Globex"]]);
  });

  it("cuts a word at an invisible joiner or a look-alike slash", () => {
    // A soft hyphen, a zero-width space and a fraction slash.
    expect([
      nameParts("ex\u00adGlobex"),
      nameParts("ex\u200bGlobex"),
      nameParts("ex\u2044Globex"),
    ]).toEqual([["Globex"], ["Globex"], ["Globex"]]);
  });

  it("keeps name characters such as + and # inside a piece", () => {
    expect([nameParts("C++"), nameParts("C#")]).toEqual([["C++"], ["C#"]]);
  });

  it("takes only the real contractions of I as Paul", () => {
    expect([nameParts("I'd"), nameParts("I'll"), nameParts("I'Globex")]).toEqual([
      [],
      [],
      ["Globex"],
    ]);
  });
});

describe("nameCandidates", () => {
  it("checks a capitalised word whole, then each of its pieces", () => {
    expect(nameCandidates("Globex-Initech")).toEqual([
      { name: "Globex-Initech", leading: true },
      { name: "Globex", leading: true },
      { name: "Initech", leading: false },
    ]);
  });

  it("checks a plain capitalised word once", () => {
    expect(nameCandidates("Globex")).toEqual([{ name: "Globex", leading: true }]);
  });

  it("checks only the pieces of a word that starts lower case", () => {
    expect([nameCandidates("iOS"), nameCandidates("ex-Globex")]).toEqual([
      [{ name: "iOS", leading: true }],
      [{ name: "Globex", leading: false }],
    ]);
  });
});
