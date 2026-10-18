/** Final one-shot root lease transition. Candidate selection and its sampled
 * timestamp are not authority if the deadline or proposed lease expires
 * before this write reaches the database; the lease must not outlive the
 * admitted request deadline even if a caller proposes a longer interval. */
export const rootActionLeaseSql = `UPDATE helix_environment_action_requests
  SET status='leased',attempt_count=attempt_count+1,
      leased_at=clock_timestamp(),lease_expires_at=$2,updated_at=clock_timestamp()
  WHERE action_request_id=$1 AND status='admitted'
    AND deadline_at>clock_timestamp()
    AND $2::timestamptz>clock_timestamp()
    AND $2::timestamptz<=deadline_at
  RETURNING *`;
