export function buildReconnectCandidates(input?: {
  lastKnownIp?: string | null;
  previousIps?: string[];
  heartbeatIp?: string | null;
}): string[];

export function createAdbSupervisor(options?: {
  port?: number;
  debounceMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterRatio?: number;
  random?: () => number;
  now?: () => number;
  log?: (scope: string, message: string, extra?: unknown) => void;
  getKnownState?: (stableSerial: string) => any;
  rememberRoute?: (stableSerial: string, updates: Record<string, unknown>) => void;
  checkRoutePortOpen?: (ip: string, port: number) => Promise<boolean>;
  adbDisconnect?: (serial: string) => Promise<{ success: boolean; message?: string }>;
  adbConnect?: (serial: string) => Promise<{ success: boolean; message?: string }>;
  verifyRouteIdentity?: (input: {
    stableSerial: string;
    serial: string;
    expectedStableId?: string | null;
    expectedAndroidId?: string | null;
  }) => Promise<{ matched: boolean; stableId?: string | null; androidId?: string | null; message?: string }>;
  checkAdbRecoveryPermission?: () => { allowed: boolean; status: string; message?: string };
  tryEnableWirelessAdb?: (input?: unknown) => Promise<{ success: boolean; status: string; message?: string }>;
}): {
  getState: (stableSerial: string) => any;
  getMetrics: (stableSerial: string) => any;
  getInFlightCount: () => number;
  getStateCount: () => number;
  forget: (stableSerial: string) => boolean;
  tick: (route: any, options?: Record<string, unknown>) => Promise<any>;
  forceReconnect: (stableSerial: string, options?: Record<string, unknown>) => Promise<any>;
};
