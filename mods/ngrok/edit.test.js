// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "./config.js";
import { addTunnel, parseHost, parsePort, removeTunnel, setHost, setOff, setPort } from "./edit.js";
import { FILE } from "./fixture.js";

// True when the two texts have the same lines outside the block of t.
const outside = (a, b, t) => {
  const x = a.split("\n"), y = b.split("\n");
  return x.length === y.length && x.every((l, i) => (i >= t.start && i < t.end) || l === y[i]);
};

test("setPort: plain", () => assert.match(setPort(FILE, "api", 9100), /^ {8}addr: 9100$/m));

test("setPort: keeps form and quotes", () => assert.match(setPort(FILE, "docs", 7100), /^#herdr-off# {8}addr: "localhost:7100"$/m));

test("setPort: other lines stay", () => assert.ok(outside(FILE, setPort(FILE, "api", 9100), parseConfig(FILE).tunnels[0])));

test("setHost: host_header follows", () => {
  const text = setHost(FILE, "api", "app.example.dev");
  assert.match(text, /hostname: app.example.dev\n {8}host_header: app.example.dev/);
});

test("setHost: domain key", () => assert.match(setHost(FILE, "secure", "s2.example.dev"), /domain: s2.example.dev/));

test("setOff: on removes the marker", () => assert.equal(parseConfig(setOff(FILE, "docs", false)).tunnels[1].off, false));

test("setOff: round trip", () => assert.equal(setOff(setOff(FILE, "api", true), "api", false), FILE));

test("addTunnel: name and fields", () => {
  const { text, name } = addTunnel(FILE, "web.example.dev", 3000);
  assert.equal(name, "web");
  assert.deepEqual(parseConfig(text).tunnels.at(-1).scalars,
    { addr: "3000", proto: "http", hostname: "web.example.dev", host_header: "web.example.dev" });
});

test("addTunnel: name taken", () => assert.equal(addTunnel(FILE, "api.other.dev", 1).name, "api2"));

test("addTunnel: no tunnels map", () => assert.equal(parseConfig(addTunnel('version: "2"\n', "a.example.dev", 1).text).tunnels.length, 1));

test("removeTunnel: block gone, rest stays", () =>
  assert.equal(removeTunnel(FILE, "api"), FILE.split("\n").filter((_, i) => i < 3 || i >= 8).join("\n")));

test("crlf: endings stay", () => {
  const crlf = FILE.replaceAll("\n", "\r\n");
  assert.equal(setPort(crlf, "api", 9100), setPort(FILE, "api", 9100).replaceAll("\n", "\r\n"));
});

test("unknown name throws", () => assert.throws(() => setPort(FILE, "nope", 1), /No tunnel with the name nope/));

test("parsePort", () => assert.deepEqual(["8020", " 80 ", "80a", "0", "70000", ""].map(parsePort), [8020, 80, null, null, null, null]));

test("parseHost", () =>
  assert.deepEqual(["a.example.dev", "Example.dev", "-a.dev", "localhost", ""].map(parseHost), ["a.example.dev", null, null, null, null]));
