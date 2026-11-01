import { describe, expect, it } from "vitest";
import { Assembler, split } from "../src/shared/net";

describe("zprávy po částech", () => {
  it("velká zpráva se rozdělí a složí i v přeházeném pořadí, malá ne", () => {
    expect(split("e", "x".repeat(100))).toBeNull();
    const json = JSON.stringify({ d: "k3." + "ž😀".repeat(30000) });
    const parts = split("kresby:platno", json)!;
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => JSON.stringify(p).length < 64000)).toBe(true);
    const a = new Assembler();
    let done: { event: string; json: string } | null = null;
    for (const p of [...parts].reverse()) done = a.add(JSON.stringify(p)) ?? done;
    expect(done).toEqual({ event: "kresby:platno", json });
  });
});
