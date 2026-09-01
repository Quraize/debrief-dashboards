import { describe, it, expect } from "vitest";
import {
  parseTwoLegAnswer, findTwoLegField, resultGroupName,
  TWO_LEG, ONE_LEG, OTHER,
} from "../src/jpResult.js";

describe("parseTwoLegAnswer — free-text normalization", () => {
  it("returns null for blank input, because an absent answer is not the same as an unclassifiable one", () => {
    expect(parseTwoLegAnswer("")).toBeNull();
    expect(parseTwoLegAnswer("   ")).toBeNull();
    expect(parseTwoLegAnswer(null)).toBeNull();
    expect(parseTwoLegAnswer(undefined)).toBeNull();
  });

  // Every string below was observed verbatim in the August 2026 result forms.
  const twoLegVariants = [
    "2legs",
    "2 legs",
    "2 legs. products showed",
    "2legs/1st: 20k, 2nd: 19k",
    "2legs/$22199",
    "2-legs",
    "Two legs",
    "two leg",
    "2 Leg",
  ];
  for (const raw of twoLegVariants) {
    it(`classifies ${JSON.stringify(raw)} as two-leg`, () => {
      expect(parseTwoLegAnswer(raw), `answer ${JSON.stringify(raw)}`).toBe(TWO_LEG);
    });
  }

  const oneLegVariants = ["1 leg", "1leg", "one leg", "1-leg", "1 leg, spouse at work"];
  for (const raw of oneLegVariants) {
    it(`classifies ${JSON.stringify(raw)} as one-leg`, () => {
      expect(parseTwoLegAnswer(raw), `answer ${JSON.stringify(raw)}`).toBe(ONE_LEG);
    });
  }

  it("classifies text with neither answer as other, so a rep's aside never inflates a rate", () => {
    expect(parseTwoLegAnswer("it's a commercial")).toBe(OTHER);
    expect(parseTwoLegAnswer("insurance job")).toBe(OTHER);
    expect(parseTwoLegAnswer("n/a")).toBe(OTHER);
  });

  it("classifies text naming both answers as other rather than guessing", () => {
    expect(parseTwoLegAnswer("1 leg at first, then 2 legs")).toBe(OTHER);
  });

  it("does not read digits inside larger numbers as a leg count", () => {
    expect(parseTwoLegAnswer("quoted 21 legs of trim")).toBe(OTHER);
    expect(parseTwoLegAnswer("$12 legs discount")).toBe(OTHER);
  });

  it("does not read ordinals like 1st as a one-leg answer", () => {
    expect(parseTwoLegAnswer("2legs/1st: 20k, 2nd: 19k")).toBe(TWO_LEG);
  });
});

describe("findTwoLegField — locating the question on a result form", () => {
  const form = [
    { name: "Was it 2-Legs? Was it Reset?", type: "text", value: "2legs" },
    { name: "Notes", type: "text", value: "long story" },
  ];

  it("finds the field whose name asks the 2-legs question and returns its value", () => {
    expect(findTwoLegField(form)).toBe("2legs");
  });

  it("matches loose spellings of the question name", () => {
    expect(findTwoLegField([{ name: "2 legs?", value: "1 leg" }])).toBe("1 leg");
    expect(findTwoLegField([{ name: "Was it two legs", value: "yes 2" }])).toBe("yes 2");
  });

  it("returns null when the form has no such question — 31 of 73 August forms did not", () => {
    expect(findTwoLegField([{ name: "Notes", value: "2legs" }])).toBeNull();
    expect(findTwoLegField([])).toBeNull();
    expect(findTwoLegField(null)).toBeNull();
  });

  it("ignores malformed entries rather than throwing", () => {
    expect(findTwoLegField([null, "string", { value: "x" }, { name: "2-legs", value: "2 legs" }])).toBe("2 legs");
  });
});

describe("resultGroupName — the Sale / No Sale / Follow-Up taxonomy", () => {
  it("reads the group name through the API's .data wrapper", () => {
    expect(resultGroupName({ group: { data: { id: 2, name: "Sale" } } })).toBe("Sale");
  });

  it("reads an unwrapped group too, because includes are not always wrapped", () => {
    expect(resultGroupName({ group: { id: 3, name: "No Sale" } })).toBe("No Sale");
  });

  it("returns null when there is no group", () => {
    expect(resultGroupName({})).toBeNull();
    expect(resultGroupName(null)).toBeNull();
    expect(resultGroupName({ group: {} })).toBeNull();
  });
});
