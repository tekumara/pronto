----------------------------- MODULE Liveness -----------------------------
EXTENDS PrefixProtocol

CONSTANTS FairScheduler, FairClock, FairStorage, FairAudit, FairGitHub,
          RetryTrigger, BrokenDispatch
ASSUME /\ Detailed /\ Mode = "postcheck"
       /\ {FairScheduler, FairClock, FairStorage, FairAudit, FairGitHub,
           RetryTrigger, BrokenDispatch} \subseteq BOOLEAN

(***************************************************************************
Conditional progress AFTER a finite failure prefix. Reuses the safety model's
actual acquisition/selection/restore/baseline/promotion/renewal actions.

Initially term 0 has acknowledged operation 0 but crashed before dispatch.
With 3 terms, term 1 additionally crashed during bootstrap after restore. The
last complete source is still 0. A final healthy candidate remains available.
No further takeover, process death, storage error, ambiguous control response or
missed local deadline occurs after recovery. This is an explicit good-window
assumption (including requests/renewals within the real lease margin), NOT a
consequence of weak fairness. Wall-clock bounds are not modelled.

New workflow stages abstract webhook Work.dispatch and publicationTask. These
are source-mapped progress steps, NOT graph-equivalent Python/TypeScript models.
External audit completion is separate from scheduler fairness. A failed POST is
terminal until an EXTERNAL re-admission/recovery trigger, never an automatic
retry timer. The trigger here maps to another explicit-apply audit of the same
PR via enqueuePublication; it does not pretend a process restart reuses a term.
***************************************************************************)
VARIABLES environment, work
ProgressVars == <<s, environment, work>>
Final == Terms - 1
Crashed == Final - 1
Seed == [InitialActor EXCEPT !.local = <<0>>, !.versions = << <<>>, <<0>> >>,
  !.written = TRUE, !.receipt = 2, !.acked = TRUE, !.stopped = TRUE]
Interrupted == [EmptyActor EXCEPT !.phase = 2, !.source = <<0, 1>>,
  !.local = <<0>>, !.selected = <<0>>, !.head = 1, !.stopped = TRUE]
CheckpointState ==
  [control |-> [owner |-> Crashed, revision |-> Crashed, expires |-> 1,
             phase |-> IF Terms = 2 THEN "ready" ELSE "bootstrapping", recovery |-> 0],
          actors |-> [i \in T |-> IF i = 0 THEN Seed
             ELSE IF i < Final THEN Interrupted ELSE EmptyActor],
          acknowledged |-> {0}]
InitialEnvironment == [storage |-> FALSE, github |-> FALSE, expired |-> FALSE]
InitialWork == [stage |-> "pending", dispatched |-> FALSE, publication |-> "none",
               attempted |-> FALSE, confirmed |-> FALSE, posted |-> FALSE,
               retried |-> FALSE]
ProgressInit == /\ s = CheckpointState /\ environment = InitialEnvironment
                /\ work = InitialWork

Ready == ReadyOwner(Final) /\ A(Final).phase = 4 /\ ~A(Final).stopped
CoreUnchanged == UNCHANGED <<environment, work>>
Core(a) == a /\ CoreUnchanged
HealStorage == /\ ~environment.storage
               /\ environment' = [environment EXCEPT !.storage = TRUE]
               /\ UNCHANGED <<s, work>>
HealGitHub == /\ ~environment.github
              /\ environment' = [environment EXCEPT !.github = TRUE]
              /\ UNCHANGED <<s, work>>
LeaseExpires == /\ C.owner = Crashed /\ ~environment.expired
                /\ environment' = [environment EXCEPT !.expired = TRUE]
                /\ UNCHANGED <<s, work>>
AcquireRead == /\ environment.storage /\ environment.expired
               /\ Cardinality(Used) = Final /\ Core(PrepareAcquisition)
ControlCAS == environment.storage /\ Core(CAS(Final))
ControlResponse ==
  /\ environment.storage /\ Core(MutationResponse(Final))
  \* Successful response branch only: the final good window excludes loss.
  /\ ~s'.actors[Final].stopped
SelectSource == environment.storage /\ Core(Select(Final))
RestoreSource == environment.storage /\ Core(Restore(Final))
UploadBaseline == environment.storage /\ Core(Baseline(Final))
Promote == Core(PreparePromotion(Final))
RenewLease == Core(PrepareRenewal(Final))

DispatchCommit ==
  /\ Ready /\ ~BrokenDispatch /\ work.stage = "pending"
  /\ 0 \in Ops(Latest(Final))
  /\ work' = [work EXCEPT !.stage = "confirming"]
  /\ UNCHANGED <<s, environment>>
DispatchConfirm ==
  /\ Ready /\ environment.storage /\ work.stage = "confirming"
  /\ work' = [work EXCEPT !.stage = "running", !.dispatched = TRUE]
  /\ UNCHANGED <<s, environment>>
AuditReturns ==
  /\ work.stage = "running"
  \* Assumes finite successful evidence/model execution and explicit --apply.
  /\ work' = [work EXCEPT !.stage = "assessed", !.publication = "pending"]
  /\ UNCHANGED <<s, environment>>
MarkAttempt ==
  /\ Ready /\ work.publication = "pending"
  /\ work' = [work EXCEPT !.publication = "local-marker", !.attempted = TRUE]
  /\ UNCHANGED <<s, environment>>
ConfirmAttempt ==
  /\ Ready /\ environment.storage /\ work.publication = "local-marker"
  /\ work' = [work EXCEPT !.publication = "sendable", !.confirmed = TRUE]
  /\ UNCHANGED <<s, environment>>
PostReview ==
  /\ Ready /\ work.publication = "sendable"
  /\ work' = [work EXCEPT
        !.publication = IF environment.github THEN "posted" ELSE "failed",
        !.posted = environment.github]
  /\ UNCHANGED <<s, environment>>
SaveReceipt ==
  /\ work.publication = "posted"
  /\ work' = [work EXCEPT !.publication = "complete"]
  /\ UNCHANGED <<s, environment>>
FinishDelivery ==
  /\ work.stage = "assessed" /\ work.publication \in {"failed", "complete"}
  \* Work.dispatch catches an audit error and completes intake bookkeeping too.
  /\ work' = [work EXCEPT !.stage = "finished"]
  /\ UNCHANGED <<s, environment>>
ReadmitPublication ==
  /\ RetryTrigger /\ Ready /\ environment.github
  /\ work.publication = "failed" /\ work.stage = "finished"
  \* A NEW external audit/recovery trigger, not the failed task running itself.
  /\ work' = [work EXCEPT !.publication = "pending", !.retried = TRUE]
  /\ UNCHANGED <<s, environment>>
Quiescent == work.stage = "finished" /\ work.publication \in {"failed", "complete"}
WaitForInput == Quiescent /\ UNCHANGED ProgressVars

ProgressNext ==
  HealStorage \/ HealGitHub \/ LeaseExpires \/ AcquireRead \/ ControlCAS \/
  ControlResponse \/ SelectSource \/ RestoreSource \/ UploadBaseline \/
  Promote \/ RenewLease \/ DispatchCommit \/ DispatchConfirm \/ AuditReturns \/
  MarkAttempt \/ ConfirmAttempt \/ PostReview \/ SaveReceipt \/ FinishDelivery \/
  ReadmitPublication \/ WaitForInput
SchedulerFairness ==
  /\ WF_ProgressVars(AcquireRead) /\ WF_ProgressVars(ControlCAS)
  /\ WF_ProgressVars(ControlResponse) /\ WF_ProgressVars(SelectSource)
  /\ WF_ProgressVars(RestoreSource) /\ WF_ProgressVars(UploadBaseline)
  /\ WF_ProgressVars(Promote) /\ WF_ProgressVars(RenewLease)
  /\ WF_ProgressVars(DispatchCommit) /\ WF_ProgressVars(DispatchConfirm)
  /\ WF_ProgressVars(MarkAttempt) /\ WF_ProgressVars(ConfirmAttempt)
  /\ WF_ProgressVars(PostReview) /\ WF_ProgressVars(SaveReceipt)
  /\ WF_ProgressVars(FinishDelivery)
ProgressSpec == ProgressInit /\ [][ProgressNext]_ProgressVars
  /\ (FairScheduler => SchedulerFairness)
  /\ (FairClock => WF_ProgressVars(LeaseExpires))
  /\ (FairStorage => WF_ProgressVars(HealStorage))
  /\ (FairAudit => WF_ProgressVars(AuditReturns))
  /\ (FairGitHub => WF_ProgressVars(HealGitHub))
  /\ (RetryTrigger => WF_ProgressVars(ReadmitPublication))

EventuallyReady == <>Ready
FailoverCompletes == (~Ready) ~> Ready
AcceptedDispatches == (0 \in s.acknowledged) ~> work.dispatched
AcceptedFinishes == (0 \in s.acknowledged) ~> (work.stage = "finished")
PublicationDelivered == (work.publication # "none") ~> work.posted
WorkflowType ==
  /\ environment \in [storage: BOOLEAN, github: BOOLEAN, expired: BOOLEAN]
  /\ work.stage \in {"pending", "confirming", "running", "assessed", "finished"}
  /\ work.publication \in {"none", "pending", "local-marker", "sendable", "failed", "posted", "complete"}
  /\ {work.dispatched, work.attempted, work.confirmed, work.posted, work.retried} \subseteq BOOLEAN
  /\ (work.posted => (work.confirmed /\ work.attempted))
\* Non-vacuity witness: a failed POST can be re-admitted and then delivered.
NoRetryWitness == ~(work.retried /\ work.posted /\ work.publication = "complete")

\* Independently construct each checkpoint with UNMODIFIED core transitions.
\* SeedSpec is a finite reachability witness, not another liveness assumption.
SeedInit == /\ Init /\ environment = InitialEnvironment
            /\ work = [InitialWork EXCEPT !.stage = "commit"]
SeedStep(from, to, action) ==
  /\ work.stage = from /\ action
  /\ work' = [work EXCEPT !.stage = to] /\ UNCHANGED environment
SeedNext ==
  \/ SeedStep("commit", "upload", Commit(0))
  \/ SeedStep("upload", "observe", Upload(0))
  \/ SeedStep("observe", "acknowledge", Observe(0))
  \/ SeedStep("acknowledge", "crash", Acknowledge(0))
  \/ SeedStep("crash", IF Terms = 2 THEN "checkpoint" ELSE "acquire", Lose(0))
  \/ SeedStep("acquire", "cas", PrepareAcquisition)
  \/ SeedStep("cas", "response", CAS(1))
  \/ SeedStep("response", "select", MutationResponse(1) /\ ~s'.actors[1].stopped)
  \/ SeedStep("select", "restore", Select(1))
  \/ SeedStep("restore", "crash-bootstrap", Restore(1))
  \/ SeedStep("crash-bootstrap", "checkpoint", Lose(1))
  \/ (work.stage = "checkpoint" /\ UNCHANGED ProgressVars)
SeedSpec == SeedInit /\ [][SeedNext]_ProgressVars
NoCheckpoint == ~(work.stage = "checkpoint" /\ s = CheckpointState)
=============================================================================
