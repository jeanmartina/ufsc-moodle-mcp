import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoredFileEntry {
  fileId: string;
  downloadToken: string;
  diskPath: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  declaredMimeType?: string;
  sizeBytes: number;
  sha256: string;
  canonicalFileUrl: string;
  createdAtMs: number;
  expiresAtMs: number;
  ttlSeconds: number;
}

export interface FileReferenceMetadata {
  fileId: string;
  downloadUrl?: string;
  resourceUri: string;
  savedPath?: string;
  originalFilename: string;
  safeFilename: string;
  mimeType: string;
  declaredMimeType?: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
  ttlSeconds: number;
}

const MAX_SAFE_FILENAME_LENGTH = 140;

/**
 * Normalizes and sanitizes a filename, preventing path traversal, control characters,
 * hidden dotfiles, and overly long names while preserving UTF-8 letters/accents in
 * `originalFilename` and producing an URL/filesystem-safe `safeFilename`.
 */
export function sanitizeFilenames(raw: string | undefined | null): {
  originalFilename: string;
  safeFilename: string;
} {
  const fallback = 'arquivo';
  if (!raw || !raw.trim()) {
    return { originalFilename: fallback, safeFilename: fallback };
  }

  // Normalize NFD -> NFC (e.g., macOS/Moodle decomposed accents like 'Estrate\u0301gia.pdf')
  const normalized = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();

  // Extract basename only (strip any slash or backslash path components)
  const baseOnly = normalized
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .pop()
    ?.trim();

  if (!baseOnly || /^\.+$/.test(baseOnly)) {
    return { originalFilename: fallback, safeFilename: fallback };
  }

  // Remove leading dots except when there is no other dot
  const cleanOriginal = baseOnly.replace(/^\.+(?=.*\.)/, '').replace(/^\.+$/, '') || fallback;

  // Split base and extension to cap length safely while preserving extension
  const lastDot = cleanOriginal.lastIndexOf('.');
  let stem = lastDot > 0 ? cleanOriginal.slice(0, lastDot) : cleanOriginal;
  const ext = lastDot > 0 ? cleanOriginal.slice(lastDot) : '';

  // Safe filename replaces path-unsafe or shell-problematic chars while keeping letters/accents/spaces/dashes
  let safeStem = stem
    .replace(/[<>:"/\\|?*#%]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safeStem) safeStem = fallback;

  const safeExt = ext.replace(/[^.\p{L}\p{N}_-]/gu, '').slice(0, 20);
  const maxStemLen = Math.max(16, MAX_SAFE_FILENAME_LENGTH - safeExt.length);
  if (safeStem.length > maxStemLen) {
    safeStem = safeStem.slice(0, maxStemLen).trim();
  }

  const safeFilename = `${safeStem}${safeExt}`;
  const originalBounded =
    cleanOriginal.length > MAX_SAFE_FILENAME_LENGTH
      ? `${stem.slice(0, maxStemLen)}${ext.slice(0, 20)}`
      : cleanOriginal;

  return {
    originalFilename: originalBounded,
    safeFilename,
  };
}

/**
 * Builds an RFC 5987 compliant Content-Disposition attachment header with both
 * an ASCII fallback and full UTF-8 filename*.
 */
export function buildContentDisposition(originalFilename: string): string {
  const asciiFallback = originalFilename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .trim() || 'download';

  const rfc5987 = encodeURIComponent(originalFilename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${rfc5987}`;
}

export interface TempFileStoreOptions {
  baseDir?: string;
  defaultTtlSeconds?: number;
  cleanupIntervalMs?: number;
  exportDir?: string;
}

export class TempFileStore {
  private readonly baseDir: string;
  private readonly defaultTtlSeconds: number;
  private readonly exportDir?: string;
  private readonly byId = new Map<string, StoredFileEntry>();
  private readonly byToken = new Map<string, string>(); // downloadToken -> fileId
  private readonly byUrlAndHash = new Map<string, string>(); // `${canonicalUrl}|${sha256}|${safeFilename}` -> fileId
  private readonly byCanonicalUrl = new Map<string, string>(); // canonicalUrl -> latest fileId
  private sweepTimer?: NodeJS.Timeout;

  constructor(options: TempFileStoreOptions = {}) {
    this.baseDir =
      options.baseDir ||
      process.env.MOODLE_TEMP_DIR ||
      path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
    this.defaultTtlSeconds =
      options.defaultTtlSeconds ??
      Math.max(60, Number(process.env.MOODLE_FILE_TTL_SECONDS || 1800));
    this.exportDir = options.exportDir || process.env.MOODLE_DOWNLOAD_DIR || undefined;

    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch {
      // Ignore on filesystems that don't support chmod
    }

    const intervalMs = options.cleanupIntervalMs ?? 60_000;
    this.sweepTimer = setInterval(() => {
      this.sweepExpired();
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public getDefaultTtlSeconds(): number {
    return this.defaultTtlSeconds;
  }

  public allocateStagingPath(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return path.join(this.baseDir, `staging_${nonce}.part`);
  }

  public commitStagedFile(params: {
    stagingPath: string;
    originalFilename: string;
    safeFilename: string;
    mimeType: string;
    declaredMimeType?: string;
    sizeBytes: number;
    sha256: string;
    canonicalFileUrl: string;
    ttlSeconds?: number;
  }): StoredFileEntry {
    const ttl = params.ttlSeconds ?? this.defaultTtlSeconds;
    const now = Date.now();
    const dedupKey = `${params.canonicalFileUrl}|${params.sha256}|${params.safeFilename}`;

    // Reuse existing entry if still valid and file exists on disk
    const existingId = this.byUrlAndHash.get(dedupKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && existing.expiresAtMs > now + 5_000 && fs.existsSync(existing.diskPath)) {
        try {
          fs.rmSync(params.stagingPath, { force: true });
        } catch {
          // ignore
        }
        // Refresh expiration window on reuse
        existing.expiresAtMs = now + ttl * 1000;
        existing.ttlSeconds = ttl;
        return existing;
      }
    }

    const fileId = `f_${crypto.randomBytes(16).toString('hex')}`;
    const downloadToken = `dl_${crypto.randomBytes(32).toString('hex')}`;
    const diskPath = path.join(this.baseDir, `${fileId}.bin`);

    fs.renameSync(params.stagingPath, diskPath);
    try {
      fs.chmodSync(diskPath, 0o600);
    } catch {
      // ignore
    }

    const entry: StoredFileEntry = {
      fileId,
      downloadToken,
      diskPath,
      originalFilename: params.originalFilename,
      safeFilename: params.safeFilename,
      mimeType: params.mimeType,
      declaredMimeType: params.declaredMimeType,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
      canonicalFileUrl: params.canonicalFileUrl,
      createdAtMs: now,
      expiresAtMs: now + ttl * 1000,
      ttlSeconds: ttl,
    };

    this.byId.set(fileId, entry);
    this.byToken.set(downloadToken, fileId);
    this.byUrlAndHash.set(dedupKey, fileId);
    this.byCanonicalUrl.set(params.canonicalFileUrl, fileId);
    return entry;
  }

  public findByCanonicalUrl(canonicalFileUrl: string): StoredFileEntry | undefined {
    const fileId = this.byCanonicalUrl.get(canonicalFileUrl);
    if (!fileId) return undefined;
    const entry = this.getByFileId(fileId);
    if (!entry || entry.expiresAtMs <= Date.now() + 5_000) {
      this.byCanonicalUrl.delete(canonicalFileUrl);
      return undefined;
    }
    return entry;
  }

  public getByFileId(fileId: string): StoredFileEntry | undefined {
    const entry = this.byId.get(fileId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAtMs || !fs.existsSync(entry.diskPath)) {
      this.removeEntry(entry);
      return undefined;
    }
    return entry;
  }

  public getByDownloadToken(candidateToken: string): StoredFileEntry | undefined {
    if (!candidateToken || !/^dl_[a-f0-9]{64}$/.test(candidateToken)) {
      return undefined;
    }
    const fileId = this.byToken.get(candidateToken);
    if (!fileId) return undefined;
    const entry = this.byId.get(fileId);
    if (!entry) return undefined;

    const a = Buffer.from(candidateToken, 'utf8');
    const b = Buffer.from(entry.downloadToken, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAtMs || !fs.existsSync(entry.diskPath)) {
      this.removeEntry(entry);
      return undefined;
    }
    return entry;
  }

  public toReferenceMetadata(
    entry: StoredFileEntry,
    publicBaseUrl?: string
  ): FileReferenceMetadata {
    const encodedName = encodeURIComponent(entry.safeFilename);
    const resourceUri = `moodle-file://${entry.fileId}/${encodedName}`;
    const downloadUrl = publicBaseUrl
      ? `${publicBaseUrl.replace(/\/+$/, '')}/files/${entry.downloadToken}/${encodedName}`
      : undefined;

    let savedPath: string | undefined;
    if (this.exportDir) {
      fs.mkdirSync(this.exportDir, { recursive: true });
      const uniquePrefix = entry.sha256.slice(0, 8);
      const targetPath = path.join(this.exportDir, `${uniquePrefix}_${entry.safeFilename}`);
      // Ensure path stays strictly inside exportDir
      const resolvedDir = path.resolve(this.exportDir);
      const resolvedTarget = path.resolve(targetPath);
      if (resolvedTarget.startsWith(`${resolvedDir}${path.sep}`)) {
        if (!fs.existsSync(resolvedTarget)) {
          fs.copyFileSync(entry.diskPath, resolvedTarget);
        }
        savedPath = resolvedTarget;
      }
    }

    const remainingTtl = Math.max(1, Math.round((entry.expiresAtMs - Date.now()) / 1000));

    return {
      fileId: entry.fileId,
      ...(downloadUrl ? { downloadUrl } : {}),
      resourceUri,
      ...(savedPath ? { savedPath } : {}),
      originalFilename: entry.originalFilename,
      safeFilename: entry.safeFilename,
      mimeType: entry.mimeType,
      ...(entry.declaredMimeType ? { declaredMimeType: entry.declaredMimeType } : {}),
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      ttlSeconds: remainingTtl,
    };
  }

  public listActiveEntries(): StoredFileEntry[] {
    this.sweepExpired();
    return Array.from(this.byId.values());
  }

  public sweepExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const entry of this.byId.values()) {
      if (now >= entry.expiresAtMs || !fs.existsSync(entry.diskPath)) {
        this.removeEntry(entry);
        removed++;
      }
    }
    return removed;
  }

  private removeEntry(entry: StoredFileEntry): void {
    this.byId.delete(entry.fileId);
    this.byToken.delete(entry.downloadToken);
    this.byUrlAndHash.delete(`${entry.canonicalFileUrl}|${entry.sha256}|${entry.safeFilename}`);
    if (this.byCanonicalUrl.get(entry.canonicalFileUrl) === entry.fileId) {
      this.byCanonicalUrl.delete(entry.canonicalFileUrl);
    }
    try {
      fs.rmSync(entry.diskPath, { force: true });
    } catch {
      // ignore
    }
  }

  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const entry of [...this.byId.values()]) {
      this.removeEntry(entry);
    }
  }
}
