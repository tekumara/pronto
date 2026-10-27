"""Run the pinned Quint CLI through mise; reject tool errors as expected counterexamples."""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MODEL = HERE / "LeaseElection.qnt"
OUT = Path(tempfile.mkdtemp(prefix="pronto-quint-"))
INPUTS = [*sorted(HERE.glob("*.*")), ROOT / "mise.toml", ROOT / "primary-runtime.ts",
          ROOT / "s3-control.ts", ROOT / "litestream.ts",
          ROOT / "test/integration/controlled-clock.mjs", ROOT / "test/integration/replicated.test.ts"]


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in INPUTS}


def command(name, args, timeout=180):
    cmd = ["mise", "exec", "--", *args]
    with (OUT / f"{name}.log").open("w") as log:
        log.write(f"Command: {json.dumps(cmd)}\n")
        log.flush()
        process = subprocess.Popen(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError(f"Timed out, not a completed check: {name}. See {OUT}")
    return code, (OUT / f"{name}.log").read_text()


# TLC's printed finite records/functions, not a second election implementation.
# Reject unknown syntax rather than guessing at a partial counterexample.
class Value:
    pattern = re.compile(r'\s*("(?:[^"\\]|\\.)*"|-?\d+|TRUE|FALSE|[A-Za-z_][A-Za-z_0-9]*|\|->|:>|@@|[][(),])')

    def __init__(self, text):
        self.tokens = []
        pos = 0
        while text[pos:].strip():
            match = self.pattern.match(text, pos)
            require(match, f"Unsupported TLC trace syntax near {text[pos:pos+50]!r}")
            self.tokens.append(match[1])
            pos = match.end()
        self.pos = 0

    def pop(self, expected=None):
        require(self.pos < len(self.tokens), "Truncated TLC value")
        token = self.tokens[self.pos]
        self.pos += 1
        require(expected is None or token == expected, f"Expected {expected}, got {token}")
        return token

    def value(self):
        token = self.pop()
        if token in ("[", "("):
            close, binding, separator = ("]", "|->", ",") if token == "[" else (")", ":>", "@@")
            result = {}
            while True:
                key = self.pop()
                if token == "(":
                    key = int(key)
                require(key not in result, "Duplicate TLC field")
                self.pop(binding)
                result[key] = self.value()
                delimiter = self.pop()
                if delimiter == close:
                    return result
                require(delimiter == separator, "Unexpected TLC collection separator")
        if token.startswith('"'):
            return json.loads(token)
        if token in ("TRUE", "FALSE"):
            return token == "TRUE"
        require(re.fullmatch(r"-?\d+", token), f"Unsupported TLC atom {token}")
        return int(token)


def trace(log, main):
    blocks = re.findall(r"^State \d+: ([^\n]*)\n(.*?)(?=^State \d+:|^\d[\d,]* states generated,)", log, re.M | re.S)
    require(blocks, f"Missing TLC counterexample: {main}")
    states = []
    for action, body in blocks:
        prefix = f"{main}_LeaseElection_s = "
        require(body.startswith(prefix), "Unexpected TLC state variable")
        parser = Value(body[len(prefix):])
        state = parser.value()
        require(parser.pos == len(parser.tokens), "Unconsumed TLC trace content")
        require(set(state["actors"]) == {0, 1}, "Incomplete actor map")
        states.append({"action": action, "state": state})
    return states


def ready(state):
    return [i for i, a in state["actors"].items()
            if a["stage"] == "ready" and not a["stopped"] and state["now"] < a["deadline"]]


def verify(main, step, invariant, failure=None):
    name = f"{main}-{step}-{invariant}"
    code, log = command(name, ["quint", "verify", str(MODEL), f"--main={main}", f"--step={step}",
        "--backend=tlc", f"--invariant={invariant}", f"--tlc-config={HERE / 'tlc.json'}",
        "--apalache-version=0.62.1", "--verbosity=3"], timeout=600)
    errors = re.findall(r"^Error: (.*)", log, re.M)
    require("Finished in" in log, f"Incomplete TLC run: {name}")
    stats = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue", log)
    depth = re.search(r"depth of the complete state graph search is (\d+)", log)
    require(stats and depth, f"Missing TLC statistics: {name}")
    row = dict(name=name, generated=int(stats[1].replace(",", "")), distinct=int(stats[2].replace(",", "")),
               queue=int(stats[3].replace(",", "")), depth=int(depth[1]), exit=code)
    if failure:
        require(code == 1 and errors == ["Invariant q_inv is violated.", "The behavior up to this point is:"],
                f"Wrong failure: {name}: {code}, {errors}")
        require("[violation] Found an issue" in log, f"Missing Quint violation status: {name}")
        states = trace(log, main)
        if failure == "singleReady":
            require(all(len(ready(x["state"])) <= 1 for x in states[:-1]), "Earlier unreported readiness violation")
            require(len(ready(states[-1]["state"])) == 2, "Counterexample does not have two locally ready terms")
            require(not any(states[-1]["state"][f] for f in ("badCAS", "badRevival", "badRecovery", "badObservation")),
                    "Readiness counterexample depends on another protocol failure")
            if main in ("ForwardJump", "BackwardJump"):
                require(any(before["state"]["offset"] == 0 and after["state"]["offset"] != 0
                            and ready(before["state"])
                            for before, after in zip(states, states[1:])),
                        "Clock jump must happen after a term becomes ready")
        else:
            require(all(not x["state"][failure] for x in states[:-1]) and states[-1]["state"][failure],
                    f"Wrong mutation cause: {failure}")
        (OUT / f"{name}.trace.json").write_text(json.dumps(states, indent=2))
        row["result"] = f"expected counterexample: {failure}"
        row["traceStates"] = len(states)
    else:
        require(code == 0 and not errors and row["queue"] == 0 and
                "Model checking completed. No error has been found." in log and "[ok] No violation found" in log,
                f"Not a completed safe check: {name}: {code}, {errors}")
        row["result"] = "no violation in complete finite graph"
    print(json.dumps(row), flush=True)
    return row


def main():
    require(len(sys.argv) == 1, "No flags are supported; edit the explicit model bounds instead")
    print(f"Evidence: {OUT}", flush=True)
    before = hashes()
    (OUT / "inputs.json").write_text(json.dumps(before, indent=2))
    code, version = command("quint-version", ["quint", "--version"])
    require(code == 0 and version.splitlines()[-1] == "0.33.0", "Expected mise-pinned Quint 0.33.0")
    code, _ = command("java-version", ["java", "-version"])
    require(code == 0, "Mise Java unavailable")
    code, _ = command("typecheck", ["quint", "typecheck", str(MODEL)])
    require(code == 0, "Quint typecheck failed")
    code, _ = command("typecheck-scenarios", ["quint", "typecheck", str(HERE / "Scenarios.qnt")])
    require(code == 0, "Quint scenario typecheck failed")
    for module, tests in [
        ("Synchronized", "(competingInitialization|expiredAcquisition|delayedRenewal|ambiguousPromotion)Test"),
        ("ExcessSkew", "(skewOverlap|staleCheck|delayedObservation)Test"),
        ("ForwardJump", "forwardJumpTest"),
        ("BackwardJump", "backwardJumpTest"),
        ("LateRenewal", "lateRenewalMutationTest"),
    ]:
        code, log = command(f"tests-{module}", ["quint", "test", str(HERE / "Scenarios.qnt"), f"--main={module}Tests",
            f"--match={tests}", "--backend=typescript", "--seed=1"])
        expected = {"Synchronized": 4, "ExcessSkew": 3, "ForwardJump": 1, "BackwardJump": 1, "LateRenewal": 1}[module]
        require(code == 0 and f"{expected} passing" in log, f"Scenario tests failed or did not run: {module}")
    # Random simulation is supplementary coverage of the combined action set, not exhaustive evidence.
    code, log = command("simulation", ["quint", "run", str(MODEL), "--main=WithinMargin", "--invariant=safety",
        "--max-samples=1000", "--max-steps=50", "--seed=20261022", "--backend=typescript"])
    require(code == 0 and "No violation found" in log, "Combined simulation failed")
    rows = [
        verify("Synchronized", "leaseStep", "safety"),
        verify("WithinMargin", "leaseStep", "safety"),
        verify("WithinMargin", "controlStep", "safety"),
        verify("WithinMargin", "step", "safety"),
        verify("ExcessSkew", "leaseStep", "protocolSafety"),
        verify("ExcessSkew", "leaseStep", "singleReady", "singleReady"),
        verify("ForwardJump", "leaseStep", "singleReady", "singleReady"),
        verify("BackwardJump", "leaseStep", "singleReady", "singleReady"),
        verify("NoCAS", "leaseStep", "protocolSafety", "badCAS"),
        verify("LateRenewal", "leaseStep", "protocolSafety", "badRevival"),
        verify("CachedConfirmation", "step", "protocolSafety", "badObservation"),
    ]
    require(hashes() == before, "Inputs changed during checking; discard this run")
    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    jar = Path.home() / ".quint/apalache-dist-0.62.1/apalache/lib/apalache.jar"
    require(jar.is_file(), "Missing Quint backend artifact")
    (OUT / "backend.json").write_text(json.dumps({"apalacheVersion": "0.62.1", "jar": str(jar),
        "sha256": hashlib.sha256(jar.read_bytes()).hexdigest()}, indent=2))
    print(f"All Quint checks passed. Logs and counterexamples: {OUT}")


if __name__ == "__main__":
    main()
