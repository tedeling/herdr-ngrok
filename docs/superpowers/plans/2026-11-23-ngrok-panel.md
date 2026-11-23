# ngrok Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Herdr sidebar panel that shows which public host goes to which local port for each ngrok tunnel, and changes one tunnel live and in `ngrok.yml`.

**Architecture:** Pure modules do the work and have `node --test` tests: `config.js` reads `ngrok.yml` text, `edit.js` changes the lines of one tunnel, `state.js` merges the file with the live agent state, and `apply.js` runs one edit through an injected `Io` with undo. Only `io.js` and `main.js` import `herdr`. `io.js` runs `ngrok` and `curl`, and reads and writes the file. `main.js` is the view.

**Tech Stack:** Herdr app mod (herdr-app 0.1.17, modules `herdr`, `gpui-kit`, `gpui-base`), plain JavaScript ES modules, `node --test` (Node 26), `curl`, `ngrok` 3.39.

**Spec:** `docs/superpowers/specs/2026-11-23-ngrok-panel-design.md`. Read it before you start a task.

## Global Constraints

- Repo root: `~/src/herdr/herdr-ngrok`. Mod source: `mods/ngrok/`. Installed copy: `~/.config/herdr-app/mods/ngrok/`, a plain copy of `mods/ngrok/` (`cp mods/ngrok/*.js mods/ngrok/mod.json ~/.config/herdr-app/mods/ngrok/`).
- `.gitignore` holds `mods/*/gpui-kit.d.ts`, `mods/*/jsconfig.json`, `.DS_Store`, the same as `herdr-postgres`.
- `mod.json`: `{ "place": "none", "title": "Tunnels" }`.
- Only config `version: "2"`. For `version: 3`, the panel shows `This panel reads only ngrok config version 2.` and allows no edit.
- An edit must not change any line outside the block of the edited tunnel. Keep the line endings (`\n` or `\r\n`) and the quote style of a value.
- The `authtoken` and `api_key` values must not show on screen, in a log, or in an error. Pass each error text through `redact`.
- After each write of `ngrok.yml`, run `chmod 600` on it.
- Agent API: `http://127.0.0.1:<port>/api/tunnels` for the ports 4040 to 4049. Poll each 5 seconds.
- `POST` body field for the host: `hostname` (tested on 2026-11-23: the agent read it and answered `ERR_NGROK_319` for a host that the account does not own). A `DELETE` that answers 404 means "already stopped" and counts as success.
- Off marker: the exact prefix `#herdr-off#` at column 0, in front of each line of the block. The rest of the line stays as it was.
- New tunnel: name = the first DNS label of the host, with `2`, `3`, ... added if the name exists. Fields in this order: `addr`, `proto: http`, `hostname`, `host_header` (same as `hostname`).
- A tunnel block with a nested field (a map or a list under a field) gets no live apply. The panel saves the file, and the row note is `Restart ngrok to apply this change.` (Settled in planning: a `POST` without the nested fields can drop auth settings.)
- Guard each `exec` and `writeTextFile` with `checking()`.
- No real host names in the repo, also not in tests. Tests use `example.dev` and made-up error texts.
- Write comments and commit messages in Simplified Technical English.
- Redirect test output: `node --test mods/ngrok/ > "$SCRATCHPAD/test.log" 2>&1; tail -8 "$SCRATCHPAD/test.log"`.
- Change only the own block in `~/.config/herdr-app/layouts/main-prs.json`, with `jq`. Other sessions own the other blocks.
- Commit only if the user approved commits for this build.

## Review Focus

1. The user edits `ngrok.yml` in an editor while the panel is open. The write of the panel must fail, the file must stay as the user left it, and the panel must read it again. Test: Task 4, `stale write`.
2. A tunnel with `basic_auth` or another nested field. An edit must not restart it through the API without that field. Test: Task 3, `postBody refuses nested`, and Task 4, `nested tunnel: save only`.
3. Bad input in the port box (`80a`, `0`, `70000`, empty) or the host box (`Example.dev`, `-a.dev`, a host of another tunnel). The panel must refuse it before any write. Test: Task 2, `parsePort` and `parseHost`, and Task 4, `duplicate host`.
4. A file with `\r\n` line endings, or with no newline at the end. An edit must keep the endings, and the other lines must stay byte for byte. Test: Task 2, `crlf`.
5. A normal user comment inside the `tunnels:` map, such as `    # old port 8000`. It must not read as a tunnel, and an edit must keep it. Test: Task 1, `user comment`.

---

### Task 1: Scaffold and config parser

**Files:**
- Create: `.gitignore`, `mods/ngrok/mod.json`, `mods/ngrok/config.js`
- Test: `mods/ngrok/fixture.js` (`export const FILE`, used by all test files), `mods/ngrok/config.test.js`

**Interfaces:**
- Produces, in `config.js`:
  - `export const OFF_MARKER = "#herdr-off#"`
  - `export function parseConfig(text: string): { tunnels: FileTunnel[], error: string | null }`
  - `FileTunnel = { name: string, off: boolean, host: string | null, port: number | null, addr: string, proto: string, scalars: Record<string, string>, nested: boolean, start: number, end: number }`. `host` is `hostname`, or `domain` if there is no `hostname`. `scalars` holds each scalar field, unquoted. `start` is the line index of the name line. `end` is the index after the last line of the block that is indented deeper than the name.
  - `export function parseAddr(addr: string): { host: string, port: number | null }`. `"8020"`, `"localhost:8020"`, and `"http://localhost:8020"` all give `{ host: "localhost", port: 8020 }`.
  - `export function secretsOf(text: string): string[]` gives the values of `authtoken` and `api_key`.
  - `export function redact(message: string, secrets: string[]): string` puts `<secret>` in place of each secret.

- [ ] **Step 1: Write the failing tests** in `config.test.js`. Put this fixture, with 4-space indent, in `fixture.js`:

```js
const FILE = [
  'authtoken: SECRET123', 'region: eu', 'tunnels:',
  '    api:', '        addr: 8020', '        proto: http', '        hostname: api.example.dev', '        host_header: api.example.dev',
  '    # old port 8000',
  '#herdr-off#    docs:', '#herdr-off#        addr: "localhost:7000"', '#herdr-off#        proto: http', '#herdr-off#        hostname: docs.example.dev',
  '    secure:', '        addr: http://localhost:9000', '        proto: http', '        domain: secure.example.dev', '        basic_auth:', '            - "u:p"',
  'version: "2"', '',
].join("\n");

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
test("parse: version 3 is an error", () => assert.equal(parseConfig('version: 3\nagent:\n  authtoken: x\n').error, "This panel reads only ngrok config version 2."));
test("parse: no tunnels map", () => assert.deepEqual(parseConfig('version: "2"\nauthtoken: x\n'), { tunnels: [], error: null }));
test("parseAddr: three forms", () => { for (const a of ["8020", "localhost:8020", "http://localhost:8020"]) assert.deepEqual(parseAddr(a), { host: "localhost", port: 8020 }); });
test("redact: hides the authtoken", () => assert.equal(redact("bad token SECRET123", secretsOf(FILE)), "bad token <secret>"));
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test mods/ngrok/ > "$SCRATCHPAD/test.log" 2>&1; tail -8 "$SCRATCHPAD/test.log"`
Expected: fail, `Cannot find module` for `config.js`.

- [ ] **Step 3: Implement `config.js`**, and create `.gitignore` and `mod.json` with the content from Global Constraints. The parser is line based. The `tunnels:` map starts at the line `tunnels:` at column 0 and stops at the next line that has a non-space, non-`#` character at column 0. Strip `OFF_MARKER` before you read the indent of a line. The tunnel indent is the indent of the first name line in the map. Do not use a YAML library.

- [ ] **Step 4: Run the tests and see them pass**

Run: the command from Step 2. Expected: `pass 9`, `fail 0`.

- [ ] **Step 5: Commit** (only if commits are approved)

```bash
git init -q 2>/dev/null; git add .gitignore mods/ngrok/mod.json mods/ngrok/config.js mods/ngrok/config.test.js docs
git commit -m "feat: read the tunnels from ngrok.yml"
```

### Task 2: Line edits and input checks

**Files:**
- Create: `mods/ngrok/edit.js`
- Test: `mods/ngrok/edit.test.js`

**Interfaces:**
- Consumes: `parseConfig`, `OFF_MARKER` from Task 1.
- Produces, in `edit.js` (each edit throws `Error("No tunnel with the name <name>.")` if the name is not in the file):
  - `export function setPort(text: string, name: string, port: number): string` keeps the form of `addr` (`8020`, `localhost:8020`, `http://localhost:8020`) and its quotes.
  - `export function setHost(text: string, name: string, host: string): string` changes `hostname` (or `domain`). It changes `host_header` only when `host_header` was the same as the old host.
  - `export function setOff(text: string, name: string, off: boolean): string`
  - `export function addTunnel(text: string, host: string, port: number): { text: string, name: string }`
  - `export function removeTunnel(text: string, name: string): string`
  - `export function parsePort(input: string): number | null` gives an integer from 1 to 65535, else `null`.
  - `export function parseHost(input: string): string | null` gives the trimmed host if it has two labels or more, each label `[a-z0-9-]`, not at the start or end `-`. Else `null`.

- [ ] **Step 1: Write the failing tests** in `edit.test.js`. Import `FILE` from `fixture.js`.

```js
// True when the two texts have the same lines outside the block of t.
const outside = (a, b, t) => { const x = a.split("\n"), y = b.split("\n"); return x.length === y.length && x.every((l, i) => (i >= t.start && i < t.end) || l === y[i]); };

test("setPort: plain", () => assert.match(setPort(FILE, "api", 9100), /^ {8}addr: 9100$/m));
test("setPort: keeps form and quotes", () => assert.match(setPort(FILE, "docs", 7100), /^#herdr-off# {8}addr: "localhost:7100"$/m));
test("setPort: other lines stay", () => assert.ok(outside(FILE, setPort(FILE, "api", 9100), parseConfig(FILE).tunnels[0])));
test("setHost: host_header follows", () => { const t = setHost(FILE, "api", "app.example.dev"); assert.match(t, /hostname: app.example.dev\n {8}host_header: app.example.dev/); });
test("setHost: domain key", () => assert.match(setHost(FILE, "secure", "s2.example.dev"), /domain: s2.example.dev/));
test("setOff: on removes the marker", () => assert.deepEqual(parseConfig(setOff(FILE, "docs", false)).tunnels[1].off, false));
test("setOff: round trip", () => assert.equal(setOff(setOff(FILE, "api", true), "api", false), FILE));
test("addTunnel: name and fields", () => {
  const { text, name } = addTunnel(FILE, "web.example.dev", 3000);
  assert.equal(name, "web");
  assert.deepEqual(parseConfig(text).tunnels.at(-1).scalars, { addr: "3000", proto: "http", hostname: "web.example.dev", host_header: "web.example.dev" });
});
test("addTunnel: name taken", () => assert.equal(addTunnel(FILE, "api.other.dev", 1).name, "api2"));
test("addTunnel: no tunnels map", () => assert.equal(parseConfig(addTunnel('version: "2"\n', "a.example.dev", 1).text).tunnels.length, 1));
test("removeTunnel: block gone, rest stays", () => assert.equal(removeTunnel(FILE, "api"), FILE.split("\n").filter((_, i) => i < 3 || i >= 8).join("\n")));
test("crlf: endings stay", () => { const crlf = FILE.replaceAll("\n", "\r\n"); assert.equal(setPort(crlf, "api", 9100), setPort(FILE, "api", 9100).replaceAll("\n", "\r\n")); });
test("unknown name throws", () => assert.throws(() => setPort(FILE, "nope", 1), /No tunnel with the name nope/));
test("parsePort", () => assert.deepEqual(["8020", " 80 ", "80a", "0", "70000", ""].map(parsePort), [8020, 80, null, null, null, null]));
test("parseHost", () => assert.deepEqual(["a.example.dev", "Example.dev", "-a.dev", "localhost", ""].map(parseHost), ["a.example.dev", null, null, null, null]));
```

- [ ] **Step 2: Run the tests and see them fail.** Same command as Task 1. Expected: fail, `Cannot find module` for `edit.js`.

- [ ] **Step 3: Implement `edit.js`.** Split the text on `\n` and keep a `\r` at the end of a line in place. `addTunnel` puts the block at the end of the `tunnels:` map, with the tunnel indent and field indent of the first tunnel (default 4 and 8). If there is no map, it adds `tunnels:` at the end of the file.

- [ ] **Step 4: Run the tests and see them pass.** Expected: `fail 0`.

- [ ] **Step 5: Commit** `feat: change one tunnel in ngrok.yml`.

### Task 3: Live state and merge

**Files:**
- Create: `mods/ngrok/state.js`
- Test: `mods/ngrok/state.test.js`

**Interfaces:**
- Consumes: `FileTunnel`, `parseAddr` from Task 1.
- Produces, in `state.js`:
  - `export const API_PORTS: number[]` = 4040 to 4049.
  - `LiveTunnel = { apiPort: number, name: string, host: string, port: number | null }`
  - `export function parseLive(json: string, apiPort: number): LiveTunnel[]`. The host comes from `public_url`, the port from `config.addr`. Bad JSON gives `[]`.
  - `Row = { key: string, name: string | null, host: string, port: number | null, state: "live" | "off" | "down" | "drift" | "outside", liveHost: string | null, livePort: number | null, nested: boolean }`. The key of a file row is the tunnel name. The key of an outside row is `outside:<apiPort>:<name>`.
  - `export function mergeRows(tunnels: FileTunnel[], live: LiveTunnel[]): Row[]`. Match by name. File rows come first, in file order, then outside rows. States follow the spec table. A tunnel that is off in the file but live is `drift`.
  - `export function chooseAgent(name: string, tunnels: FileTunnel[], live: LiveTunnel[]): number | null`. Use the agent of the live tunnel with that name. Else use the agent that runs the most file tunnels. Else `null`.
  - `export function postBody(t: FileTunnel): Record<string, string | boolean>` gives `{ name, ...scalars }`, with `"true"` and `"false"` as booleans. It throws if `t.nested`.
  - `export function agentError(body: string): string` gives `msg` and `details.err` of an agent error answer, trimmed, or the raw body if it is not JSON.

- [ ] **Step 1: Write the failing tests** in `state.test.js`:

```js
const live = (apiPort, name, host, port) => ({ apiPort, name, host, port });
const tunnels = parseConfig(FILE).tunnels; // api 8020 on, docs off, secure 9000 on

test("parseLive", () => assert.deepEqual(parseLive(JSON.stringify({ tunnels: [{ name: "api", public_url: "https://api.example.dev", config: { addr: "http://localhost:8020" } }] }), 4041), [live(4041, "api", "api.example.dev", 8020)]));
test("parseLive: bad json", () => assert.deepEqual(parseLive("<html>", 4041), []));
test("merge: states", () => {
  const rows = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8020), live(4040, "command_line", "x.example.dev", 3000)]);
  assert.deepEqual(rows.map((r) => [r.key, r.state]), [["api", "live"], ["docs", "off"], ["secure", "down"], ["outside:4040:command_line", "outside"]]);
});
test("merge: port drift", () => { const [r] = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8021)]); assert.deepEqual([r.state, r.livePort], ["drift", 8021]); });
test("merge: off but live is drift", () => assert.equal(mergeRows(tunnels, [live(4041, "docs", "docs.example.dev", 7000)])[1].state, "drift"));
test("chooseAgent: by name", () => assert.equal(chooseAgent("api", tunnels, [live(4040, "x", "x", 1), live(4041, "api", "a", 1)]), 4041));
test("chooseAgent: most file tunnels", () => assert.equal(chooseAgent("secure", tunnels, [live(4040, "command_line", "x", 1), live(4041, "api", "a", 1)]), 4041));
test("chooseAgent: none", () => assert.equal(chooseAgent("api", tunnels, [live(4040, "command_line", "x", 1)]), null));
test("postBody", () => assert.deepEqual(postBody(tunnels[0]), { name: "api", addr: "8020", proto: "http", hostname: "api.example.dev", host_header: "api.example.dev" }));
test("postBody refuses nested", () => assert.throws(() => postBody(tunnels[2])));
test("agentError", () => assert.equal(agentError('{"msg":"failed to start tunnel","details":{"err":"host not reserved\\r\\n\\r\\nERR_NGROK_319\\r\\n"}}'), "failed to start tunnel: host not reserved ERR_NGROK_319"));
```

- [ ] **Step 2: Run the tests and see them fail.** Expected: `Cannot find module` for `state.js`.
- [ ] **Step 3: Implement `state.js`.** `agentError` trims each line of `details.err`, drops the empty lines, and joins the rest with single spaces.
- [ ] **Step 4: Run the tests and see them pass.** Expected: `fail 0`.
- [ ] **Step 5: Commit** `feat: merge the file tunnels with the live tunnels`.

### Task 4: Apply one edit, with undo

**Files:**
- Create: `mods/ngrok/apply.js`
- Test: `mods/ngrok/apply.test.js`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces, in `apply.js`:
  - `Io = { read(): Promise<string>, write(text: string, expected: string): Promise<void>, check(): Promise<string | null>, live(): Promise<LiveTunnel[]>, start(apiPort: number, body: object): Promise<string | null>, stop(apiPort: number, name: string): Promise<string | null> }`. `write` rejects when the file changed. `check`, `start`, and `stop` give `null` on success, else the error text.
  - `Edit = { kind: "port", name, port } | { kind: "host", name, host } | { kind: "off" | "on" | "remove" | "sync", name } | { kind: "add", host, port }`
  - `export async function applyEdit(io: Io, edit: Edit): Promise<{ ok: boolean, error: string | null, note: string | null }>`

The steps follow the spec section "Steps for one edit" and the undo rule after it. `sync` does no file write: it stops the live tunnel if there is one, and starts it again if the file has it on. Messages (exact copy):
- stale write: `The file changed outside the panel. The panel read it again.`
- duplicate host: `Another tunnel uses this host.`
- nested: note `Restart ngrok to apply this change.`
- no agent: note `No ngrok agent runs the tunnels from the config.`

- [ ] **Step 1: Write the failing tests** in `apply.test.js`. Build a fake `Io` that holds the file text and a list of calls, for example `["write"]`, `["stop", 4041, "api"]`, `["start", 4041, "api"]`. Options set the answers: `{ stale, checkError, startErrors: [..], live: [..] }`.

```js
test("port edit: write, check, stop, start", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] });
  assert.deepEqual(await applyEdit(io, { kind: "port", name: "api", port: 9100 }), { ok: true, error: null, note: null });
  assert.deepEqual(io.calls.map((c) => c[0]), ["read", "write", "check", "live", "stop", "start"]);
  assert.equal(io.startBodies[0].addr, "9100");
});
test("stale write: file stays", async () => { const io = fakeIo(FILE, { stale: true }); const r = await applyEdit(io, { kind: "port", name: "api", port: 1 }); assert.equal(r.error, "The file changed outside the panel. The panel read it again."); assert.equal(io.text, FILE); });
test("check fails: undo, secret hidden", async () => { const io = fakeIo(FILE, { checkError: "bad SECRET123" }); const r = await applyEdit(io, { kind: "port", name: "api", port: 1 }); assert.equal(io.text, FILE); assert.equal(r.error, "bad <secret>"); });
test("agent rejects: undo file and start old tunnel", async () => {
  const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)], startErrors: ["host not reserved", null] });
  const r = await applyEdit(io, { kind: "host", name: "api", host: "new.example.dev" });
  assert.equal(io.text, FILE); assert.equal(r.error, "host not reserved"); assert.equal(io.startBodies[1].hostname, "api.example.dev");
});
test("add rejected: undo", async () => { const io = fakeIo(FILE, { live: [live(4041, "api", "a", 1)], startErrors: ["no"] }); await applyEdit(io, { kind: "add", host: "w.example.dev", port: 1 }); assert.equal(io.text, FILE); });
test("nested tunnel: save only", async () => { const io = fakeIo(FILE, { live: [live(4041, "secure", "secure.example.dev", 9000)] }); const r = await applyEdit(io, { kind: "port", name: "secure", port: 9100 }); assert.equal(r.note, "Restart ngrok to apply this change."); assert.ok(!io.calls.some((c) => c[0] === "stop" || c[0] === "start")); });
test("no agent: save only", async () => { const io = fakeIo(FILE, {}); const r = await applyEdit(io, { kind: "on", name: "docs" }); assert.equal(r.note, "No ngrok agent runs the tunnels from the config."); assert.notEqual(io.text, FILE); });
test("off: stop only", async () => { const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8020)] }); await applyEdit(io, { kind: "off", name: "api" }); assert.deepEqual(io.calls.filter((c) => c[0] === "stop" || c[0] === "start").map((c) => c[0]), ["stop"]); });
test("sync: no write", async () => { const io = fakeIo(FILE, { live: [live(4041, "api", "api.example.dev", 8021)] }); await applyEdit(io, { kind: "sync", name: "api" }); assert.ok(!io.calls.some((c) => c[0] === "write")); });
test("duplicate host", async () => { const io = fakeIo(FILE, {}); assert.equal((await applyEdit(io, { kind: "add", host: "api.example.dev", port: 1 })).error, "Another tunnel uses this host."); assert.equal(io.text, FILE); });
```

- [ ] **Step 2: Run the tests and see them fail.** Expected: `Cannot find module` for `apply.js`.
- [ ] **Step 3: Implement `applyEdit`.** Read the live state after the check, not before. Catch an error from an edit function of Task 2 and give it as `error`.
- [ ] **Step 4: Run the tests and see them pass.** Expected: `fail 0`.
- [ ] **Step 5: Commit** `feat: apply one tunnel edit to the file and the agent`.

### Task 5: Real Io and the read-only overview in Herdr

**Files:**
- Create: `mods/ngrok/io.js`, `mods/ngrok/main.js`
- Modify: `~/.config/herdr-app/layouts/main-prs.json` (one new block, with `jq`)

**Interfaces:**
- Consumes: Tasks 1 to 4.
- Produces, in `io.js`:
  - `export async function configPath(): Promise<string>`. Take the path from the `ngrok config check` output `Valid configuration file at <path>`. Else use `join(home(), ".config/ngrok/ngrok.yml")`.
  - `export function makeIo(path: string): Io`. `read` uses `readTextFile`. `write` uses `writeTextFile(path, text, expected)`, then `exec("chmod", ["600", path])`. `check` runs `ngrok config check --config <path>`. `live` runs `curl -s -m 1` on each port of `API_PORTS` at the same time. `start` and `stop` run `curl` with `-X POST` (JSON body) or `-X DELETE`, and `-w "\n%{http_code}"`. A 2xx code gives `null`. A 404 on `stop` gives `null`. Else give `agentError(body)`. Each function gives a safe empty answer when `checking()` is true.
- Produces, in `main.js`: `export default class Tunnels extends View` with the overview: header `Tunnels` with `+` and `↻`, then one row for each `Row`: state dot, host, port (right aligned), and a state note (`off`, `down`, `live: <port>` for drift, `outside config`). Outside rows are dimmed. The row of the error or note of the last edit shows that text under the row. Use plain `v_flex` children, not a virtual list. Copy the narrow-sidebar check from `pg/panel.js`. Use `theme()` colors: `ansi2` for live, `dim` for off and outside, `ansi1` for down, `ansi3` for drift.
- Refresh: one `cx.spawn` loop that reads `io.live()` each 5 seconds, and one loop on `watchFolder(dirname(path))` that reads the file again. Start each loop body with `await cx.sleep(0)`.

- [ ] **Step 1: Implement `io.js` and `main.js`** (overview only; the edit controls come in Task 6).
- [ ] **Step 2: Check the mod loads**

Run: `cp -r mods/ngrok ~/.config/herdr-app/mods/ && herdr-app check ~/.config/herdr-app/mods/ngrok > "$SCRATCHPAD/check.log" 2>&1; echo "exit $?"; tail -5 "$SCRATCHPAD/check.log"`
Expected: `exit 0`.

- [ ] **Step 3: Add the layout block.** Add the block only if no block with the id `tunnels` exists. Keep the inode of the file:

```bash
L=~/.config/herdr-app/layouts/main-prs.json
jq '(.. | objects | select(.id == "sidebar-lists") | .children) |= (if any(.[]; .id == "tunnels") then . else . + [{"id":"tunnels","type":"block","content":{"mod":"ngrok"},"size":{"px":160},"min":90}] end)' "$L" > "$SCRATCHPAD/layout.json" && cat "$SCRATCHPAD/layout.json" > "$L"
jq -c '.. | objects | select(.id == "sidebar-lists") | [.children[].id]' "$L"
```
Expected: `["spaces","agents","databases","tunnels"]`.

- [ ] **Step 4: Check the real panel.** Run `herdr-app status` and `journalctl --user --since "-5 min" | grep -i ngrok`. Expected: no error. Run `herdr-app shot "$SCRATCHPAD/tunnels.png"` and look at the image. Expected: the four tunnels that run now, three `live` and one `outside config`.
- [ ] **Step 5: Commit** `feat: show the ngrok tunnels in the sidebar`.

### Task 6: Edit controls, README, and LICENSE

**Files:**
- Modify: `mods/ngrok/main.js`
- Create: `README.md`, `LICENSE` (MIT, copy the holder line from `herdr-postgres/LICENSE`)

**Interfaces:**
- Consumes: `applyEdit` (Task 4), `parsePort`, `parseHost` (Task 2), `makeIo` (Task 5).

- [ ] **Step 1: Add the controls to `main.js`.** Each control calls `applyEdit`, then reads the file and the live state again.
  - Click the port or the host: an `InputState` in place of the text. Enter applies, Esc cancels. Refuse bad input with `parsePort` or `parseHost`, and show `Type a port from 1 to 65535.` or `Type a host such as app.example.dev.` under the row.
  - Click the dot: `off` or `on`.
  - `+`: a new row with a host input and a port input. Enter in the port input applies `add`.
  - A `sync` button on `down` and `drift` rows.
  - A remove button (`✕`). The first click changes it to `remove?`. The second click applies `remove`. A click on another row resets it.
  - While an edit runs, the row is busy and takes no click.
  - Outside rows have no controls.
- [ ] **Step 2: Write `README.md`** in the style of `herdr-postgres/README.md`: what the panel shows, install (`cp -r`, the `jq` layout line), the off marker, the rule that tunnels with nested fields need a restart, and that the panel only talks to `127.0.0.1`.
- [ ] **Step 3: Check the mod loads.** Same command as Task 5 Step 2. Expected: `exit 0`.
- [ ] **Step 4: Test by hand on the real config.** The `poc` tunnel is the test tunnel. The user said on 2026-11-23 that the `ui` tunnel must not change. Before you start, copy `~/.config/ngrok/ngrok.yml` to `$SCRATCHPAD/ngrok.yml.before` and check its mode with `stat -c %a`.
  1. Set the port of `poc` from 9010 to 9011. Expected: the row shows `live` with 9011, `curl -s 127.0.0.1:4041/api/tunnels` shows `localhost:9011`, and `diff` with the copy shows only the `addr` line.
  2. Set it back to 9010. Expected: `diff` shows no change, and `stat -c %a` gives `600`.
  3. Switch `poc` off and on. Expected: `off`, then `live`, and no change in `diff` at the end.
  4. Check the journal. Expected: no error.
- [ ] **Step 5: Commit** `feat: edit the ngrok tunnels from the panel`.
