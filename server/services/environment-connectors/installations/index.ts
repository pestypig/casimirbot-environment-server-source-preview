export type EnvironmentConnectorInstallationStatus =
  | "active"
  | "suspended"
  | "revoked"
  | "uninstalled";

/**
 * Installations are owner-scoped grants over one immutable package version.
 * Persistence is introduced by migration 039 and materialized by the binding
 * or pairing services; they are intentionally not merged with devices.
 */
export const environmentConnectorInstallationTable =
  "helix_environment_connector_installations" as const;

