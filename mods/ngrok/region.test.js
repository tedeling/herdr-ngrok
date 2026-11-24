// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGION_NONE, REGION_SECRET, editOnHub, editRegion } from "./region.js";

const OLD = 'version: "2"\nauthtoken: SECRET123\ntunnels:\n    api:\n        addr: 8020\n    web:\n        addr: 3000\n';
const S = ["SECRET123"];
test("editRegion: one changed line", () =>
  assert.deepEqual(editRegion(OLD, OLD.replace("8020", "8021"), S), { old: "        addr: 8020\n", new: "        addr: 8021\n" }));
test("editRegion: a repeated line widens until it is unique", () => {
  const two = OLD.replace("8020", "3000");
  assert.deepEqual(editRegion(two, two.replace("    web:\n        addr: 3000", "    web:\n        addr: 3001"), S),
    { old: "    web:\n        addr: 3000\n", new: "    web:\n        addr: 3001\n" });
});
test("editRegion: an add at the end", () =>
  assert.deepEqual(editRegion(OLD, OLD + "    new:\n        addr: 9000\n", S),
    { old: "        addr: 3000\n", new: "        addr: 3000\n    new:\n        addr: 9000\n" }));
test("editRegion: never a secret line", () =>
  assert.throws(() => editRegion("authtoken: SECRET123\n", "authtoken: SECRET123\ntunnels:\n    a:\n        addr: 1\n", S), /line with a secret/));
test("editRegion: CRLF stays", () => {
  const crlf = OLD.replaceAll("\n", "\r\n");
  assert.deepEqual(editRegion(crlf, crlf.replace("8020", "8021"), S), { old: "        addr: 8020\r\n", new: "        addr: 8021\r\n" });
});
test("editRegion: no unique place in an empty file", () => assert.throws(() => editRegion("", "tunnels:\n", S), { message: REGION_NONE }));
test("copy strings", () => {
  assert.equal(REGION_SECRET, "The change touches a line with a secret. Edit ngrok.yml on the hub by hand.");
  assert.equal(REGION_NONE, "The panel cannot find a unique place for this change.");
});

const TARGET = { mode: "remote", machine: "desk", hub: "hub.example" };
const PATH = "/home/u/.config/ngrok/ngrok.yml";

/** A fake hc that records each argument list and gives one answer. */
function fakeHc(answer) {
  const calls = [];
  const hc = async (args) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { hc, calls };
}
const json = (o) => JSON.stringify(o);

test("editOnHub: sends the region with hc file edit", async () => {
  const { hc, calls } = fakeHc({ code: 0, stdout: json({ ok: true }), stderr: "" });
  await editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD);
  assert.deepEqual(calls, [["file", "edit", "--json", "--on", "desk", PATH, "--old", "        addr: 8020\n", "--new", "        addr: 8021\n"]]);
});

test("editOnHub: edit_failed is stale", async () => {
  const { hc } = fakeHc({ code: 1, stdout: json({ error: { kind: "edit_failed", message: "the old text is not in the file" } }), stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD), (e) => e instanceof Error && !e.hub);
});

test("editOnHub: another failure is a hub error", async () => {
  const { hc } = fakeHc({ code: 1, stdout: json({ error: { kind: "unreachable", message: "machine unreachable" } }), stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD),
    { hub: true, message: "hub.example does not answer (machine unreachable)" });
});

test("editOnHub: a failure with no JSON gives the error text", async () => {
  const { hc } = fakeHc({ code: 2, stdout: "", stderr: "error: unexpected argument\n" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD),
    { hub: true, message: "hub.example does not answer (error: unexpected argument)" });
});

test("editOnHub: hc does not start", async () => {
  const { hc } = fakeHc(new Error("spawn failed"));
  await assert.rejects(editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD),
    { hub: true, message: "hub.example does not answer (spawn failed)" });
});

test("editOnHub: a secret never goes to hc", async () => {
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, "authtoken: SECRET123\ntunnels:\n", "authtoken: SECRET123\n"),
    { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});

test("editOnHub: a basic_auth item never goes to hc", async () => {
  const text = 'tunnels:\n    a:\n        addr: 1\n        basic_auth:\n            - "user:pass"\n';
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, "tunnels:\n", text), { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});
