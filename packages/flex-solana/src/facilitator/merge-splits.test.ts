import { describe, test, expect } from "bun:test";
import { mergeSplits } from "./merge-splits";

describe("mergeSplits", () => {
  test("passes through distinct recipients unchanged", () => {
    const splits = [
      { recipient: "A", bps: 9700 },
      { recipient: "B", bps: 300 },
    ];
    expect(mergeSplits(splits)).toEqual(splits);
  });

  test("merges duplicate recipients by summing bps", () => {
    const result = mergeSplits([
      { recipient: "A", bps: 9700 },
      { recipient: "A", bps: 300 },
    ]);
    expect(result).toEqual([{ recipient: "A", bps: 10000 }]);
  });

  test("preserves insertion order of first occurrence", () => {
    const result = mergeSplits([
      { recipient: "A", bps: 5000 },
      { recipient: "B", bps: 3000 },
      { recipient: "A", bps: 2000 },
    ]);
    expect(result).toEqual([
      { recipient: "A", bps: 7000 },
      { recipient: "B", bps: 3000 },
    ]);
  });

  test("handles single entry", () => {
    expect(mergeSplits([{ recipient: "A", bps: 10000 }])).toEqual([
      { recipient: "A", bps: 10000 },
    ]);
  });

  test("handles empty array", () => {
    expect(mergeSplits([])).toEqual([]);
  });
});
