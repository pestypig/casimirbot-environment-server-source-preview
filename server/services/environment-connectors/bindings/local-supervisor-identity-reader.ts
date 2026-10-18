import {
  readSharedRealtimeRoomDatabase,
} from "../../helix-ask/realtime-room/room-store/database";

export type LocalSupervisorEnvironmentIdentity = Readonly<{
  roomId: string;
  participantId: string;
  environmentBindingId: string;
  connectorInstallationId: string;
  sourceId: string;
  producerEpochRef: string;
}>;

type IdentityRow = {
  room_id: string;
  participant_id: string;
  environment_binding_id: string;
  installation_id: string;
  source_id: string;
  producer_epoch_ref: string;
};

/**
 * Resolve one environment identity from canonical room, connector, device, and
 * grant state. Client prose never supplies any returned identity component.
 */
export const readLocalSupervisorEnvironmentIdentity = async (input: {
  roomId: string;
  profileId: string;
  participantId: string;
  environmentBindingId: string;
  now?: Date;
}): Promise<LocalSupervisorEnvironmentIdentity | null> => {
  const db = await readSharedRealtimeRoomDatabase();
  const now = (input.now ?? new Date()).toISOString();
  const selected = await db.query<IdentityRow>(
    `SELECT DISTINCT
       binding.room_id,
       member.participant_id,
       binding.environment_binding_id,
       binding.installation_id,
       binding.source_id,
       device.producer_epoch_ref
     FROM helix_environment_connector_bindings binding
     JOIN helix_shared_realtime_rooms room
       ON room.room_id = binding.room_id
      AND room.status <> 'closed'
     JOIN helix_shared_realtime_room_members member
       ON member.room_id = binding.room_id
      AND member.profile_id = $3
      AND member.participant_id = $4
      AND member.presence <> 'left'
     JOIN helix_environment_connector_installations installation
       ON installation.installation_id = binding.installation_id
      AND installation.status = 'active'
     JOIN helix_environment_connector_devices device
       ON device.device_id = binding.device_id
      AND device.status = 'active'
      AND device.producer_epoch_ref IS NOT NULL
     LEFT JOIN helix_room_environment_capability_grants room_grant
       ON room_grant.room_id = binding.room_id
      AND room_grant.environment_binding_id = binding.environment_binding_id
      AND room_grant.installation_id = binding.installation_id
      AND room_grant.device_id = binding.device_id
      AND room_grant.source_id = binding.source_id
      AND room_grant.producer_epoch_ref = device.producer_epoch_ref
      AND room_grant.status = 'active'
      AND room_grant.expires_at > $5
     WHERE binding.room_id = $1
       AND binding.environment_binding_id = $2
       AND binding.status = 'active'
       AND (
         binding.owner_profile_id = $3
         OR room_grant.grant_id IS NOT NULL
       )
     LIMIT 2;`,
    [
      input.roomId,
      input.environmentBindingId,
      input.profileId,
      input.participantId,
      now,
    ],
  );
  if (selected.rows.length !== 1) return null;
  const row = selected.rows[0];
  return Object.freeze({
    roomId: row.room_id,
    participantId: row.participant_id,
    environmentBindingId: row.environment_binding_id,
    connectorInstallationId: row.installation_id,
    sourceId: row.source_id,
    producerEpochRef: row.producer_epoch_ref,
  });
};
