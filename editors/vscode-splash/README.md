# Splash Check

Static semantic analysis for **Splash apps** (`.splash`), in your editor.

The analysis is the OctoSense framework's own checker — `splashcheck`, from
`makepad-widgets` — running as a Language Server. It is not a reimplementation
and it does not drift: the binary and the framework it checks are one revision.

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

The extension is only a client; the analysis lives in the `splash-lsp` binary,
built from an Octoscript-Makepad checkout:

```sh
cargo build --release -p makepad-widgets --bin splash-lsp --features maps
```

Then point the extension at it, in any of these ways:

1. **Setting**: `splashCheck.serverPath` — an absolute path to the binary.
2. **Environment**: `$SPLASH_LSP`.
3. **PATH**: `splash-lsp` (or `splash-lsp.exe`).
4. **Workspace layout**: a `makepad/` or `Octoscript-Makepad/` checkout beside
   the workspace, with `target/release/splash-lsp` in it — the same places
   `octo` looks for the tools it wraps.

Until one of those is true, the extension says so and offers to open the
setting rather than failing silently.

## Building the extension

```sh
npm install
npm run compile     # or: npm run watch
npm run package     # produces splash-check-<version>.vsix
```

`code --install-extension splash-check-0.1.0.vsix` installs it.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `splashCheck.serverPath` | `""` | The binary. Empty: `$SPLASH_LSP`, then `$PATH`, then a sibling checkout. |
| `splashCheck.debounceMs` | `300` | How long after the last keystroke a document is checked. Checking a 130 KB app takes ~200 ms, and doing it per keystroke would lag the editor. |

## The command line

The same analysis runs without an editor:

```sh
splashcheck path/to/bundle        # or a single main.splash
```

It is advisory — it never decides admission, the store's gate does that — and
it comes with a baseline so a legacy app can adopt it without a wall of red.
