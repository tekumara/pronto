#!/usr/bin/env python3
"""Protocol regression gate. Python 3.10+, Java 17+. No application dependency.

Authoring gate: independent safety contract and cross-language transition relation;
regressions include reordered observation, missing baseline and rebased stale CAS.
No production seam, source greps or simulated S3. DOT is TLC's actual state graph.
"""
import importlib.util
import json
from pathlib import Path
import re
import sys
import subprocess
import tempfile
from collections import deque

sys.dont_write_bytecode = True
from tlc import command, require, sha

ROOT = Path(__file__).resolve().parent
ORACLE_SHA = "7f4d1337fb39411d96988f4ae3fa332267e4293d6673d82c939cb0f014337374"
OUT = Path(tempfile.mkdtemp(prefix="pronto-protocol-"))
# Only tool results go in OUT. Never put generated graphs/Java/jars in the repo.
print(f"Protocol evidence: {OUT}", flush=True)


require(len(sys.argv) == 1, "test:protocol accepts no arguments; edit the reviewed finite .cfg files for a new bound")
require(sha(ROOT / "oracle/check_protocol.py") == ORACLE_SHA, "Original oracle changed")
INPUTS = [ROOT / "PrefixProtocol.tla", ROOT / "check.py", ROOT / "tlc.py", ROOT / "schedules.json", ROOT / "oracle/check_protocol.py", *sorted(ROOT.glob("*.cfg"))]
INPUT_HASHES = {str(p.relative_to(ROOT)): sha(p) for p in INPUTS}
spec = importlib.util.spec_from_file_location("oracle", ROOT / "oracle/check_protocol.py")
oracle = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
sys.modules[spec.name] = oracle
spec.loader.exec_module(oracle)


# Strict parser for the value subset emitted by this spec's DOT labels. No eval.
# Unknown syntax, unconsumed data and duplicate keys fail, never silently skip.
TOKEN = re.compile(r'\s*(<<|>>|\|->|:>|@@|[\[\]{},()]|-?\d+|"(?:\\.|[^"\\])*"|[A-Za-z_]\w*)')


class ValueParser:
    def __init__(self, source):
        self.tokens = []
        pos = 0
        while source[pos:].strip():
            match = TOKEN.match(source, pos)
            require(match, f"Unsupported TLC value near {source[pos:pos+80]!r}")
            self.tokens.append(match[1])
            pos = match.end()
        self.pos = 0

    def pop(self, expected=None):
        require(self.pos < len(self.tokens), "Truncated TLC value")
        token = self.tokens[self.pos]
        self.pos += 1
        require(expected is None or token == expected, f"Expected {expected}, found {token}")
        return token

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def value(self):
        token = self.pop()
        if token in ("<<", "{"):
            end = ">>" if token == "<<" else "}"
            values = []
            while self.peek() != end:
                values.append(self.value())
                if self.peek() != end:
                    self.pop(",")
            self.pop(end)
            return values
        if token in ("[", "("):
            end, arrow, separator = ("]", "|->", ",") if token == "[" else (")", ":>", "@@")
            values = {}
            while self.peek() != end:
                key = self.pop()
                self.pop(arrow)
                require(key not in values, "Duplicate TLC key")
                values[key] = self.value()
                if self.peek() != end:
                    self.pop(separator)
            self.pop(end)
            return values
        if token.startswith('"'):
            return json.loads(token)
        if token in ("TRUE", "FALSE"):
            return token == "TRUE"
        require(re.fullmatch(r"-?\d+", token), f"Unsupported scalar {token}")
        return int(token)

    def parse(self):
        value = self.value()
        require(self.pos == len(self.tokens), "Unconsumed TLC value")
        return value


FIELDS = ("phase", "source", "local", "versions", "written", "pending", "receipt", "acked", "renewed")


def key(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def python_state(s):
    return key({"owner": s.owner, "revision": s.revision, "ready": s.ready,
                "ref": list(s.ref), "acknowledged": s.acknowledged,
                "actors": [{f: getattr(a, f) for f in FIELDS} for a in s.actors]})


def tla_state(s):
    c = s["control"]
    return key({"owner": c["owner"], "revision": c["revision"], "ready": c["phase"] == "ready",
                "ref": [c["recovery"], 1], "acknowledged": sum(1 << i for i in s["acknowledged"]),
                "actors": [{f: s["actors"][str(i)][f] for f in FIELDS} for i in range(len(s["actors"]))]})


def python_graph(mode, terms):
    start = oracle.initial(terms)
    states = {python_state(start): start}
    edges = set()
    queue = deque([start])
    while queue:
        before = queue.popleft()
        for label, after in oracle.transitions(before, mode):
            a, b = python_state(before), python_state(after)
            edges.add((a, b))
            if b not in states:
                require(len(states) < 100_000, "Cross-check state limit exceeded")
                states[b] = after
                queue.append(after)
    return states, edges


NODE = re.compile(r'^(-?\d+) \[label=("(?:\\.|[^"\\])*")')
EDGE = re.compile(r'^(-?\d+) -> (-?\d+) \[label=("(?:\\.|[^"\\])*")')


def read_graph(path):
    states, edges, labelled = {}, set(), set()
    for line in path.read_text().splitlines():
        if match := NODE.match(line):
            label = json.loads(match[2])
            require(label.startswith("s = "), "Unexpected TLC state variable")
            value = tla_state(ValueParser(label[4:]).parse())
            require(match[1] not in states or states[match[1]] == value, "TLC fingerprint collision")
            states[match[1]] = value
        elif match := EDGE.match(line):
            edges.add((match[1], match[2]))
            labelled.add((match[1], json.loads(match[3]), match[2]))
        else:
            require(not re.match(r"^-?\d", line), f"Unsupported DOT line: {line[:80]}")
    require(states and edges, "Empty TLC graph")
    require(all(a in states and b in states for a, b in edges), "Incomplete TLC graph")
    return (set(states.values()), {(states[a], states[b]) for a, b in edges},
            {(states[a], label, states[b]) for a, label, b in labelled})


def same_graph(expected_states, expected_edges, actual_states, actual_edges):
    require(set(expected_states) == actual_states,
            f"State mismatch: python-only={len(set(expected_states)-actual_states)}, TLC-only={len(actual_states-set(expected_states))}")
    missing, extra = expected_edges - actual_edges, actual_edges - expected_edges
    if missing or extra:
        (OUT / "differential-failure.json").write_text(json.dumps({"missing": list(missing)[:2], "extra": list(extra)[:2]}, indent=2))
    require(not missing and not extra, f"Successor mismatch: missing={len(missing)}, extra={len(extra)}")


COUNTS = []
CMD = command(OUT)


def tlc(name, expected=None, graph=False):
    cfg = (ROOT / f"{name}.cfg").read_text()
    if graph:
        # Explore unsafe states too, in a SEPARATE run. Do not call this a safety pass.
        cfg = cfg.replace(" AckRecoverable", "")
    run_name = name + ("-graph" if graph else "")
    config = OUT / f"{run_name}.cfg"
    config.write_text(cfg)
    command = CMD + ["-metadir", str(OUT / f"{run_name}-states"), "-config", str(config)]
    if graph:
        command += ["-dump", "dot,actionlabels", str(OUT / f"{run_name}.dot")]
    if expected:
        command += ["-dumpTrace", "json", str(OUT / f"{run_name}-trace.json")]
    command += [str(ROOT / "PrefixProtocol.tla")]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as error:
        (OUT / f"{run_name}-incomplete.log").write_bytes((error.stdout or b"") + (error.stderr or b""))
        raise RuntimeError(f"TLC timed out; no completed result: {run_name}") from error
    log = result.stdout + result.stderr
    (OUT / f"{run_name}.log").write_text(log)
    errors = re.findall(r"^Error: (.*)$", log, re.M)
    require("Finished in" in log, f"Incomplete TLC invocation: {run_name}")
    if expected:
        require(result.returncode == 12 and errors == [f"Invariant {expected} is violated.", "The behavior up to this point is:"],
                f"Wrong TLC failure in {run_name}: exit {result.returncode}, {errors}")
        require("The behavior up to this point is:" in log, "No counterexample")
    else:
        require(result.returncode == 0 and not errors and "Model checking completed. No error has been found." in log,
                f"TLC failed: {run_name}: exit {result.returncode}, {errors}")
        require("0 states left on queue" in log, f"TLC exploration incomplete: {run_name}")
    stats = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue", log)
    require(stats, f"Missing TLC statistics: {run_name}")
    row = {"run": run_name, "generated": int(stats[1].replace(",", "")),
           "distinct": int(stats[2].replace(",", "")), "queue": int(stats[3].replace(",", "")),
           "expected_violation": expected}
    COUNTS.append(row)
    print(json.dumps(row), flush=True)
    return OUT / f"{run_name}.dot"


def replay_tlc_trace(name, mode, states, edges):
    trace = json.loads((OUT / f"{name}-trace.json").read_text())["counterexample"]
    sequence = [tla_state(item[1]["s"]) for item in trace["state"]]
    require(sequence[0] == python_state(oracle.initial(2)), "Trace starts outside oracle Init")
    require(all((a, b) in edges for a, b in zip(sequence, sequence[1:])), "TLC counterexample not executable in Python")
    reasons = [oracle.violation(states[a], states[b], mode) for a, b in zip(sequence, sequence[1:])]
    require(all(r is None for r in reasons[:-1]), "TLC trace passed an earlier unreported violation")
    require(reasons[-1] and "acknowledged operations absent" in reasons[-1], "Wrong counterexample cause")
    # Check the critical ordering, not merely an arbitrary invariant failure.
    actions = [(entry[1]["name"], entry[1].get("context", {}).get("i")) for entry in trace["action"]]
    end = states[sequence[-1]]
    recovered = set(oracle.history(end, end.ref, mode))
    missing = next(i for i in range(2) if end.acknowledged & (1 << i) and i not in recovered)
    upload = actions.index(("Upload", missing))
    restore = next(j for j, a in enumerate(actions) if a == ("Restore", end.ref[0]))
    require(restore < upload, "Unsafe trace did not select stale history before old upload")
    if mode == "precheck":
        require(actions.index(("Observe", missing)) < upload, "Precheck did not observe before upload")
    return [f"{name}({i})" if i is not None else name for name, i in actions]


# Baseline checker behaviour, unchanged, including unrelated alternative designs.
baselines = []
for mode, terms in [("naive", 2), ("precheck", 2), ("postcheck", 2), ("postcheck", 3),
                    ("fenced", 2), ("fenced", 3), ("blind-retry", 2)]:
    result = oracle.check(mode, terms)
    unsafe = mode in ("naive", "precheck", "blind-retry")
    require(bool(result["counterexample"]) == unsafe and not result.get("incomplete") and not result.get("depth_limited"),
            f"Unexpected Python result: {result}")
    if unsafe:
        s = oracle.initial(terms)
        for label in result["trace"]:
            choices = [n for action, n in oracle.transitions(s, mode) if action == label]
            require(len(choices) == 1, "Ambiguous oracle trace")
            before, s = s, choices[0]
        reason = oracle.violation(before, s, mode)
        expected = "publication replaced committed history" if mode == "blind-retry" else "acknowledged operations absent"
        require(expected in reason, f"Wrong Python counterexample: {reason}")
    baselines.append(result)
retention = oracle.retention_counterexample()
require(retention["target"] == 2 and retention["retained_ranges"] == [(1, 3)], "Retention warning changed")
(OUT / "python-baselines.json").write_text(json.dumps(baselines + [retention], indent=2))

traces = {}
for mode in ("postcheck", "naive", "precheck"):
    for terms in ((2, 3) if mode == "postcheck" else (2,)):
        name = f"common-{mode}-{terms}"
        unsafe = mode != "postcheck"
        tlc(name, expected="AckRecoverable" if unsafe else None)
        states, edges = python_graph(mode, terms)
        graph = tlc(name, graph=True)
        actual_states, actual_edges, labelled = read_graph(graph)
        same_graph(states, edges, actual_states, actual_edges)
        if mode == "postcheck" and terms == 2:
            for schedule in json.loads((ROOT / "schedules.json").read_text()):
                current = python_state(oracle.initial(2))
                for action in schedule["actions"]:
                    choices = {b for a, label, b in labelled if a == current and label == action}
                    require(len(choices) == 1, f"Schedule not executable in TLC: {action}")
                    current = choices.pop()
                require(bool(states[current].acknowledged & 1) == schedule["acknowledges"], "Wrong schedule outcome")
                if not schedule["acknowledges"]:
                    require(not any(a == current and label in ("Observe(0)", "Acknowledge(0)") for a, label, b in labelled),
                            "Delayed old upload could still acknowledge")
            print("Real-transport schedules are executable in both common models", flush=True)
        # Negative controls for the correspondence gate, not another oracle.
        try:
            same_graph(states, edges, actual_states, actual_edges - {next(iter(actual_edges))})
        except RuntimeError as error:
            require("Successor mismatch" in str(error), "Wrong differential negative-control failure")
        else:
            raise RuntimeError("Correspondence checker accepted a removed transition")
        (OUT / "differential-failure.json").unlink(missing_ok=True)
        COUNTS[-1].update(normalized_states=len(states), normalized_edges=len(edges))
        if unsafe:
            traces[name] = replay_tlc_trace(name, mode, states, edges)
        print(f"Exact normalized graph agreement: {name}: {len(states)} states / {len(edges)} edges", flush=True)

# Full lifecycle explores extra control bookkeeping; it is NOT graph-equivalent to Python.
for terms in (2, 3):
    tlc(f"lifecycle-postcheck-{terms}")
tlc("lifecycle-early-promote-2", expected="CompleteBaseline")
early = json.loads((OUT / "lifecycle-early-promote-2-trace.json").read_text())["counterexample"]
last = early["state"][-1][1]["s"]
require(not last["actors"][str(last["control"]["recovery"])]["versions"],
        "Early promotion did not publish a missing baseline")
require(early["action"][-1][1]["name"] == "CAS", "Early promotion failed before conditional publication")
traces["lifecycle-early-promote-2"] = [
    a[1]["name"] + (f'({a[1]["context"]["i"]})' if "context" in a[1] else "") for a in early["action"]]
(OUT / "counterexample-actions.json").write_text(json.dumps(traces, indent=2))
(OUT / "summary.json").write_text(json.dumps(COUNTS, indent=2))
require(all(sha(p) == INPUT_HASHES[str(p.relative_to(ROOT))] for p in INPUTS), "Protocol inputs changed during exploration; rerun without concurrent edits")
(OUT / "manifest.json").write_text(json.dumps(INPUT_HASHES, indent=2))
print(f"PASS: completed bounded checks, expected counterexamples and exact common graphs. Evidence: {OUT}", flush=True)
