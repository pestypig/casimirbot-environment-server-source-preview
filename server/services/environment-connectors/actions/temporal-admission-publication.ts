import type { PoolClient } from "pg";

/** Publish only after retention succeeds. pg-mem does not undo writes on SQL
 * ROLLBACK, so a temporal INSERT must start queued, never executable. The
 * caller owns this newly inserted ID; duplicate requests must not enter here.
 * A crash/cleanup failure leaves queued state, which neither dispatcher leases.
 */
export async function publishTemporalAdmission(
  db: PoolClient,
  actionRequestId: string,
  retain: () => Promise<void>,
): Promise<void> {
  try {
    await retain();
    const published = await db.query(`UPDATE helix_environment_action_requests
      SET status='admitted' WHERE action_request_id=$1 AND status='queued'
      RETURNING action_request_id`, [actionRequestId]);
    if (published.rows.length !== 1) throw new Error("temporal_admission_publication_conflict");
  } catch (error) {
    // PostgreSQL may already have aborted this transaction; its rollback owns
    // cleanup there. On pg-mem compensate only this still-unpublished request,
    // never another request or a concurrent observation/authority update.
    await db.query(`DELETE FROM helix_environment_temporal_plan_admissions
      WHERE action_request_id=$1 AND action_request_id IN
        (SELECT action_request_id FROM helix_environment_action_requests
         WHERE action_request_id=$1 AND status='queued')`, [actionRequestId]).catch(() => undefined);
    await db.query(`UPDATE helix_environment_action_requests
      SET status='failed', cancellation_reason='temporal_admission_rejected'
      WHERE action_request_id=$1 AND status='queued'`, [actionRequestId]).catch(() => undefined);
    throw error;
  }
}
