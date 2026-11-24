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

test("secretsOf: authtoken and a basic_auth item of the fixture", () => assert.deepEqual(secretsOf(FILE), ["SECRET123", "u:p"]));

test("secretsOf: a basic_auth block list", () =>
  assert.deepEqual(secretsOf('    a:\n        basic_auth:\n            - "user:pass"\n            - other:word\n        addr: 1\n    - "not:this"\n'),
    ["user:pass", "other:word"]));

test("secretsOf: an inline list", () =>
  assert.deepEqual(secretsOf('        basic_auth: ["user:pass", \'a:b\']\n'), ["user:pass", "a:b"]));

test("secretsOf: each key with auth, token, secret, or password in its name", () =>
  assert.deepEqual(secretsOf("api_key: k1\nclient_secret: s1\nWebhook_Token: 't1'\ndb_password: p1\naddr: 8020\n"), ["k1", "s1", "t1", "p1"]));

test("secretsOf: an off line counts", () =>
  assert.deepEqual(secretsOf('#herdr-off#        basic_auth:\n#herdr-off#            - "user:pass"\n'), ["user:pass"]));

test("secretsOf: a skip: true style value does not count", () =>
  assert.deepEqual(secretsOf("auth_skip: true\ntoken_ttl: 300\npassword_set: False\nsecret: null\noauth: ~\nbasic_auth: [1, true]\n"), []));

test("redact: hides a basic_auth item", () => assert.equal(redact('bad "u:p"', secretsOf(FILE)), 'bad "<secret>"'));
