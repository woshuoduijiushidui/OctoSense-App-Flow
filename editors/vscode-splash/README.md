# Splash Check

Static semantic analysis for **Splash apps** (`.splash`), in your editor.

The analysis is the OctoSense framework's own checker — `splashcheck`, from
`makepad-widgets` — running as a Language Server. It also contributes the `splash` language: comments, strings with their
escapes, numbers, hex colours, keywords, widget and type names, properties,
function calls, enum values and operators. It is not a reimplementation
and it does not drift: the binary and the framework it checks are one revision.

## What it does

* **Diagnostics as you type** — the analysis runs on open, on change
  (debounced, `splashCheck.debounceMs`) and on save. A finding carries its own
  line and column and the VM's `Did you mean` list, and the lightbulb offers to
  apply it.
* **Go-to-definition and the outline** — F12 on a `let`, an `fn` or a `:=`
  binding jumps to its declaration; the outline view lists them. Textual, over
  the DSL's three binding forms: the VM holds the real scopes but exposes no
  "where is this name declared" query.
* **Completion as you type** — a widget name where a constructor goes, the
  properties a widget accepts inside its braces, the values a property
  accepts, and the members of `sys.` / `host.` / `mod.` after a `.`. Every
  name is read out of the registry the app itself runs against, so a
  suggestion cannot be a name that does not exist, and each item says which
  registry path it came from. It works on an unsaved buffer, because the
  buffer is what you are typing.

## What it completes, and from where

The names come from a live isolate — the same VM, the same widget families,
the same `sys` / `host` / `fs` an app's body runs in — read through the VM's
query API. Nothing is a hand-written list, and nothing is generated ahead of
time, so the list cannot drift from the framework the plugin checks.

* **At a constructor name** — the widget families. Not every name in the
  widget table is a family: the modules register enums (`Flow`, `Align`) and
  api objects beside them, and a family is the one the VM has a property
  table for. A family with no property at all is not offered, because the
  registry exposes no other marker to tell it from an enum.
* **Inside a widget's braces** — the properties that widget accepts, its own
  and the ones it inherits. They live in the type's property table, not on
  the object: a widget's registration block sets only the fields it changes,
  so the object answers a handful of names where the type answers the whole
  set an app may write.
* **After `name:`** — the values that property accepts. An enum's variants
  are the enum object's keys, so `width:` offers `Fill`, `Fit`, `Fixed`.
* **After `.`** — the names the receiver holds: a module's members
  (`sys.weather`), a type's variants (`Size.Fill`), or a property's own type
  (`draw_bg.`).

Inside a widget's braces an item can be a property or a child widget, and the
DSL does not say which until the `{` arrives, so both are offered and each
says where it came from.

Stated boundaries, rather than discovered: a draw field is registered as its
shader, so a `draw_bg +: {}` block offers the shader's own fields — a `+:`
merge accepts keys no table declares (`color` works and is in no table), so
that list is a subset. And a name that only exists at runtime — a local's
object, a value the body computed — is not in the registry and is not
suggested, which is the failure mode the whole design exists to avoid.

## What it finds

* **Evaluation errors**, at the app's own line and column: a name nothing
  declares, a widget or property that does not exist, a type mismatch. Each
  carries the VM's `Did you mean: …` list, and the lightbulb offers to apply it.
* **Host-contract errors**: `host.request("news.list")` when the manifest
  declares no `news` capability; a network use the manifest does not declare.
* **What it could not check**, in the output channel — a computed service name
  cannot be read statically, and saying so is better than silence.

Known boundaries, stated rather than discovered: only top-level code is
evaluated (a `fn` nothing calls at the top level is compiled but never run, and
a `host.request` callback never runs because nothing answers it), and the
widget set is whatever the binary was built with — build it with the features
of the host you are writing for (`--features maps` for the OctoSense shells).

## Installing the server

The extension is only a client; the analysis lives in the `splash-lsp` binary.
A fresh install needs nothing built: on first use the extension downloads the
binary its manifest pins for your platform and starts it. The version is
pinned in the manifest (`splashCheck.serverVersion`), so the plugin and the
server do not drift apart, and the output channel names that version beside the
makepad revision the binary was built from.

If you have a local build, it wins — a download never shadows a statement of
intent. In order:

1. **Setting**: `splashCheck.serverPath` — an absolute path to the binary.
2. **Environment**: `$SPLASH_LSP`.
3. **PATH**: `splash-lsp` (or `splash-lsp.exe`).
4. **Workspace layout**: a `makepad/` or `Octoscript-Makepad/` checkout beside
   the workspace, with `target/release/splash-lsp` in it — the same places
   `octo` looks for the tools it wraps.
5. **Download**: the pinned release asset for your platform.

To build the server yourself instead:

```sh
cargo build --release -p makepad-widgets --bin splash-lsp --features maps
```

## When the server cannot be fetched

A platform with no published build, or a download that fails, is one notice,
one output-channel line with the cause and the build path above, and then the
extension carries on in degraded mode: highlighting, and whatever else
survives without a server. It never throws, and it never fails silently — the
notice says which of the two happened.

## Building the extension

```sh
npm install
npm run compile     # or: npm run watch
npm test            # the resolver's priority chain, in node
npm run package     # produces splash-check-<version>.vsix
```

`code --install-extension splash-check-0.1.0.vsix` installs it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `splashCheck.serverPath` | `""` | The binary. Empty: `$SPLASH_LSP`, then `$PATH`, then a sibling checkout, then the pinned download. |
| `splashCheck.serverVersion` | `"2.0.0"` | The `splash-lsp` version to download when no local build is found. Pinned in the manifest; override it to test a local build of the server against a released plugin. |
| `splashCheck.debounceMs` | `300` | How long after the last keystroke a document is checked. Checking a 130 KB app takes ~200 ms, and doing it per keystroke would lag the editor. |

## The command line

The same analysis runs without an editor:

```sh
splashcheck path/to/bundle        # or a single main.splash
```

It is advisory — it never decides admission, the store's gate does that — and
it comes with a baseline so a legacy app can adopt it without a wall of red.
