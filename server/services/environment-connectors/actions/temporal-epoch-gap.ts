// An epoch replacement cannot restore an in-memory native outbox. Preserve
// evidence/results, but close unfinished old-epoch requests as unknown effects.
// This is not an execution result and must never authorize action replay.
export const closeTemporalEpochGapSql = `UPDATE helix_environment_action_requests
  SET status='connector_offline',
    cancellation_reason='producer_epoch_replaced_evidence_incomplete_no_replay',
    completed_at=now(),updated_at=now()
  WHERE action_authority_id=$1
    AND connector_manifest_id IN (
      SELECT manifest_id FROM helix_environment_action_connector_manifests
      WHERE action_authority_id=$1 AND producer_epoch_ref<>$2
    )
    AND request_payload->'temporal_plan' IS NOT NULL
    AND status IN ('queued','admitted','leased','running','paused_manual_override','cancel_requested')`;
