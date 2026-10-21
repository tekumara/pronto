#!/usr/bin/env python3
"""Bounded protocol model, not a Litestream/S3 integration test.

Independent contracts:
* An acknowledged operation must be present in the authoritative recovery log.
* A successful publication must extend, not replace, the committed log.

Credible regressions are a post-takeover upload acknowledgement and retrying a
stale publication with a new ETag without checking its term. There is no existing
protocol implementation or coverage to extend. This model needs no production
seams. Object bytes, SQLite, clocks, deletion and IAM are deliberately abstracted.
CAS revisions are unique integers. Uploads are atomic and append-only. Strong
ownership GETs are separate transitions, not atomic with uploads or responses.
Takeover may happen at any time (a stronger safety adversary than waiting for expiry).
Each term has one application operation, at most two commit CAS attempts, and one
renewal. Processes may pause between any two transitions, including indefinitely.
"""
from collections import deque
from dataclasses import dataclass, replace
import argparse
import json


@dataclass(frozen=True)
class Actor:
    # 0 absent, 1 acquired, 2 restored, 3 seeded, 4 serving
    phase: int = 0
    source: tuple = ()
    local: tuple = ()
    versions: tuple = ()
    written: bool = False
    pending: tuple = ()  # kind, expected_revision
    receipt: int = 0  # 0 none, 1 response pending, 2 received, 3 lost
    acked: bool = False
    attempts: int = 0
    failed_commit_cas: bool = False
    renewed: bool = False


@dataclass(frozen=True)
class State:
    owner: int
    revision: int
    ready: bool
    ref: tuple
    actors: tuple
    acknowledged: int = 0


def initial(terms):
    a = Actor(phase=4, source=(0, 1), versions=((),))
    return State(0, 0, True, (0, 1), (a,) + (Actor(),) * (terms - 1))


def set_actor(s, i, a, **changes):
    actors = list(s.actors)
    actors[i] = a
    return replace(s, actors=tuple(actors), **changes)


def history(s, ref, mode):
    term, txid = ref
    versions = s.actors[term].versions
    if mode in ('naive', 'postcheck', 'precheck'):
        return versions[-1]  # Prefix discovery means latest at this read.
    return versions[txid - 1]


def extends(new, old):
    return new[:len(old)] == old


def transitions(s, mode):
    # Successful ownership CAS preserves the published recovery reference.
    nxt = s.owner + 1
    if nxt < len(s.actors) and s.actors[nxt].phase == 0:
        a = Actor(phase=1, source=s.ref)
        yield f'{chr(65+nxt)} takes ownership; preserves recovery reference', set_actor(
            s, nxt, a, owner=nxt, revision=s.revision+1, ready=False)

    for i, a in enumerate(s.actors):
        name = chr(65+i)
        if a.phase == 1:
            local = history(s, a.source, mode)
            yield f'{name} restores source {a.source} -> {list(local)}', set_actor(
                s, i, replace(a, phase=2, local=local))
        if a.phase == 2:
            yield f'{name} uploads complete baseline', set_actor(
                s, i, replace(a, phase=3, versions=(a.local,)))
        if a.phase == 3 and not a.pending and s.owner == i and not s.ready:
            yield f'{name} prepares promotion at revision {s.revision}', set_actor(
                s, i, replace(a, pending=('promote', s.revision)))
        if a.phase == 4 and not a.written:
            yield f'{name} commits local operation {name}', set_actor(
                s, i, replace(a, written=True, local=a.local+(i,)))
        if a.phase == 4 and a.written and len(a.versions) == 1:
            # The old owner can finish this upload after any later takeover.
            yield f'{name} upload finishes', set_actor(
                s, i, replace(a, versions=a.versions+(a.local,)))
        if mode in ('naive', 'postcheck', 'precheck'):
            uploaded = len(a.versions) == 2
            if mode != 'naive':
                can_check = uploaded if mode == 'postcheck' else a.written
                if (can_check and not a.receipt and s.owner == i
                        and s.ready and s.ref[0] == i):
                    yield f'{name} strongly reads control: still ready owner', set_actor(
                        s, i, replace(a, receipt=2))
            if uploaded and not a.acked and (mode == 'naive' or a.receipt == 2):
                yield f'{name} acknowledges its uploaded operation', set_actor(
                    s, i, replace(a, acked=True),
                    acknowledged=s.acknowledged | (1 << i))
        else:
            can_read = (s.owner == i and s.ready and s.ref[0] == i)
            if mode == 'blind-retry' and a.failed_commit_cas:
                can_read = True  # Deliberate mutation: fresh ETag after 412, ignore term.
            if (a.phase == 4 and len(a.versions) == 2 and not a.acked
                    and not a.pending and a.receipt in (0, 3)
                    and a.attempts < 2 and can_read):
                yield f'{name} prepares commit CAS at revision {s.revision}', set_actor(
                    s, i, replace(a, pending=('commit', s.revision),
                                  receipt=0, attempts=a.attempts+1))
            if a.receipt == 1:
                yield f'{name} receives successful CAS response', set_actor(
                    s, i, replace(a, receipt=2))
                yield f'{name} loses successful CAS response', set_actor(
                    s, i, replace(a, receipt=3))
            if a.receipt == 2 and not a.acked:
                # A valid CAS receipt can arrive after a takeover. Its effects
                # must already be inherited by the new recovery reference.
                yield f'{name} acknowledges CAS-covered operation', set_actor(
                    s, i, replace(a, acked=True),
                    acknowledged=s.acknowledged | (1 << i))
        if a.pending:
            kind, expected = a.pending
            if expected != s.revision:
                yield f'{name} {kind} CAS fails on stale revision', set_actor(
                    s, i, replace(a, pending=(),
                                  failed_commit_cas=a.failed_commit_cas or kind == 'commit'))
            elif kind == 'promote':
                yield f'{name} promotion CAS succeeds', set_actor(
                    s, i, replace(a, pending=(), phase=4),
                    ref=(i, 1), revision=s.revision+1, ready=True)
            else:
                yield f'{name} commit CAS succeeds', set_actor(
                    s, i, replace(a, pending=(), receipt=1),
                    ref=(i, 2), revision=s.revision+1)
        if a.phase and not a.renewed and s.owner == i:
            # An atomic successful renewal CAS always preserves the latest head.
            # Its revision change can invalidate another pending publication.
            yield f'{name} renews lease without changing recovery reference', set_actor(
                s, i, replace(a, renewed=True), revision=s.revision+1)


def violation(before, after, mode):
    recovered = history(after, after.ref, mode)
    mask = sum(1 << operation for operation in recovered)
    if after.acknowledged & ~mask:
        missing = [chr(65+i) for i in range(len(after.actors))
                   if after.acknowledged & ~mask & (1 << i)]
        return f'acknowledged operations absent from authoritative recovery: {missing}'
    if mode in ('fenced', 'blind-retry') and before.ref != after.ref:
        old = history(before, before.ref, mode)
        if not extends(recovered, old):
            return f'publication replaced committed history: {list(old)} -> {list(recovered)}'
    return None


def check(mode, terms, max_depth=None, max_states=2_000_000):
    start = initial(terms)
    queue = deque([(start, 0)])
    parent = {start: None}
    edges = 0
    max_seen = 0
    truncated = False
    while queue:
        s, depth = queue.popleft()
        max_seen = max(max_seen, depth)
        if max_depth is not None and depth >= max_depth:
            truncated = True
            continue
        for label, n in transitions(s, mode):
            edges += 1
            why = violation(s, n, mode)
            if why:
                trace = [(label, n)]
                cursor = s
                while parent[cursor] is not None:
                    prev, action = parent[cursor]
                    trace.append((action, cursor))
                    cursor = prev
                trace.reverse()
                return {'mode': mode, 'terms': terms, 'states': len(parent),
                        'transitions': edges, 'counterexample': why,
                        'trace': [action for action, _ in trace]}
            if n not in parent:
                if len(parent) >= max_states:
                    return {'mode': mode, 'terms': terms, 'states': len(parent),
                            'transitions': edges, 'incomplete': 'state limit'}
                parent[n] = (s, label)
                queue.append((n, depth+1))
    return {'mode': mode, 'terms': terms, 'states': len(parent),
            'transitions': edges, 'counterexample': None,
            'max_depth': max_seen, 'depth_limited': truncated}


def retention_counterexample():
    # Independent storage-level contract: a published endpoint must retain a
    # complete path to that endpoint, not merely newer compacted data.
    target = 2
    ltx = [(1, 1), (2, 2)]
    assert any(end == target for _, end in ltx)
    # A later compaction crosses the endpoint, then deletes its inputs.
    ltx = [(1, 3)]
    current = 0
    for start, end in ltx:
        if start <= current+1 and end <= target:
            current = end
    assert current < target
    return {'counterexample': 'compaction + deleting old L0 files makes published TXID 2 unrestorable',
            'retained_ranges': ltx, 'target': target}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--mode', choices=['naive', 'postcheck', 'precheck', 'fenced', 'blind-retry', 'retention'], required=True)
    p.add_argument('--terms', type=int, default=2)
    p.add_argument('--depth', type=int)
    p.add_argument('--max-states', type=int, default=2_000_000)
    args = p.parse_args()
    result = retention_counterexample() if args.mode == 'retention' else check(
        args.mode, args.terms, args.depth, args.max_states)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
