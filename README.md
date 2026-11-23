# ngrok Tunnels, a Herdr mod

A sidebar panel for the [Herdr](https://herdr.dev) app. It shows which public host of each ngrok
tunnel goes to which local port, and it lets you change one tunnel with a few clicks. Each change
goes to the running ngrok agent at once, for that tunnel only, and into `ngrok.yml`.

```
Tunnels                        +  ↻
example.dev
 ● api     ── 206 ──▶   8020  ○
 ● app     ── 79 ───▶  10005  ●
 ● site    ┄┄┄┄┄┄┄┄▶   9010  ○  down
 ○ docs    ┄┄┄┄┄┄┄┄▶   7000     off
 ● demo    ── 74 ───▶   3000  ●  outside config
```

Each row is one tunnel, grouped by domain:

- The left light is the tunnel: green live, red down, yellow drift, gray outside the config. It is
  `○` when the tunnel is off in the file, and a click switches it on or off.
- The arrow carries the number of requests. It turns blue when requests came in since the last
  refresh (each 5 seconds). It is dashed when no agent runs the tunnel.
- The right light is the local server: green when a program listens on the port, red when nothing
  listens. Its tooltip names the program. The panel reads the listening ports with `ss` (Linux) or
  `lsof` (macOS), and sends nothing to your dev servers.

## Install

You need `ngrok` (version 3, with a config of `version: "2"`) and `curl`.

```
git clone <this repository>
cp -r herdr-ngrok/mods/ngrok ~/.config/herdr-app/mods/
```

Herdr does not dock a mod in a shipped layout. Clone a layout with `layout.clone`, then add the
block to its `sidebar-lists` column. For a layout `my-layout`:

```
L=~/.config/herdr-app/layouts/my-layout.json
jq '(.. | objects | select(.id == "sidebar-lists") | .children) += [{"id":"tunnels","type":"block","content":{"mod":"ngrok"},"size":{"px":190},"min":90}]' "$L" > /tmp/layout.json && cat /tmp/layout.json > "$L"
```

## Use

- Click the port or the host to edit it. Enter applies, Esc cancels.
- Click the dot to switch a tunnel off or on.
- Click `+` to add a tunnel. Type the host, press Enter, type the port, and press Enter.
- Click `✕`, then `remove?`, to remove a tunnel. The buttons show on the row under the pointer.
- Click `sync` on a `down` or `drift` row to apply the file to the agent again.

| State | Meaning |
|---|---|
| live | The agent runs the tunnel as the file has it. |
| off | The tunnel is off in the file. |
| down | The tunnel is on in the file, but no agent runs it. |
| drift | The agent runs the tunnel with a different host or port than the file. |
| outside config | An agent runs a tunnel that is not in the file, for example from `ngrok http`. You cannot edit it here. |

## How a change works

1. The panel changes only the lines of the one tunnel in `ngrok.yml`, and keeps all other lines,
   the comments, and the file mode 600.
2. It runs `ngrok config check`. If the check fails, it undoes the change.
3. It tells the agent through its local API (`127.0.0.1:4040` to `4049`) to stop and start that
   one tunnel. A new host goes through a short test tunnel first, so that a host that your account
   does not own never stops a working tunnel. If the agent rejects the change, the panel undoes it
   in the file too.

ngrok refuses unknown keys in its config. So the panel switches a tunnel off with the comment
marker `#herdr-off#` in front of each line of the tunnel. `ngrok start --all` skips such a tunnel.

A tunnel with a nested field, such as `basic_auth`, gets no live change. The API cannot take the
nested field, so a restart through the API could drop it. The panel saves the file and asks you to
restart ngrok.

The panel never shows your `authtoken`, and it talks only to `127.0.0.1`.

## Tests

`node --test mods/ngrok/`

## License

[MIT](LICENSE).
