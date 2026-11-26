import { describe, expect, it } from "vitest";
import { nameCandidates, nameParts, unbackedUnits, unitBacked } from "./names.js";

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
    expect([nameParts("2FA"), nameParts("5G")]).toEqual([["2FA"], ["5G"]]);
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
      [{ name: "iOS", leading: false }],
      [{ name: "Globex", leading: false }],
    ]);
  });
});

describe("number-plus-unit tokens (NS-216)", () => {
  it("never takes a number with a listed unit as a name", () => {
    const units = ["K", "M", "B", "KB", "MB", "GB", "TB", "PB", "kW", "MW", "GW", "dB", "Hz"];
    const more = ["kHz", "MHz", "GHz"];
    expect([...units, ...more].map((u) => nameParts(`12${u}`))).toEqual(
      [...units, ...more].map(() => []),
    );
  });

  it("cuts a decimal at its dot and still exempts the unit", () => {
    expect([nameParts("1.5M"), nameParts("$2M")]).toEqual([[], []]);
  });

  it("keeps product names, acronyms and units not on the list as names", () => {
    expect([nameParts("2FA"), nameParts("macOS"), nameParts("S3"), nameParts("5G")]).toEqual([
      ["2FA"],
      ["macOS"],
      ["S3"],
      ["5G"],
    ]);
  });
});

describe("a unit's scale (NS-216)", () => {
  it("is backed by the same unit after a number, in any case and spacing", () => {
    expect([
      unitBacked("M", "we served 1m users"),
      unitBacked("GB", "a 5 gb cache"),
      unitBacked("M", "we served 1M users"),
    ]).toEqual([true, true, true]);
  });

  it("is backed by its word for K, M and B", () => {
    expect([
      unitBacked("K", "ten thousand users"),
      unitBacked("M", "1 million users"),
      unitBacked("B", "5 billion events"),
    ]).toEqual([true, true, true]);
  });

  it("is not backed by a different scale, or by an m that ends I'm", () => {
    expect([
      unitBacked("B", "grew to 5 thousand users"),
      unitBacked("M", "I'm proud of the 7 engineers"),
      unitBacked("GB", "a 5 mb cache"),
    ]).toEqual([false, false, false]);
  });

  it("finds the words whose unit the sources don't state", () => {
    expect(unbackedUnits("We grew to 5B users and 2GB of logs.", "5 thousand users, 2 gb")).toEqual(
      [3],
    );
  });

  it("leaves a number with digits from another script a name", () => {
    expect(nameParts("\u0667M")).toEqual(["\u0667M"]);
  });
});
