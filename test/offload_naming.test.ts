import { test } from "node:test";
import assert = require("node:assert/strict");
import { dedup, offloadNames, tabNames, toSafeName } from "../src/offload_naming";
import type { NodeWithOffload, SafeName, SafeNames } from "../src/offload_naming";

// Results use null-prototype objects, which deepStrictEqual distinguishes from plain objects
const plain = <T extends object>(o: T) => ({ ...o });
const nodes = (...n: object[]) => n as unknown as NodeWithOffload[];
const names = (o: { [id: string]: string }) => o as SafeNames;

test("toSafeName replaces reserved characters", () => {
  assert.equal(toSafeName('a<b>c:d"e/f\\g|h?i*j~k', "t"), "a_b_c_d_e_f_g_h_i_j_k");
  assert.equal(toSafeName("\x01x", "t"), "_x");
});

test("toSafeName collapses repeated dots and trims dots and spaces", () => {
  assert.equal(toSafeName("a..b", "t"), "a.b");
  assert.equal(toSafeName("a...b", "t"), "a.b");
  assert.equal(toSafeName("  .name. ", "t"), "name");
});

test("toSafeName suffixes Windows device names", () => {
  assert.equal(toSafeName("con", "t"), "con_");
  assert.equal(toSafeName("CON.txt", "t"), "CON_.txt");
  assert.equal(toSafeName("com1", "t"), "com1_");
  assert.equal(toSafeName("lpt9.x", "t"), "lpt9_.x");
  assert.equal(toSafeName("console", "t"), "console");
});

test("toSafeName truncates to 80 characters", () => {
  assert.equal(toSafeName("a".repeat(100), "t"), "a".repeat(80));
});

test("toSafeName falls back to the type", () => {
  assert.equal(toSafeName(undefined, "function"), "function");
  assert.equal(toSafeName("", "function"), "function");
  assert.equal(toSafeName(" ", "function"), "function");
  assert.equal(toSafeName("...", "function"), "function");
});

test("dedup leaves distinct names untouched", () => {
  assert.deepEqual(plain(dedup(names({ a: "X", b: "Y" }))), { a: "X", b: "Y" });
});

test("dedup suffixes every member of a case-insensitive collision, including the first", () => {
  assert.deepEqual(plain(dedup(names({ a: "X", b: "x", c: "Y" }))), { a: "X-a", b: "x-b", c: "Y" });
  assert.deepEqual(plain(dedup(names({ a: "X", b: "x", c: "X" }))), { a: "X-a", b: "x-b", c: "X-c" });
});

test("tabNames prefers label over name, and covers tabs and subflows only", () => {
  const out = tabNames(nodes(
    { id: "t1", type: "tab", label: "L", name: "N" },
    { id: "t2", type: "tab", name: "N2" },
    { id: "t3", type: "tab" },
    { id: "s1", type: "subflow", name: "Sub" },
    { id: "f1", type: "function", name: "Not a tab" },
  ));
  assert.deepEqual(plain(out), { t1: "L", t2: "N2", t3: "tab", s1: "Sub" });
});

test("tabNames deduplicates case-insensitively", () => {
  const out = tabNames(nodes({ id: "t1", type: "tab", label: "A" }, { id: "t2", type: "tab", label: "a" }));
  assert.deepEqual(plain(out), { t1: "A-t1", t2: "a-t2" });
});

test("offloadNames names rule nodes as <tab>/<node>, with ./ for nodes without a tab", () => {
  const out = offloadNames(nodes(
    { id: "t1", type: "tab", label: "Main" },
    { id: "f1", type: "function", name: "Calc", z: "t1" },
    { id: "f2", type: "function", name: "Calc", z: "t2" },
    { id: "f3", type: "function", z: "t1" },
    { id: "u1", type: "ui_template", name: "Page", z: "t1" },
    { id: "g1", type: "function", name: "Global" },
    { id: "i1", type: "inject", name: "Not offloadable", z: "t1" },
    { id: "t2", type: "tab", label: "Other" }, // A tab may appear after the nodes that reference it
  ));
  assert.deepEqual(plain(out), {
    f1: "Main/Calc", f2: "Other/Calc", f3: "Main/function", u1: "Main/Page", g1: "./Global",
  });
});

test("offloadNames suffixes ids for names that collide within a tab", () => {
  const out = offloadNames(nodes(
    { id: "t1", type: "tab", label: "Main" },
    { id: "f1", type: "function", name: "Calc", z: "t1" },
    { id: "f2", type: "function", name: "calc", z: "t1" },
  ));
  assert.deepEqual(plain(out), { f1: "Main/Calc-f1", f2: "Main/calc-f2" });
});

test("offloadNames keeps nodes in same-named tabs apart through the tab suffix", () => {
  const out = offloadNames(nodes(
    { id: "t1", type: "tab", label: "Same" },
    { id: "t2", type: "tab", label: "same" },
    { id: "f1", type: "function", name: "N", z: "t1" },
    { id: "f2", type: "function", name: "N", z: "t2" },
  ));
  assert.deepEqual(plain(out), { f1: "Same-t1/N", f2: "same-t2/N" });
});

test("offloadNames uses the subflow name for nodes inside a subflow, and ./ for an unknown z", () => {
  const out = offloadNames(nodes(
    { id: "s1", type: "subflow", name: "My Sub" },
    { id: "t1", type: "tab", name: "ByName" },
    { id: "f1", type: "function", name: "In", z: "s1" },
    { id: "f2", type: "function", name: "Named", z: "t1" },
    { id: "f3", type: "function", name: "Orphan", z: "missing" },
  ));
  assert.deepEqual(plain(out), { f1: "My Sub/In", f2: "ByName/Named", f3: "./Orphan" });
});
