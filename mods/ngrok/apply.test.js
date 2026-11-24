// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit } from "./apply.js";
import { parseConfig } from "./config.js";
import { setOff } from "./edit.js";
import { FILE } from "./fixture.js";

const live = (apiPort, name, host, port) => ({ apiPort, name, host, port });

// An Io that holds the file text in memory and records each call. Like the real agent, it keeps the
// name of a tunnel whose start failed, and refuses a later start with that name.
function fakeIo(text, { stale = false, writeError = null, checkError = null, startErrors = [], live = [] } = {}) {
  const blocked = new Set();
  const io = {
    text,
    calls: [],
    startBodies: [],
    async read() { io.calls.push(["read"]); return io.text; },
    async write(next, expected) {
      io.calls.push(["write"]);
      if (writeError) throw writeError;
      if (stale || expected !== io.text) throw new Error("stale");
      io.text = next;
    },
    async check() { io.calls.push(["check"]); return checkError; },
    async live() { io.calls.push(["live"]); return live; },
    async start(apiPort, body) {
      io.calls.push(["start", apiPort, body.name]);
      io.startBodies.push(body);
      if (blocked.has(body.name)) return `tunnel "${body.name}" already exists`;
      const error = startErrors.shift() ?? null;
      if (error) blocked.add(body.name);
      return error;
    },
    async stop(apiPort, name) { io.calls.push(["stop", apiPort, name]); return null; },
  };
  return io;
}

const agentCalls = (io) => io.calls.filter((c) => c[0] === "stop" || c[0] === "start").map((c) => c[0]);

test("port edit: write, check, stop, start", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] });
  assert.deepEqual(await applyEdit(io, { kind: "port", name: "api", port: 9100 }), { ok: true, error: null, note: null });
  assert.deepEqual(io.calls.map((c) => c[0]), ["read", "write", "check", "live", "stop", "start"]);
  assert.equal(io.startBodies[0].addr, "9100");
});

test("stale write: file stays", async () => {
  const io = fakeIo(FILE, { stale: true });
  const r = await applyEdit(io, { kind: "port", name: "api", port: 1 });
  assert.equal(r.error, "The file changed outside the panel. The panel read it again.");
  assert.equal(io.text, FILE);
});

test("write: a hub error shows as it is", async () => {
  const io = fakeIo(FILE, { writeError: Object.assign(new Error("hub.example does not answer (x)"), { hub: true }) });
  const r = await applyEdit(io, { kind: "port", name: "api", port: 1 });
  assert.equal(r.error, "hub.example does not answer (x)");
  assert.equal(io.text, FILE);
});

test("check fails: undo, secret hidden", async () => {
  const io = fakeIo(FILE, { checkError: "bad SECRET123" });
  const r = await applyEdit(io, { kind: "port", name: "api", port: 1 });
  assert.equal(io.text, FILE);
  assert.equal(r.error, "bad <secret>");
});

test("agent rejects a new host: undo file, old tunnel keeps running", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)], startErrors: ["host not reserved"] });
  const r = await applyEdit(io, { kind: "host", name: "api", host: "new.example.dev" });
  assert.equal(io.text, FILE);
  assert.equal(r.error, "host not reserved");
  assert.ok(!io.calls.some((c) => c[0] === "stop" && c[2] === "api"));
  assert.ok(io.startBodies.every((b) => b.name.startsWith("herdr-probe-")));
});

test("new host: probe, then stop and start", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] });
  const r = await applyEdit(io, { kind: "host", name: "api", host: "new.example.dev" });
  assert.equal(r.ok, true);
  const probe = io.startBodies[0].name;
  assert.deepEqual(io.calls.filter((c) => c[0] === "stop" || c[0] === "start").map((c) => [c[0], c[2]]),
    [["start", probe], ["stop", probe], ["stop", "api"], ["start", "api"]]);
});

test("add rejected: undo, and the name stays free", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "a", 1)], startErrors: ["no"] });
  await applyEdit(io, { kind: "add", host: "w.example.dev", port: 1 });
  assert.equal(io.text, FILE);
  assert.ok(!io.startBodies.some((b) => b.name === "w"));
});

test("add: a live tunnel of another agent with the same name stays untouched", async () => {
  const io = fakeIo(FILE, { live: [live(4040, "web", "web.other.dev", 3000), live(4041, "api", "api.example.dev", 8020)] });
  const r = await applyEdit(io, { kind: "add", host: "web.example.dev", port: 1 });
  assert.equal(r.ok, true);
  assert.ok(!io.calls.some((c) => c[0] === "stop" && c[2] === "web"));
  assert.equal(parseConfig(io.text).tunnels.at(-1).name, "web2");
});

test("port edit, start fails: says that the tunnel is down", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)], startErrors: ["bad field"] });
  const r = await applyEdit(io, { kind: "port", name: "api", port: 9100 });
  assert.equal(io.text, FILE);
  assert.equal(r.error, "bad field The tunnel is down. Restart ngrok to start it again.");
});

test("nested tunnel: off stops it", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "secure", "secure.example.dev", 9000)] });
  const r = await applyEdit(io, { kind: "off", name: "secure" });
  assert.deepEqual(r, { ok: true, error: null, note: null });
  assert.deepEqual(agentCalls(io), ["stop"]);
});

test("nested tunnel: remove stops it", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "secure", "secure.example.dev", 9000)] });
  await applyEdit(io, { kind: "remove", name: "secure" });
  assert.deepEqual(agentCalls(io), ["stop"]);
});

test("edit with no change: no write and no agent call", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] });
  const r = await applyEdit(io, { kind: "port", name: "api", port: 8020 });
  assert.deepEqual(r, { ok: true, error: null, note: null });
  assert.ok(!io.calls.some((c) => c[0] === "write"));
  assert.deepEqual(agentCalls(io), []);
});

test("nested tunnel: save only", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "secure", "secure.example.dev", 9000)] });
  const r = await applyEdit(io, { kind: "port", name: "secure", port: 9100 });
  assert.equal(r.note, "Restart ngrok to apply this change.");
  assert.deepEqual(agentCalls(io), []);
});

test("no agent: save only", async () => {
  const io = fakeIo(FILE, {});
  const r = await applyEdit(io, { kind: "on", name: "docs" });
  assert.equal(r.note, "No ngrok agent runs the tunnels from the config.");
  assert.notEqual(io.text, FILE);
});

test("off: stop only", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] });
  await applyEdit(io, { kind: "off", name: "api" });
  assert.deepEqual(agentCalls(io), ["stop"]);
});

test("sync: no write", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8021)] });
  await applyEdit(io, { kind: "sync", name: "api" });
  assert.ok(!io.calls.some((c) => c[0] === "write"));
  assert.deepEqual(agentCalls(io), ["stop", "start"]);
});

test("duplicate host", async () => {
  const io = fakeIo(FILE, {});
  assert.equal((await applyEdit(io, { kind: "add", host: "api.example.dev", port: 1 })).error, "Another tunnel uses this host.");
  assert.equal(io.text, FILE);
});

// A tunnel with a scalar secret field, the v2 form of basic auth.
const LOCKED = FILE.replace('version: "2"', '    locked:\n        addr: 8030\n        proto: http\n        hostname: locked.example.dev\n        auth: "user:pass"\nversion: "2"');
const LOCKED_LIVE = [live(4041, "api", "api.example.dev", 8020), live(4041, "locked", "locked.example.dev", 8030)];

test("scalar secret tunnel: a port edit writes the file and asks for a restart, with no agent call", async () => {
  const io = fakeIo(LOCKED, { live: LOCKED_LIVE });
  const r = await applyEdit(io, { kind: "port", name: "locked", port: 8031 });
  assert.deepEqual(r, { ok: true, error: null, note: "Restart ngrok to apply this change." });
  assert.ok(io.text.includes("        addr: 8031\n"));
  assert.deepEqual(agentCalls(io), []);
});

test("scalar secret tunnel: a host edit sends no probe", async () => {
  const io = fakeIo(LOCKED, { live: LOCKED_LIVE });
  const r = await applyEdit(io, { kind: "host", name: "locked", host: "new.example.dev" });
  assert.equal(r.note, "Restart ngrok to apply this change.");
  assert.deepEqual(io.startBodies, []);
});

test("scalar secret tunnel: on and sync ask for a restart, with no agent call", async () => {
  const off = fakeIo(setOff(LOCKED, "locked", true), { live: [live(4041, "api", "api.example.dev", 8020)] });
  assert.equal((await applyEdit(off, { kind: "on", name: "locked" })).note, "Restart ngrok to apply this change.");
  assert.deepEqual(agentCalls(off), []);
  const sync = fakeIo(LOCKED, { live: [live(4041, "api", "api.example.dev", 8020), live(4041, "locked", "locked.example.dev", 8099)] });
  assert.equal((await applyEdit(sync, { kind: "sync", name: "locked" })).note, "Restart ngrok to apply this change.");
  assert.deepEqual(agentCalls(sync), []);
});

test("scalar secret tunnel: off still stops it", async () => {
  const io = fakeIo(LOCKED, { live: LOCKED_LIVE });
  assert.deepEqual(await applyEdit(io, { kind: "off", name: "locked" }), { ok: true, error: null, note: null });
  assert.deepEqual(io.calls.filter((c) => c[0] === "stop").map((c) => c[2]), ["locked"]);
});

test("a tunnel next to a scalar secret tunnel still applies live, and no body holds the secret", async () => {
  const io = fakeIo(LOCKED, { live: LOCKED_LIVE });
  assert.deepEqual(await applyEdit(io, { kind: "port", name: "api", port: 9100 }), { ok: true, error: null, note: null });
  assert.deepEqual(agentCalls(io), ["stop", "start"]);
  assert.ok(io.startBodies.every((b) => !JSON.stringify(b).includes("user:pass")));
});
