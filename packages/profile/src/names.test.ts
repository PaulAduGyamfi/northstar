import { describe, expect, it } from "vitest";
import { nameParts } from "./names.js";

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
});
