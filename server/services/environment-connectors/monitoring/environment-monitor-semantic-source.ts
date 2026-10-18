import {
  buildHelixEnvironmentMonitorIdleDelivery,
  type HelixEnvironmentMonitorDelivery,
  type HelixEnvironmentMonitorItem,
  type HelixEnvironmentMonitorLease,
} from "@shared/helix-environment-monitor";
import type { StagePlayLiveSourceMailItemV1 } from
  "@shared/contracts/stage-play-live-source-mail.v1";
import {
  listStagePlayLiveSourceMailItems,
  listStagePlayLiveSourceMailCompactionIntervals,
  subscribeStagePlayLiveSourceMailEnqueued,
  type StagePlayLiveSourceMailEnqueuedEvent,
  type StagePlayLiveSourceMailCompactionIntervalV1,
} from "../../stage-play/stage-play-live-source-mailbox-store";
import {
  environmentMonitorStore,
  type EnvironmentMonitorStore,
} from "./environment-monitor-store";

type MonitorAccess = {
  monitorId: string;
  profileId: string;
  mcpClientId: string;
  clientContinuationRef: string;
};

type MonitorStorePort = Pick<
  EnvironmentMonitorStore,
  "inspect" | "readPendingDeliveries" | "findDeliveredEvidenceRefs" | "deliver" | "markRetentionGap"
>;

type MailReader = typeof listStagePlayLiveSourceMailItems;
type MailSubscriber = typeof subscribeStagePlayLiveSourceMailEnqueued;
type CompactionReader = typeof listStagePlayLiveSourceMailCompactionIntervals;

const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];

const semanticTokens = (summary: Record<string, unknown>): string[] => {
  const state = record(summary.semantic_state);
  return [
    ...strings(summary.changed_fields),
    ...strings(state?.semantic_event_types),
    ...Object.keys(state ?? {}),
  ].map((entry: string) => entry.toLowerCase());
};

export const classifyEnvironmentMonitorEventFamilies = (
  summary: Record<string, unknown>,
): HelixEnvironmentMonitorLease["event_families"] => {
  const text = semanticTokens(summary).join(" ");
  const families = new Set<HelixEnvironmentMonitorLease["event_families"][number]>();
  if (/inventory|item|hotbar|equip|craft/u.test(text)) families.add("inventory");
  if (/hazard|damage|health|air|fire|lava|fall|death|threat|drown/u.test(text)) {
    families.add("hazard");
  }
  if (/actor|viability|position|food|movement|velocity/u.test(text)) families.add("actor");
  if (/workflow|action|sequence|guardian|program/u.test(text)) families.add("workflow");
  if (/focus|advancement|target|screen|crosshair/u.test(text)) families.add("focus");
  if (/authority|lease|consent|override|emergency/u.test(text)) families.add("authority");
  if (/durable|goal|milestone|checkpoint/u.test(text)) families.add("durable_goal");
  if (families.size === 0) families.add("actor");
  return [...families].sort();
};

const parseSummary = (mail: StagePlayLiveSourceMailItemV1): Record<string, unknown> => {
  try {
    return record(JSON.parse(mail.summary.text) as unknown) ?? {};
  } catch {
    return {};
  }
};

const projectMail = (input: {
  mail: StagePlayLiveSourceMailItemV1;
  lease: HelixEnvironmentMonitorLease;
  now: string;
}): HelixEnvironmentMonitorItem | null => {
  const identity = input.mail.environmentIdentity;
  if (
    !identity ||
    !identity.provenanceValid ||
    identity.participantId !== input.lease.identity.participant_id ||
    input.mail.sourceId !== input.lease.identity.source_id ||
    identity.worldId !== input.lease.identity.world_id ||
    identity.subjectRef !== input.lease.identity.subject_ref ||
    identity.producerEpochRef !== input.lease.identity.producer_epoch_ref ||
    !sha256Pattern.test(identity.digestHash)
  ) {
    return null;
  }
  const observedMs = Date.parse(input.mail.createdAt);
  const nowMs = Date.parse(input.now);
  if (
    !Number.isFinite(observedMs) ||
    !Number.isFinite(nowMs) ||
    nowMs - observedMs > input.lease.max_event_age_ms ||
    observedMs - nowMs > 5_000
  ) {
    return null;
  }
  const admitted = classifyEnvironmentMonitorEventFamilies(parseSummary(input.mail))
    .filter((family) => input.lease.event_families.includes(family));
  if (admitted.length === 0) return null;
  return {
    evidence_ref: identity.digestId,
    digest_id: identity.digestId,
    digest_hash: identity.digestHash,
    observation_revision: identity.observationRevision,
    event_families: admitted,
    source_id: input.mail.sourceId,
    world_id: identity.worldId,
    subject_ref: identity.subjectRef,
    producer_epoch_ref: identity.producerEpochRef,
    observed_at: input.mail.createdAt,
    provenance_valid: true,
    raw_events_included: false,
    content_role: "environment_monitor_item_not_assistant_answer",
    answer_authority: false,
    assistant_answer: false,
    terminal_eligible: false,
  };
};

export class EnvironmentMonitorSemanticSource {
  constructor(
    private readonly store: MonitorStorePort = environmentMonitorStore,
    private readonly readMail: MailReader = listStagePlayLiveSourceMailItems,
    private readonly subscribeMail: MailSubscriber =
      subscribeStagePlayLiveSourceMailEnqueued,
    private readonly readCompactions: CompactionReader =
      listStagePlayLiveSourceMailCompactionIntervals,
  ) {}

  async readOrWait(input: MonitorAccess & {
    timeoutMs?: number;
    limit?: number;
    now?: () => string;
  }): Promise<{
    lease: HelixEnvironmentMonitorLease;
    delivery: HelixEnvironmentMonitorDelivery;
  }> {
    const now = input.now ?? (() => new Date().toISOString());
    const timeoutMs = Math.max(0, Math.min(10_000, input.timeoutMs ?? 0));
    const first = await this.tryRead(input, now(), input.limit);
    if (first) return first;
    if (timeoutMs === 0) {
      const lease = await this.store.inspect(input);
      return { lease, delivery: buildHelixEnvironmentMonitorIdleDelivery({ lease, now: now() }) };
    }
    return await new Promise((resolve, reject) => {
      let settled = false;
      let checking = false;
      const finish = (result: { lease: HelixEnvironmentMonitorLease; delivery: HelixEnvironmentMonitorDelivery }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        reject(error);
      };
      const check = async (): Promise<void> => {
        if (settled || checking) return;
        checking = true;
        try {
          const result = await this.tryRead(input, now(), input.limit);
          if (result) finish(result);
        } catch (error) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      const unsubscribe = this.subscribeMail((event: StagePlayLiveSourceMailEnqueuedEvent) => {
        const identity = event.mail.environmentIdentity;
        if (
          event.mail.roomId === undefined ||
          identity?.participantId === null
        ) return;
        void check();
      });
      const timer = setTimeout(() => {
        void this.store.inspect(input).then((lease) => finish({
          lease,
          delivery: buildHelixEnvironmentMonitorIdleDelivery({ lease, now: now() }),
        }), fail);
      }, timeoutMs);
      void check();
    });
  }

  private async tryRead(
    access: MonitorAccess,
    now: string,
    limit = 10,
  ): Promise<{
    lease: HelixEnvironmentMonitorLease;
    delivery: HelixEnvironmentMonitorDelivery;
  } | null> {
    const pending = await this.store.readPendingDeliveries({ ...access, limit: 1 });
    if (
      pending.lease.status !== "active" ||
      pending.lease.fresh_snapshot_required ||
      pending.lease.wakes_delivered >= pending.lease.wake_budget_total ||
      Date.parse(pending.lease.expires_at) <= Date.parse(now)
    ) {
      return {
        lease: pending.lease,
        delivery: buildHelixEnvironmentMonitorIdleDelivery({ lease: pending.lease, now }),
      };
    }
    if (pending.deliveries[0]) {
      return { lease: pending.lease, delivery: pending.deliveries[0] };
    }
    const items = this.readMail({
      threadId: pending.lease.identity.room_id
        ? `helix-ask:room:${pending.lease.identity.room_id}`
        : undefined,
      roomId: pending.lease.identity.room_id,
      sourceId: pending.lease.identity.source_id,
      sourceKind: "minecraft_world_event",
      limit: 250,
    })
      .map((mail: StagePlayLiveSourceMailItemV1) =>
        projectMail({ mail, lease: pending.lease, now }),
      )
      .filter((item): item is HelixEnvironmentMonitorItem => item !== null)
      .slice(-Math.max(1, Math.min(20, limit)));
    if (items.length === 0) {
      const continuityFrom = pending.lease.recovery_snapshot_observed_at ??
        pending.lease.created_at;
      const compacted = this.readCompactions({
        threadId: pending.lease.identity.room_id
          ? `helix-ask:room:${pending.lease.identity.room_id}`
          : undefined,
        roomId: pending.lease.identity.room_id,
        sourceId: pending.lease.identity.source_id,
        limit: 120,
      }).filter((interval: StagePlayLiveSourceMailCompactionIntervalV1) =>
        Date.parse(interval.endCreatedAt) > Date.parse(continuityFrom) &&
        interval.evidenceRefs.includes(pending.lease.identity.subject_ref) &&
        interval.evidenceRefs.includes(pending.lease.identity.producer_epoch_ref),
      );
      const compactedDigestRefs = [...new Set(compacted.flatMap(
        (interval: StagePlayLiveSourceMailCompactionIntervalV1) =>
          interval.evidenceRefs.filter((ref: string) =>
            !ref.startsWith("sha256:") && /digest/iu.test(ref),
          ),
      ))];
      if (compactedDigestRefs.length > 0) {
        const delivered = await this.store.findDeliveredEvidenceRefs({
          ...access,
          evidenceRefs: compactedDigestRefs,
        });
        if (delivered.length < compactedDigestRefs.length) {
          return await this.store.markRetentionGap({ ...access, now });
        }
      }
      return null;
    }
    const delivered = await this.store.deliver({
      ...access,
      items,
      now,
      clientWakeTransport: "active_wait",
    });
    return delivered.delivery
      ? { lease: delivered.lease, delivery: delivered.delivery }
      : null;
  }
}

export const environmentMonitorSemanticSource =
  new EnvironmentMonitorSemanticSource();
