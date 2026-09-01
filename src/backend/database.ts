/**
 * Compatibility facade for the backend persistence API.
 *
 * New code should depend on the owning repository/service directly. Existing
 * tests and callers can keep importing this module while the HTTP boundary is
 * decomposed incrementally.
 */
export * from "./db";
export * from "./repositories/audit";
export * from "./repositories/organizations";
export * from "./repositories/clubs";
export * from "./repositories/hubs";
export * from "./repositories/apps";
export * from "./repositories/devices";
export * from "./services/device-service";
export * from "./services/authorization";
export * from "./services/agent-security";
export * from "./services/command-policy";
export * from "./services/command-service";
export * from "./services/session-state";
export * from "./services/session-service";
export * from "./services/hub-sync-service";
export * from "./seed/demo-data";
