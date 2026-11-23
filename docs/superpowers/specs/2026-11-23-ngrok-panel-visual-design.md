# ngrok panel, visual overview: short design

Date: 2026-11-23. Status: approved by the user on 2026-11-23. Builds on `2026-11-23-ngrok-panel-design.md`.

## Intent

The user wants to see the tunnels at a glance, not read them. Each row must show the path from the
public host to the local port, if a local program listens on that port, and if the tunnel gets
traffic now.

## Goals

- Show each tunnel as a flow: tunnel light, short name, arrow, port, local light.
- Show if a program listens on the local port, and name the program in a tooltip.
- Show the request count of each tunnel on its arrow, and mark the arrow when requests came in since
  the last refresh.

## Non-goals

- An HTTP request to the local port. The panel must not fill the logs of a dev server.
- A traffic graph over time.
- Other changes to how edits apply.

## Approaches

Layout. The user saw three mockups with real data and picked **C, two lights**: a light for the
tunnel on the left and a light for the local server on the right. They did not pick A (the port as
a socket chip with the program name) or B (a line from the port to the program).

Local check. **One listing of the listening ports on each refresh (my call):** `ss -ltnpH` on Linux,
and `lsof -nP -iTCP -sTCP:LISTEN` on macOS. One cheap call gives all ports and their programs. A TCP
connection to each port cannot name the program, and some dev servers log each connection. An HTTP
request to each port fills the dev server logs.

## Design

```
Tunnels                        +  ↻
example.dev
 ● api     ── 206 ──▶   8020  ○
 ● dev     ── 79 ───▶  10005  ●      (blue arrow: requests since the last refresh)
 ● site    ── 3 ────▶   9010  ○
 ○ bend    ┄┄┄┄┄┄┄┄▶  10010         off
 · collab  ── 74 ───▶   3000  ●      outside config
```

- **Groups.** A small header names the domain: the host without its first label. Rows keep the file
  order inside a group. A group comes in the order of its first row. Outside rows join the group of
  their domain, dimmed.
- **Tunnel light.** The color follows the state: live green, down red, drift yellow, outside gray.
  The light is `○` when the tunnel is off in the file, and stays the on/off switch.
- **Name.** The first label of the host. The tooltip shows the full host. A click edits the full host.
- **Arrow.** A solid line with the request count (`metrics.http.count`, or `metrics.conns.count`
  for a tunnel that is not HTTP). The line is dashed, with no count, when no agent runs the tunnel.
  The arrow takes the accent color when the count went up since the last refresh.
- **Port.** Unchanged: mono, right aligned, a click edits it. A drift note stays (`live: 9011`).
- **Local light.** Green `●` when a program listens on the port. Red `○` when nothing listens. No
  light when the tunnel is off, or when its `addr` is not on this computer. Tooltip:
  `node (pid 4321) listens on 10005`, `Nothing listens on 9010`, or
  `A program listens on 3000, but the panel cannot see which one.` (a process of another user).
  If the listing command fails, the panel shows no local lights and no error.
- **Buttons.** `sync` and `✕` show only on the row under the pointer (`on_hover`), and on the row
  that asks `remove?`. (My call: the row has no room for them at all times.)
- **Block height.** 160 px → 190 px in `main-prs.json`, so five rows and the group header fit. (My call.)

## Left to the builder

- The exact parsers for the `ss` and `lsof` output, with tests.
- Colors from `theme()`, and the drawing of the arrow line.
