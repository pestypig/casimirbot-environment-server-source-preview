// The caller already holds authority -> goal -> resident locks. Plain FOR
// UPDATE retains row locking (including the joined admission) and also parses
// in the packaged pg-mem backend, which does not implement FOR UPDATE OF alias.
export const temporalSuccessorCandidatesSql = `SELECT a.request_payload,a.action_request_id,a.deadline_at,
      p.checkpoint_association,p.reasoning_binding_id,p.reasoning_binding_epoch,p.client_continuation_ref
    FROM helix_environment_temporal_plan_admissions p JOIN helix_environment_action_requests a
      ON a.action_request_id=p.action_request_id
    WHERE p.resident_action_request_id=$1 AND p.previous_plan_id=$2 AND p.previous_plan_hash=$3
      AND a.action_authority_id=$4 AND a.connector_manifest_id=$5 AND a.status='admitted' AND a.deadline_at>now()
    LIMIT 2 FOR UPDATE`;

// The atomic lease repeats expiry validation against the database clock after
// candidate selection. A caller's earlier timestamp cannot keep an expired
// request or proposed lease alive while other checks are running. The lease
// must also remain within the child's admitted deadline.
export const temporalSuccessorLeaseSql = `UPDATE helix_environment_action_requests
    SET status='leased',attempt_count=attempt_count+1,
      leased_at=clock_timestamp(),lease_expires_at=$2,updated_at=clock_timestamp()
    WHERE action_request_id=$1 AND status='admitted'
      AND deadline_at>clock_timestamp()
      AND $2::timestamptz>clock_timestamp()
      AND $2::timestamptz<=deadline_at RETURNING *`;

// Read-only reconciliation includes nonterminal and terminal recorded statuses.
// It never selects request_payload or performs a lease transition. The caller
// independently checks checkpoint, plan and active reasoning-binding identity.
export const temporalSuccessorStateSql = `SELECT r.action_request_id,r.status,a.reasoning_binding_id,a.reasoning_binding_epoch,
    a.client_continuation_ref,a.checkpoint_association,a.source_plan
    FROM helix_environment_action_requests r
    JOIN helix_environment_temporal_plan_admissions a ON a.action_request_id=r.action_request_id
    WHERE a.resident_action_request_id=$1 AND a.previous_plan_id=$2 AND a.previous_plan_hash=$3
      AND r.action_authority_id=$4 AND r.connector_manifest_id=$5 AND r.run_id=$6 LIMIT 2`;
