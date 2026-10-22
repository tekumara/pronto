#!/usr/bin/env python3
"""Conditional progress gate; no new production dependencies or application seams.

Authoring gate: safety admits infinite stuttering. These checks independently
require eventual readiness/dispatch/completion/delivery. Remove each environment
or scheduler assumption to get the intended waiting cycle; break dispatch to get
a structural deadlock. Core checkpoint reachability and an actual failed-POST /
re-admission path prevent vacuous successes. Workflow stages are abstractions,
not implementation refinement; see LIVENESS.md and the real HTTP integration case.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from tlc import command, require, sha

ROOT = Path(__file__).resolve().parent
require(len(sys.argv) == 1, "Liveness gate accepts no arguments; edit the reviewed configuration/matrix instead")
INPUTS = [ROOT / name for name in ("PrefixProtocol.tla", "Liveness.tla", "liveness.cfg", "check_liveness.py", "tlc.py")]
HASHES = {p.name: sha(p) for p in INPUTS}
BASE = (ROOT / "liveness.cfg").read_text()
OUT = Path(tempfile.mkdtemp(prefix="pronto-liveness-"))
print(f"Liveness evidence: {OUT}", flush=True)
CMD = command(OUT)
RESULTS = []


def config(terms=2, flag=None, properties=None, witness=None):
    text = BASE.replace("Terms = 2", f"Terms = {terms}")
    if flag:
        old = f"{flag} = {'FALSE' if flag == 'BrokenDispatch' else 'TRUE'}"
        require(text.count(old) == 1, f"Missing or ambiguous configuration: {old}")
        text = text.replace(old, f"{flag} = {'TRUE' if flag == 'BrokenDispatch' else 'FALSE'}")
    if properties is not None:
        line = next(line for line in text.splitlines() if line.startswith("PROPERTIES "))
        text = text.replace(line, f"PROPERTIES {properties}" if properties else "")
    if witness == "NoCheckpoint":
        text = text.replace("SPECIFICATION ProgressSpec", "SPECIFICATION SeedSpec")
        text = text.replace(" WorkflowType", "")
    if witness:
        text = text.replace("INVARIANTS ", f"INVARIANTS {witness} ")
    return text


def ready(state, terms=2):
    c = state["s"]["control"]
    a = state["s"]["actors"][str(terms - 1)]
    return c["owner"] == c["recovery"] == terms - 1 and c["phase"] == "ready" and a["phase"] == 4 and not a["stopped"]


def check_cause(name, states, actions, terms):
    last = states[-1]
    env, work = last["environment"], last["work"]
    require(0 in last["s"]["acknowledged"], "Counterexample lost its accepted-work antecedent")
    if name.startswith("checkpoint-"):
        require(work["stage"] == "checkpoint" and last["s"]["control"]["recovery"] == 0, "Wrong checkpoint witness")
    elif name == "retry-witness":
        require(work["retried"] and work["posted"] and work["publication"] == "complete", "No successful retry witness")
        require(actions.count("PostReview") == 2 and "ReadmitPublication" in actions, "Witness did not exercise failed and successful POST")
        first, second = [i for i, action in enumerate(actions) if action == "PostReview"]
        require(not states[first]["environment"]["github"] and states[second]["environment"]["github"], "Witness POSTs did not cross GitHub recovery")
    elif name in ("without-scheduler", "without-clock", "without-storage"):
        require(not ready(last) and work["stage"] == "pending" and not last["s"]["actors"]["1"]["stopped"], "Wrong readiness failure")
        expected = {"storage": name != "without-storage", "github": True, "expired": name != "without-clock"}
        require(env == expected, f"Readiness stalled for an unrelated environmental reason: {env}")
    elif name == "without-audit-return":
        require(ready(last) and all(env.values()) and work["dispatched"] and work["stage"] == "running" and work["publication"] == "none", "Wrong hung-audit failure")
    elif name in ("without-github", "without-retry-trigger"):
        require(ready(last) and work["stage"] == "finished" and work["publication"] == "failed" and not work["posted"], "Wrong publication failure")
        require(env == {"storage": True, "github": name != "without-github", "expired": True}, "Wrong publication availability")
        require(work["attempted"] and work["confirmed"] and "PostReview" in actions and "ReadmitPublication" not in actions, "Missing failed POST or unexpected retry")
    elif name == "broken-dispatch":
        require(ready(last) and all(env.values()) and work["stage"] == "pending" and not work["dispatched"], "Deadlock is not the missing dispatch transition")
    else:
        raise RuntimeError(f"Unchecked counterexample cause: {name}")


def run(name, cfg, expected=None, property_name=None, terms=2):
    path = OUT / f"{name}.cfg"
    path.write_text(cfg)
    trace = OUT / f"{name}-trace.json"
    invocation = CMD + ["-metadir", str(OUT / f"{name}-states"), "-config", str(path)]
    if expected:
        invocation += ["-dumpTrace", "json", str(trace)]
    invocation += [str(ROOT / "Liveness.tla")]
    try:
        result = subprocess.run(invocation, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as error:
        (OUT / f"{name}-incomplete.log").write_bytes((error.stdout or b"") + (error.stderr or b""))
        raise RuntimeError(f"Incomplete TLC liveness run: {name}") from error
    log = result.stdout + result.stderr
    (OUT / f"{name}.log").write_text(log)
    errors = re.findall(r"^Error: (.*)$", log, re.M)
    require("Finished in" in log, f"Incomplete TLC invocation: {name}")
    codes = {None: 0, "temporal": 13, "deadlock": 11, "witness": 12}
    expected_errors = {
        None: [],
        "temporal": [f"Temporal property {property_name} was violated.", "The following behavior constitutes a counter-example:"],
        "deadlock": ["Deadlock reached.", "The behavior up to this point is:"],
        "witness": [f"Invariant {property_name} is violated.", "The behavior up to this point is:"],
    }
    require(result.returncode == codes[expected] and errors == expected_errors[expected],
            f"Unexpected TLC outcome in {name}: exit {result.returncode}, {errors}; see {OUT}")
    stats = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue", log)
    require(stats, f"Missing TLC statistics: {name}")
    counts = [int(value.replace(",", "")) for value in stats.groups()]
    if expected in (None, "temporal"):
        require(counts[2] == 0 and "for the complete state space" in log and "Finished checking temporal properties" in log,
                f"Missing completed whole-graph temporal check: {name}")
    if expected is None:
        require("Model checking completed. No error has been found." in log, f"Missing success: {name}")
    row = {"run": name, "terms": terms, "generated": counts[0], "distinct": counts[1], "queue": counts[2],
           "expected": expected, "property": property_name, "config_sha256": sha(path)}
    if expected:
        ce = json.loads(trace.read_text())["counterexample"]
        states = [entry[1] for entry in ce["state"]]
        transitions = ce["action"]
        if expected == "temporal":
            # TLC's JSON includes the synthetic stutter edge, sometimes labelled
            # with the PRECEDING action's name. Check endpoints and the log, not
            # that misleading label. Keep the infinite tail in the summary.
            require(len(transitions) == len(states) and transitions[-1][0] == transitions[-1][2] == ce["state"][-1],
                    "Missing JSON waiting-cycle edge")
            require(re.search(rf"^State {len(states)+1}: Stuttering$", log, re.M), "Missing infinite waiting cycle")
            transitions = transitions[:-1]
            row["cycle"] = {"kind": "stuttering", "at_state": len(states)}
        require(len(transitions) == len(states) - 1 and all(
            edge[0] == ce["state"][i] and edge[2] == ce["state"][i+1] for i, edge in enumerate(transitions)),
            "Unsupported or disconnected trace shape")
        actions = [entry[1]["name"] for entry in transitions]
        check_cause(name, states, actions, terms)
        row.update(actions=actions, last_state=states[-1])
    RESULTS.append(row)
    print(json.dumps({k: v for k, v in row.items() if k not in ("actions", "last_state")}), flush=True)


for terms in (2, 3):
    run(f"all-fair-{terms}", config(terms=terms), terms=terms)
    run(f"checkpoint-{terms}", config(terms=terms, properties="ControlDiscipline", witness="NoCheckpoint"),
        expected="witness", property_name="NoCheckpoint", terms=terms)

# Service/task progress still holds when no external publication retry arrives.
run("without-retry-other-progress", config(flag="RetryTrigger", properties=
    "ControlDiscipline EventuallyReady FailoverCompletes AcceptedDispatches AcceptedFinishes"))

for name, flag, prop in (
    ("without-scheduler", "FairScheduler", "FailoverCompletes"),
    ("without-clock", "FairClock", "FailoverCompletes"),
    ("without-storage", "FairStorage", "FailoverCompletes"),
    ("without-audit-return", "FairAudit", "AcceptedFinishes"),
    ("without-github", "FairGitHub", "PublicationDelivered"),
    ("without-retry-trigger", "RetryTrigger", "PublicationDelivered"),
):
    run(name, config(flag=flag, properties=prop), expected="temporal", property_name=prop)
run("broken-dispatch", config(flag="BrokenDispatch", properties=""), expected="deadlock")
run("retry-witness", config(properties="ControlDiscipline", witness="NoRetryWitness"),
    expected="witness", property_name="NoRetryWitness")

require(all(sha(p) == HASHES[p.name] for p in INPUTS), "Inputs changed during liveness checking; rerun")
(OUT / "manifest.json").write_text(json.dumps(HASHES, indent=2))
(OUT / "summary.json").write_text(json.dumps(RESULTS, indent=2))
print(f"PASS: conditional progress, six expected waiting cycles, deadlock control and three reachability witnesses. Evidence: {OUT}", flush=True)
