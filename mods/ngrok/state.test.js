// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";
import { agentError, chooseAgent, controlsOf, domainOf, groupRows, listenerCommand, localTip, mergeRows, parseLive, parseLsof, parseSs, postBody, rising, shortName } from "./state.js";
import { FILE } from "./fixture.js";

const live = (apiPort, name, host, port) => ({ apiPort, name, host, port });
const tunnels = parseConfig(FILE).tunnels; // api 8020 on, docs off, secure 9000 on

test("parseLive", () => {
  const json = JSON.stringify({ tunnels: [{ name: "api", public_url: "https://api.example.dev", config: { addr: "http://localhost:8020" } }] });
  assert.deepEqual(parseLive(json, 4041), [{ ...live(4041, "api", "api.example.dev", 8020), count: null, local: true }]);
});

test("parseLive: bad json", () => assert.deepEqual(parseLive("<html>", 4041), []));

test("merge: states", () => {
  const rows = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8020), live(4040, "command_line", "x.example.dev", 3000)]);
  assert.deepEqual(rows.map((r) => [r.key, r.state]),
    [["api", "live"], ["docs", "off"], ["secure", "down"], ["outside:4040:command_line", "outside"]]);
});

test("merge: rows carry the off flag of the file", () => {
  const rows = mergeRows(tunnels, [live(4041, "docs", "docs.example.dev", 7000), live(4040, "command_line", "x.example.dev", 3000)]);
  assert.deepEqual(rows.map((r) => [r.key, r.state, r.off]),
    [["api", "down", false], ["docs", "drift", true], ["secure", "down", false], ["outside:4040:command_line", "outside", false]]);
});

test("merge: port drift", () => {
  const [row] = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8021)]);
  assert.deepEqual([row.state, row.livePort], ["drift", 8021]);
});

test("merge: off but live is drift", () => assert.equal(mergeRows(tunnels, [live(4041, "docs", "docs.example.dev", 7000)])[1].state, "drift"));

test("chooseAgent: by name", () => assert.equal(chooseAgent("api", tunnels, [live(4040, "x", "x", 1), live(4041, "api", "a", 1)]), 4041));

test("chooseAgent: most file tunnels", () =>
  assert.equal(chooseAgent("secure", tunnels, [live(4040, "command_line", "x", 1), live(4041, "api", "a", 1)]), 4041));

test("chooseAgent: none", () => assert.equal(chooseAgent("api", tunnels, [live(4040, "command_line", "x", 1)]), null));

test("postBody", () =>
  assert.deepEqual(postBody(tunnels[0]), { name: "api", addr: "8020", proto: "http", hostname: "api.example.dev", host_header: "api.example.dev" }));

test("postBody refuses nested", () => assert.throws(() => postBody(tunnels[2])));

test("postBody refuses a scalar secret field, and its error does not hold the secret", () => {
  const [locked] = parseConfig('tunnels:\n    locked:\n        addr: 8030\n        auth: "user:pass"\n').tunnels;
  assert.throws(() => postBody(locked), (e) => !String(e.message).includes("user:pass"));
});

test("agentError: no repeated text", () =>
  assert.equal(agentError('{"msg":"failed to start tunnel","details":{"err":"failed to start tunnel: host not reserved"}}'),
    "failed to start tunnel: host not reserved"));

test("agentError", () =>
  assert.equal(agentError('{"msg":"failed to start tunnel","details":{"err":"host not reserved\\r\\n\\r\\nERR_NGROK_319\\r\\n"}}'),
    "failed to start tunnel: host not reserved ERR_NGROK_319"));

const SS = [
  "LISTEN 0 511 127.0.0.1:10005 0.0.0.0:* users:((\"node-MainThread\",pid=4321,fd=24))",
  "LISTEN 0 511 [::1]:10006 [::]:* users:((\"node\",pid=7,fd=3))",
  "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*",
].join("\n");
const LSOF = "p4312\ncjava\nf12\nn*:8020\np99\ncnode\nf3\nn127.0.0.1:10005\n";

test("parseLive: request count", () => {
  const json = JSON.stringify({ tunnels: [
    { name: "a", public_url: "https://a.example.dev", config: { addr: "http://localhost:1" }, metrics: { http: { count: 36 }, conns: { count: 21 } } },
    { name: "t", public_url: "tcp://1.tcp.ngrok.io:2", config: { addr: "localhost:22" }, metrics: { http: { count: 0 }, conns: { count: 5 } } },
    { name: "n", public_url: "https://n.example.dev", config: { addr: "192.168.1.5:80" } }] });
  assert.deepEqual(parseLive(json, 4041).map((l) => [l.count, l.local]), [[36, true], [5, true], [null, false]]);
});

test("parseSs", () =>
  assert.deepEqual([...parseSs(SS)], [[10005, { program: "node-MainThread", pid: 4321 }], [10006, { program: "node", pid: 7 }], [3000, { program: null, pid: null }]]));

test("parseLsof", () => assert.deepEqual([...parseLsof(LSOF)], [[8020, { program: "java", pid: 4312 }], [10005, { program: "node", pid: 99 }]]));

test("local: listening and not", () => {
  const rows = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8020)], new Map([[8020, { program: "java", pid: 1 }]]));
  assert.deepEqual(rows[0].local, { port: 8020, listening: true, program: "java", pid: 1 });
  assert.equal(rows[2].local.listening, false);
});

test("local: off tunnel has no light", () => assert.equal(mergeRows(tunnels, [], new Map())[1].local, null));

test("local: unknown listeners", () => assert.equal(mergeRows(tunnels, [], null)[0].local, null));

test("local: other host", () => {
  const other = parseConfig("tunnels:\n    x:\n        addr: 192.168.1.5:80\n        hostname: x.example.dev\n").tunnels;
  assert.equal(mergeRows(other, [], new Map())[0].local, null);
});

test("localTip", () => {
  assert.equal(localTip({ port: 10005, listening: true, program: "node", pid: 7 }), "node (pid 7) listens on 10005");
  assert.equal(localTip({ port: 9010, listening: false, program: null, pid: null }), "Nothing listens on 9010");
  assert.equal(localTip({ port: 3000, listening: true, program: null, pid: null }), "A program listens on 3000, but the panel cannot see which one.");
});

test("domainOf and shortName", () =>
  assert.deepEqual(["api.example.dev", "abc.ngrok-free.app", "localhost", ""].map((h) => [domainOf(h), shortName(h)]),
    [["example.dev", "api"], ["ngrok-free.app", "abc"], ["localhost", "localhost"], ["", ""]]));

test("groupRows: order of first row, outside joins its domain", () => {
  const rows = mergeRows(tunnels, [live(4040, "command_line", "c.other.dev", 3000), live(4040, "x", "z.example.dev", 1)]);
  assert.deepEqual(groupRows(rows).map((g) => [g.domain, g.rows.map((r) => r.key)]),
    [["example.dev", ["api", "docs", "secure", "outside:4040:x"]], ["other.dev", ["outside:4040:command_line"]]]);
});

test("rising", () => {
  const rows = [{ key: "a", count: 5 }, { key: "b", count: 2 }, { key: "c", count: null }];
  assert.deepEqual([...rising(new Map([["a", 4], ["b", 3]]), rows)], ["a"]);
});

test("controlsOf: the buttons replace the note on the row under the pointer", () => {
  const down = { state: "down" };
  const at = (hovered, confirming, busy) => ({ hovered, confirming, busy });
  assert.deepEqual(controlsOf(down, at(false, false, false)), { note: true, sync: false, remove: null });
  assert.deepEqual(controlsOf(down, at(true, false, false)), { note: false, sync: true, remove: "✕" });
  assert.deepEqual(controlsOf({ state: "live" }, at(true, false, false)), { note: false, sync: false, remove: "✕" });
  assert.deepEqual(controlsOf(down, at(false, true, false)), { note: false, sync: false, remove: "remove?" });
  assert.deepEqual(controlsOf({ state: "outside" }, at(true, false, false)), { note: true, sync: false, remove: null });
  assert.deepEqual(controlsOf(down, at(true, false, true)), { note: true, sync: false, remove: null });
});

test("listenerCommand: lsof on Darwin, ss elsewhere", () => {
  assert.deepEqual(listenerCommand("Darwin"), { command: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], parse: parseLsof });
  assert.deepEqual(listenerCommand("Linux"), { command: "ss", args: ["-ltnpH"], parse: parseSs });
  assert.equal(listenerCommand("FreeBSD").command, "ss");
});
