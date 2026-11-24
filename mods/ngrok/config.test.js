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

test("secretsOf: an indentless list at the indent of its key", () =>
  assert.deepEqual(secretsOf('    a:\n        basic_auth:\n        - "user:pass"\n        - other:word\n        addr: 1\n        - "not:this"\n'),
    ["user:pass", "other:word"]));

test("secretsOf: a value on the next line", () =>
  assert.deepEqual(secretsOf("authtoken:\n  abc123\nregion: eu\n"), ["abc123"]));

test("secretsOf: a block scalar gives its lines, never the indicator", () => {
  // The scan of the uncommented lines adds "def".
  assert.deepEqual(secretsOf("authtoken: |\n  abc\n  # def\nregion: eu\n"), ["abc", "# def", "def"]);
  assert.deepEqual(secretsOf("    password: >-\n        p1\n    addr: 1\n"), ["p1"]);
});

test("secretsOf: a comment between a key and its items does not end the block", () => {
  // A comment at column 0, and a comment at the indent of the key. The scan of the uncommented
  // lines adds the text of the comment, which is the safe side.
  for (const [comment, text] of [['#            - "old:pass"', "old:pass"], ["        # first user", "first user"]]) {
    assert.deepEqual(secretsOf(`        basic_auth:\n${comment}\n            - "user:pass"\n`), ["user:pass", text], `deeper list, ${comment}`);
    assert.deepEqual(secretsOf(`        basic_auth:\n${comment}\n        - "user:pass"\n`), ["user:pass", text], `indentless list, ${comment}`);
    assert.deepEqual(secretsOf(`        authtoken:\n${comment}\n            abc123\n`), ["abc123", text], `next line, ${comment}`);
  }
});

test("secretsOf: a # line inside a block scalar is content", () =>
  // The scan of the uncommented lines adds "p1".
  assert.deepEqual(secretsOf("    password: |\n        # p1\n        p2\n    addr: 1\n"), ["# p1", "p2", "p1"]));

// A person often comments out a field to switch it off, and the value often still works.
test("secretsOf: a commented-out basic_auth counts", () => {
  // The marker at column 0, and the marker at the indent of the field.
  assert.ok(secretsOf('    a:\n        addr: 1\n#        basic_auth:\n#            - "user:pass"\n').includes("user:pass"));
  assert.ok(secretsOf('    a:\n        addr: 1\n        # basic_auth:\n        #     - "user:pass"\n').includes("user:pass"));
  // A commented-out item under a real key.
  assert.ok(secretsOf('        basic_auth:\n#        - "old:pass"\n            - "user:pass"\n').includes("old:pass"));
});

test("secretsOf: a commented-out authtoken counts", () => {
  for (const line of ["# authtoken: OLD123", "#authtoken: OLD123", '    ## authtoken: "OLD123"']) {
    assert.deepEqual(secretsOf(`${line}\nregion: eu\n`), ["OLD123"], line);
  }
});

test("secretsOf: a commented-out secret in an off tunnel counts", () =>
  assert.ok(secretsOf('#herdr-off#    a:\n#herdr-off#        addr: 1\n#herdr-off#        # basic_auth:\n#herdr-off#        #     - "user:pass"\n')
    .includes("user:pass")));

test("secretsOf: an off tunnel and a comment with no secret give nothing", () =>
  assert.deepEqual(secretsOf('tunnels:\n    # old port 8000\n#herdr-off#    docs:\n#herdr-off#        addr: "localhost:7000"\n#herdr-off#        hostname: docs.example.dev\n'), []));

test("secretsOf: each value one time", () =>
  assert.deepEqual(secretsOf('authtoken: abc\n# authtoken: abc\n'), ["abc"]));

// The v2 form of basic auth is a scalar: `auth: "user:pass"`.
const LOCKED = FILE.replace('version: "2"', '    locked:\n        addr: 8030\n        proto: http\n        hostname: locked.example.dev\n        auth: "user:pass"\nversion: "2"');

test("parse: a scalar secret field marks the tunnel", () => {
  assert.deepEqual(parseConfig(LOCKED).tunnels.map((t) => [t.name, t.secret]),
    [["api", false], ["docs", false], ["secure", false], ["locked", true]]);
  // A bare value that secretsOf skips, and an empty value, do not count.
  assert.deepEqual(parseConfig("tunnels:\n    a:\n        addr: 1\n        auth_skip: true\n        token: ''\n").tunnels.map((t) => t.secret), [false]);
});
