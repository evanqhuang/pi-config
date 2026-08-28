export type RuntimeTaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export interface RuntimeTaskOwner {
  goalId: string;
  goalGeneration: number;
}

export interface RuntimeTaskRecord {
  id: string;
  kind: string;
  status: RuntimeTaskStatus;
  description: string;
  startedAt: number;
  completedAt?: number;
  generation: number;
  outputFile?: string;
  result?: string;
  error?: string;
  owner?: RuntimeTaskOwner;
  notified: boolean;
}

export interface RuntimeTaskOutput {
  text: string;
  nextOffset: number;
  eof: boolean;
}

export interface RuntimeTaskProvider {
  readonly name: string;
  list(): RuntimeTaskRecord[];
  get(id: string): RuntimeTaskRecord | undefined;
  wait(id: string, signal?: AbortSignal): Promise<RuntimeTaskRecord | undefined>;
  kill?(id: string): boolean | Promise<boolean>;
  readOutput?(id: string, offset: number, maxBytes: number): RuntimeTaskOutput | undefined;
}

export interface RuntimeTaskHub {
  readonly sessionId: string;
  registerProvider(provider: RuntimeTaskProvider): () => void;
  list(owner?: RuntimeTaskOwner): RuntimeTaskRecord[];
  get(id: string): RuntimeTaskRecord | undefined;
  wait(id: string, signal?: AbortSignal): Promise<RuntimeTaskRecord | undefined>;
  kill(id: string): Promise<boolean>;
  readOutput(id: string, offset?: number, maxBytes?: number): RuntimeTaskOutput | undefined;
  hasRunning(owner?: RuntimeTaskOwner): boolean;
  currentOwner(): RuntimeTaskOwner | undefined;
  setDefaultOwner(owner: RuntimeTaskOwner | undefined): void;
  clearDefaultOwner(expected?: RuntimeTaskOwner): void;
  withOwner<T>(owner: RuntimeTaskOwner | undefined, fn: () => T): T;
}

export interface RuntimeTaskRegistry {
  createSession(sessionId: string): RuntimeTaskHub;
  getSession(sessionId: string): RuntimeTaskHub | undefined;
  deleteSession(sessionId: string, hub: RuntimeTaskHub): void;
}
