# The splashcheck golden corpus

The Splash checker's findings over the twelve real apps, pinned as text. One
command re-runs the checker and compares:

```sh
python3 tools/splashcheck_golden.py                 # compare
python3 tools/splashcheck_golden.py --update        # re-record after an intended change
python3 tools/splashcheck_golden.py --only mail     # one app
```

Exit status: `0` every golden matches, `1` at least one differs (with a unified
diff on stdout), `2` a setup problem - no checker binary, no corpus app, no
golden file. A workspace that cannot run the corpus says so; it never passes
quietly.

## Where the apps and the checker are

Neither is in this repository, so the runner expects a workspace that holds the
sibling checkouts beside this one:

```text
<workspace>/
  OctoSense-App-Flow/    this repository
  OctoSense/             the shell and its system apps: apps/<app>/bundle
  OctoSense-AppCard/     the AppCard assistant: bundle
  makepad/ splash-probe/ where the checker is built
```

Where that workspace is, in order: `--corpus-root`, `$OCTOSENSE_WORKSPACE`, then
this repository's parent directory. The checker is `splashcheck`, built from the
OctoSense fork of Makepad - `cargo build -p makepad-widgets --bin splashcheck
--features maps` - and is found in `$SPLASHCHECK`, then `splash-probe`, `makepad`
or `Octoscript-Makepad` under the workspace root, then `$PATH`: the order and the
`os.X_OK` test `tools/octo` applies to the tools it wraps. Build it with the
features of the host it checks for; this corpus is recorded with `maps`, or the
maps app reports a `MapView` its host does have.

## Layout

| Path | What it is |
| --- | --- |
| `golden/<app>.txt` | One app's report: app id, a digest of the sources the checker read, and every finding with its line, column, code and message. |
| `fn-blindspot/` | The fn blind-spot fixture, shipped here so it is checked wherever the checker is. |
| `callback-blindspot/` | The callback blind-spot fixture, likewise. |
| `callback-nildata/` | The same, for the one message shape the stub is allowed to invent. |

The twelve apps are the OctoSense shell's eleven system apps (`news`, `photos`,
`maps`, `camera`, `mail`, `calendar`, `ai-providers`, `youtube`, `quickdeck`,
`pdftools`, `writer`) plus the AppCard assistant. `wasmlab` also ships a bundle
but is a lab rather than a system app, so it is not in the corpus. Fifteen
entries in all: the twelve apps and the two fixtures.

The digest covers the `.splash` files and the manifest and nothing else, because
those are the checker's whole input: an icon, a `tools.json` or a screenshot
cannot move a finding, and hashing them would make a screenshot update look like
a checker regression.

## What a golden does not show

Two reductions, both deliberate, both in the code with their reasons:

- **Findings are sorted**, not listed in report order, so a reordering is not a
  diff.
- **The VM's allocation counters are scrubbed** (`width(obj653)` becomes
  `width(obj)`, `pow(fn280)` becomes `pow(fn)`). They are heap indices: they
  move when anything ahead of them in the registry moves, and a golden that kept
  them would churn on every unrelated refactor and bury the change a reader came
  to see. Both kinds, because an object and a fn are allocated from the same
  registry and a `fn` counter is exactly as unstable.

## The fn blind spot

`fn-blindspot/main.splash` is one line: `fn broken(){ let x = nope }` - a fault
inside a function nothing calls at the top level. The checker used to evaluate
top-level code only, so its golden recorded no findings. That was the
measurement this corpus existed to make.

It now records one, because the checker re-runs every top-level `fn` once with
no arguments after the body ([ADR 0002](../../docs/adr/0002-analysis-posture-and-one-suppression-rule.md)
§1):

```text
findings 1
  1:22 error splash.fnstub variable nope not found in scope. Did you mean: ...
```

The fn's own line, the name's own column, and `splash.fnstub` - the stub's own
code, beside `splash.eval` for what the body itself raised. Grep it, baseline
it, or demote the whole class in one move.

## What the fn re-run added to the twelve apps

The same re-run reaches the real apps' fns, so their goldens grew. Every new
finding is `splash.fnstub`, and every one of them is a fault the re-run itself
reached - either a real fault inside a `fn`, or a fault the no-argument call
invented. The shapes, with what each one is:

| Shape | Count | What it is |
| --- | --- | --- |
| `variable ui not found in scope` | 177 | The checker's own gap. A real host injects the `ui` handle into the isolate after the body builds its view; a dry run has no widget tree to point it at. Not the app's fault. |
| `no getter for field X on type NotFound` | 177 | The cascade of the line above: `ui` came back `NotFound`, so `ui.docs` has no getter. |
| `method X not found on nil` | 60 | A `nil` parameter reaching a native method (`"".replace(nil, …)`). The measured cost of passing no arguments. |
| `path must be a string` | 13 | A `nil` parameter reaching a native call that checks its argument's type. Same cost. |
| `variable sys not found in scope` | 9 | The framework's own `sys`/`agent` vocabulary, which every host installs into its isolates and a checker does not. Also the checker's gap, not the app's. |
| `method X not found on error` | 9 | The cascade of a call whose target came back an error (`sys.gps(...)`). |
| `array index …`, `type mismatch …`, `cannot assign …` | 14 | More `nil` parameters. |

One shape is **not** in that table because it is not a finding at all:
`no getter for field X on type nil`, produced while running a stub, is a note
(`suppressed (a no-argument fn re-run leaves every parameter nil): …`). That is
the single suppression rule ADR 0002 §2 measured, and it is the only one.

So the corpus says, in numbers, what the ADR could not say from one-file
fixtures: **the false-positive surface of a no-argument re-run on real apps is
much wider than one shape**, and its largest part is the `ui` global a dry run
cannot provide. The rule is not widened here - an invented rule suppresses
shapes nobody has measured, and `variable ui not found in scope` is the same
shape as the fixture's own `variable nope not found in scope`, so a rule wide
enough to hide the first would hide the second. The follow-up is to make the
dry run faithful instead: install the body's root view somewhere a `ui` handle
can point at, and install the vocabulary a host installs. Until then the
goldens are the record of exactly what the posture costs, which is what a
baseline is for.

Per app, so a reader can see the size of it without opening every file:

| App | findings before | after | of which `splash.fnstub` | notes |
| --- | --- | --- | --- | --- |
| `ai-providers` | 1 | 19 | 18 | 9 |
| `appcard` | 0 | 84 | 84 | 5 |
| `calendar` | 1 | 15 | 14 | 0 |
| `camera` | 0 | 29 | 29 | 1 |
| `fn-blindspot` | 0 | 1 | 1 | 0 |
| `mail` | 1 | 17 | 16 | 4 |
| `maps` | 0 | 80 | 80 | 4 |
| `news` | 0 | 24 | 24 | 4 |
| `pdftools` | 1 | 58 | 57 | 15 |
| `photos` | 0 | 29 | 29 | 3 |
| `quickdeck` | 1 | 50 | 49 | 17 |
| `writer` | 1 | 47 | 46 | 9 |
| `youtube` | 0 | 13 | 13 | 2 |

The `notes` column is the suppressed `nil` field reads plus, where the checker
answered a queued request, the stub's own count. Nothing else moved: every
app's digest is unchanged, so these are the same sources saying more.

## The callback blind spot

`callback-blindspot/main.splash` is the other hole
[ADR 0002](../../docs/adr/0002-analysis-posture-and-one-suppression-rule.md)
measured: a `host.request` whose callback carries a fault, in a `fn` the body
calls at the top level. A validation run has no host, so the request used to
queue and nothing answered it - the callback never ran, and its golden recorded
no findings. The checker now drains what the body queued and answers each
request once with a stub success, so the callback runs, and the golden carries
its fault at the callback's own line under `splash.fnstub`:

```text
findings 1
  3:32 error splash.fnstub variable nope not found in scope. ...
notes 1
  1 host request(s) answered with a stub success, so their callbacks ran against data: nil
```

The note is the posture being honest about itself: a stub answer is not the
host's answer, and the code that ran against it ran against `data: nil`.

One fault per callback, not one per line: the VM stops a callback at its first
error, so a second fault further down the same body is not reached. The fixture
carries one on purpose.

`callback-nildata/main.splash` is the same app reading what a real app reads -
`r.data.messages` - against a stub whose `data` is nil. That read is the ONE
message shape
[ADR 0002](../../docs/adr/0002-analysis-posture-and-one-suppression-rule.md) §2
pays for, and its golden records it as a note rather than a finding:

```text
findings 0
notes 2
  suppressed (the stub answer's data is nil): no getter for field messages on type nil
  1 host request(s) answered with a stub success, so their callbacks ran against data: nil
```

This fixture is the gate on the suppression rule itself. It is the one rule that
pays for the depth, so dropping it - or widening it to `on type object`, which
nothing has measured - moves this golden, and the diff says so.

What the stub does NOT reach is the same boundary as the fn blind spot. Drop the
top-level `load()` from either fixture and the request is never queued, nothing
is answered, and the golden would record no findings again - a `fn` nothing calls
still is not evaluated. The two fixtures measure the two halves of the analysis
depth, and they flip independently.

Why the twelve apps did not move when the answering landed: every one of them
boots behind `start_timeout(0.05, || boot())`, so a synchronous check queues no
request at all and the stub answers none. Their goldens were byte-identical,
which is the claim this corpus made about them then. They moved later, when the
fn re-run landed - measured shape by shape under [What the fn re-run added to
the twelve apps](#what-the-fn-re-run-added-to-the-twelve-apps) - and the two
callback goldens above did not move with them, because the requests a re-run
`fn` queues arrive after the drain has already run.

## Re-recording

`--update` writes what the checker says now, so it is also how an intended
change is accepted. [ADR 0002](../../docs/adr/0002-analysis-posture-and-one-suppression-rule.md)
§4 makes this corpus the regression gate for the analysis depth: the **fn**
fixture's expectation flips from "no findings" to "findings", and every other
app's diff must be empty or explained. So a re-record is not a silent refresh -
name what moved and why, in the commit and in the pull request, the way
[ADR 0001](../../docs/adr/0001-vm-query-api-two-functions.md) §4 asks of the
corpus it governs: a green local run nobody wrote down is not a promise.

### The run that recorded the two callback goldens

```sh
python3 tools/splashcheck_golden.py --corpus-root <workspace> \
    --checker <workspace>/splash-probe/target/debug/splashcheck \
    --only callback-blindspot --only callback-nildata --update
```

```text
  rec  callback-blindspot - 1 finding(s)
  rec  callback-nildata - 0 finding(s)
splashcheck_golden: wrote 2 golden file(s) to tools/splashcheck_corpus/golden
```

and the comparison that says the rest of the corpus is untouched by it, over the
same workspace:

```text
$ python3 tools/splashcheck_golden.py --corpus-root <workspace>
  ...
splashcheck_golden: 15 ok, 0 changed
```

Both were run against a build carrying the host answering and nothing else. The
`fn` fixture is deliberately still `findings 0` here: its re-run is issue #6, and
that ticket's re-record is where it flips. If a run shows the twelve apps or the
fn fixture moving, look there first - a shared `makepad` checkout can carry more
than one ticket's change, and the goldens name the build they were recorded
against rather than pretending to be absolute.

The run that recorded `callback-blindspot.txt`: `splashcheck` built from the
OctoSense fork of Makepad with `--features maps`, over the workspace this
README names. One golden was added (`callback-blindspot`); the twelve apps and
the fn fixture were compared and are unchanged. That is the whole diff, and it
is written here because no CI runs it.

## Boundary

CI does not run the corpus: no runner has the `splashcheck` binary or the two app
checkouts, so `tools/test_splashcheck_golden.py` asserts the honest exit 2 there
and compares for real on a prepared developer machine. The corpus is a local
regression net, and a machine that has not run it has not been checked - which
is why the runner says so instead of passing quietly.
