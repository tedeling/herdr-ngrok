# ngrok Panel Visual Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each tunnel as a flow (tunnel light, short name, arrow with request count, port, local light), grouped by domain.

**Architecture:** New pure functions in `state.js` parse the request counts and the list of listening ports, and give each row a `count` and a `local` value. `io.js` gets `listeners()`. `main.js` draws the groups and the rows.

**Tech Stack:** as in `2026-11-23-ngrok-panel.md`; plus `ss` (Linux) and `lsof` (macOS).

**Spec:** `docs/superpowers/specs/2026-11-23-ngrok-panel-visual-design.md` (and the first spec for all other rules).

## Global Constraints

- All Global Constraints of `2026-11-23-ngrok-panel.md` stay in force (no real host names in the repo, test output to a file, `checking()` guards, STE comments, no commits).
- Count: `metrics.http.count` when `public_url` starts with `http`, else `metrics.conns.count`. No metrics gives `null`.
- Local addresses: `localhost`, `127.0.0.1`, `::1`, `[::1]`, `0.0.0.0`. Any other `addr` host gets no local light.
- Local light port: the live port if the tunnel runs, else the file port.
- Tooltips (exact copy): `<program> (pid <pid>) listens on <port>`, `Nothing listens on <port>`, `A program listens on <port>, but the panel cannot see which one.`
- Block height in `main-prs.json`: 190 px.

## Review Focus

1. A tunnel whose `addr` points to another computer (`192.168.1.5:80`). It must get no local light. Test: Task 1, `local: other host`.
2. `ss` or `lsof` is missing or fails. The panel must show no local lights and no error. Test: Task 1, `local: unknown listeners`; Task 2 returns `null` on a failed `exec`.
3. A port that listens only on IPv6 (`[::1]:10005`) or on all addresses (`*:8080`, `0.0.0.0:8080`). It must count as listening. Test: Task 1, `parseSs` and `parseLsof`.
4. The agent restarts and its counts drop. The arrow must not turn blue. Test: Task 1, `rising`.
5. A host with one label or a random ngrok host (`abc.ngrok-free.app`). Grouping must not fail. Test: Task 1, `domainOf`.

---

### Task 1: Counts, listeners, local lights, and groups

**Files:**
- Modify: `mods/ngrok/state.js`
- Test: `mods/ngrok/state.test.js`

**Interfaces:**
- Produces, in `state.js`:
  - `LiveTunnel` gets `count: number | null` and `local: boolean` (the `addr` host is a local address).
  - `Listener = { program: string | null, pid: number | null }`
  - `export function parseSs(text: string): Map<number, Listener>` for `ss -ltnpH`.
  - `export function parseLsof(text: string): Map<number, Listener>` for `lsof -nP -iTCP -sTCP:LISTEN -F pcn`.
  - `mergeRows(tunnels, live, listeners: Map<number, Listener> | null = null)`. Each `Row` gets `count: number | null` and `local: { port: number, listening: boolean, program: string | null, pid: number | null } | null`.
  - `export function localTip(local): string` gives the tooltip copy.
  - `export function domainOf(host: string): string` and `export function shortName(host: string): string`.
  - `export function groupRows(rows: Row[]): { domain: string, rows: Row[] }[]`
  - `export function rising(previous: Map<string, number>, rows: Row[]): Set<string>` gives the keys whose count is higher than before.

- [ ] **Step 1: Write the failing tests** in `state.test.js`:

```js
const SS = [
  "LISTEN 0 511 127.0.0.1:10005 0.0.0.0:* users:((\"node-MainThread\",pid=4321,fd=24))",
  "LISTEN 0 511 [::1]:10006 [::]:* users:((\"node\",pid=7,fd=3))",
  "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*",
].join("\n");
const LSOF = "p4312\ncjava\nn*:8020\np99\ncnode\nn127.0.0.1:10005\n";

test("parseLive: request count", () => {
  const json = JSON.stringify({ tunnels: [
    { name: "a", public_url: "https://a.example.dev", config: { addr: "http://localhost:1" }, metrics: { http: { count: 36 }, conns: { count: 21 } } },
    { name: "t", public_url: "tcp://1.tcp.ngrok.io:2", config: { addr: "localhost:22" }, metrics: { http: { count: 0 }, conns: { count: 5 } } },
    { name: "n", public_url: "https://n.example.dev", config: { addr: "192.168.1.5:80" } }] });
  assert.deepEqual(parseLive(json, 4041).map((l) => [l.count, l.local]), [[36, true], [5, true], [null, false]]);
});
test("parseSs", () => assert.deepEqual([...parseSs(SS)], [[10005, { program: "node-MainThread", pid: 4321 }], [10006, { program: "node", pid: 7 }], [3000, { program: null, pid: null }]]));
test("parseLsof", () => assert.deepEqual([...parseLsof(LSOF)], [[8020, { program: "java", pid: 4312 }], [10005, { program: "node", pid: 99 }]]));
test("local: listening and not", () => {
  const rows = mergeRows(tunnels, [live(4041, "api", "api.example.dev", 8020)], new Map([[8020, { program: "java", pid: 1 }]]));
  assert.deepEqual(rows[0].local, { port: 8020, listening: true, program: "java", pid: 1 });
  assert.equal(rows[2].local.listening, false); // secure, port 9000
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
test("domainOf and shortName", () => {
  assert.deepEqual(["api.example.dev", "abc.ngrok-free.app", "localhost", ""].map((h) => [domainOf(h), shortName(h)]),
    [["example.dev", "api"], ["ngrok-free.app", "abc"], ["localhost", "localhost"], ["", ""]]);
});
test("groupRows: order of first row, outside joins its domain", () => {
  const rows = mergeRows(tunnels, [live(4040, "command_line", "c.other.dev", 3000), live(4040, "x", "z.example.dev", 1)]);
  assert.deepEqual(groupRows(rows).map((g) => [g.domain, g.rows.map((r) => r.key)]),
    [["example.dev", ["api", "docs", "secure", "outside:4040:x"]], ["other.dev", ["outside:4040:command_line"]]]);
});
test("rising", () => {
  const rows = [{ key: "a", count: 5 }, { key: "b", count: 2 }, { key: "c", count: null }];
  assert.deepEqual([...rising(new Map([["a", 4], ["b", 3]]), rows)], ["a"]);
});
```

- [ ] **Step 2: Run the tests and see them fail.** `node --test mods/ngrok/ > "$SCRATCHPAD/test.log" 2>&1; tail -8 "$SCRATCHPAD/test.log"`. Expected: the new tests fail with "is not a function" or a wrong value.
- [ ] **Step 3: Implement the functions in `state.js`.**
- [ ] **Step 4: Run the tests and see them pass.** Expected: `fail 0`.

### Task 2: The visual rows in Herdr

**Files:**
- Modify: `mods/ngrok/io.js`, `mods/ngrok/main.js`, `README.md`, `~/.config/herdr-app/layouts/main-prs.json` (`size.px` of block `tunnels` → 190, with `jq`)

**Interfaces:**
- Consumes: Task 1.
- Produces, in `io.js`: `listeners(): Promise<Map<number, Listener> | null>` on the object of `makeIo`. Use `platform()` from `os`: `darwin` runs `lsof -nP -iTCP -sTCP:LISTEN -F pcn` and `parseLsof`; else `ss -ltnpH` and `parseSs`. A failed `exec` or a non-zero code gives `null`. `checking()` gives `null`.

- [ ] **Step 1: Change `main.js`** to the design in the spec: read `io.live()` and `io.listeners()` together, keep the counts of the last refresh for `rising`, draw `groupRows` with a domain header, and draw each row as tunnel light, `shortName`, arrow (count, accent color when rising, dashed and no count when the tunnel does not run), port, local light with `localTip`, note. Show `sync` and `✕` only for the row in `on_hover`, or the row that asks `remove?`. A host edit puts the input in place of the name and the arrow.
- [ ] **Step 2: Change the block height** with `jq` to 190, and check: `jq -c '.. | objects | select(.id == "tunnels") | .size' <layout>` gives `{"px":190}`.
- [ ] **Step 3: Update the README sketch** to the new row form (this also fixes the deferred minor m).
- [ ] **Step 4: Install and check.** `cp mods/ngrok/*.js ~/.config/herdr-app/mods/ngrok/ && herdr-app check ~/.config/herdr-app/mods/ngrok > "$SCRATCHPAD/check.log" 2>&1; echo "exit $?"`. Expected: `exit 0`. Then `herdr-app status` has no errors, and the journal has no ngrok error.
- [ ] **Step 5: Look at the panel.** `herdr-app shot`, crop the sidebar block. Expected: group header, four or five rows with arrows and counts, a green local light on `dev`, red local lights on `api` and `site`.
