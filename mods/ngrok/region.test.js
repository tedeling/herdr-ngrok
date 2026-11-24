// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGION_NONE, REGION_SECRET, editOnHub, editRegion } from "./region.js";
import { removeTunnel, setOff } from "./edit.js";
import { FILE } from "./fixture.js";

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
test("editRegion: an add after a basic_auth item takes the line after it", () => {
  const old = 'tunnels:\n    secure:\n        addr: 9000\n        basic_auth:\n            - "u:p"\nversion: "2"\n';
  const block = "    web:\n        addr: 3000\n        proto: http\n";
  assert.deepEqual(editRegion(old, old.replace('version: "2"\n', block + 'version: "2"\n'), ["u:p"]),
    { old: 'version: "2"\n', new: block + 'version: "2"\n' });
});
test("editRegion: a remove of a whole tunnel block", () => {
  const old = 'tunnels:\n    api:\n        addr: 8020\n    web:\n        addr: 3000\nversion: "2"\n';
  assert.deepEqual(editRegion(old, old.replace("    web:\n        addr: 3000\n", ""), S), { old: "    web:\n        addr: 3000\n", new: "" });
});
test("editRegion: an add at the start of the file", () =>
  assert.deepEqual(editRegion('version: "2"\nregion: eu\n', 'tunnels:\nversion: "2"\nregion: eu\n', S),
    { old: 'version: "2"\n', new: 'tunnels:\nversion: "2"\n' }));
test("editRegion: a last line with no newline", () =>
  assert.deepEqual(editRegion("tunnels:\n    a:\n        addr: 1", "tunnels:\n    a:\n        addr: 1\n    b:\n        addr: 2", S),
    { old: "        addr: 1", new: "        addr: 1\n    b:\n        addr: 2" }));
test("editRegion: only a region on both sides is unique", () => {
  const old = "p\nx\nq\nr\np\nx\ns\nx\nq\nr\n";
  assert.deepEqual(editRegion(old, old.replace("p\nx\nq\n", "p\ny\nq\n"), S), { old: "p\nx\nq\n", new: "p\ny\nq\n" });
});
test("editRegion: a secret on one side only blocks that side", () =>
  // The line before the change holds the secret, so the line after it makes the region unique.
  assert.deepEqual(editRegion("SECRET123\nx\nc\nx\nd\n", "SECRET123\ny\nc\nx\nd\n", S), { old: "x\nc\n", new: "y\nc\n" }));
test("editRegion: a 2000-line file with many equal lines", () => {
  const line = "        addr: 1\n";
  const started = Date.now();
  const old = line.repeat(1000) + "    end:\n" + line.repeat(999);
  assert.deepEqual(editRegion(old, old.replace("    end:\n", "    end:\n        addr: 2\n"), S),
    { old: "    end:\n", new: "    end:\n        addr: 2\n" });
  // Only the whole file is unique when all 2000 lines are equal.
  const same = line.repeat(2000);
  const changed = line.repeat(1999) + "        addr: 2\n";
  assert.deepEqual(editRegion(same, changed, S), { old: same, new: changed });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});
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
  assert.deepEqual(calls, [["file", "edit", "--json", "--on", "desk", PATH, "--old=        addr: 8020\n", "--new=        addr: 8021\n"]]);
});

test("editOnHub: a region that starts with a dash stays one argument", async () => {
  const { hc, calls } = fakeHc({ code: 0, stdout: json({ ok: true }), stderr: "" });
  await editOnHub(hc, TARGET, PATH, "- y\n", "- x\n");
  assert.deepEqual(calls, [["file", "edit", "--json", "--on", "desk", PATH, "--old=- x\n", "--new=- y\n"]]);
});

test("editOnHub: a usage error is a hub error, not stale", async () => {
  const { hc } = fakeHc({ code: 2, stdout: json({ error: { kind: "usage", message: "unexpected argument" } }), stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, OLD.replace("8020", "8021"), OLD),
    { hub: true, message: "hub.example does not answer (unexpected argument)" });
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

test("editOnHub: an indentless basic_auth item never goes to hc", async () => {
  const text = 'tunnels:\n    a:\n        addr: 1\n        basic_auth:\n        - "user:pass"\nversion: "2"\n';
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, 'tunnels:\nversion: "2"\n', text), { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});

test("editOnHub: a basic_auth item never goes to hc", async () => {
  const text = 'tunnels:\n    a:\n        addr: 1\n        basic_auth:\n            - "user:pass"\n';
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, "tunnels:\n", text), { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});

test("editOnHub: a commented-out basic_auth never goes to hc", async () => {
  const text = 'tunnels:\n    a:\n        addr: 1\n        # basic_auth:\n        #     - "user:pass"\n    b:\n        addr: 2\nversion: "2"\n';
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, removeTunnel(text, "a"), text), { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});

test("editOnHub: a commented-out authtoken never goes to hc", async () => {
  const { hc, calls } = fakeHc({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(editOnHub(hc, TARGET, PATH, "# authtoken: OLD123\ntunnels:\n", "# authtoken: OLD123\n"),
    { hub: true, message: REGION_SECRET });
  assert.deepEqual(calls, []);
});

test("editOnHub: an off tunnel with no secret stays editable", async () => {
  const { hc, calls } = fakeHc({ code: 0, stdout: json({ ok: true }), stderr: "" });
  await editOnHub(hc, TARGET, PATH, setOff(FILE, "docs", false), FILE);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`--old=#herdr-off#    docs:\n#herdr-off#        addr: "localhost:7000"\n#herdr-off#        proto: http\n#herdr-off#        hostname: docs.example.dev\n`));
});
