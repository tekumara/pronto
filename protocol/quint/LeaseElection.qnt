// One tick = 5 seconds. Two terms and one operation per term keep the joint
// leadership and recovery-history exploration finite.
module LeaseElection {
  const Skew: int
  const Jump: bool
  const BrokenCAS: bool
  const Revive: bool
  const CachedCheck: bool
  const UnsafeAck: bool
  const EarlyPromotion: bool
  const WrongBaseline: bool
  const RebaseMutation: bool

  pure val NODES = Set(0, 1)
  pure val TTL = 6
  pure val MARGIN = 1
  pure val MAX_TIME = 7

  // Revision abstracts UUID/ETag identity as a generation counter. Owner IDs are not epoch order.
  type Control = { revision: int, owner: int, expires: int, phase: str, recovery: int }
  type Pending = { kind: str, expected: int, start: int, expires: int,
                   phase: str, recovery: int, outcome: str, resultRevision: int }
  type History = int
  type Actor = { stage: str, head: int, headRecovery: int, deadline: int,
                 ready: bool, stopped: bool, acquired: bool, baseline: bool,
                 selectedHistory: int, prefixHistory: int,
                 renewed: bool, released: bool, seen: Control, pending: Pending, barrier: str }
  type State = { now: int, offset: int, control: Control, actors: int -> Actor,
                 acknowledged: History,
                 badCAS: bool, badRevival: bool, badRecovery: bool, badObservation: bool,
                 badControlDiscipline: bool }
  var s: State

  // A two-bit set represents operation IDs 0 and 1; histories are membership-only.
  pure val emptyHistory: History = 0
  pure def historyHas(history, i) =
    if (i == 0) history == 1 or history == 3 else history == 2 or history == 3
  pure def historyAdd(history, i) =
    if (historyHas(history, i)) history else history + (if (i == 0) 1 else 2)
  pure def historySubset(left, right) =
    (not(historyHas(left, 0)) or historyHas(right, 0)) and
      (not(historyHas(left, 1)) or historyHas(right, 1))
  pure val emptyControl: Control = { revision: 0, owner: -1, expires: 0, phase: "idle", recovery: -1 }
  pure val emptyPending: Pending = { kind: "", expected: 0, start: 0, expires: 0,
    phase: "idle", recovery: -1, outcome: "", resultRevision: 0 }
  pure val emptyActor: Actor = { stage: "new", head: 0, headRecovery: -1, deadline: 0,
    ready: false, stopped: false, acquired: false, baseline: false,
    selectedHistory: -1, prefixHistory: emptyHistory,
    renewed: false, released: false, seen: emptyControl, pending: emptyPending, barrier: "idle" }

  def actor(i) = s.actors.get(i)
  def localHistory(i) = if (actor(i).barrier == "idle") actor(i).selectedHistory
    else historyAdd(actor(i).selectedHistory, i)
  def hasUploaded(i) = actor(i).barrier.in(Set("uploaded", "synced", "observed", "returned", "failed", "rejected"))
  def recoveryHistory = if (s.control.recovery == 0) actor(0).prefixHistory
    else if (s.control.recovery == 1) actor(1).prefixHistory else emptyHistory
  def wall(i) = s.now + (if (i == 1) s.offset else 0)
  def live(i) = not(actor(i).stopped) and s.now < actor(i).deadline
  def locallyReady(i) = actor(i).ready and live(i)
  def confirms(i) = and {
    s.control.owner == i, s.control.phase == "ready", s.control.recovery == i,
    s.control.expires > wall(i) + MARGIN,
  }

  action init = s' = { now: 0, offset: if (Jump) 0 else Skew, control: emptyControl,
    actors: NODES.mapBy(_ => emptyActor), acknowledged: emptyHistory,
    badCAS: false, badRevival: false, badRecovery: false, badObservation: false,
    badControlDiscipline: false }

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
    val resultingControl = if (succeeds) nextControl else s.control
    // Recovery IDs name actors, not ordered terms; check applicable pointer transitions only.
    val controlViolation = resultingControl.revision < s.control.revision or
      (resultingControl.revision == s.control.revision and resultingControl != s.control) or
      (resultingControl.phase == "bootstrapping" and
        resultingControl.recovery != s.control.recovery) or
      (p.expected != s.control.revision and resultingControl != s.control)
    all {
      p.outcome == "request",
      s' = { ...s, control: resultingControl,
        actors: s.actors.set(i, { ...a, pending: { ...p,
          outcome: if (succeeds) "ok" else "conflict",
          resultRevision: if (succeeds) nextControl.revision else s.control.revision } }),
        badCAS: s.badCAS or (succeeds and p.expected != s.control.revision),
        badRecovery: s.badRecovery or (succeeds and
          (if (p.kind == "promote") not(a.baseline)
           else p.recovery != s.control.recovery)),
        badControlDiscipline: s.badControlDiscipline or controlViolation,
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
            stage: if (p.kind == "promote" or a.ready) "ready" else "bootstrapping",
            acquired: true, head: p.resultRevision, headRecovery: p.recovery,
            deadline: p.start + TTL - MARGIN, stopped: false,
            ready: p.kind == "promote" or a.ready }
          else { ...a, pending: emptyPending, stopped: true, ready: false,
            acquired: a.acquired or (p.kind == "acquire" and p.outcome == "ok" and not(lost)),
            head: if (p.outcome == "ok" and not(lost)) p.resultRevision else a.head,
            headRecovery: if (p.outcome == "ok" and not(lost)) p.recovery else a.headRecovery,
            deadline: if (p.kind == "acquire" and p.outcome == "ok" and not(lost))
              p.start + TTL - MARGIN else a.deadline,
            stage: if (a.acquired) a.stage else "spent" }),
      },
    }
  }

  // Selection freezes the source history. Baseline creates an independent prefix from it.
  action selectSource(i) = {
    val a = actor(i)
    val selectedHistory = if (a.headRecovery == -1) emptyHistory
      else actor(a.headRecovery).prefixHistory
    all {
      a.stage == "bootstrapping", live(i), a.selectedHistory == -1,
      if (a.headRecovery == -1) true else actor(a.headRecovery).baseline,
      s' = { ...s, actors: s.actors.set(i, { ...a, selectedHistory: selectedHistory }) },
    }
  }
  action baseline(i) = {
    val a = actor(i)
    val installedHistory = if (WrongBaseline) emptyHistory else a.selectedHistory
    all {
      a.stage == "bootstrapping", live(i), a.selectedHistory >= 0, not(a.baseline),
      s' = { ...s, actors: s.actors.set(i, { ...a,
        baseline: true, prefixHistory: installedHistory }) },
    }
  }
  // One logical operation per term. Its upload may finish after local loss.
  action commit(i) = all {
    locallyReady(i), actor(i).barrier == "idle",
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), barrier: "committed" }) },
  }
  action upload(i) = all {
    actor(i).baseline, actor(i).barrier == "committed",
    s' = { ...s, actors: s.actors.set(i, { ...actor(i),
      prefixHistory: localHistory(i), barrier: "uploaded" }) },
  }
  action earlyAcknowledge(i) = all {
    UnsafeAck, actor(i).barrier == "committed", not(historyHas(s.acknowledged, i)),
    s' = { ...s, acknowledged: historyAdd(s.acknowledged, i) },
  }
  action prepareMutation(i, promote) = {
    val a = actor(i)
    val expected = if (RebaseMutation) s.control.revision else a.head
    all {
      a.acquired, live(i), a.pending.kind == "",
      if (promote) a.stage == "bootstrapping" and (a.baseline or EarlyPromotion) else not(a.renewed),
      s' = { ...s, actors: s.actors.set(i, { ...a, renewed: a.renewed or not(promote),
        pending: { kind: if (promote) "promote" else "renew", expected: expected,
          start: s.now, expires: wall(i) + TTL,
          phase: if (promote or a.ready) "ready" else "bootstrapping",
          recovery: if (promote) i else a.headRecovery, outcome: "request", resultRevision: 0 } }) },
    }
  }
  action lose(i) = all {
    actor(i).acquired, not(actor(i).stopped),
    s' = { ...s, actors: s.actors.set(i, { ...actor(i), stopped: true, ready: false }) },
  }
  // Cleanup waits for the serialized mutation; then a NEW fresh read may release only its own term.
  action prepareRelease(i) = all {
    actor(i).acquired, actor(i).stopped, not(actor(i).released), actor(i).pending.kind == "",
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
    locallyReady(i), actor(i).barrier == "uploaded",
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
  action deliver(i) = {
    val accepted = actor(i).barrier == "observed" and locallyReady(i)
    all {
      actor(i).barrier.in(Set("observed", "failed")),
      s' = { ...s,
        acknowledged: if (accepted) historyAdd(s.acknowledged, i) else s.acknowledged,
        actors: s.actors.set(i,
          if (accepted) { ...actor(i), barrier: "returned" }
          else { ...actor(i), barrier: "rejected", stopped: true, ready: false }) },
    }
  }
  action tick = all { s.now < MAX_TIME, s' = { ...s, now: s.now + 1 } }
  action jumpClock = all {
    Jump, s.offset == 0, NODES.exists(i => locallyReady(i)),
    s' = { ...s, offset: Skew },
  }

  action step = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      selectSource(i), baseline(i), prepareMutation(i, true), prepareMutation(i, false),
      commit(i), upload(i), earlyAcknowledge(i), lose(i), prepareRelease(i),
      sync(i), observe(i), deliver(i), tick, jumpClock }
  }

  // Joint election/history projection: no renewal or cleanup churn, but clocks,
  // takeover, source selection, upload and delayed acknowledgement interleave.
  action recoveryStep = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      selectSource(i), baseline(i), prepareMutation(i, true), commit(i), upload(i),
      sync(i), observe(i), deliver(i), tick }
  }

  // Focused projections retain source selection and baseline construction.
  action leaseStep = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      selectSource(i), baseline(i), prepareMutation(i, true), prepareMutation(i, false), tick, jumpClock }
  }
  // Control lifecycle and history barrier at fixed time, including cleanup.
  action controlStep = {
    nondet i = NODES.oneOf()
    any { readAcquisition(i), prepareAcquisition(i), cas(i), response(i, false), response(i, true),
      selectSource(i), baseline(i), prepareMutation(i, true), prepareMutation(i, false),
      commit(i), upload(i), earlyAcknowledge(i), lose(i), prepareRelease(i),
      sync(i), observe(i), deliver(i) }
  }

  val singleReady = NODES.filter(i => locallyReady(i)).size() <= 1
  val typeOK = and {
    s.now.in(0.to(MAX_TIME)), s.control.owner.in(NODES.union(Set(-1))),
    s.control.recovery.in(NODES.union(Set(-1))), s.control.revision.in(0.to(8)),
    s.acknowledged.in(0.to(3)),
    (s.control.phase == "idle") == (s.control.owner == -1),
    NODES.forall(i => actor(i).selectedHistory.in(Set(-1, 0, 1, 2, 3))),
    NODES.forall(i => actor(i).prefixHistory.in(0.to(3))),
    NODES.forall(i => actor(i).ready implies (actor(i).acquired and actor(i).baseline)),
  }
  val ackRecoverable = historySubset(s.acknowledged, recoveryHistory)
  val completeBaseline = and {
    NODES.forall(i => s.control.recovery != i or actor(i).baseline),
    NODES.forall(i => s.control.phase != "ready" or s.control.owner != i or
      (s.control.recovery == i and actor(i).baseline)),
  }
  val baselineContainsSelected = and {
    NODES.forall(i => not(actor(i).baseline) or
      (if (hasUploaded(i)) actor(i).prefixHistory == localHistory(i)
       else actor(i).prefixHistory == actor(i).selectedHistory)),
  }
  val mutationUsesObservedHead = NODES.forall(i =>
    not(actor(i).pending.kind.in(Set("promote", "renew"))) or
      actor(i).pending.expected == actor(i).head)
  val controlDiscipline = not(s.badControlDiscipline)
  val protocolSafety = and {
    typeOK, ackRecoverable, completeBaseline, baselineContainsSelected,
    mutationUsesObservedHead, controlDiscipline,
    not(s.badCAS), not(s.badRevival), not(s.badRecovery), not(s.badObservation),
  }
  val safety = protocolSafety and singleReady

}

module WithinMargin {
  import LeaseElection(Skew = 1, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module ExcessSkew {
  import LeaseElection(Skew = 2, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module ForwardJump {
  import LeaseElection(Skew = 2, Jump = true, BrokenCAS = false, Revive = false, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module BackwardJump {
  import LeaseElection(Skew = -2, Jump = true, BrokenCAS = false, Revive = false, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module NoCAS {
  import LeaseElection(Skew = 0, Jump = false, BrokenCAS = true, Revive = false, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module LateRenewal {
  import LeaseElection(Skew = 0, Jump = false, BrokenCAS = false, Revive = true, CachedCheck = false,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
module CachedConfirmation {
  import LeaseElection(Skew = 2, Jump = false, BrokenCAS = false, Revive = false, CachedCheck = true,
    UnsafeAck = false, EarlyPromotion = false, WrongBaseline = false, RebaseMutation = false).*
}
