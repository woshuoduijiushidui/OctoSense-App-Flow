"""tools/splashcheck_golden.py: the corpus runner's behavior, with no checker needed.

The runner's seam is `run_checker`: one call, one bundle, one JSON report. The
tests below replace it with a canned checker and a synthetic corpus, so what is
tested is the runner's own contract - record, compare, diff, and say so when the
workspace is not prepared - and not the checker, which has its own tests beside
it. The real corpus is checked at the end, when this workspace has it.
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
_loader = importlib.machinery.SourceFileLoader("splashcheck_golden", str(HERE / "splashcheck_golden.py"))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
splashcheck_golden = importlib.util.module_from_spec(_spec)
_loader.exec_module(splashcheck_golden)

# One finding, as the checker's JSON carries it.
FINDING = {
    "severity": "error",
    "code": "splash.eval",
    "line": 3,
    "column": 17,
    "message": "variable nope not found in scope. Did you mean: width(obj653)",
}

# The blind-spot fixtures that ship in this repository: the checker's own test
# cases for the analysis depth, one per half of it, plus the one message shape
# the depth is allowed to invent.
FIXTURES = ("fn-blindspot", "callback-blindspot", "callback-nildata")


class FakeChecker:
    """A stand-in for the binary: canned reports, one recipe per app name."""

    def __init__(self, recipes):
        self.recipes = recipes
        self.calls = []

    def __call__(self, checker, bundle):
        self.calls.append(bundle)
        recipe = self.recipes.get(bundle.parent.name, {})
        return {
            "tool": "splashcheck",
            "version": recipe.get("version", "2.0.0"),
            "files": [{
                "path": str(bundle / "main.splash"),
                "bytes": recipe.get("bytes", 32),
                "manifest_found": True,
                "declares_net": recipe.get("declares_net", False),
                "capabilities": list(recipe.get("capabilities", ("storage",))),
                "findings": [dict(finding) for finding in recipe.get("findings", ())],
                "notes": list(recipe.get("notes", ())),
                "fatal": recipe.get("fatal"),
            }],
        }


class GoldenRunnerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="splashcheck-golden-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.golden = self.root / "golden"
        # Only the runner looks at this path; the fake checker stands in for it.
        self.checker = self.root / "splashcheck.exe"
        self.checker.write_bytes(b"")

    def bundle(self, name, source="// a synthetic app\n", capabilities=("storage",)):
        path = self.root / "OctoSense" / "apps" / name / "bundle"
        path.mkdir(parents=True, exist_ok=True)
        (path / "main.splash").write_text(source, encoding="utf-8")
        (path / "manifest.json").write_text(
            json.dumps({"schema": 1, "id": f"os.{name}", "capabilities": list(capabilities)}),
            encoding="utf-8",
        )
        return path

    def run_tool(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = splashcheck_golden.main([str(arg) for arg in argv])
        return status, out.getvalue(), err.getvalue()

    def argv(self, *extra, only=("news",)):
        argv = [
            "--corpus-root", str(self.root),
            "--checker", str(self.checker),
            "--golden-dir", str(self.golden),
        ]
        for name in only:
            argv += ["--only", name]
        return tuple(argv) + extra

    def test_a_recorded_corpus_compares_clean(self):
        self.bundle("news")
        self.bundle("mail")
        recorder = FakeChecker({"mail": {"findings": [FINDING]}})
        with patch.object(splashcheck_golden, "run_checker", recorder):
            status, out, err = self.run_tool(*self.argv("--update", only=("news", "mail")))
            self.assertEqual(status, 0, err)
            self.assertIn("wrote 2 golden file(s)", out)
            self.assertIn("rec  mail - 1 finding(s)", out)
        # One invocation per bundle, in the corpus's own order.
        self.assertEqual([path.parent.name for path in recorder.calls], ["mail", "news"])
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"mail": {"findings": [FINDING]}})):
            status, out, err = self.run_tool(*self.argv(only=("news", "mail")))
        self.assertEqual(status, 0, out)
        self.assertIn("ok   news - 0 finding(s)", out)
        self.assertIn("ok   mail - 1 finding(s)", out)
        self.assertIn("2 ok, 0 changed", out)

    def test_a_new_finding_is_a_readable_diff(self):
        self.bundle("news")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({})):
            status, _, err = self.run_tool(*self.argv("--update"))
            self.assertEqual(status, 0, err)
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [FINDING]}})):
            status, out, err = self.run_tool(*self.argv())
        self.assertEqual(status, 1, out)
        self.assertIn("DIFF news - 1 finding(s)", out)
        self.assertIn("--- golden/news.txt", out)
        self.assertIn("+++ current", out)
        self.assertIn("-findings 0", out)
        self.assertIn("+findings 1", out)
        self.assertIn("+  3:17 error splash.eval variable nope not found in scope", out)
        self.assertIn("0 ok, 1 changed", out)

    def test_a_changed_app_says_so_on_the_digest_line(self):
        self.bundle("news", source="// the first shape\n")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({})):
            self.assertEqual(self.run_tool(*self.argv("--update"))[0], 0)
        # The app moved, the checker did not: the digest line is the difference.
        self.bundle("news", source="// the second shape\n")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({})):
            status, out, _ = self.run_tool(*self.argv())
        self.assertEqual(status, 1, out)
        self.assertIn("-digest ", out)
        self.assertIn("+digest ", out)
        self.assertNotIn("-findings", out)

    def test_findings_are_ordered_not_listed(self):
        self.bundle("news")
        second = dict(FINDING, line=9, column=4, code="splash.capability", severity="warn",
                      message="1 host.request call(s) pass a computed service name")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [FINDING, second]}})):
            self.assertEqual(self.run_tool(*self.argv("--update"))[0], 0)
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [second, FINDING]}})):
            status, out, _ = self.run_tool(*self.argv())
        self.assertEqual(status, 0, out)

    def test_the_vm_object_counters_are_not_part_of_a_golden(self):
        self.bundle("news")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [FINDING]}})):
            self.assertEqual(self.run_tool(*self.argv("--update"))[0], 0)
        moved = dict(FINDING, message=FINDING["message"].replace("obj653", "obj654"))
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [moved]}})):
            status, out, _ = self.run_tool(*self.argv())
        self.assertEqual(status, 0, out)
        golden = (self.golden / "news.txt").read_text(encoding="utf-8")
        self.assertIn("width(obj)", golden)
        self.assertNotIn("obj653", golden)

    def test_the_vm_fn_counters_are_not_part_of_a_golden_either(self):
        """The tail's other kind of counter, scrubbed for the same reason.

        `pow(fn280)` is a heap index like `width(obj653)`, and it moves the same
        way. A golden that kept it would churn on an unrelated refactor - which
        is how the first callback golden came to embed one.
        """
        finding = dict(FINDING, message="variable nope not found in scope. Did you mean: pow(fn280), mix(fn281)")
        self.bundle("news")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [finding]}})):
            self.assertEqual(self.run_tool(*self.argv("--update"))[0], 0)
        moved = dict(finding, message=finding["message"].replace("fn280", "fn999"))
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({"news": {"findings": [moved]}})):
            status, out, _ = self.run_tool(*self.argv())
        self.assertEqual(status, 0, out)
        golden = (self.golden / "news.txt").read_text(encoding="utf-8")
        self.assertIn("pow(fn)", golden)
        self.assertNotIn("fn280", golden)

    def test_a_workspace_without_the_checker_says_so(self):
        self.bundle("news")
        missing = self.root / "no-such-splashcheck"
        status, out, err = self.run_tool(*self.argv("--checker", str(missing)))
        self.assertEqual(status, 2, out)
        self.assertIn(f"no splashcheck binary at {missing}", err)

    def test_a_checker_that_will_not_run_is_a_setup_problem(self):
        # A file that is there but not a runnable program is not a checker, and
        # saying so beats the crash subprocess would raise instead. Windows
        # `os.access(X_OK)` only looks at the extension, so there the refusal
        # arrives one step later, when the run itself fails; either way it is a
        # named setup problem and exit 2, never a traceback.
        self.bundle("news")
        blocked = self.root / "splashcheck.exe"
        blocked.write_bytes(b"")
        os.chmod(blocked, 0o444)
        status, out, err = self.run_tool(*self.argv("--checker", str(blocked)))
        self.assertEqual(status, 2, out)
        self.assertIn(str(blocked), err)
        self.assertRegex(err, r"no splashcheck binary at|will not run")

    def test_a_workspace_with_no_checker_anywhere_says_where_it_looked(self):
        self.bundle("news")
        with patch.dict(os.environ, {"SPLASHCHECK": ""}), patch.object(shutil, "which", return_value=None):
            status, out, err = self.run_tool(
                "--corpus-root", str(self.root),
                "--golden-dir", str(self.golden),
                "--only", "news",
            )
        self.assertEqual(status, 2, out)
        self.assertIn("no splashcheck binary. Searched:", err)
        # Every place it looked, then the two ways out: the variable and the build.
        self.assertIn(str(self.root / "splash-probe" / "target" / "release" / "splashcheck.exe"), err)
        self.assertIn(str(self.root / "makepad" / "target" / "debug" / "splashcheck.exe"), err)
        self.assertIn("PATH (splashcheck)", err)
        self.assertIn("$SPLASHCHECK", err)
        self.assertIn("--features maps", err)

    def test_a_workspace_without_the_app_says_so(self):
        status, out, err = self.run_tool(*self.argv())
        self.assertEqual(status, 2, out)
        self.assertIn("no corpus app 'news'", err)
        self.assertIn("OCTOSENSE_WORKSPACE", err)

    def test_a_missing_golden_file_is_a_setup_problem(self):
        self.bundle("news")
        self.bundle("mail")
        with patch.object(splashcheck_golden, "run_checker", FakeChecker({})):
            status, _, err = self.run_tool(*self.argv("--update", only=("news",)))
            self.assertEqual(status, 0, err)
            status, out, err = self.run_tool(*self.argv(only=("mail",)))
        self.assertEqual(status, 2, out)
        self.assertIn("no golden file for 'mail'", err)
        self.assertIn("--update", err)

    def test_an_unknown_app_name_is_a_setup_problem(self):
        status, out, err = self.run_tool(*self.argv(only=("wasmlab",)))
        self.assertEqual(status, 2, out)
        self.assertIn("no corpus app 'wasmlab'", err)
        self.assertIn("fn-blindspot", err)


class CorpusTests(unittest.TestCase):
    """What the corpus is, as committed: the twelve apps, the two fixtures, the goldens."""

    def test_the_corpus_is_the_twelve_real_apps_and_the_two_fixtures(self):
        entries = splashcheck_golden.corpus(Path("/nowhere"))
        self.assertEqual([name for name, _ in entries], self.names())
        self.assertEqual(len([name for name, _ in entries if name not in FIXTURES]), 12)
        # The eleven system apps sit in the OctoSense checkout, AppCard beside it.
        paths = dict(entries)
        self.assertEqual(paths["news"], Path("/nowhere/OctoSense/apps/news/bundle"))
        self.assertEqual(paths["appcard"], Path("/nowhere/OctoSense-AppCard/bundle"))
        # The fixtures ship here, so they are checked wherever the checker is.
        for fixture in FIXTURES:
            self.assertEqual(paths[fixture], splashcheck_golden.CORPUS / fixture)
    def names(self):
        """The roster, read from the module: one list, not one per file."""
        return [name for name, _ in splashcheck_golden.corpus(Path("/nowhere"))]

    def test_every_corpus_entry_has_a_golden_file(self):
        golden = splashcheck_golden.GOLDEN
        self.assertEqual(
            sorted(path.name for path in golden.glob("*.txt")),
            [f"{name}.txt" for name in self.names()],
        )
        for name in self.names():
            text = (golden / f"{name}.txt").read_text(encoding="utf-8")
            self.assertTrue(text.startswith("# splashcheck_golden golden corpus"), name)
            self.assertIn("# checker: splashcheck ", text, name)
            self.assertIn("digest ", text, name)

    def test_the_fn_blind_spot_is_the_fixture_the_ticket_names(self):
        source = (splashcheck_golden.CORPUS / "fn-blindspot" / "main.splash").read_text(encoding="utf-8")
        self.assertEqual(source.strip(), "fn broken(){ let x = nope }")
        manifest = json.loads((splashcheck_golden.CORPUS / "fn-blindspot" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], "dev.example.fnblindspot")

    def test_the_callback_fixture_calls_its_fn_at_the_top_level(self):
        """The fixture's shape is what makes it a measurement.

        The `load()` on its own line is the whole point: it is what queues the
        request the checker answers. Without it the fixture would be silent for
        the fn reason instead, and the two halves of the depth would be
        indistinguishable.
        """
        source = (splashcheck_golden.CORPUS / "callback-blindspot" / "main.splash").read_text(encoding="utf-8")
        self.assertIn("fn load(){", source)
        self.assertIn("host.request(\"news.list\", {}, fn(r){", source)
        self.assertIn("\nload()\n", source, "the fn is called at the top level")
        manifest = json.loads((splashcheck_golden.CORPUS / "callback-blindspot" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], "dev.example.callbackblindspot")
        # The service it asks for is declared, so the golden is about the
        # callback and not about a capability the manifest lacks.
        self.assertEqual(manifest["capabilities"], ["news"])

    def test_the_nildata_fixture_reads_what_a_real_app_reads(self):
        source = (splashcheck_golden.CORPUS / "callback-nildata" / "main.splash").read_text(encoding="utf-8")
        self.assertIn("r.data.messages", source)
        self.assertIn("\nload()\n", source, "the fn is called at the top level")
        manifest = json.loads((splashcheck_golden.CORPUS / "callback-nildata" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], "dev.example.callbacknildata")
        self.assertEqual(manifest["capabilities"], ["news"])

    def test_the_fn_blind_spot_currently_reports_nothing(self):
        """The expectation the analysis-depth tickets flip, made executable.

        The checker evaluates top-level code only, so a fault inside a `fn`
        nothing calls at the top level is not reported yet. When it starts
        evaluating every `fn`, this golden gains a finding and this test is
        updated with it: the delivery is measured here, not asserted in prose.
        """
        golden = (splashcheck_golden.GOLDEN / "fn-blindspot.txt").read_text(encoding="utf-8")
        self.assertIn("app dev.example.fnblindspot", golden)
        self.assertIn("findings 0", golden)
        self.assertIn("notes 0", golden)

    def test_the_callback_blind_spot_reports_the_callbacks_fault(self):
        """The other half of the analysis depth, already delivered.

        The checker answers the requests the body queued, so a callback's body
        runs and its fault is reported at the callback's own line, under
        `splash.fnstub` - the code that makes a stub finding greppable and
        demotable. Before that, this golden held `findings 0` and the fixture
        was silent for exactly the reason the fn fixture still is.
        """
        golden = (splashcheck_golden.GOLDEN / "callback-blindspot.txt").read_text(encoding="utf-8")
        self.assertIn("app dev.example.callbackblindspot", golden)
        self.assertIn("findings 1", golden)
        # Line 3, the callback's own: the fault is inside `if r.is_ok { ... }`.
        self.assertIn("3:32 error splash.fnstub variable nope not found in scope", golden)
        # And the run says it stubbed: an answer no host gave is not a secret.
        self.assertIn("notes 1", golden)
        self.assertIn("answered with a stub success", golden)

    def test_the_stubs_one_invented_shape_is_a_note_not_a_finding(self):
        """The suppression rule, under a golden of its own.

        `r.data.messages` against a stub whose `data` is nil is the one shape
        the posture pays for. It is the rule that keeps the depth usable, so it
        gets a fixture: drop or widen it and this golden moves.
        """
        golden = (splashcheck_golden.GOLDEN / "callback-nildata.txt").read_text(encoding="utf-8")
        self.assertIn("app dev.example.callbacknildata", golden)
        self.assertIn("findings 0", golden)
        self.assertIn("notes 2", golden)
        self.assertIn("suppressed (the stub answer's data is nil): no getter for field messages on type nil", golden)


class RealCorpusTests(unittest.TestCase):
    """The corpus itself, when this workspace has the checker and the twelve apps."""

    def test_the_real_corpus_compares_clean(self):
        root = splashcheck_golden.workspace_root()
        checker, _ = splashcheck_golden.find_checker(None, root)
        prepared = checker is not None and all(
            path.is_dir() for _, path in splashcheck_golden.corpus(root)
        )
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = splashcheck_golden.main([])
        if not prepared:
            # A workspace without the corpus says so; it never passes quietly.
            self.assertEqual(status, 2, out.getvalue())
            self.assertIn("splashcheck_golden:", err.getvalue())
            return
        self.assertEqual(status, 0, out.getvalue())
        self.assertIn("15 ok, 0 changed", out.getvalue())


if __name__ == "__main__":
    unittest.main()
