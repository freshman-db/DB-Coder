/** Code entry point discovered by deterministic scanning or AI refinement. */
export interface EntryPoint {
  name: string; // "POST /api/tasks", "runCycle()"
  file: string; // relative to project root
  line: number;
  kind: "http" | "cli" | "event" | "timer" | "export" | "other";
}

/** Cross-module boundary where data flows between files. */
export interface BoundaryPoint {
  crossing: string; // "MainLoop.workerExecute → ClaudeCodeSession.run"
  producerFile: string;
  consumerFile: string;
  dataFlowing: string; // description of data type/fields
  producerContract: string; // what the producer promises
  consumerAssumption: string; // what the consumer assumes
}

/** Contract mismatch found at a boundary. */
export interface BoundaryFinding {
  boundary: BoundaryPoint;
  mismatch: string; // specific mismatch description
  severity: "critical" | "high" | "medium";
  failureScenario: string; // what concrete problem this causes
  fingerprint: string; // dedup key: md5(crossing+mismatch).slice(0,16)
}

/** A fully traced execution chain from an entry point. */
export interface TracedChain {
  entryPoint: EntryPoint;
  callPath: string[]; // call sequence
  boundaries: BoundaryPoint[];
}

/** Persistent state for chain scanning (stored in DB chain_scan_state table). */
export interface ChainScanState {
  projectPath: string; // primary key
  nextIndex: number;
  entryPoints: EntryPoint[];
  knownFingerprints: string[]; // fingerprints of findings already turned into tasks
  lastDiscoveryAt: string; // ISO timestamp
  lastScanAt: string; // ISO timestamp
  scanCount: number; // total scans, used for rediscovery decision
}

/** Configuration for chain scanning. */
export interface ChainScanConfig {
  enabled: boolean;
  interval: number; // trigger every N completed tasks (default 5)
  maxBudget: number; // max USD per scan trigger (default 3.0)
  chainsPerTrigger: number; // how many chains to scan per trigger (default 2)
  rediscoveryInterval: number; // re-discover entry points every N scans (default 10)
}
