import { appendFile, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface DiagnosticRecord {
  ts: string;
  seq: number;
  run: string;
  event: string;
  [key: string]: unknown;
}

export interface DiagnosticsOptions {
  enabled: boolean;
  file?: string;
  stderr: boolean;
  recentLimit?: number;
}

function defaultLogFile(): string {
  return join(homedir(), ".pi", "agent", "logs", "fast-jev-compaction.jsonl");
}

function safeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: safeValue(value.cause),
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = safeValue(entry);
    }
    return out;
  }
  return value;
}

export class Diagnostics {
  readonly file: string;
  readonly run: string;

  private readonly enabled: boolean;
  private readonly stderr: boolean;
  private readonly recentLimit: number;
  private readonly recentRecords: DiagnosticRecord[] = [];
  private seq = 0;
  private fileReady = false;
  private fileFailed = false;

  constructor(options: DiagnosticsOptions) {
    this.enabled = options.enabled;
    this.stderr = options.stderr;
    this.recentLimit = Math.max(10, options.recentLimit ?? 200);
    this.file = options.file?.trim() || defaultLogFile();
    this.run = `${Date.now().toString(36)}-${process.pid}`;
  }

  record(event: string, data: Record<string, unknown> = {}): DiagnosticRecord {
    const record: DiagnosticRecord = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      run: this.run,
      event,
      ...safeValue(data) as Record<string, unknown>,
    };

    this.recentRecords.push(record);
    if (this.recentRecords.length > this.recentLimit) this.recentRecords.shift();

    const line = JSON.stringify(record);
    if (this.stderr) {
      try {
        console.error(`[pi-fast-jev] ${line}`);
      } catch {
        // Diagnostics must never interfere with Pi.
      }
    }

    if (this.enabled && !this.fileFailed) {
      try {
        if (!this.fileReady) {
          mkdirSync(dirname(this.file), { recursive: true });
          this.fileReady = true;
        }
        appendFile(this.file, `${line}\n`, "utf8", (error) => {
          if (!error) return;
          this.fileFailed = true;
          try {
            console.error(`[pi-fast-jev] diagnostics file disabled: ${error.message}`);
          } catch {
            // Ignore logging failures.
          }
        });
      } catch (error) {
        this.fileFailed = true;
        try {
          console.error(`[pi-fast-jev] diagnostics file disabled: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Ignore logging failures.
        }
      }
    }

    return record;
  }

  recent(limit = 10): DiagnosticRecord[] {
    const count = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.recentRecords.slice(-count);
  }

  clear(): void {
    this.recentRecords.length = 0;
    this.seq = 0;
    this.fileFailed = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, "", "utf8");
      this.fileReady = true;
    } catch (error) {
      this.fileFailed = true;
      try {
        console.error(`[pi-fast-jev] could not clear diagnostics file: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // Ignore logging failures.
      }
    }
  }
}

export function summarizeDiagnostic(record: DiagnosticRecord): string {
  const time = record.ts.slice(11, 23);
  const bits: string[] = [];
  for (const key of [
    "hookId",
    "httpId",
    "reason",
    "outcome",
    "durationMs",
    "status",
    "piPercent",
    "logicalPercent",
    "grossPercent",
    "eligible",
    "committed",
    "cached",
    "requests",
    "totalHttpRequests",
    "questionCount",
    "requestId",
    "contextHookId",
    "contextOutcome",
    "reduction",
    "error",
  ]) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      bits.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }
  return `${time} ${record.event}${bits.length ? ` ${bits.join(" ")}` : ""}`;
}
