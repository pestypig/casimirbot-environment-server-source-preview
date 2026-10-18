import {
  HELIX_ENVIRONMENT_DEVICE_CHECK_SCHEMA,
  HELIX_ENVIRONMENT_DEVICE_CHECK_LIST_SCHEMA,
  helixEnvironmentDeviceCheckListSchema,
  helixEnvironmentDeviceCheckSchema,
  type HelixEnvironmentDeviceCheck,
  type HelixEnvironmentDeviceCheckBlockingReason,
  type HelixEnvironmentDeviceCheckList,
} from "@shared/helix-environment-device-check";
import { readSharedRealtimeRoomDatabase } from
  "../../helix-ask/realtime-room/room-store/database";

export const DEFAULT_ENVIRONMENT_DEVICE_STALE_AFTER_MS = 120_000;

export type EnvironmentDeviceCheckRow = {
  device_id: string;
  installation_id: string;
  package_id: string;
  package_version: string;
  trust_classification: string;
  security_review_state: string;
  installation_status: string;
  installed_device_id: string | null;
  installed_device_status: string | null;
  device_status: string;
  reported_health_status: HelixEnvironmentDeviceCheck["health"];
  last_contact_at: Date | string | null;
  paired_at: Date | string;
  environment_binding_id: string | null;
  binding_status: string | null;
  admission_status: string | null;
  room_id: string | null;
  source_id: string | null;
  world_id: string | null;
  domain_adapter: string | null;
  granted_capability_ids: unknown;
  consent_capability_ids: unknown;
  credential_status: string | null;
  credential_expires_at: Date | string | null;
};

const asIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const stringArray = (value: unknown): string[] => {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? Array.from(
        new Set(
          parsed
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ).sort()
    : [];
};

const validIsoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : asIso(value);

export function projectEnvironmentDeviceCheck(input: {
  row: EnvironmentDeviceCheckRow;
  now?: Date;
  staleAfterMs?: number;
}): HelixEnvironmentDeviceCheck {
  const { row } = input;
  const now = input.now ?? new Date();
  const staleAfterMs = Math.max(
    1,
    Math.floor(input.staleAfterMs ?? DEFAULT_ENVIRONMENT_DEVICE_STALE_AFTER_MS),
  );
  const lastContactAt = validIsoOrNull(row.last_contact_at);
  const contactAgeMs = lastContactAt
    ? Math.max(0, now.getTime() - Date.parse(lastContactAt))
    : null;
  const freshness =
    contactAgeMs === null
      ? "never_observed"
      : contactAgeMs <= staleAfterMs
        ? "fresh"
        : "stale";
  const capabilityIds = stringArray(
    row.consent_capability_ids ?? row.granted_capability_ids,
  );
  const credentialExpiresAt = validIsoOrNull(row.credential_expires_at);
  const credentialExpired = credentialExpiresAt
    ? Date.parse(credentialExpiresAt) <= now.getTime()
    : false;
  const reportedHealth = helixEnvironmentDeviceCheckSchema.shape.health.parse(
    row.reported_health_status,
  );

  const blockingReasons: HelixEnvironmentDeviceCheckBlockingReason[] = [];
  if (row.installation_status !== "active") {
    blockingReasons.push("installation_inactive");
  }
  if (!row.installed_device_id) {
    blockingReasons.push("installed_node_unbound");
  } else if (row.installed_device_status !== "active") {
    blockingReasons.push("installed_node_inactive");
  }
  if (row.device_status !== "active") {
    blockingReasons.push("device_inactive");
  }
  if (!row.environment_binding_id) {
    blockingReasons.push("binding_missing");
  } else if (row.binding_status !== "active") {
    blockingReasons.push("binding_inactive");
  }
  if (row.admission_status !== "active") {
    blockingReasons.push("adapter_admission_inactive");
  }
  if (!row.credential_status) {
    blockingReasons.push("credential_missing");
  } else if (row.credential_status !== "active") {
    blockingReasons.push("credential_inactive");
  }
  if (credentialExpired) blockingReasons.push("credential_expired");
  if (freshness === "never_observed") {
    blockingReasons.push("contact_never_observed");
  } else if (freshness === "stale") {
    blockingReasons.push("contact_stale");
  }
  if (reportedHealth === "degraded") {
    blockingReasons.push("connector_reported_degraded");
  }
  if (reportedHealth === "offline") {
    blockingReasons.push("connector_reported_offline");
  }
  if (reportedHealth === "unknown") {
    blockingReasons.push("connector_health_unknown");
  }
  if (capabilityIds.length === 0) {
    blockingReasons.push("capabilities_missing");
  }

  const inactive =
    row.installation_status !== "active" || row.device_status !== "active";
  const health = inactive || freshness === "stale"
    ? "offline"
    : freshness === "never_observed"
      ? "unknown"
      : reportedHealth;

  return helixEnvironmentDeviceCheckSchema.parse({
    schema: HELIX_ENVIRONMENT_DEVICE_CHECK_SCHEMA,
    device_id: row.device_id,
    installation_id: row.installation_id,
    package_id: row.package_id,
    package_version: row.package_version,
    trust_classification:
      row.trust_classification as HelixEnvironmentDeviceCheck["trust_classification"],
    security_review_state:
      row.security_review_state as HelixEnvironmentDeviceCheck["security_review_state"],
    installation_status:
      row.installation_status as HelixEnvironmentDeviceCheck["installation_status"],
    device_status:
      row.device_status as HelixEnvironmentDeviceCheck["device_status"],
    health,
    freshness,
    last_contact_at: lastContactAt,
    last_contact_age_ms: contactAgeMs,
    stale_after_ms: staleAfterMs,
    paired_at: asIso(row.paired_at),
    environment_binding_id: row.environment_binding_id,
    binding_status:
      row.binding_status as HelixEnvironmentDeviceCheck["binding_status"],
    adapter_admission_status:
      row.admission_status as HelixEnvironmentDeviceCheck["adapter_admission_status"],
    room_id: row.room_id,
    source_id: row.source_id,
    world_id: row.world_id,
    domain_adapter: row.domain_adapter,
    capability_ids: capabilityIds,
    credential_status:
      row.credential_status as HelixEnvironmentDeviceCheck["credential_status"],
    credential_expires_at: credentialExpiresAt,
    probe_ready: blockingReasons.length === 0,
    blocking_reasons: blockingReasons,
    content_role: "device_health_observation_not_assistant_answer",
    credential_included: false,
    device_public_key_included: false,
    producer_epoch_included: false,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
}

export async function listEnvironmentConnectorDeviceChecks(input: {
  ownerProfileId: string;
  roomId?: string;
  now?: Date;
  staleAfterMs?: number;
}): Promise<HelixEnvironmentDeviceCheck[]> {
  const db = await readSharedRealtimeRoomDatabase();
  const values: unknown[] = [input.ownerProfileId];
  const roomFilter = input.roomId
    ? (() => {
        values.push(input.roomId);
        return `AND eb.room_id = $${values.length}`;
      })()
    : "";
  const result = await db.query<EnvironmentDeviceCheckRow>(
    `
      SELECT
        d.device_id,
        d.installation_id,
        p.package_id,
        p.package_version,
        p.trust_classification,
        p.security_review_state,
        i.status AS installation_status,
        i.installed_device_id,
        installed_device.status AS installed_device_status,
        d.status AS device_status,
        d.health_status AS reported_health_status,
        d.last_contact_at,
        d.paired_at,
        eb.environment_binding_id,
        eb.status AS binding_status,
        a.status AS admission_status,
        eb.room_id,
        eb.source_id,
        eb.world_id,
        a.domain_adapter,
        i.granted_capability_ids,
        eb.consent_capability_ids,
        COALESCE(device_credential.status, source_credential.status) AS credential_status,
        COALESCE(device_credential.expires_at, source_credential.expires_at) AS credential_expires_at
      FROM helix_environment_connector_devices d
      JOIN helix_environment_connector_installations i
        ON i.installation_id = d.installation_id
      JOIN helix_environment_connector_packages p
        ON p.package_version_id = i.package_version_id
      LEFT JOIN helix_installed_devices installed_device
        ON installed_device.profile_id = i.owner_profile_id
       AND installed_device.device_id = i.installed_device_id
      LEFT JOIN helix_environment_connector_bindings eb
        ON eb.device_id = d.device_id
      LEFT JOIN helix_environment_adapter_admissions a
        ON a.admission_id = eb.adapter_admission_id
      LEFT JOIN helix_environment_connector_device_credentials device_credential
        ON device_credential.device_credential_id = d.credential_ref
      LEFT JOIN helix_room_source_credentials source_credential
        ON source_credential.credential_id = d.credential_ref
       AND source_credential.binding_id = eb.room_source_binding_id
      WHERE i.owner_profile_id = $1
        ${roomFilter}
      ORDER BY d.paired_at DESC, d.device_id ASC, eb.created_at DESC;
    `,
    values,
  );
  return result.rows.map((row) =>
    projectEnvironmentDeviceCheck({
      row,
      now: input.now,
      staleAfterMs: input.staleAfterMs,
    }),
  );
}

export async function buildEnvironmentConnectorDeviceCheckList(input: {
  ownerProfileId: string;
  roomId?: string;
  now?: Date;
  staleAfterMs?: number;
}): Promise<HelixEnvironmentDeviceCheckList> {
  const now = input.now ?? new Date();
  return helixEnvironmentDeviceCheckListSchema.parse({
    schema: HELIX_ENVIRONMENT_DEVICE_CHECK_LIST_SCHEMA,
    generated_at: now.toISOString(),
    devices: await listEnvironmentConnectorDeviceChecks({
      ...input,
      now,
    }),
    content_role: "device_health_observations_not_assistant_answer",
    credential_included: false,
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
    raw_content_included: false,
  });
}
