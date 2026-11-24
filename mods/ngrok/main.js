// The ngrok panel in the sidebar: one row for each tunnel, with its host, its port, and its state.
// A click on the host or the port edits it, a click on the dot switches the tunnel on or off.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, layout, readTextFile, settings, theme, watchFolder } from "herdr";
import { dirname } from "path";
import { applyEdit } from "./apply.js";
import { parseConfig } from "./config.js";
import { parseHost, parsePort } from "./edit.js";
import { controlsOf, groupRows, localTip, mergeRows, rising, shortName, showsNoTunnels } from "./state.js";
import { hubError, loadTarget } from "./hub.js";
import { configPath, makeIo } from "./io.js";

const POLL_MS = 5000;
const ROW_HEIGHT = 24;
const NAME_WIDTH = 50;
const PORT_WIDTH = 40;
const ADD_KEY = "add";
const PORT_HELP = "Type a port from 1 to 65535.";
const HOST_HELP = "Type a host such as app.example.dev.";
const LOCAL = { mode: "local" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar is a narrow rail below this width, and a host does not fit in the rail.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function noteOf(row) {
  switch (row.state) {
    case "off": return "off";
    case "down": return "down";
    case "outside": return "outside config";
    case "drift":
      if (row.livePort !== row.port) return `live: ${row.livePort ?? "?"}`;
      if (row.liveHost !== row.host) return `live: ${row.liveHost}`;
      return "off, still live";
    default: return "";
  }
}

export default class Tunnels extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    // Where the panel runs, from hub.json (see hub.js). The poll reads it again each time.
    this.target = null;
    this.io = null;
    this.path = null;
    // The watch of the folder of ngrok.yml. Only a local file has one.
    this.watch = null;
    this.tunnels = [];
    this.live = [];
    // The listening ports of the target computer, or null when the panel cannot read them.
    this.listeners = null;
    // The request count of each row at the last refresh, and the rows whose count went up since then.
    this.counts = new Map();
    this.hot = new Set();
    // The row under the pointer. Only that row shows its buttons, because the row has no room for them.
    this.hoverKey = null;
    this.rows = [];
    this.fileError = null;
    // An error of the last refresh. A refresh loop must not stop on one error.
    this.loadError = null;
    this.loading = true;
    // The error or note of the last edit, for each row key.
    this.messages = {};
    // The key of the row that an edit runs on. While it runs, the panel takes no other edit.
    this.busy = null;
    // { key, field: "port" | "host" } while an inline input shows.
    this.editing = null;
    this.adding = false;
    // The key of the row whose remove button asks "remove?".
    this.confirmRemove = null;

    this.editInput = InputState.new({});
    this.editInput.on("submit", (_e, cx) => this.submitEdit(cx));
    this.editInput.on("blur", (_e, cx) => {
      if (!this.editing) return;
      this.editing = null;
      cx.notify();
    });
    this.addHostInput = InputState.new({ placeholder: "host" });
    this.addHostInput.on("submit", () => this.addPortInput.focus());
    this.addPortInput = InputState.new({ placeholder: "port" });
    this.addPortInput.on("submit", (_e, cx) => this.submitAdd(cx));

    cx.spawn(async (cx) => {
      for (;;) {
        await this.safely(() => this.poll());
        cx.notify();
        await cx.sleep(POLL_MS);
      }
    });
    // watchFolder works only on this computer. On the hub, the poll reads the file.
    cx.spawn(async (cx) => {
      for (;;) {
        const io = this.io;
        if (!io || this.target?.mode !== "local") {
          await cx.sleep(POLL_MS);
          continue;
        }
        this.watch = watchFolder(dirname(this.path));
        await this.watch.catch(() => cx.sleep(POLL_MS));
        this.watch = null;
        if (io !== this.io) continue;
        await this.safely(() => this.readFile());
        cx.notify();
      }
    });
  }

  /** The message of a blocked target, or null. */
  blocked() {
    return this.target?.mode === "blocked" ? this.target.message : null;
  }

  /** Read hub.json, make a new io when the target changed, and read the state. */
  async poll() {
    const target = await loadTarget(readTextFile, appHome());
    if (JSON.stringify(target) !== JSON.stringify(this.target)) this.useTarget(target);
    const current = this.target;
    if (current.mode === "blocked") return;
    if (!this.io) {
      const path = await configPath(current);
      // A newer poll can change the target while this one waits.
      if (current !== this.target) return;
      if (!this.io) {
        this.path = path;
        this.io = makeIo(path, current);
      }
    }
    await this.reload();
  }

  /** Forget the state of the old target. */
  useTarget(target) {
    this.target = target;
    this.io = null;
    this.path = null;
    this.watch?.cancel();
    this.tunnels = [];
    this.live = [];
    this.listeners = null;
    this.counts = new Map();
    this.hot = new Set();
    this.rows = [];
    this.fileError = null;
    this.messages = {};
    this.editing = null;
    this.adding = false;
    this.confirmRemove = null;
  }

  async readFile() {
    const io = this.io;
    const parsed = parseConfig(await io.read());
    if (io !== this.io) return;
    this.tunnels = parsed.tunnels;
    this.fileError = parsed.error;
    this.rows = mergeRows(this.tunnels, this.live, this.listeners);
  }

  async readLive() {
    const io = this.io;
    const [live, listeners] = await Promise.all([io.live(), io.listeners()]);
    if (io !== this.io) return;
    [this.live, this.listeners] = [live, listeners];
    const rows = mergeRows(this.tunnels, this.live, this.listeners);
    this.hot = rising(this.counts, rows);
    this.counts = new Map(rows.filter((r) => r.count !== null).map((r) => [r.key, r.count]));
    this.rows = rows;
  }

  async safely(load) {
    try {
      await load();
      this.loadError = null;
    } catch (e) {
      // On the hub, a failed command means that the hub does not answer.
      this.loadError = hubError(this.target ?? LOCAL, String(e?.message ?? e));
    }
    this.loading = false;
  }

  async reload() {
    await Promise.all([this.readFile(), this.readLive()]);
    this.rows = mergeRows(this.tunnels, this.live, this.listeners);
    this.loading = false;
  }

  refresh(cx) {
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.safely(() => this.poll());
      cx.notify();
    });
  }

  /** Run one edit through applyEdit, show its error or note on the row, and read the state again. */
  run(key, edit, cx, after = () => {}) {
    if (this.busy || !this.io) return;
    this.busy = key;
    this.confirmRemove = null;
    delete this.messages[key];
    cx.notify();
    cx.spawn(async (cx) => {
      let outcome;
      try {
        outcome = await applyEdit(this.io, edit);
      } catch (e) {
        outcome = { ok: false, error: hubError(this.target ?? LOCAL, String(e?.message ?? e)), note: null };
      }
      const text = outcome.error ?? outcome.note;
      if (text) this.messages[key] = { tone: outcome.error ? "error" : "note", text };
      if (outcome.ok) after();
      this.busy = null;
      await this.safely(() => this.poll());
      cx.notify();
    });
  }

  startEdit(row, field, cx) {
    if (this.busy) return;
    this.confirmRemove = null;
    this.editing = { key: row.key, field };
    this.editInput.set_value(field === "port" ? String(row.port ?? "") : row.host);
    this.editInput.focus();
    cx.notify();
  }

  submitEdit(cx) {
    const editing = this.editing;
    if (!editing) return;
    const text = this.editInput.value();
    const value = editing.field === "port" ? parsePort(text) : parseHost(text);
    if (value === null) {
      this.messages[editing.key] = { tone: "error", text: editing.field === "port" ? PORT_HELP : HOST_HELP };
      cx.notify();
      return;
    }
    this.editing = null;
    this.handle.focus();
    const edit = editing.field === "port"
      ? { kind: "port", name: editing.key, port: value }
      : { kind: "host", name: editing.key, host: value };
    this.run(editing.key, edit, cx);
  }

  startAdd(cx) {
    if (this.busy) return;
    this.adding = !this.adding;
    this.confirmRemove = null;
    delete this.messages[ADD_KEY];
    this.addHostInput.set_value("");
    this.addPortInput.set_value("");
    if (this.adding) this.addHostInput.focus();
    cx.notify();
  }

  submitAdd(cx) {
    const host = parseHost(this.addHostInput.value());
    const port = parsePort(this.addPortInput.value());
    if (host === null || port === null) {
      this.messages[ADD_KEY] = { tone: "error", text: host === null ? HOST_HELP : PORT_HELP };
      cx.notify();
      return;
    }
    this.run(ADD_KEY, { kind: "add", host, port }, cx, () => {
      this.adding = false;
    });
  }

  // The dot is the on/off switch of the file, also on a row that is off in the file but still live.
  toggle(row, cx) {
    this.run(row.key, { kind: row.off ? "on" : "off", name: row.name }, cx);
  }

  remove(row, cx) {
    if (this.busy) return;
    if (this.confirmRemove !== row.key) {
      this.confirmRemove = row.key;
      cx.notify();
      return;
    }
    this.run(row.key, { kind: "remove", name: row.name }, cx);
  }

  onKey(e, cx) {
    if (e.key !== "escape") return;
    if (this.editing) this.editing = null;
    else if (this.adding) this.adding = false;
    else if (this.confirmRemove) this.confirmRemove = null;
    else return;
    this.handle.focus();
    cx.stop_propagation();
    cx.notify();
  }

  inputBox(id, state, t) {
    return div().id(id).h(ROW_HEIGHT - 2).px(6).flex().items_center().rounded(5).border_1().border_color(t.accent).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  button(id, label, tooltip, t, onClick) {
    return div().id(id).flex_none().px(4).h(18).flex().items_center().rounded(4).text_size(10.5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tooltip)
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  message(key, t) {
    const message = this.messages[key];
    if (!message) return null;
    return div().flex_none().pl(24).pr(8).pb(4).text_size(11).text_color(message.tone === "error" ? t.ansi1 : t.dim).child(message.text);
  }

  // One row: tunnel light, short name, arrow with the request count, port, local light, note.
  row(row, t) {
    const colors = { live: t.ansi2, off: t.dim, down: t.ansi1, drift: t.ansi3, outside: t.dim };
    const mono = settings().font_family ?? "JetBrains Mono";
    const note = noteOf(row);
    const editable = row.state !== "outside" && !this.busy;
    const busy = this.busy === row.key;
    const editingField = this.editing?.key === row.key ? this.editing.field : null;
    const controls = controlsOf(row, { hovered: this.hoverKey === row.key, confirming: this.confirmRemove === row.key, busy: Boolean(this.busy) });
    const clickable = (e) => e.cursor_pointer().hover((s) => s.text_color(t.accent));
    const message = this.message(row.key, t);

    const dot = div().id(`dot-${row.key}`).flex_none().w(12).text_size(10).text_color(colors[row.state])
      .child(busy ? "…" : row.off ? "○" : "●");
    const name = div().id(`host-${row.key}`).w(NAME_WIDTH).flex_none().truncate().tooltip(row.host)
      .child(shortName(row.host) || row.name || "?");

    // The arrow is solid with the request count while an agent runs the tunnel, else dashed.
    const runs = row.livePort !== null;
    const hot = this.hot.has(row.key);
    const lineColor = hot ? t.accent : t.dim;
    // A border on an element with no height does not draw, so the line is a filled bar of 1 px.
    const line = () => runs
      ? div().flex_1().min_w(3).h(1).bg(lineColor)
      : h_flex().flex_1().min_w(3).gap(2).overflow_hidden().children(Array.from({ length: 24 }, () => div().w(3).h(1).flex_none().bg(lineColor)));
    const showCount = runs && row.count !== null;
    const arrow = h_flex().id(`arrow-${row.key}`).flex_1().min_w(18).overflow_hidden().items_center().text_color(lineColor)
      .tooltip(!runs ? "No agent runs this tunnel" : hot ? `${row.count} requests, new ones since the last refresh` : `${row.count ?? 0} requests`)
      .child(line())
      .when(showCount, (e) => e.child(div().flex_none().px(3).font_family(mono).text_size(9.5).child(String(row.count))).child(line()))
      .child(div().flex_none().text_size(8).child("▶"));

    const port = div().id(`port-${row.key}`).w(PORT_WIDTH).flex_none().flex().justify_end().font_family(mono).text_size(11.5)
      .child(String(row.port ?? ""));
    const local = row.local
      ? div().id(`local-${row.key}`).flex_none().w(10).text_size(10).text_color(row.local.listening ? t.ansi2 : t.ansi1)
        .tooltip(localTip(row.local)).child(row.local.listening ? "●" : "○")
      : div().flex_none().w(10);

    return v_flex().id(`tunnel-${row.key}`).flex_none()
      .child(h_flex().id(`row-${row.key}`).h(ROW_HEIGHT).flex_none().px(8).gap(5).items_center().rounded(6).text_size(12)
        .hover((s) => s.bg(t.hover))
        .on_hover((hovered, cx) => {
          if (hovered) this.hoverKey = row.key;
          else if (this.hoverKey === row.key) this.hoverKey = null;
          cx.notify();
        })
        .when(row.state === "outside", (e) => e.text_color(t.dim))
        .child(editable ? clickable(dot).tooltip(row.off ? "Switch on" : "Switch off").on_click((_e, cx) => this.toggle(row, cx)) : dot)
        .when(editingField === "host", (e) => e.child(div().flex_1().min_w(0).child(this.inputBox("edit-host", this.editInput, t))))
        .when(editingField !== "host", (e) => e
          .child(editable ? clickable(name).on_click((_e, cx) => this.startEdit(row, "host", cx)) : name)
          .child(arrow))
        .child(editingField === "port" ? div().w(64).flex_none().child(this.inputBox("edit-port", this.editInput, t))
          : editable ? clickable(port).on_click((_e, cx) => this.startEdit(row, "port", cx)) : port)
        .child(local)
        // A long note (live: <host>) shrinks, and its tooltip shows the full text.
        .when(controls.note && note !== "", (e) =>
          e.child(div().id(`note-${row.key}`).min_w(0).truncate().text_size(10).text_color(colors[row.state]).tooltip(note).child(note)))
        .when(controls.sync, (e) =>
          e.child(this.button(`sync-${row.key}`, "sync", `Apply the file to ngrok (${note})`, t, (cx) => this.run(row.key, { kind: "sync", name: row.name }, cx))))
        .when(controls.remove !== null, (e) => e.child(this.button(`remove-${row.key}`, controls.remove, "Remove the tunnel", t, (cx) => this.remove(row, cx)))))
      .when(Boolean(message), (e) => e.child(message));
  }

  groupHeader(domain, t) {
    return div().id(`group-${domain}`).h(18).flex_none().px(8).pt(2).text_size(10.5).text_color(t.dim).child(domain || "no host");
  }

  addRow(t) {
    const message = this.message(ADD_KEY, t);
    return v_flex().id("tunnel-add").flex_none()
      .child(h_flex().h(ROW_HEIGHT + 4).flex_none().px(8).gap(6).items_center()
        .child(div().flex_none().w(12).text_size(10).text_color(t.dim).child(this.busy === ADD_KEY ? "…" : "+"))
        .child(div().flex_1().min_w(0).child(this.inputBox("add-host", this.addHostInput, t)))
        .child(div().w(64).flex_none().child(this.inputBox("add-port", this.addPortInput, t))))
      .when(Boolean(message), (e) => e.child(message));
  }

  render() {
    const t = theme();
    if (narrow()) return div().size_full().bg(t.chrome).border_t(1).border_color(t.border);
    const blocked = this.blocked();
    const icon = svg("mods/ngrok/refresh.svg").size(12).flex_none().text_color(t.dim);
    const headerButton = (id, tooltip, onClick, child) => div().id(id).w(20).h(20).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tooltip)
      .on_click((_e, cx) => onClick(cx))
      .child(child);
    return v_flex().id("ngrok").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().h(41).pt(14).pb(5).flex_none().pl(16).pr(10).items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Tunnels"))
        .child(h_flex().gap(2).items_center()
          .when(!this.fileError && !blocked, (e) => e.child(headerButton("ngrok-add", "Add a tunnel", (cx) => this.startAdd(cx),
            div().text_size(14).text_color(t.dim).child("+"))))
          .child(headerButton("ngrok-refresh", "Load again", (cx) => this.refresh(cx), this.loading ? icon.spin(900) : icon))))
      .when(Boolean(blocked), (e) => e.child(div().flex_none().px(16).py(4).text_size(11).text_color(t.dim).child(blocked)))
      .when(Boolean(this.fileError || this.loadError), (e) =>
        e.child(div().flex_none().px(16).py(4).text_size(11).text_color(t.ansi1).child(this.fileError ?? this.loadError)))
      .when(showsNoTunnels({ loading: this.loading, blocked, fileError: this.fileError, loadError: this.loadError, rows: this.rows, adding: this.adding }), (e) =>
        e.child(div().flex_none().px(16).py(4).text_size(11).text_color(t.dim).child("No tunnels in the config.")))
      .child(v_flex().id("ngrok-list").flex_1().min_h(0).px(8).overflow_y_scrollbar()
        .children(groupRows(this.rows).flatMap((group) => [this.groupHeader(group.domain, t), ...group.rows.map((row) => this.row(row, t))]))
        .when(this.adding, (e) => e.child(this.addRow(t))));
  }
}
