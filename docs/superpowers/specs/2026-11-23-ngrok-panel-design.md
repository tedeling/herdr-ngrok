# ngrok panel for Herdr: design

Date: 2026-11-23. Status: approved by the user on 2026-11-23.

## Intent

The user runs ngrok tunnels for development. Each tunnel forwards a public host to a local port.
Today the user reads `ngrok.yml` and the agent output to know which host goes to which port. To
change a tunnel, the user swaps whole copies of the file (`ngrok.yml.all`, `ngrok.yml.bend`).

The panel gives an overview of host to port in the Herdr sidebar at all times. It also gives a quick
way to change one tunnel. The user does not need named sets that switch many tunnels at once.

## Goals

- Show each tunnel as one row: host, port, and state.
- Change one tunnel with a few clicks: the port, the host, on or off, add, and remove.
- Apply each change to the running agent at once, for that one tunnel only.
- Save each change in `ngrok.yml`, so that the next `ngrok start --all` gives the same result.

## Non-goals

- Named sets of tunnels that switch together.
- Start, stop, or restart the ngrok agent process.
- The ngrok cloud account: reserved domains, the cloud API, or the ngrok MCP server.
- The config format `version: 3` (`endpoints:`). The panel shows a message for this format.
- Edits to tunnels that do not come from the config. The panel shows them read-only.
- Edits to other tunnel fields (proto `tcp`, auth, and so on). The panel keeps these fields as they are.
- Traffic inspection or a request log.

## Anti-goals

The panel fails, even if the edit works, when one of these occurs:

- A line of `ngrok.yml` outside the edited tunnel changes. This includes the `authtoken`, the
  comments, the key order, and the indent.
- The `authtoken` shows on screen, in a log, or in an error message.
- An edit stops a tunnel other than the edited one, or stops the agent.
- `ngrok.yml` loses the file mode 600.

## Facts about the current system

- ngrok 3.39.13. The command `ngrok config check` prints the config path. On this computer, it is
  `~/.config/ngrok/ngrok.yml`.
- The file has `version: "2"`, `authtoken`, `region`, and a `tunnels:` map with a 4-space indent.
  Each tunnel has `addr` (a port number), `proto: http`, `hostname`, and `host_header`. The
  `host_header` is the same as the `hostname` in all tunnels.
- Two agents run now. One runs `ngrok start --all` in a terminal. It has its local API on
  `127.0.0.1:4041` and runs the three config tunnels. The other runs
  `ngrok http 3000 --url https://<host>` under systemd. It has its local API on `127.0.0.1:4040`,
  and its tunnel has the name `command_line`. Each agent takes the first free port from 4040 up.
- The agent API: `GET /api/tunnels` lists `name`, `public_url`, and `config.addr` for each tunnel.
  `POST /api/tunnels` starts a tunnel. Its body takes the same fields as a tunnel entry in the
  config. `DELETE /api/tunnels/<name>` stops one tunnel.
- ngrok rejects unknown keys in the config. A test with a tunnel field `enabled`, and with a
  top-level key `x_disabled`, failed `ngrok config check`. The tunnel field `metadata` passes.
- The Herdr mod API (herdr-app 0.1.13 when the PR and Postgres mods were made) has `exec`,
  `readTextFile`, `writeTextFile(path, text, expected)`, `watchFolder`, and `checking()`.
  `writeTextFile` replaces a file atomically, and it rejects the write if the file changed since
  the read. During `herdr-app check`, `exec` and `writeTextFile` also run, so side effects must
  check `checking()` first.

## Approaches

**A. Live apply and save (picked).** The panel writes the change to `ngrok.yml`. Then it tells
the running agent, through the local API, to stop and start only the edited tunnel. The other
tunnels stay up, and the agent stays in the user's terminal. The risk is drift: the agent can run
a different config than the file. The panel shows the live state next to the file state, so the
user sees each difference.

**B. Save and restart.** The panel writes `ngrok.yml` and restarts `ngrok start --all`. The file is
then the only source of truth. But the panel must own the agent process, so the agent leaves the
user's terminal. Each edit also stops all tunnels for a few seconds.

**C. The panel owns the agent (dropped).** The panel starts its own agent and controls all tunnels
through the API. This ties the tunnels to Herdr, and the agent log leaves the terminal.

The user picked A, because one quick edit then touches only one host.

## Design

### Place in Herdr

The mod has the folder name `ngrok` and one view. Its `mod.json` has `"place": "none"`. The
layout `~/.config/herdr-app/layouts/main-prs.json` gets one new block in the column
`sidebar-lists`, below the block `databases`. (My call.) Other sessions also own blocks in this
file, so the builder must add the block with `jq` and must not change the other blocks.

Text sketch of the panel (268 px wide):

```
TUNNELS                       +  ↻
● api.example.dev          8020
● dev.example.dev         10005
○ bend.example.dev        10010  off
▲ site.example.dev         9010  live: 9011
✕ docs.example.dev         7000  down
· collab.example.dev       3000  outside config
```

### Row states

| State | Meaning |
|---|---|
| live | The tunnel is in the file, it is on, and an agent runs it with the same host and port. |
| off | The tunnel block is commented out in the file. |
| down | The tunnel is in the file and on, but no agent runs it. |
| drift | An agent runs the tunnel with a different host or port than the file. The row shows both values. |
| outside config | An agent runs the tunnel, but the file does not have it. The row is read-only and dimmed. |
| off but live | The tunnel is off in the file, but an agent still runs it, for example after a failed `DELETE`. The panel shows it as `drift`. |

To compare a port, the panel must normalize `addr`. The file can hold `8020`, `localhost:8020`, or
`http://localhost:8020`. The API gives `http://localhost:8020`.

### Edit actions

- Click the port: an inline input opens. Enter saves. Esc cancels.
- Click the host: the same inline input, for the host.
- Click the state dot: switch the tunnel on or off.
- Click `+` in the header: a new row with a host input and a port input.
- Remove: a remove button on the row. The first click changes the button to "remove?". The second
  click removes the tunnel. (My call.)
- Click `↻`: read the file and the agents again.
- A row in the state `down` or `drift` shows a "sync" button. The button applies the file state of
  that tunnel to the agent, and it does not write the file. The state dot stays the on/off switch.
  (My call, from the review.)

A host edit changes `hostname`. It also changes `host_header` when `host_header` is the same as the
old `hostname`. The tunnel keeps its name. (My call.)

A new tunnel gets these fields: the name is the first DNS label of the host, with a number added if
the name exists. `proto: http`, `addr: <port>`, `hostname: <host>`, `host_header: <host>`. These
fields match all the tunnels in the current file. (My call.) The panel adds the block at the end of
`tunnels:`, with the indent that the file uses.

### Off state

ngrok rejects an unknown key, so the panel cannot store "off" as a field. To switch a tunnel off,
the panel comments out each line of the tunnel block with a fixed marker, and keeps the indent.
`ngrok start --all` then skips the tunnel. To switch it on, the panel removes the marker. The parser
must read a block with the marker as an off tunnel. A normal comment of the user must not read as an
off tunnel, so the marker must be unique. The exact marker is the builder's call.

### Steps for one edit

1. Read the file text.
2. Make the new text with a line edit of only the lines of the edited tunnel.
3. Write the new text with `writeTextFile(path, newText, oldText)`. If the write fails because the
   file changed, read the file again and tell the user.
4. Run `ngrok config check --config <path>`. If the check fails, write the old text back and show
   the error.
5. Apply the change to the agent:
   - port or host edit: `DELETE` the tunnel, then `POST` the new definition.
   - off: `DELETE` only.
   - on or add: `POST` only.
   - remove: `DELETE` only.
6. Read the live state again and show the row state.

If the agent rejects the change in step 5, the panel undoes the change. (My call, from the review.)
A rejected host can stop the next `ngrok start --all`, so the file must not keep it.

1. Write the old text back to the file.
2. If the panel sent a `DELETE` before the failed `POST`, `POST` the old definition again.
3. Show the error from the agent on the row.

If no agent runs config tunnels, there is no agent to reject the change. The file then keeps the
change, and the row shows `down`.

To choose the agent: use the agent that runs a tunnel with the same name. For a new tunnel, or for a
tunnel that is down, use the agent that runs the most config tunnels. If no agent runs a config
tunnel, the panel only saves the file, and the row shows `down`.

### Refresh

- Watch the config folder with `watchFolder`, so that a change from outside the panel shows.
- While the panel shows, poll the agent APIs on ports 4040 to 4049 each 5 seconds. (My call.)

### File safety

- `writeTextFile` replaces the file. After each write, the builder must check the file mode, and
  run `chmod 600` if the mode changed.
- The panel reads the whole file, but it must only show, log, or put in an error message the lines
  of the `tunnels:` map.
- Before each `exec` or `writeTextFile`, check `checking()`.

### Repository

The source goes in `~/src/herdr/herdr-ngrok`, with the same structure as `herdr-postgres`:
`mods/ngrok/`, `README.md`, and `LICENSE`. The installed copy in `~/.config/herdr-app/mods/ngrok/`
is a plain copy of `mods/ngrok/`. The repository must not hold the user's real host names, also not
in tests or in a preview image. Tests use `example.dev`. The repository goes public only when the
user asks.

The logic goes in `logic.js`, with tests in `logic.test.js` that run with `node --test`: the
parser, the line edits, the off marker, and the merge of file state and live state. The view goes in
`main.js`.

## Left to the builder

- The parser and the line edits for the `tunnels:` map.
- The exact form of the off marker.
- The exact fields of the `POST` body. The agent runs a `version: "2"` config, so the builder must
  find out if the API takes `hostname`, `domain`, or `url`. A test `POST` registers a real host on
  the ngrok account. The user approved on 2026-11-23 one short test with the `bend` host from the
  `.bend` variant of the config (port 10010), because it does not run now. The test must `DELETE`
  the tunnel after a few seconds. If the account does not have that host, stop and ask the user.
- Colors, icons, sizes, and the height of the block.
- The way to find the agent API ports: a scan of 4040 to 4049, or another way.
