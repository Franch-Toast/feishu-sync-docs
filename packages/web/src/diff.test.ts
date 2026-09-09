import { describe, expect, it } from "vitest";
import { applyHunks, clashingHunkIndices, computeHunks, hunksOverlap, lineDiff } from "./diff";

describe("lineDiff", () => {
  it("marks unchanged rows as same with aligned numbers", () => {
    const rows = lineDiff("a\nb\nc", "a\nb\nc");
    expect(rows.map((row) => row.kind)).toEqual(["same", "same", "same"]);
    expect(rows.map((row) => row.text)).toEqual(["a", "b", "c"]);
    expect(rows.map((row) => row.oldNumber)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.newNumber)).toEqual([1, 2, 3]);
  });

  it("pairs removed/added rows and emits word spans for modified lines", () => {
    const rows = lineDiff("hello moon", "hello brave world");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe("del");
    expect(rows[1]!.kind).toBe("add");
    expect(rows[0]!.words?.map((span) => `${span.kind}:${span.text}`)).toEqual([
      "same:hello ",
      "del:moon"
    ]);
    expect(rows[1]!.words?.map((span) => `${span.kind}:${span.text}`)).toEqual([
      "same:hello ",
      "add:brave world"
    ]);
  });

  it("keeps shared words as same spans when one side inserts", () => {
    const rows = lineDiff("hello world", "hello brave world");
    expect(rows[0]!.words?.map((span) => `${span.kind}:${span.text}`)).toEqual([
      "same:hello ",
      "same:world"
    ]);
    expect(rows[1]!.words?.map((span) => `${span.kind}:${span.text}`)).toEqual([
      "same:hello ",
      "add:brave ",
      "same:world"
    ]);
  });

  it("handles pure additions and deletions without word spans", () => {
    const added = lineDiff("a", "a\nb\nc");
    expect(added.slice(1).map((row) => row.kind)).toEqual(["add", "add"]);
    expect(added[1]!.words).toBeUndefined();

    const removed = lineDiff("a\nb\nc", "a");
    expect(removed.slice(1).map((row) => row.kind)).toEqual(["del", "del"]);
  });

  it("treats empty inputs as no rows and ignores trailing-newline drift", () => {
    expect(lineDiff("", "")).toEqual([]);
    expect(lineDiff("x\n", "x").map((row) => row.kind)).toEqual(["same"]);
  });
});

describe("computeHunks", () => {
  it("produces insertion hunks with baseCount 0", () => {
    const hunks = computeHunks("a\nc", "a\nb\nc", "local");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ baseStart: 1, baseCount: 0, lines: ["b"], side: "local" });
  });

  it("produces replacement hunks against base coordinates", () => {
    const hunks = computeHunks("a\nold1\nold2\nd", "a\nnew\nd", "remote");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ baseStart: 1, baseCount: 2, lines: ["new"], side: "remote" });
  });

  it("produces deletion hunks with empty lines", () => {
    const hunks = computeHunks("a\nb\nc", "a\nc", "local");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ baseStart: 1, baseCount: 1, lines: [] });
  });

  it("returns no hunks for identical text", () => {
    expect(computeHunks("same\ntext", "same\ntext", "local")).toEqual([]);
  });
});

describe("applyHunks", () => {
  it("applies a single hunk", () => {
    const base = "a\nb\nc";
    expect(applyHunks(base, [{ baseStart: 1, baseCount: 1, lines: ["B"], side: "local" }])).toBe("a\nB\nc");
  });

  it("applies multiple hunks bottom-up so coordinates stay stable", () => {
    const base = "1\n2\n3\n4\n5";
    const hunks = [
      { baseStart: 0, baseCount: 1, lines: ["one"], side: "local" as const },
      { baseStart: 5, baseCount: 0, lines: ["six"], side: "remote" as const }
    ];
    expect(applyHunks(base, hunks)).toBe("one\n2\n3\n4\n5\nsix");
  });

  it("merges local and remote hunks that share the base coordinate system", () => {
    const base = "a\nb\nc";
    const localHunks = computeHunks(base, "a\nB\nc", "local");
    const remoteHunks = computeHunks(base, "a\nb\nC", "remote");
    expect(applyHunks(base, [...localHunks, ...remoteHunks])).toBe("a\nB\nC");
  });
});

describe("overlap detection", () => {
  it("detects overlapping and disjoint hunks", () => {
    const left = { baseStart: 1, baseCount: 2, lines: ["x"], side: "local" as const };
    const right = { baseStart: 2, baseCount: 1, lines: ["y"], side: "remote" as const };
    const apart = { baseStart: 5, baseCount: 1, lines: ["z"], side: "remote" as const };
    expect(hunksOverlap(left, right)).toBe(true);
    expect(hunksOverlap(left, apart)).toBe(false);
  });

  it("treats pure insertions as touching their insertion point", () => {
    const insert = { baseStart: 3, baseCount: 0, lines: ["new"], side: "local" as const };
    const replace = { baseStart: 3, baseCount: 1, lines: ["other"], side: "remote" as const };
    expect(hunksOverlap(insert, replace)).toBe(true);
  });

  it("flags clashing cross-side hunk indices only", () => {
    const hunks = [
      { baseStart: 0, baseCount: 1, lines: ["a1"], side: "local" as const },
      { baseStart: 0, baseCount: 1, lines: ["a2"], side: "remote" as const },
      { baseStart: 4, baseCount: 0, lines: ["b1"], side: "local" as const }
    ];
    expect(clashingHunkIndices(hunks)).toEqual(new Set([0, 1]));
  });
});
