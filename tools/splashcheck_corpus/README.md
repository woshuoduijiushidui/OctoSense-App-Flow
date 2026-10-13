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
  `width(obj)`). They are heap indices: they move when anything ahead of them in
  the registry moves, and a golden that kept them would churn on every unrelated
  refactor and bury the change a reader came to see.

## The fn blind spot

`fn-blindspot/main.splash` is one line: `fn broken(){ let x = nope }` - a fault
inside a function nothing calls at the top level. The checker evaluates
top-level code only, so its golden records no findings. That is the measurement
this corpus exists to make: when the checker starts evaluating every `fn`, this
golden gains a finding and the diff says so, rather than the change arriving as
a sentence in a changelog.

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

Why the twelve apps did not move: every one of them boots behind
`start_timeout(0.05, || boot())`, so a synchronous check queues no request at
all and the stub answers none. Their goldens are byte-identical, which is the
claim this corpus makes about them - the depth cost them nothing.

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
