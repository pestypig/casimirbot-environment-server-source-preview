import {
  helixBrokerageMarketObserverReceiptSchema,
  type HelixBrokerageMarketObserverReceipt,
} from "@shared/trading/brokerage-market-observer";
import {
  helixEnvironmentMonitorSha256,
  type HelixEnvironmentMonitorItem,
  type HelixEnvironmentMonitorLease,
  type HelixEnvironmentMonitorDelivery,
} from "@shared/helix-environment-monitor";
import {
  environmentMonitorStore,
  type EnvironmentMonitorStore,
} from "./environment-monitor-store";

type MonitorAccess = {
  profileId: string;
  mcpClientId: string;
  clientContinuationRef: string;
};

type MonitorStorePort = Pick<EnvironmentMonitorStore, "inspect" | "deliver">;

const eventFamiliesFor = (
  receipt: HelixBrokerageMarketObserverReceipt,
): HelixEnvironmentMonitorItem["event_families"] => {
  const families = new Set<HelixEnvironmentMonitorItem["event_families"][number]>([
    "paper_simulation",
  ]);
  for (const event of receipt.event_types) {
    if (event === "paper_position_marked") families.add("market");
    if (event.includes("position")) families.add("portfolio");
    if (event.includes("order") || event.includes("stop")) families.add("orders");
    if (event.includes("stop") || event === "risk_kill_switch_activated") {
      families.add("risk_control");
    }
  }
  return [...families].sort();
};

const assertExactIdentity = (input: {
  lease: HelixEnvironmentMonitorLease;
  receipt: HelixBrokerageMarketObserverReceipt;
}): void => {
  const { identity } = input.lease;
  const receipt = input.receipt;
  const mismatches = [
    input.lease.monitor_id !== receipt.monitor_lease_id && "monitor_id",
    identity.owner_profile_id !== receipt.owner_profile_id && "owner_profile_id",
    identity.room_id !== receipt.room_id && "room_id",
    identity.environment_binding_id !== receipt.environment_binding_id &&
      "environment_binding_id",
    identity.source_id !== receipt.connection_id && "source_id",
    identity.world_id !== receipt.paper_account_id && "world_id",
    identity.subject_ref !== receipt.paper_account_id && "subject_ref",
    identity.producer_epoch_ref !== receipt.producer_epoch_ref &&
      "producer_epoch_ref",
  ].filter((value): value is string => Boolean(value));
  if (mismatches.length > 0) {
    throw new Error(
      `brokerage_monitor_identity_mismatch:${mismatches.join(",")}`,
    );
  }
};

export class BrokerageMarketObserverSemanticSource {
  constructor(
    private readonly store: MonitorStorePort = environmentMonitorStore,
  ) {}

  async deliver(input: MonitorAccess & {
    receipt: HelixBrokerageMarketObserverReceipt;
    now?: string;
  }): Promise<{
    lease: HelixEnvironmentMonitorLease;
    delivery: HelixEnvironmentMonitorDelivery | null;
    duplicate_evidence_refs: string[];
  }> {
    const receipt = helixBrokerageMarketObserverReceiptSchema.parse(input.receipt);
    const access = {
      monitorId: receipt.monitor_lease_id,
      profileId: input.profileId,
      mcpClientId: input.mcpClientId,
      clientContinuationRef: input.clientContinuationRef,
    };
    const lease = await this.store.inspect(access);
    assertExactIdentity({ lease, receipt });
    if (!receipt.semantic_wake_eligible) {
      return { lease, delivery: null, duplicate_evidence_refs: [] };
    }
    const item: HelixEnvironmentMonitorItem = {
      evidence_ref: receipt.observer_cycle_id,
      digest_id: receipt.observer_cycle_id,
      digest_hash: helixEnvironmentMonitorSha256(receipt),
      observation_revision: receipt.observation_revision,
      event_families: eventFamiliesFor(receipt),
      source_id: receipt.connection_id,
      world_id: receipt.paper_account_id,
      subject_ref: receipt.paper_account_id,
      producer_epoch_ref: receipt.producer_epoch_ref,
      observed_at: receipt.source_observed_at,
      provenance_valid: true,
      raw_events_included: false,
      content_role: "environment_monitor_item_not_assistant_answer",
      answer_authority: false,
      assistant_answer: false,
      terminal_eligible: false,
    };
    return this.store.deliver({
      ...access,
      items: [item],
      now: input.now,
      clientWakeTransport: "active_wait",
    });
  }
}

export const brokerageMarketObserverSemanticSource =
  new BrokerageMarketObserverSemanticSource();
