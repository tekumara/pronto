// Deterministic schedules are separate from the checker input to keep compiled IR small.
module Scenarios {
  const CfgSkew: int
  const CfgJump: bool
  const CfgBrokenCAS: bool
  const CfgRevive: bool
  const CfgCachedCheck: bool
  const CfgUnsafeAck: bool
  const CfgEarlyPromotion: bool
  const CfgWrongBaseline: bool
  const CfgRebaseMutation: bool
  import LeaseElection(Skew = CfgSkew, Jump = CfgJump, BrokenCAS = CfgBrokenCAS,
    Revive = CfgRevive, CachedCheck = CfgCachedCheck, UnsafeAck = CfgUnsafeAck,
    EarlyPromotion = CfgEarlyPromotion, WrongBaseline = CfgWrongBaseline,
    RebaseMutation = CfgRebaseMutation).* from "./LeaseElection"

  // Deterministic schedules are model regressions and reachability witnesses, not extra assumptions.
  run acquireA = init.then(readAcquisition(0)).then(prepareAcquisition(0)).then(cas(0))
    .then(response(0, false)).then(selectSource(0)).then(baseline(0))
    .then(prepareMutation(0, true)).then(cas(0)).then(response(0, false)).expect(locallyReady(0))
  run competingInitializationTest = init.then(readAcquisition(0)).then(readAcquisition(1))
    .then(prepareAcquisition(0)).then(prepareAcquisition(1)).then(cas(0)).then(cas(1))
    .expect(actor(1).pending.outcome == "conflict" and protocolSafety)
  run expiredAcquisitionTest = init.then(readAcquisition(0)).then(prepareAcquisition(0))
    .then(cas(0)).then(5.reps(_ => tick)).then(response(0, false))
    .expect(actor(0).stopped and not(locallyReady(0)) and protocolSafety)
  run delayedRenewalTest = acquireA.then(prepareMutation(0, false)).then(cas(0))
    .then(5.reps(_ => tick)).then(response(0, false))
    .expect(actor(0).stopped and not(s.badRevival))
  run ambiguousPromotionTest = init.then(readAcquisition(0)).then(prepareAcquisition(0)).then(cas(0))
    .then(response(0, false)).then(selectSource(0)).then(baseline(0)).then(prepareMutation(0, true))
    .then(cas(0)).then(response(0, true))
    .expect(s.control.recovery == 0 and actor(0).stopped and not(locallyReady(0)))
  run skewOverlap = acquireA.then(4.reps(_ => tick)).then(readAcquisition(1))
    .then(prepareAcquisition(1)).then(cas(1)).then(response(1, false)).then(selectSource(1))
    .then(baseline(1)).then(prepareMutation(1, true)).then(cas(1)).then(response(1, false))
  run skewOverlapTest = skewOverlap.expect(not(singleReady) and protocolSafety)
  run staleCheckTest = skewOverlap.then(commit(0)).then(upload(0)).then(sync(0)).then(observe(0))
    .then(deliver(0)).expect(actor(0).barrier == "rejected" and not(locallyReady(0)) and protocolSafety)
  // A's read linearizes before takeover; its acknowledgement can arrive after B is ready.
  // B must select and baseline from the already-uploaded operation in A's prefix.
  run delayedObservationTest = acquireA.then(commit(0)).then(upload(0)).then(4.reps(_ => tick))
    .then(sync(0)).then(observe(0)).then(readAcquisition(1)).then(prepareAcquisition(1))
    .then(cas(1)).then(response(1, false)).then(selectSource(1)).then(baseline(1))
    .then(prepareMutation(1, true)).then(cas(1)).then(response(1, false)).then(deliver(0))
    .expect(actor(0).barrier == "returned" and s.control.owner == 1
      and historyHas(s.acknowledged, 0) and historyHas(actor(1).prefixHistory, 0)
      and ackRecoverable and completeBaseline and baselineContainsSelected and protocolSafety)
  run forwardJumpTest = acquireA.then(4.reps(_ => tick)).then(jumpClock)
    .then(readAcquisition(1)).then(prepareAcquisition(1)).then(cas(1)).then(response(1, false))
    .then(selectSource(1)).then(baseline(1)).then(prepareMutation(1, true))
    .then(cas(1)).then(response(1, false))
    .expect(not(singleReady) and protocolSafety)
  run backwardJumpTest = init.then(readAcquisition(1)).then(prepareAcquisition(1)).then(cas(1))
    .then(response(1, false)).then(selectSource(1)).then(baseline(1)).then(prepareMutation(1, true))
    .then(cas(1)).then(response(1, false)).then(tick).then(jumpClock).then(prepareMutation(1, false))
    .then(cas(1)).then(response(1, false)).then(4.reps(_ => tick))
    .then(readAcquisition(0)).then(prepareAcquisition(0)).then(cas(0)).then(response(0, false))
    .then(selectSource(0)).then(baseline(0)).then(prepareMutation(0, true))
    .then(cas(0)).then(response(0, false))
    .expect(not(singleReady) and protocolSafety)
  run lateRenewalMutationTest = acquireA.then(4.reps(_ => tick)).then(prepareMutation(0, false))
    .then(cas(0)).then(2.reps(_ => tick)).then(response(0, false))
    .expect(s.badRevival and locallyReady(0))

  run earlyAcknowledgementTest = acquireA.then(commit(0)).then(earlyAcknowledge(0))
    .expect(not(ackRecoverable))
  run earlyPromotionTest = init.then(readAcquisition(0)).then(prepareAcquisition(0)).then(cas(0))
    .then(response(0, false)).then(prepareMutation(0, true)).then(cas(0)).then(response(0, false))
    .expect(not(completeBaseline))
  run wrongBaselineTest = acquireA.then(commit(0)).then(upload(0)).then(sync(0)).then(observe(0))
    .then(deliver(0)).then(4.reps(_ => tick)).then(readAcquisition(1)).then(prepareAcquisition(1))
    .then(cas(1)).then(response(1, false)).then(selectSource(1)).then(baseline(1))
    .expect(not(baselineContainsSelected))
  run rebasedMutationTest = skewOverlap.then(prepareMutation(0, false))
    .expect(not(mutationUsesObservedHead))
  run staleCASDisciplineTest = init.then(readAcquisition(0)).then(readAcquisition(1))
    .then(prepareAcquisition(0)).then(prepareAcquisition(1)).then(cas(0)).then(cas(1))
    .expect(not(controlDiscipline) and s.badControlDiscipline)
}

module SynchronizedTests {
  import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module ExcessSkewTests {
  import Scenarios(CfgSkew = 2, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module ForwardJumpTests {
  import Scenarios(CfgSkew = 2, CfgJump = true, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module BackwardJumpTests {
  import Scenarios(CfgSkew = -2, CfgJump = true, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module LateRenewalTests {
  import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = false, CfgRevive = true,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module RecoveryHistoryTests {
  import Scenarios(CfgSkew = 2, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module EarlyAcknowledgementTests {
  import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = true, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module EarlyPromotionTests {
  import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = true,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
module WrongBaselineTests {
  import Scenarios(CfgSkew = 2, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = true, CfgRebaseMutation = false).*
}
module RebasedMutationTests {
  import Scenarios(CfgSkew = 2, CfgJump = false, CfgBrokenCAS = false, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = true).*
}
module NoCASTests {
  import Scenarios(CfgSkew = 0, CfgJump = false, CfgBrokenCAS = true, CfgRevive = false,
    CfgCachedCheck = false, CfgUnsafeAck = false, CfgEarlyPromotion = false,
    CfgWrongBaseline = false, CfgRebaseMutation = false).*
}
