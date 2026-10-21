-------------------------- MODULE PrefixProtocol --------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC

CONSTANTS Terms, Mode, Detailed
ASSUME /\ Terms \in {2, 3}
       /\ Mode \in {"postcheck", "naive", "precheck", "early-promote"}
       /\ Detailed \in BOOLEAN
       /\ (Mode = "early-promote" => Detailed)

(***************************************************************************
Control is authoritative; actors retain LOCAL beliefs after takeover. A term
is also its unique prefix. Revisions stand for unique record.revision + ETag
pairs, not clocks. expires=1 abstracts a lease not yet locally known expired;
takeover is enabled at any time, a safety overapproximation of lease expiry.

Storage assumptions, NOT theorems: complete uploads atomically append unchanged
history; no deletion/reset/prefix reuse; latest inventory is strongly consistent;
a selected endpoint remains restorable; a baseline is independent. One operation
per term, one renewal, finite never-reused terms. No fairness/liveness claim.

Detailed=FALSE is the original Python transition system for prefix modes:
selection+restore and renewal are atomic; promotion failure can prepare again.
Detailed=TRUE splits acquisition GET/CAS/response, fixed selection/restore and
serialized control operations (one acquisition contender in flight at a time),
uses the local observed head, fails closed, allows lost successful responses,
and fresh-read conditional cleanup. It is NOT a refinement proof of TypeScript.
***************************************************************************)
VARIABLE s
vars == <<s>>
T == 0..(Terms - 1)
EmptyActor == [phase |-> 0, source |-> <<>>, local |-> <<>>,
  versions |-> <<>>, written |-> FALSE, pending |-> <<>>, receipt |-> 0,
  acked |-> FALSE, renewed |-> FALSE,
  selected |-> <<>>, head |-> 0, stopped |-> FALSE, released |-> FALSE]
InitialActor == [EmptyActor EXCEPT !.phase = 4, !.source = <<0, 1>>,
  !.versions = << <<>> >>]
Init == s = [control |-> [owner |-> 0, revision |-> 0, expires |-> 1,
                        phase |-> "ready", recovery |-> 0],
             actors |-> [i \in T |-> IF i = 0 THEN InitialActor ELSE EmptyActor],
             acknowledged |-> {}]
A(i) == s.actors[i]
C == s.control
Latest(p) == LET v == s.actors[p].versions IN v[Len(v)]
Ops(log) == {log[j] : j \in 1..Len(log)}
Uploaded(i) == Len(A(i).versions) = 2
ReadyOwner(i) == C.owner = i /\ C.phase = "ready" /\ C.recovery = i
Running(i) == ~Detailed \/ ~A(i).stopped
Used == {i \in T : A(i).phase # 0}

Takeover ==
  LET i == Cardinality(Used) IN
  /\ ~Detailed /\ i \in T
  /\ s' = [s EXCEPT !.control = [C EXCEPT !.owner = i,
        !.revision = @ + 1, !.phase = "bootstrapping", !.expires = 1],
      !.actors[i] = [EmptyActor EXCEPT !.phase = 1,
        !.source = <<C.recovery, 1>>, !.head = C.revision + 1]]
PrepareAcquisition ==
  LET i == Cardinality(Used) IN
  /\ Detailed /\ i \in T
  /\ ~\E j \in T: A(j).phase = 6 /\ A(j).pending # <<>>
  \* Fresh GET. A renewal/promotion/release can invalidate this observed revision
  \* before CAS. Allocating the candidate consumes its unique term even on failure.
  /\ s' = [s EXCEPT !.actors[i] = [EmptyActor EXCEPT !.phase = 6,
        !.source = <<C.recovery, 1>>, !.pending = <<"acquire", C.revision>>]]

Select(i) ==
  /\ Detailed /\ A(i).phase = 1 /\ Running(i)
  /\ s' = [s EXCEPT !.actors[i].selected = Latest(A(i).source[1]),
                    !.actors[i].phase = 5]
Restore(i) ==
  /\ A(i).phase = (IF Detailed THEN 5 ELSE 1) /\ Running(i)
  /\ s' = [s EXCEPT !.actors[i].local =
       IF Detailed THEN A(i).selected ELSE Latest(A(i).source[1]),
       !.actors[i].phase = 2]
Baseline(i) ==
  /\ A(i).phase = 2 /\ Running(i)
  /\ s' = [s EXCEPT !.actors[i].versions = <<A(i).local>>,
                    !.actors[i].phase = 3]
PreparePromotion(i) ==
  /\ (A(i).phase = 3 \/ (Mode = "early-promote" /\ A(i).phase = 2))
  /\ A(i).pending = <<>> /\ Running(i)
  /\ IF Detailed THEN TRUE ELSE C.owner = i /\ C.phase = "bootstrapping"
  /\ s' = [s EXCEPT !.actors[i].pending =
       <<"promote", IF Detailed THEN A(i).head ELSE C.revision>>]
Commit(i) ==
  /\ A(i).phase = 4 /\ ~A(i).written /\ Running(i)
  /\ s' = [s EXCEPT !.actors[i].written = TRUE,
                    !.actors[i].local = Append(@, i)]
Upload(i) ==
  /\ A(i).phase = 4 /\ A(i).written /\ Len(A(i).versions) = 1
  \* May complete even after local term loss or takeover.
  /\ s' = [s EXCEPT !.actors[i].versions = Append(@, A(i).local)]
Observe(i) ==
  /\ Mode # "naive" /\ A(i).receipt = 0 /\ Running(i)
  /\ IF Mode = "precheck" THEN A(i).written ELSE Uploaded(i)
  /\ ReadyOwner(i)
  /\ s' = [s EXCEPT !.actors[i].receipt = 2]
Acknowledge(i) ==
  /\ Uploaded(i) /\ ~A(i).acked
  /\ Mode = "naive" \/ A(i).receipt = 2
  \* Delayed acknowledgement: deliberately NO current-owner guard.
  /\ s' = [s EXCEPT !.actors[i].acked = TRUE,
                    !.acknowledged = @ \cup {i}]

Renew(i) ==
  /\ ~Detailed /\ A(i).phase # 0 /\ ~A(i).renewed /\ C.owner = i
  /\ s' = [s EXCEPT !.actors[i].renewed = TRUE,
                    !.control.revision = @ + 1]
PrepareRenewal(i) ==
  /\ Detailed /\ A(i).phase \in 1..5 /\ ~A(i).renewed /\ Running(i)
  /\ A(i).pending = <<>>
  /\ s' = [s EXCEPT !.actors[i].pending = <<"renew", A(i).head>>,
                    !.actors[i].renewed = TRUE]

RequestPending(i) == A(i).pending # <<>> /\
  A(i).pending[1] \in {"acquire", "promote", "renew", "release"}
CAS(i) ==
  /\ RequestPending(i)
  /\ LET kind == A(i).pending[1]
         expected == A(i).pending[2]
     IN IF expected # C.revision
        THEN s' = [s EXCEPT !.actors[i].pending = <<>>,
          !.actors[i].stopped = IF Detailed THEN TRUE ELSE @]
        ELSE s' = [s EXCEPT
          !.control = [C EXCEPT !.revision = @ + 1,
            !.phase = IF kind = "promote" THEN "ready"
                      ELSE IF kind = "release" THEN "idle"
                      ELSE IF kind = "acquire" THEN "bootstrapping" ELSE @,
            !.recovery = IF kind = "promote" THEN i ELSE @,
            !.owner = IF kind = "release" THEN -1
                      ELSE IF kind = "acquire" THEN i ELSE @,
            !.expires = IF kind = "release" THEN 0 ELSE 1],
          !.actors[i].pending = IF Detailed
            THEN <<kind \o "-response", C.revision + 1>> ELSE <<>>,
          !.actors[i].phase = IF ~Detailed /\ kind = "promote" THEN 4 ELSE @]

MutationResponse(i) ==
  /\ Detailed /\ A(i).pending # <<>>
  /\ A(i).pending[1] \in {"acquire-response", "promote-response", "renew-response", "release-response"}
  /\ \/ s' = [s EXCEPT !.actors[i].head = A(i).pending[2],
          !.actors[i].phase = IF A(i).pending[1] = "promote-response" THEN 4
                             ELSE IF A(i).pending[1] = "acquire-response" THEN 1 ELSE @,
          !.actors[i].pending = <<>>]
     \/ s' = [s EXCEPT !.actors[i].stopped = TRUE,
                        !.actors[i].pending = <<>>]

Lose(i) ==
  /\ Detailed /\ A(i).phase # 0 /\ ~A(i).stopped
  \* Pauses, deadlines, sync/GET errors and cancellation only remove permission.
  /\ s' = [s EXCEPT !.actors[i].stopped = TRUE]
PrepareRelease(i) ==
  /\ Detailed /\ A(i).phase \in 1..5 /\ A(i).stopped /\ ~A(i).released
  /\ A(i).pending = <<>> /\ C.owner = i
  \* NEW operation: a fresh GET authorizes cleanup, not retry of a stale mutation.
  /\ s' = [s EXCEPT !.actors[i].pending = <<"release", C.revision>>,
                    !.actors[i].released = TRUE]

Next == Takeover \/ PrepareAcquisition \/ (\E i \in T:
  Select(i) \/ Restore(i) \/ Baseline(i) \/ PreparePromotion(i) \/
  Commit(i) \/ Upload(i) \/ Observe(i) \/ Acknowledge(i) \/ Renew(i) \/
  PrepareRenewal(i) \/ CAS(i) \/ MutationResponse(i) \/ Lose(i) \/ PrepareRelease(i))
Spec == Init /\ [][Next]_vars

MutationUsesObservedHead == ~Detailed \/ (\A i \in T:
  (RequestPending(i) /\ A(i).pending[1] \in {"promote", "renew"})
    => A(i).pending[2] = A(i).head)
TypeOK ==
  /\ DOMAIN s.actors = T
  /\ C.owner \in T \cup {-1} /\ C.recovery \in T
  /\ C.revision \in 0..(6 * Terms) /\ C.expires \in {0, 1}
  /\ C.phase \in {"ready", "bootstrapping", "idle"}
  /\ (C.owner = -1) = (C.phase = "idle")
  /\ (C.expires = 0) = (C.phase = "idle")
  /\ s.acknowledged \subseteq T
  /\ \A i \in T:
       /\ A(i).phase \in 0..6
       /\ A(i).local \in Seq(T) /\ A(i).selected \in Seq(T)
       /\ A(i).written \in BOOLEAN /\ A(i).stopped \in BOOLEAN
       /\ A(i).acked \in BOOLEAN /\ A(i).renewed \in BOOLEAN
       /\ A(i).released \in BOOLEAN /\ A(i).receipt \in {0, 2}
       /\ A(i).head \in 0..(6 * Terms)
       /\ A(i).source \in {<<>>} \cup (T \X {1})
       /\ A(i).versions \in Seq(Seq(T)) /\ Len(A(i).versions) \in 0..2
CompleteBaseline ==
  /\ Len(s.actors[C.recovery].versions) >= 1
  /\ C.phase = "ready" => C.recovery = C.owner
AckRecoverable ==
  IF Len(s.actors[C.recovery].versions) = 0 THEN s.acknowledged = {}
  ELSE s.acknowledged \subseteq Ops(Latest(C.recovery))
\* Successful promotion has all earlier acknowledgements, not merely the old
\* prefix name. Complete retained history is a storage assumption above.
BaselineContainsSelected == \A i \in T:
  A(i).phase \in {3, 4} =>
    /\ Len(A(i).versions) >= 1
    /\ A(i).versions[1] = IF A(i).written
          THEN SubSeq(A(i).local, 1, Len(A(i).local) - 1) ELSE A(i).local
    /\ Detailed => A(i).versions[1] = A(i).selected

\* Action properties (check each reachable edge, not just final ownership).
ControlDiscipline == [][
  /\ s'.control.revision >= C.revision
  /\ (s'.control.revision = C.revision => s'.control = C)
  /\ s'.control.recovery >= C.recovery
  /\ (s'.control.phase = "bootstrapping" => s'.control.recovery = C.recovery)
  /\ (\A i \in T: (RequestPending(i) /\ A(i).pending[2] # C.revision
        /\ s'.actors[i].pending = <<>> /\ s'.actors[i].stopped)
        => s'.control = C)
]_vars
=============================================================================
