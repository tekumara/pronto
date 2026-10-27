// One tick = 5 seconds. This models leadership, not the existing recovery-history model.
module LeaseElection {
  const Skew: int
  const Jump: bool
  const BrokenCAS: bool
  const Revive: bool
  const CachedCheck: bool

  pure val NODES = Set(0, 1)
  pure val TTL = 6
  pure val MARGIN = 1
  pure val MAX_TIME = 7

  type Control = { revision: int, owner: int, expires: int, phase: str, recovery: int }
  type Pending = { kind: str, expected: int, start: int, expires: int,
                   phase: str, recovery: int, outcome: str, resultRevision: int }
  type Actor = { stage: str, head: int, headRecovery: int, deadline: int,
                 stopped: bool, baseline: bool, renewed: bool, released: bool,
                 seen: Control, pending: Pending, barrier: str }
  type State = { now: int, offset: int, control: Control, actors: int -> Actor,
                 badCAS: bool, badRevival: bool, badRecovery: bool, badObservation: bool }
  var s: State

  pure val emptyControl: Control = { revision: 0, owner: -1, expires: 0, phase: "idle", recovery: -1 }
  pure val emptyPending: Pending = { kind: "", expected: 0, start: 0, expires: 0,
    phase: "idle", recovery: -1, outcome: "", resultRevision: 0 }
  pure val emptyActor: Actor = { stage: "new", head: 0, headRecovery: -1, deadline: 0,
    stopped: false, baseline: false, renewed: false, released: false,
    seen: emptyControl, pending: emptyPending, barrier: "idle" }

  def actor(i) = s.actors.get(i)
  // Derived state, not independent bookkeeping: a positive head records an observed acquisition;
  // stopped masks the historical ready stage. The monotonic deadline remains separate.
  def acquired(i) = actor(i).head > 0
  def ready(i) = actor(i).stage == "ready" and not(actor(i).stopped)
  def wall(i) = s.now + (if (i == 1) s.offset else 0)
  def live(i) = not(actor(i).stopped) and s.now < actor(i).deadline
  def locallyReady(i) = ready(i) and live(i)
  def confirms(i) = and {
    s.control.owner == i, s.control.phase == "ready", s.control.recovery == i,
    s.control.expires > wall(i) + MARGIN,
  }

  action init = s' = { now: 0, offset: if (Jump) 0 else Skew, control: emptyControl,
    actors: NODES.mapBy(_ => emptyActor), badCAS: false, badRevival: false,
    badRecovery: false, badObservation: false }

  // Strong GET observation and its delayed delivery/preparation are separate.
  // An ineligible standby can poll again. Each node represents ONE unique incarnation.
  action readAcquisition(i) = all {
    actor(i).stage.in(Set("new", "observed")),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), stage: "observed", seen: s.control }) },
  }
  action prepareAcquisition(i) = all {
    actor(i).stage == "observed",
    actor(i).seen.owner == -1 or actor(i).seen.expires <= wall(i),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), stage: "candidate", seen: emptyControl,
      pending: { kind: "acquire", expected: actor(i).seen.revision, start: s.now,
        expires: wall(i) + TTL, phase: "bootstrapping", recovery: actor(i).seen.recovery,
        outcome: "request", resultRevision: 0 } }) },
  }

  // A request can linearize after its process loses authority. Only its captured ETag matters.
  action cas(i) = {
    val a = actor(i)
    val p = a.pending
    val succeeds = p.expected == s.control.revision or BrokenCAS
    val nextControl: Control = { revision: s.control.revision + 1,
      owner: if (p.kind == "release") -1 else i,
      expires: p.expires, phase: p.phase, recovery: p.recovery }
    all {
      p.outcome == "request",
      s' = { ...s, control: if (succeeds) nextControl else s.control,
        actors: s.actors.set(i, { ...a, pending: { ...p,
          outcome: if (succeeds) "ok" else "conflict",
          resultRevision: if (succeeds) nextControl.revision else s.control.revision } }),
        badCAS: s.badCAS or (succeeds and p.expected != s.control.revision),
        badRecovery: s.badRecovery or (succeeds and
          (if (p.kind == "promote") not(a.baseline)
           else p.recovery != s.control.recovery)),
      },
    }
  }

  // The post-await live() uses the OLD deadline, before installing a renewed deadline.
  // Lost responses and conflicts fail closed. A lost acquire response creates no local term.
  action response(i, lost) = {
    val a = actor(i)
    val p = a.pending
    val oldLive = if (p.kind == "acquire") s.now < p.start + TTL - MARGIN else live(i)
    val accept = p.outcome == "ok" and not(lost) and
      (oldLive or (Revive and p.kind == "renew"))
    all {
      p.outcome.in(Set("ok", "conflict")),
      s' = { ...s,
        badRevival: s.badRevival or (accept and p.kind == "renew" and not(oldLive)),
        actors: s.actors.set(i,
          if (p.kind == "release") { ...a, pending: emptyPending, stage: "spent" }
          else if (accept) { ...a, pending: emptyPending,
            stage: if (p.kind == "promote" or ready(i)) "ready" else "bootstrapping",
            head: p.resultRevision, headRecovery: p.recovery,
            deadline: p.start + TTL - MARGIN, stopped: false }
          else { ...a, pending: emptyPending, stopped: true,
            head: if (p.outcome == "ok" and not(lost)) p.resultRevision else a.head,
            headRecovery: if (p.outcome == "ok" and not(lost)) p.recovery else a.headRecovery,
            deadline: if (p.kind == "acquire" and p.outcome == "ok" and not(lost))
              p.start + TTL - MARGIN else a.deadline,
            stage: if (acquired(i)) a.stage else "spent" }),
      },
    }
  }

  // Restore, child startup, recovery staging and baseline sync are condensed here.
  // There is no task dispatch until promotion's successful response.
  action baseline(i) = all {
    actor(i).stage == "bootstrapping", live(i), not(actor(i).baseline),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), baseline: true }) },
  }
  action prepareMutation(i, promote) = {
    val a = actor(i)
    all {
      acquired(i), live(i), a.pending.kind == "",
      if (promote) a.stage == "bootstrapping" and a.baseline else not(a.renewed),
      s' = { ...s, actors: s.actors.set(i, { ...a, renewed: a.renewed or not(promote),
        pending: { kind: if (promote) "promote" else "renew", expected: a.head,
          start: s.now, expires: wall(i) + TTL,
          phase: if (promote or ready(i)) "ready" else "bootstrapping",
          recovery: if (promote) i else a.headRecovery, outcome: "request", resultRevision: 0 } }) },
    }
  }
  action lose(i) = all {
    acquired(i), not(actor(i).stopped),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), stopped: true }) },
  }
  // Cleanup waits for the serialized mutation; then a NEW fresh read may release only its own term.
  action prepareRelease(i) = all {
    acquired(i), actor(i).stopped, not(actor(i).released), actor(i).pending.kind == "",
    s.control.owner == i,
    (s.control.phase == "ready" and s.control.recovery == i) or
      (s.control.phase == "bootstrapping" and s.control.recovery == actor(i).headRecovery),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), released: true,
      pending: { kind: "release", expected: s.control.revision, start: s.now, expires: 0,
        phase: "idle", recovery: s.control.recovery, outcome: "request", resultRevision: 0 } }) },
  }

  // Sync, strong GET observation, and response delivery are NOT one atomic check.
  // A successful old-owner observation may be delivered after takeover; this is not hard fencing.
  action sync(i) = all {
    locallyReady(i), actor(i).barrier == "idle",
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), barrier: "synced" }) },
  }
  action observe(i) = {
    val accepted = confirms(i) or (CachedCheck and locallyReady(i))
    all {
      actor(i).barrier == "synced",
      s' = { ...s, badObservation: s.badObservation or (accepted and not(confirms(i))),
        actors: s.actors.set(i, { ...actor(i), barrier: if (accepted) "observed" else "failed" }) },
    }
  }
  action deliver(i) = all {
    actor(i).barrier.in(Set("observed", "failed")),
    s' = { ...s, actors: s.actors.set(i,
      if (actor(i).barrier == "observed" and locallyReady(i)) { ...actor(i), barrier: "returned" }
      else { ...actor(i), barrier: "rejected", stopped: true }) },
  }
  action tick = all { s.now < MAX_TIME, s' = { ...s, now: s.now + 1 } }
  action jumpClock = all {
    Jump, s.offset == 0, NODES.exists(i => locallyReady(i)),
    s' = { ...s, offset: Skew },
  }

  action step = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      baseline(i), prepareMutation(i, true), prepareMutation(i, false), lose(i), prepareRelease(i),
      sync(i), observe(i), deliver(i), tick, jumpClock }
  }

  // Focused projections reduce independent bookkeeping, without changing any included action.
  // Lease checks allow delayed/lost responses but omit cleanup and application barriers.
  action leaseStep = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      baseline(i), prepareMutation(i, true), prepareMutation(i, false), tick, jumpClock }
  }
  // Control lifecycle and barriers at fixed time, including cancellation and conditional release.
  action controlStep = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      baseline(i), prepareMutation(i, true), prepareMutation(i, false), lose(i), prepareRelease(i),
      sync(i), observe(i), deliver(i) }
  }

  val singleReady = NODES.filter(i => locallyReady(i)).size() <= 1
  val typeOK = and {
    s.now.in(0.to(MAX_TIME)), s.control.owner.in(NODES.union(Set(-1))),
    s.control.recovery.in(NODES.union(Set(-1))), s.control.revision.in(0.to(8)),
    (s.control.phase == "idle") == (s.control.owner == -1),
    NODES.forall(i => ready(i) implies (acquired(i) and actor(i).baseline)),
  }
  val completePointer = s.control.phase == "ready" implies
    (s.control.recovery == s.control.owner and actor(s.control.owner).baseline)
  val protocolSafety = typeOK and completePointer and not(s.badCAS) and not(s.badRevival)
    and not(s.badRecovery) and not(s.badObservation)
  val safety = protocolSafety and singleReady

}

module Synchronized {
  import LeaseElection(Skew = 0, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = false).*
}
module WithinMargin {
  import LeaseElection(Skew = 1, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = false).*
}
module ExcessSkew {
  import LeaseElection(Skew = 2, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = false).*
}
module ForwardJump {
  import LeaseElection(Skew = 2, Jump = true, BrokenCAS = false, Revive = false, CachedCheck = false).*
}
module BackwardJump {
  import LeaseElection(Skew = -2, Jump = true, BrokenCAS = false, Revive = false, CachedCheck = false).*
}
module NoCAS {
  import LeaseElection(Skew = 0, Jump = false, BrokenCAS = true, Revive = false, CachedCheck = false).*
}
module LateRenewal {
  import LeaseElection(Skew = 0, Jump = false, BrokenCAS = false, Revive = true, CachedCheck = false).*
}
module CachedConfirmation {
  import LeaseElection(Skew = 2, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = true).*
}
