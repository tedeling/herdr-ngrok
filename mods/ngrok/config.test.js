// Run with: node --test mods/ngrok/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddr, parseConfig, redact, secretsOf } from "./config.js";
import { FILE } from "./fixture.js";

test("parse: three tunnels in file order", () => {
  assert.deepEqual(parseConfig(FILE).tunnels.map((t) => [t.name, t.off, t.host, t.port]),
    [["api", false, "api.example.dev", 8020], ["docs", true, "docs.example.dev", 7000], ["secure", false, "secure.example.dev", 9000]]);
});

test("parse: block lines", () => {
  const [api] = parseConfig(FILE).tunnels;
  assert.deepEqual([api.start, api.end], [3, 8]);
});

test("parse: user comment is not a tunnel", () => assert.equal(parseConfig(FILE).tunnels.length, 3));

test("parse: nested field", () => assert.deepEqual(parseConfig(FILE).tunnels.map((t) => t.nested), [false, false, true]));

test("parse: scalars are unquoted", () => assert.equal(parseConfig(FILE).tunnels[1].scalars.addr, "localhost:7000"));

test("parse: version 3 is an error", () =>
  assert.equal(parseConfig("version: 3\nagent:\n  authtoken: x\n").error, "This panel reads only ngrok config version 2."));

test("parse: no tunnels map", () => assert.deepEqual(parseConfig('version: "2"\nauthtoken: x\n'), { tunnels: [], error: null }));

test("parseAddr: three forms", () => {
  for (const a of ["8020", "localhost:8020", "http://localhost:8020"]) assert.deepEqual(parseAddr(a), { host: "localhost", port: 8020 });
});

test("redact: hides the authtoken", () => assert.equal(redact("bad token SECRET123", secretsOf(FILE)), "bad token <secret>"));
