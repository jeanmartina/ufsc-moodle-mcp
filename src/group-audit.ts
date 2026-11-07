import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from './moodle.js';

export type GroupAuditOperation =
  | 'create_course_group'
  | 'add_group_member'
  | 'remove_group_member'
  | 'create_group_with_members';

export type GroupAuditOutcome =
  | 'succeeded'
  | 'idempotent_replay'
  | 'partial_failure'
  | 'failed';

export interface GroupAuditEntry {
  auditId: string;
  timestamp: string;
  operation: GroupAuditOperation;
  outcome: GroupAuditOutcome;
  courseId: number;
  activityCmid?: number;
  actor?: {
    userId: number;
    username: string;
    fullname: string;
  };
  groupId?: number;
  groupName?: string;
  idempotencyKey?: string;
  requestedUserIds?: number[];
  addedUserIds?: number[];
  alreadyMemberUserIds?: number[];
  removedUserIds?: number[];
  failedUserIds?: Array<{ userId: number; errorCode: string; errorMessage: string }>;
  confirmedMemberIds?: number[];
  transportUsed: 'moodle_ws' | 'moodle_web_controller' | 'none';
  errorCode?: string;
  errorMessage?: string;
}

export interface GroupAuditStoreOptions {
  auditLogPath?: string;
  fallbackDir?: string;
  secrets?: (string | undefined)[];
}

function resolveDefaultAuditPath(explicitPath?: string, fallbackDir?: string): string {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath.trim();
  }
  if (process.env.MOODLE_AUDIT_LOG_PATH?.trim()) {
    return process.env.MOODLE_AUDIT_LOG_PATH.trim();
  }
  try {
    if (fs.existsSync('/config')) {
      fs.accessSync('/config', fs.constants.W_OK);
      return '/config/group-audit.jsonl';
    }
  } catch {
    // /config not writable; fall through
  }
  const base = fallbackDir || path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return path.join(base, 'group-audit.jsonl');
}

export class GroupAuditStore {
  private readonly logPath: string;
  private readonly secrets: (string | undefined)[];
  private readonly idempotencyMap = new Map<
    string,
    { groupId: number; groupName: string; timestampMs: number }
  >();
  private readonly createdGroupSignatures = new Map<
    string,
    { groupId: number; groupName: string; timestampMs: number }
  >();
  private readonly courseLocks = new Map<number, Promise<void>>();

  constructor(options: GroupAuditStoreOptions = {}) {
    this.logPath = resolveDefaultAuditPath(options.auditLogPath, options.fallbackDir);
    this.secrets = options.secrets ?? [];

    const parentDir = path.dirname(this.logPath);
    fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    this.hydrateFromDisk();
  }

  public getLogPath(): string {
    return this.logPath;
  }

  private hydrateFromDisk(): void {
    if (!fs.existsSync(this.logPath)) return;
    try {
      const content = fs.readFileSync(this.logPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as GroupAuditEntry;
          this.indexEntry(entry);
        } catch {
          // Ignore malformed historical line
        }
      }
    } catch {
      // Ignore initial read error
    }
  }

  private indexEntry(entry: GroupAuditEntry): void {
    if (
      (entry.operation === 'create_course_group' ||
        entry.operation === 'create_group_with_members') &&
      (entry.outcome === 'succeeded' ||
        entry.outcome === 'partial_failure' ||
        entry.outcome === 'idempotent_replay') &&
      entry.groupId &&
      entry.groupName
    ) {
      const ts = Date.parse(entry.timestamp) || Date.now();
      if (entry.idempotencyKey) {
        this.idempotencyMap.set(`${entry.courseId}:${entry.idempotencyKey}`, {
          groupId: entry.groupId,
          groupName: entry.groupName,
          timestampMs: ts,
        });
      }
      const normName = entry.groupName.trim().toLowerCase();
      this.createdGroupSignatures.set(`${entry.courseId}:${normName}`, {
        groupId: entry.groupId,
        groupName: entry.groupName,
        timestampMs: ts,
      });
    }
  }

  public record(
    partial: Omit<GroupAuditEntry, 'auditId' | 'timestamp'>
  ): GroupAuditEntry {
    const entry: GroupAuditEntry = {
      auditId: `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      timestamp: new Date().toISOString(),
      ...partial,
      ...(partial.errorMessage
        ? { errorMessage: redactSecrets(partial.errorMessage, this.secrets) }
        : {}),
      ...(partial.failedUserIds
        ? {
            failedUserIds: partial.failedUserIds.map((f) => ({
              ...f,
              errorMessage: redactSecrets(f.errorMessage, this.secrets),
            })),
          }
        : {}),
    };

    this.indexEntry(entry);

    const serialized = `${redactSecrets(JSON.stringify(entry), this.secrets)}\n`;
    fs.appendFileSync(this.logPath, serialized, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(this.logPath, 0o600);
    } catch {
      // Ignore on filesystems without chmod
    }
    return entry;
  }

  public findCreatedGroupByIdempotencyKey(
    courseId: number,
    idempotencyKey: string
  ): { groupId: number; groupName: string } | undefined {
    return this.idempotencyMap.get(`${courseId}:${idempotencyKey}`);
  }

  /**
   * Checks if a group name in `courseId` was created by this MCP server within the
   * idempotent retry window (default 15 minutes), distinguishing a post-timeout retry
   * from a pre-existing course group that must never be overwritten or reused.
   */
  public findRecentMcpCreatedGroupByName(
    courseId: number,
    groupName: string,
    windowMs = 15 * 60 * 1000
  ): { groupId: number; groupName: string } | undefined {
    const key = `${courseId}:${groupName.trim().toLowerCase()}`;
    const hit = this.createdGroupSignatures.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.timestampMs > windowMs) return undefined;
    return { groupId: hit.groupId, groupName: hit.groupName };
  }

  public readRecentEntries(limit = 50): GroupAuditEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs
      .readFileSync(this.logPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as GroupAuditEntry);
  }

  public async withCourseLock<T>(courseId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.courseLocks.get(courseId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.courseLocks.set(courseId, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.courseLocks.get(courseId) === chained) {
        this.courseLocks.delete(courseId);
      }
    }
  }
}
