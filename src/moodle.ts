import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import {
  TempFileStore,
  sanitizeFilenames,
  type FileReferenceMetadata,
  type StoredFileEntry,
} from './file-store.js';
import {
  checkOcrCapabilities,
  extractImageWithOcr,
  extractPdfWithOcr,
  type OcrCapabilities,
  type OcrConfigSettings,
  type OcrMode,
  type OcrPageFailure,
  type OcrPageResult,
  type OcrUnprocessedPage,
} from './ocr.js';
import {
  getEffectivePublicBaseUrl,
  recordCacheHit,
  recordFileDownload,
  recordMoodleApiCall,
} from './request-context.js';

export interface MoodleConfig {
  siteUrl: string;
  restEndpoint: string;
  token?: string;
  username?: string;
  password?: string;
  defaultCourseId?: number;
  tokenFilePath?: string;
  publicBaseUrl?: string;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
  fileTtlSeconds?: number;
  tempDir?: string;
  downloadDir?: string;
  auditLogPath?: string;
  gradingAuditLogPath?: string;
  gradingStateDir?: string;
  resourceAuditLogPath?: string;
  ocrEnabled?: boolean;
  ocrMaxPages?: number;
  ocrDpi?: number;
  ocrTimeoutMs?: number;
  ocrPageTimeoutMs?: number;
  ocrMaxConcurrency?: number;
  ocrDefaultLanguages?: string[];
  ocrTesseractBin?: string;
  ocrPdftoppmBin?: string;
}

export interface SiteInfo {
  sitename: string;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  userid: number;
  siteurl: string;
  useremail?: string;
  release?: string;
  version?: string;
  functions?: Array<{ name: string; version?: string }>;
}

export type DownloadErrorCode =
  | 'invalid_url'
  | 'invalid_origin'
  | 'unauthorized_route'
  | 'redirect_blocked'
  | 'auth_failed'
  | 'access_denied'
  | 'not_found'
  | 'html_error_page'
  | 'invalid_file_format'
  | 'moodle_ws_error'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'network_error';

export class MoodleDownloadError extends Error {
  public readonly code: DownloadErrorCode;
  public readonly httpStatus?: number;

  constructor(code: DownloadErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'MoodleDownloadError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type ExtractionStatus =
  | 'downloaded_with_text'
  | 'downloaded_needs_ocr'
  | 'downloaded_ocr_no_text'
  | 'downloaded_ocr_error'
  | 'downloaded_parser_error'
  | 'unsupported_binary'
  | 'not_attempted';

export type ExtractionMethod =
  | 'native_pdf'
  | 'ocr_pdf'
  | 'hybrid_pdf_ocr'
  | 'ocr_image'
  | 'docx_xml'
  | 'odt_xml'
  | 'pptx_xml'
  | 'zip_archive'
  | 'plain_text'
  | 'none';

export interface DownloadFileOptions {
  filename?: string;
  timeoutMs?: number;
  maxBytes?: number;
  ttlSeconds?: number;
  publicBaseUrl?: string;
  forceDownload?: boolean;
}

export type DownloadFileOutcome =
  | {
      ok: true;
      status: 'downloaded';
      entry: StoredFileEntry;
      file: FileReferenceMetadata;
      canonicalFileUrl: string;
      reusedCachedFile?: boolean;
    }
  | {
      ok: false;
      status: 'failed';
      errorCode: DownloadErrorCode;
      errorMessage: string;
      httpStatus?: number;
      canonicalFileUrl?: string;
    };

export interface ExtractedFileResult {
  filename: string;
  originalFilename: string;
  safeFilename?: string;
  fileurl: string;
  fileKey: string;
  mimetype?: string;
  declaredMimeType?: string;
  filesize?: number;
  downloadStatus: 'downloaded' | 'failed' | 'not_downloaded';
  reusedCachedFile?: boolean;
  extractionStatus: ExtractionStatus;
  extractionMethod: ExtractionMethod;
  ocrStatus?:
    | 'not_requested'
    | 'diagnostic_only'
    | 'not_needed'
    | 'completed'
    | 'completed_no_text'
    | 'partial_failure'
    | 'failed'
    | 'unavailable';
  ocrMode?: OcrMode;
  ocrLanguagesUsed?: string[];
  ocrConfidence?: number;
  needsOcr: boolean;
  fileId?: string;
  downloadUrl?: string;
  resourceUri?: string;
  savedPath?: string;
  sha256?: string;
  expiresAt?: string;
  ttlSeconds?: number;
  pageCount?: number;
  pagesWithTextCount?: number;
  nativeTextPageNumbers?: number[];
  ocrProcessedPageNumbers?: number[];
  emptyPageNumbers?: number[];
  unprocessedPages?: OcrUnprocessedPage[];
  failedPages?: OcrPageFailure[];
  pages?: OcrPageResult[];
  extractedText?: string;
  truncated?: boolean;
  parserError?: string;
  parserErrorCode?: string;
  ocrError?: string;
  errorCode?: DownloadErrorCode;
  errorMessage?: string;
  note?: string;
  source?: 'individual_submission' | 'group_submission';
  submissionId?: number;
  groupId?: number;
  groupName?: string;
}

export interface GroupMemberInfo {
  id: number;
  fullname: string;
  email?: string;
}

export interface GroupInfo {
  id: number;
  name: string;
  members: GroupMemberInfo[];
  hasNonStudentMembers?: boolean;
}

export interface EnrolledUserSummary {
  id: number;
  fullname: string;
  email?: string;
  username?: string;
  groups: { id: number; name: string }[];
  roles: string[];
}

export interface AssignmentConfigEntry {
  plugin: string;
  subtype: string;
  name: string;
  value: string;
}

export interface AssignmentSummaryMeta {
  id: number;
  cmid?: number;
  name: string;
  maxGrade: number;
  teamsubmission: boolean;
  teamsubmissiongroupingid: number;
  preventsubmissionnotingroup: boolean;
  requireallteammemberssubmit: boolean;
  markingworkflow: boolean;
  markingallocation: boolean;
  blindmarking: boolean;
  duedate?: number;
  configs?: AssignmentConfigEntry[];
}

export interface AssignmentContext {
  courseId: number;
  courseName?: string;
  assignment: AssignmentSummaryMeta;
  usersById: Map<number, EnrolledUserSummary>;
  groupsById: Map<number, GroupInfo>;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000; // 60s

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'php', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs',
  'kt', 'swift', 'scala', 'r', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'tex', 'bib', 'ini', 'cfg', 'conf', 'env', 'dockerfile', 'makefile', 'vhdl', 'vhd', 'v', 'sv',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff',
]);

export function extensionOf(filename: string): string {
  const base = filename.split('/').pop() ?? filename;
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx + 1) : '';
}

export function redactSecrets(input: string, secrets: (string | undefined)[] = []): string {
  let out = input
    .replace(/([?&](?:ws)?token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&]password=)[^&\s"']+/gi, '$1[REDACTED]');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

export function stripTokenFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('token');
    u.searchParams.delete('wstoken');
    return u.href;
  } catch {
    return redactSecrets(rawUrl);
  }
}

export function computeFileKey(canonicalUrl: string): string {
  return `fk_${crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16)}`;
}

export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function flattenParams(
  obj: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemKey = `${fullKey}[${index}]`;
        if (item !== null && typeof item === 'object') {
          flattenParams(item as Record<string, unknown>, itemKey, out);
        } else if (typeof item === 'boolean') {
          out[itemKey] = item ? '1' : '0';
        } else if (item !== undefined) {
          out[itemKey] = String(item);
        }
      });
    } else if (typeof value === 'object') {
      flattenParams(value as Record<string, unknown>, fullKey, out);
    } else if (typeof value === 'boolean') {
      out[fullKey] = value ? '1' : '0';
    } else {
      out[fullKey] = String(value);
    }
  }
  return out;
}

function decodeHeaderLatin1Utf8(raw: string): string {
  // HTTP headers without RFC 5987 encoding are exposed as Latin-1 (ISO-8859-1) by Fetch/Undici.
  // Moodle PHP often emits raw UTF-8 bytes inside `filename="..."`; recover UTF-8 cleanly if valid.
  if (!/[\u0080-\u00ff]/.test(raw)) return raw;
  try {
    const bytes = Buffer.from(raw, 'latin1');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    return raw;
  }
}

function parseFilenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const utf8Match = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // fall through
    }
  }
  const quotedMatch = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quotedMatch?.[1]) return decodeHeaderLatin1Utf8(quotedMatch[1].trim());
  const bareMatch = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bareMatch?.[1]) return decodeHeaderLatin1Utf8(bareMatch[1].trim());
  return undefined;
}

function sniffMimeFromBytes(head: Uint8Array, ext: string, declaredMime: string): {
  mimeType: string;
  hasPdfSignature: boolean;
  looksLikeHtml: boolean;
} {
  // Check %PDF- within first 1024 bytes (PDF spec allows preamble whitespace/header)
  const pdfCheckSlice = head.subarray(0, Math.min(head.length, 1024));
  const pdfLatin = Buffer.from(pdfCheckSlice).toString('latin1');
  const hasPdfSignature = pdfLatin.includes('%PDF-');

  const headUtf8 = new TextDecoder('utf-8', { fatal: false })
    .decode(head.subarray(0, Math.min(head.length, 2048)))
    .trimStart();

  const looksLikeHtml =
    /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(
      headUtf8
    ) ||
    headUtf8.includes('sistemas.ufsc.br/login') ||
    headUtf8.includes('/login/index.php');

  if (hasPdfSignature) {
    return { mimeType: 'application/pdf', hasPdfSignature: true, looksLikeHtml: false };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return { mimeType: 'image/png', hasPdfSignature: false, looksLikeHtml: false };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mimeType: 'image/jpeg', hasPdfSignature: false, looksLikeHtml: false };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38
  ) {
    return { mimeType: 'image/gif', hasPdfSignature: false, looksLikeHtml: false };
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return { mimeType: 'image/webp', hasPdfSignature: false, looksLikeHtml: false };
  }
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  ) {
    if (ext === 'docx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        hasPdfSignature: false,
        looksLikeHtml: false,
      };
    }
    if (ext === 'pptx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        hasPdfSignature: false,
        looksLikeHtml: false,
      };
    }
    if (ext === 'xlsx') {
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        hasPdfSignature: false,
        looksLikeHtml: false,
      };
    }
    if (ext === 'odt') {
      return {
        mimeType: 'application/vnd.oasis.opendocument.text',
        hasPdfSignature: false,
        looksLikeHtml: false,
      };
    }
    return { mimeType: 'application/zip', hasPdfSignature: false, looksLikeHtml: false };
  }

  const cleanDeclared = declaredMime.split(';')[0]?.trim().toLowerCase() || '';
  if (
    cleanDeclared &&
    cleanDeclared !== 'application/octet-stream' &&
    cleanDeclared !== 'application/forcedownload' &&
    cleanDeclared !== 'binary/octet-stream'
  ) {
    return { mimeType: cleanDeclared, hasPdfSignature: false, looksLikeHtml };
  }

  if (ext === 'pdf') return { mimeType: 'application/pdf', hasPdfSignature: false, looksLikeHtml };
  if (TEXT_EXTENSIONS.has(ext)) {
    return { mimeType: 'text/plain; charset=utf-8', hasPdfSignature: false, looksLikeHtml };
  }
  return {
    mimeType: cleanDeclared || 'application/octet-stream',
    hasPdfSignature: false,
    looksLikeHtml,
  };
}

export function loadMoodleConfig(): MoodleConfig {
  const rawUrl = (
    process.env.MOODLE_URL ||
    process.env.MOODLE_API_URL ||
    'https://presencial.moodle.ufsc.br'
  ).trim();

  const siteUrl = rawUrl
    .replace(/\/webservice\/rest\/server\.php.*$/i, '')
    .replace(/\/+$/, '');
  const restEndpoint = `${siteUrl}/webservice/rest/server.php`;

  let token = (process.env.MOODLE_API_TOKEN || process.env.MOODLE_TOKEN || '').trim() || undefined;
  let tokenFilePath: string | undefined;

  const possibleTokenPaths = [
    process.env.MOODLE_TOKEN_FILE,
    '/config/token',
    './config/token',
    'token',
  ].filter((p): p is string => Boolean(p));

  if (!token) {
    for (const p of possibleTokenPaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (content) {
          token = content;
          tokenFilePath = p;
          break;
        }
      }
    }
  }

  const username =
    (process.env.MOODLE_USERNAME || process.env.UFSC_USERNAME || '').trim() || undefined;
  let password =
    (process.env.MOODLE_PASSWORD || process.env.UFSC_PASSWORD || '').trim() || undefined;
  if (!password) {
    for (const p of ['/config/password', './config/password', 'password']) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (content) {
          password = content;
          break;
        }
      }
    }
  }

  const defaultCourseRaw = process.env.MOODLE_COURSE_ID?.trim();
  const defaultCourseId =
    defaultCourseRaw && /^\d+$/.test(defaultCourseRaw) ? Number(defaultCourseRaw) : undefined;

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
  const maxDownloadBytes = process.env.MOODLE_MAX_DOWNLOAD_BYTES
    ? Math.max(1024, Number(process.env.MOODLE_MAX_DOWNLOAD_BYTES))
    : DEFAULT_MAX_DOWNLOAD_BYTES;
  const downloadTimeoutMs = process.env.MOODLE_DOWNLOAD_TIMEOUT_MS
    ? Math.max(1000, Number(process.env.MOODLE_DOWNLOAD_TIMEOUT_MS))
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const fileTtlSeconds = process.env.MOODLE_FILE_TTL_SECONDS
    ? Math.max(60, Number(process.env.MOODLE_FILE_TTL_SECONDS))
    : 1800;

  const ocrEnabledRaw = process.env.MOODLE_OCR_ENABLED?.trim().toLowerCase();
  const ocrEnabled =
    ocrEnabledRaw === undefined || ocrEnabledRaw === ''
      ? true
      : !['0', 'false', 'off', 'no'].includes(ocrEnabledRaw);
  const ocrMaxPages = process.env.MOODLE_OCR_MAX_PAGES
    ? Math.max(1, Math.min(200, Number(process.env.MOODLE_OCR_MAX_PAGES)))
    : 30;
  const ocrDpi = process.env.MOODLE_OCR_DPI
    ? Math.max(72, Math.min(300, Number(process.env.MOODLE_OCR_DPI)))
    : 200;
  const ocrTimeoutMs = process.env.MOODLE_OCR_TIMEOUT_MS
    ? Math.max(1000, Number(process.env.MOODLE_OCR_TIMEOUT_MS))
    : 120_000;
  const ocrPageTimeoutMs = process.env.MOODLE_OCR_PAGE_TIMEOUT_MS
    ? Math.max(1000, Number(process.env.MOODLE_OCR_PAGE_TIMEOUT_MS))
    : 60_000;
  const ocrMaxConcurrency = process.env.MOODLE_OCR_MAX_CONCURRENCY
    ? Math.max(1, Math.min(8, Number(process.env.MOODLE_OCR_MAX_CONCURRENCY)))
    : 2;
  const ocrDefaultLanguages = process.env.MOODLE_OCR_LANGUAGES
    ? process.env.MOODLE_OCR_LANGUAGES.split(/[+,;\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : ['eng', 'por'];

  return {
    siteUrl,
    restEndpoint,
    token,
    username,
    password,
    defaultCourseId,
    tokenFilePath: tokenFilePath || (fs.existsSync('/config') ? '/config/token' : undefined),
    publicBaseUrl,
    maxDownloadBytes,
    downloadTimeoutMs,
    fileTtlSeconds,
    tempDir: process.env.MOODLE_TEMP_DIR?.trim() || undefined,
    downloadDir: process.env.MOODLE_DOWNLOAD_DIR?.trim() || undefined,
    auditLogPath: process.env.MOODLE_AUDIT_LOG_PATH?.trim() || undefined,
    gradingAuditLogPath: process.env.MOODLE_GRADING_AUDIT_LOG_PATH?.trim() || undefined,
    gradingStateDir: process.env.MOODLE_GRADING_STATE_DIR?.trim() || undefined,
    resourceAuditLogPath: process.env.MOODLE_RESOURCE_AUDIT_LOG_PATH?.trim() || undefined,
    ocrEnabled,
    ocrMaxPages,
    ocrDpi,
    ocrTimeoutMs,
    ocrPageTimeoutMs,
    ocrMaxConcurrency,
    ocrDefaultLanguages,
    ocrTesseractBin: process.env.MOODLE_OCR_TESSERACT_BIN?.trim() || undefined,
    ocrPdftoppmBin: process.env.MOODLE_OCR_PDFTOPPM_BIN?.trim() || undefined,
  };
}

interface CachedCourseParticipants {
  expiresAt: number;
  usersById: Map<number, EnrolledUserSummary>;
  groupsById: Map<number, GroupInfo>;
}

interface CachedAssignmentIndex {
  expiresAt: number;
  byAssignmentId: Map<
    number,
    AssignmentSummaryMeta & {
      courseId: number;
      courseName?: string;
    }
  >;
}

const SAFE_READ_ONLY_WS_REGEX =
  /(?:_get_|_list_|^core_webservice_get_site_info$|^gradereport_user_get_grade_items$)/i;

function isSafeIdempotentReadWs(wsfunction: string): boolean {
  if (/save|create|delete|remove|add|send|submit|update|set_/i.test(wsfunction)) {
    return false;
  }
  return SAFE_READ_ONLY_WS_REGEX.test(wsfunction);
}

export function isNonStudentCourseRole(roles: string[]): boolean {
  if (!roles || roles.length === 0) return false;
  const lower = roles.map((r) => r.toLowerCase());
  const hasStudent = lower.some((r) => r === 'student' || r.includes('student') || r.includes('estudante'));
  if (hasStudent) return false;
  return lower.some((r) =>
    ['editingteacher', 'teacher', 'manager', 'coursecreator', 'professor', 'tutor'].includes(r)
  );
}

export class MoodleClient {
  private config: MoodleConfig;
  private cachedSiteInfo?: SiteInfo;
  public readonly fileStore: TempFileStore;
  private courseParticipantsCache = new Map<number, CachedCourseParticipants>();
  private assignmentIndexCache?: CachedAssignmentIndex;

  constructor(config?: MoodleConfig, sharedFileStore?: TempFileStore) {
    this.config = config ?? loadMoodleConfig();
    if (!this.config.restEndpoint && this.config.siteUrl) {
      this.config.restEndpoint = `${this.config.siteUrl}/webservice/rest/server.php`;
    }
    this.fileStore =
      sharedFileStore ??
      new TempFileStore({
        baseDir: this.config.tempDir,
        defaultTtlSeconds: this.config.fileTtlSeconds,
        exportDir: this.config.downloadDir,
      });
  }

  public getConfig(): MoodleConfig {
    return this.config;
  }

  public getDefaultCourseId(): number | undefined {
    return this.config.defaultCourseId;
  }

  private getSecretsList(): (string | undefined)[] {
    return [this.config.token, this.config.password];
  }

  public sanitizeErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return redactSecrets(raw, this.getSecretsList());
  }

  public resolveCourseId(courseId?: number): number {
    const resolved = courseId ?? this.config.defaultCourseId;
    if (!resolved) {
      throw new Error(
        'courseId é obrigatório para esta operação (dica: use a ferramenta get_courses para listar os IDs das suas disciplinas no Moodle).'
      );
    }
    return resolved;
  }

  public async ensureToken(forceRefresh = false): Promise<string> {
    if (this.config.token && !forceRefresh) {
      return this.config.token;
    }

    if (!forceRefresh && this.config.tokenFilePath && fs.existsSync(this.config.tokenFilePath)) {
      const diskToken = fs.readFileSync(this.config.tokenFilePath, 'utf-8').trim();
      if (diskToken) {
        this.config.token = diskToken;
        return diskToken;
      }
    }

    if (!this.config.username || !this.config.password) {
      throw new MoodleDownloadError(
        'auth_failed',
        'Token do Moodle não configurado (defina MOODLE_API_TOKEN ou /config/token, ou forneça MOODLE_USERNAME e MOODLE_PASSWORD para login automático via UFSC CAS SSO).'
      );
    }

    const freshToken = await this.authenticateViaCasOrTokenEndpoint(
      this.config.username,
      this.config.password
    );
    this.config.token = freshToken;

    if (this.config.tokenFilePath) {
      try {
        fs.writeFileSync(this.config.tokenFilePath, `${freshToken}\n`, { mode: 0o600 });
      } catch {
        // Ignore read-only volume errors
      }
    }

    return freshToken;
  }

  private async authenticateViaCasOrTokenEndpoint(
    username: string,
    password: string
  ): Promise<string> {
    try {
      const tokenUrl = `${this.config.siteUrl}/login/token.php`;
      const body = new URLSearchParams({
        username,
        password,
        service: 'moodle_mobile_app',
      });
      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { token?: string };
        if (json.token) {
          return json.token;
        }
      }
    } catch {
      // Fall through to CAS SSO mobile launch flow
    }

    const cookieJar = new Map<string, string>();
    const updateCookies = (headers: Headers) => {
      const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
      for (const raw of setCookies) {
        const firstPart = raw.split(';')[0];
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx > 0) {
          cookieJar.set(firstPart.slice(0, eqIdx).trim(), firstPart.slice(eqIdx + 1).trim());
        }
      }
    };
    const cookieHeader = () =>
      Array.from(cookieJar.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

    const fetchFollow = async (
      initialUrl: string,
      init?: RequestInit
    ): Promise<{ finalUrl: string; html: string; customSchemeUrl?: string }> => {
      let currentUrl = initialUrl;
      let currentInit = init;
      for (let hop = 0; hop < 15; hop++) {
        const headers = new Headers(currentInit?.headers);
        const cookies = cookieHeader();
        if (cookies) headers.set('Cookie', cookies);
        headers.set('User-Agent', 'MoodleMobile/4.4.0 (Linux; Android 14)');

        const res = await fetch(currentUrl, {
          ...currentInit,
          headers,
          redirect: 'manual',
        });
        updateCookies(res.headers);

        const location = res.headers.get('location');
        if (location && res.status >= 300 && res.status < 400) {
          if (location.startsWith('moodlemobile://')) {
            return { finalUrl: currentUrl, html: '', customSchemeUrl: location };
          }
          currentUrl = new URL(location, currentUrl).href;
          currentInit = { method: 'GET' };
          continue;
        }

        const html = await res.text();
        return { finalUrl: currentUrl, html };
      }
      throw new Error('Excesso de redirecionamentos durante autenticação CAS SSO no Moodle.');
    };

    const passport = String(Math.floor(100000 + Math.random() * 900000));
    const launchUrl = `${this.config.siteUrl}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=moodlemobile`;

    const step1 = await fetchFollow(launchUrl);
    if (step1.customSchemeUrl) {
      return this.parseMoodleMobileTokenUrl(step1.customSchemeUrl);
    }

    const formData: Record<string, string> = {};
    const inputRegex = /<input[^>]+>/gi;
    for (const match of step1.html.matchAll(inputRegex)) {
      const tag = match[0];
      const nameMatch = /name=["']([^"']+)["']/i.exec(tag);
      const valMatch = /value=["']([^"']*)["']/i.exec(tag);
      if (nameMatch) {
        formData[nameMatch[1]] = valMatch ? valMatch[1] : '';
      }
    }
    formData['username'] = username;
    formData['password'] = password;
    formData['admin'] = '0';
    if (!formData['_eventId']) formData['_eventId'] = 'submit';

    const actionMatch = /<form[^>]*id=["']fm1["'][^>]*action=["']([^"']+)["']/i.exec(step1.html);
    const postUrl = actionMatch
      ? new URL(actionMatch[1].replace(/&amp;/g, '&'), step1.finalUrl).href
      : step1.finalUrl;

    const step2 = await fetchFollow(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formData).toString(),
    });

    if (step2.customSchemeUrl) {
      return this.parseMoodleMobileTokenUrl(step2.customSchemeUrl);
    }

    const inlineScheme = /moodlemobile:\/\/token=([A-Za-z0-9+/=_-]+)/.exec(step2.html);
    if (inlineScheme) {
      return this.parseMoodleMobileTokenUrl(inlineScheme[0]);
    }

    throw new MoodleDownloadError(
      'auth_failed',
      'Falha ao obter token do Moodle via CAS SSO (verifique usuário e senha).'
    );
  }

  private parseMoodleMobileTokenUrl(schemeUrl: string): string {
    const rawB64 = schemeUrl.split('token=')[1]?.split('&')[0];
    if (!rawB64) {
      throw new Error('URL moodlemobile:// não contém parâmetro token.');
    }
    const decoded = Buffer.from(rawB64, 'base64').toString('utf-8');
    const parts = decoded.split(':::');
    const wstoken = parts.length >= 2 ? parts[1] : parts[0];
    if (!wstoken) {
      throw new Error('Token decodificado do Moodle está vazio.');
    }
    return wstoken.trim();
  }

  public getOcrSettings(overrides?: {
    timeoutMs?: number;
    pageTimeoutMs?: number;
    maxPages?: number;
  }): OcrConfigSettings {
    return {
      enabled: this.config.ocrEnabled ?? true,
      maxPages: overrides?.maxPages ?? this.config.ocrMaxPages ?? 30,
      dpi: this.config.ocrDpi ?? 200,
      timeoutMs: overrides?.timeoutMs ?? this.config.ocrTimeoutMs ?? 120_000,
      pageTimeoutMs: overrides?.pageTimeoutMs ?? this.config.ocrPageTimeoutMs ?? 60_000,
      maxConcurrency: this.config.ocrMaxConcurrency ?? 2,
      defaultLanguages: this.config.ocrDefaultLanguages ?? ['eng', 'por'],
      tempBaseDir: this.fileStore.getBaseDir(),
      tesseractBin: this.config.ocrTesseractBin,
      pdftoppmBin: this.config.ocrPdftoppmBin,
    };
  }

  public async getOcrCapabilities(forceRefresh = false): Promise<OcrCapabilities> {
    return checkOcrCapabilities(this.getOcrSettings(), forceRefresh);
  }

  public async call<T = any>(
    wsfunction: string,
    params: Record<string, unknown> = {},
    allowRetry = true
  ): Promise<T> {
    const wstoken = await this.ensureToken(false);
    const flat = flattenParams(params);
    const body = new URLSearchParams({
      wstoken,
      wsfunction,
      moodlewsrestformat: 'json',
      ...flat,
    });

    const canBackoffRetry = allowRetry && isSafeIdempotentReadWs(wsfunction);
    const maxAttempts = canBackoffRetry ? 3 : 1;
    let response: Response | undefined;
    let lastFetchErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        recordMoodleApiCall(1);
        response = await fetch(this.config.restEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });

        if (
          canBackoffRetry &&
          attempt < maxAttempts &&
          (response.status === 502 || response.status === 503 || response.status === 504 || response.status === 429)
        ) {
          await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt - 1)));
          continue;
        }
        break;
      } catch (err) {
        lastFetchErr = err;
        if (canBackoffRetry && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 150 * Math.pow(2, attempt - 1)));
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      throw lastFetchErr instanceof Error
        ? lastFetchErr
        : new Error(`Falha de rede ao chamar ${wsfunction} no Moodle.`);
    }

    if (!response.ok) {
      throw new Error(`Erro HTTP ${response.status} ao chamar ${wsfunction} no Moodle.`);
    }

    const data = (await response.json()) as any;
    if (data && typeof data === 'object' && ('exception' in data || 'errorcode' in data)) {
      if (
        allowRetry &&
        data.errorcode === 'invalidtoken' &&
        this.config.username &&
        this.config.password
      ) {
        await this.ensureToken(true);
        return this.call<T>(wsfunction, params, false);
      }
      throw new Error(
        redactSecrets(
          `Erro Moodle (${data.errorcode || data.exception}): ${data.message || JSON.stringify(data)}`,
          this.getSecretsList()
        )
      );
    }

    return data as T;
  }

  public getCachedSiteInfo(): SiteInfo | undefined {
    return this.cachedSiteInfo;
  }

  public async getSiteInfo(): Promise<SiteInfo> {
    if (this.cachedSiteInfo) {
      recordCacheHit();
      return this.cachedSiteInfo;
    }
    const info = await this.call<SiteInfo>('core_webservice_get_site_info');
    this.cachedSiteInfo = info;
    return info;
  }

  public async hasWsFunction(wsfunction: string): Promise<boolean> {
    const info = await this.getSiteInfo();
    if (!Array.isArray(info.functions) || info.functions.length === 0) {
      return false;
    }
    return info.functions.some((fn) => fn.name === wsfunction);
  }

  public invalidateCourseParticipantsCache(courseId?: number): void {
    if (courseId !== undefined) {
      this.courseParticipantsCache.delete(courseId);
    } else {
      this.courseParticipantsCache.clear();
    }
  }

  /**
   * Validates that a file URL strictly belongs to the configured Moodle origin and
   * points to an authorized Moodle file delivery route (`pluginfile.php` or `draftfile.php`),
   * returning both a token-free `canonicalUrl` and an authenticated `authedUrl`.
   */
  public validateAndBuildFileUrls(
    rawFileUrl: string,
    token: string
  ): { canonicalUrl: string; authedUrl: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawFileUrl);
    } catch {
      throw new MoodleDownloadError('invalid_url', 'A URL informada não é uma URL válida.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new MoodleDownloadError(
        'invalid_url',
        `Protocolo não permitido (${parsed.protocol}). Apenas HTTP/HTTPS do servidor Moodle configurado são aceitos.`
      );
    }

    const siteParsed = new URL(this.config.siteUrl);
    if (parsed.origin !== siteParsed.origin) {
      throw new MoodleDownloadError(
        'invalid_origin',
        `Origem não autorizada (${parsed.origin}). Esta ferramenta baixa exclusivamente arquivos do Moodle configurado (${siteParsed.origin}).`
      );
    }

    const siteBasePath = siteParsed.pathname.replace(/\/+$/, '');
    const allowedPrefixes = [
      `${siteBasePath}/pluginfile.php/`,
      `${siteBasePath}/webservice/pluginfile.php/`,
      `${siteBasePath}/draftfile.php/`,
      `${siteBasePath}/webservice/draftfile.php/`,
    ];

    const isAllowedRoute = allowedPrefixes.some((prefix) => parsed.pathname.startsWith(prefix));
    if (!isAllowedRoute) {
      throw new MoodleDownloadError(
        'unauthorized_route',
        `Rota de arquivo não autorizada (${parsed.pathname}). Apenas rotas de arquivos do Moodle (pluginfile.php / draftfile.php) são permitidas.`
      );
    }

    // Build clean canonical URL without any token parameters
    const canonicalObj = new URL(parsed.href);
    canonicalObj.searchParams.delete('token');
    canonicalObj.searchParams.delete('wstoken');
    const canonicalUrl = canonicalObj.href;

    // Build authenticated Web Service file URL
    const authedObj = new URL(canonicalUrl);
    if (
      authedObj.pathname.startsWith(`${siteBasePath}/pluginfile.php/`) &&
      !authedObj.pathname.startsWith(`${siteBasePath}/webservice/pluginfile.php/`)
    ) {
      authedObj.pathname = authedObj.pathname.replace(
        `${siteBasePath}/pluginfile.php/`,
        `${siteBasePath}/webservice/pluginfile.php/`
      );
    } else if (
      authedObj.pathname.startsWith(`${siteBasePath}/draftfile.php/`) &&
      !authedObj.pathname.startsWith(`${siteBasePath}/webservice/draftfile.php/`)
    ) {
      authedObj.pathname = authedObj.pathname.replace(
        `${siteBasePath}/draftfile.php/`,
        `${siteBasePath}/webservice/draftfile.php/`
      );
    }
    authedObj.searchParams.set('token', token);

    return {
      canonicalUrl,
      authedUrl: authedObj.href,
    };
  }

  /**
   * Streams and validates an original file from Moodle into the isolated TempFileStore,
   * never exposing the Moodle token and rejecting HTML login/error pages, cross-origin
   * redirects, oversized files, and timeouts.
   */
  public async downloadFile(
    fileUrl: string,
    options: DownloadFileOptions = {},
    allowRetry = true
  ): Promise<DownloadFileOutcome> {
    const cleanInputUrl = stripTokenFromUrl(fileUrl);
    const maxBytesCeiling = this.config.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const effectiveMaxBytes = options.maxBytes
      ? Math.min(Math.max(1, options.maxBytes), maxBytesCeiling)
      : maxBytesCeiling;
    const effectiveTimeoutMs =
      options.timeoutMs ?? this.config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

    let stagingPath: string | undefined;

    try {
      const token = await this.ensureToken(false);
      const { canonicalUrl, authedUrl } = this.validateAndBuildFileUrls(fileUrl, token);

      if (!options.forceDownload) {
        const cachedEntry = this.fileStore.findByCanonicalUrl(canonicalUrl);
        if (cachedEntry && cachedEntry.sizeBytes <= effectiveMaxBytes) {
          const customNameMatches =
            !options.filename ||
            sanitizeFilenames(options.filename).safeFilename === cachedEntry.safeFilename;
          if (customNameMatches) {
            recordCacheHit();
            const effectiveBaseUrl =
              options.publicBaseUrl ?? getEffectivePublicBaseUrl(this.config.publicBaseUrl);
            const reference = this.fileStore.toReferenceMetadata(cachedEntry, effectiveBaseUrl);
            return {
              ok: true,
              status: 'downloaded',
              entry: cachedEntry,
              file: reference,
              canonicalFileUrl: canonicalUrl,
              reusedCachedFile: true,
            };
          }
        }
      }

      recordFileDownload(1);
      const siteOrigin = new URL(this.config.siteUrl).origin;

      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort(
          new MoodleDownloadError(
            'timeout',
            `Tempo limite excedido (${effectiveTimeoutMs} ms) ao baixar o arquivo do Moodle.`
          )
        );
      }, effectiveTimeoutMs);
      timer.unref?.();

      try {
        let currentUrl = authedUrl;
        let response: Response | undefined;

        for (let hop = 0; hop <= 5; hop++) {
          if (hop === 5) {
            throw new MoodleDownloadError(
              'redirect_blocked',
              'Excesso de redirecionamentos ao baixar arquivo do Moodle.'
            );
          }

          response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: abortController.signal,
            headers: {
              'User-Agent': 'UFSC-Moodle-MCP/1.1',
            },
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              throw new MoodleDownloadError(
                'redirect_blocked',
                `Redirecionamento HTTP ${response.status} sem cabeçalho Location.`
              );
            }
            const nextUrl = new URL(location, currentUrl);
            if (nextUrl.origin !== siteOrigin) {
              throw new MoodleDownloadError(
                'redirect_blocked',
                `Redirecionamento para origem externa bloqueado (${nextUrl.origin}). Credenciais não foram encaminhadas.`
              );
            }
            if (nextUrl.pathname.includes('/login/')) {
              throw new MoodleDownloadError(
                'auth_failed',
                'O Moodle redirecionou a requisição do arquivo para a tela de login (sessão ou token inválido).'
              );
            }
            // Validate target route remains an authorized Moodle file endpoint
            const checked = this.validateAndBuildFileUrls(nextUrl.href, token);
            currentUrl = checked.authedUrl;
            continue;
          }
          break;
        }

        if (!response) {
          throw new MoodleDownloadError('network_error', 'Sem resposta HTTP do Moodle.');
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader) {
          const declaredSize = Number(contentLengthHeader);
          if (Number.isFinite(declaredSize) && declaredSize > effectiveMaxBytes) {
            try {
              await response.body?.cancel();
            } catch {
              // ignore
            }
            throw new MoodleDownloadError(
              'too_large',
              `Arquivo excede o limite máximo permitido (${declaredSize} bytes > ${effectiveMaxBytes} bytes).`
            );
          }
        }

        const declaredContentType = (response.headers.get('content-type') || '').trim();
        const cdFilename = parseFilenameFromContentDisposition(
          response.headers.get('content-disposition')
        );
        const urlPathnameName = (() => {
          try {
            const seg = new URL(canonicalUrl).pathname.split('/').pop();
            return seg ? decodeURIComponent(seg) : undefined;
          } catch {
            return undefined;
          }
        })();

        const { originalFilename, safeFilename } = sanitizeFilenames(
          options.filename || cdFilename || urlPathnameName || 'arquivo'
        );

        stagingPath = this.fileStore.allocateStagingPath();
        const hash = crypto.createHash('sha256');
        const headChunks: Buffer[] = [];
        let headLen = 0;
        let totalBytes = 0;

        if (response.body) {
          const reader = response.body.getReader();
          const fileOut = fs.createWriteStream(stagingPath, { mode: 0o600 });

          const byteStream = new Readable({
            async read() {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  this.push(null);
                  return;
                }
                totalBytes += value.byteLength;
                if (totalBytes > effectiveMaxBytes) {
                  await reader.cancel().catch(() => {});
                  this.destroy(
                    new MoodleDownloadError(
                      'too_large',
                      `Download interrompido: tamanho excedeu o limite máximo permitido (${effectiveMaxBytes} bytes).`
                    )
                  );
                  return;
                }
                hash.update(value);
                if (headLen < 4096) {
                  const slice = Buffer.from(
                    value.buffer,
                    value.byteOffset,
                    Math.min(value.byteLength, 4096 - headLen)
                  );
                  headChunks.push(slice);
                  headLen += slice.length;
                }
                this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
              } catch (streamErr) {
                this.destroy(streamErr as Error);
              }
            },
          });

          await pipeline(byteStream, fileOut);
        } else {
          fs.writeFileSync(stagingPath, Buffer.alloc(0), { mode: 0o600 });
        }

        const headBuf = Buffer.concat(headChunks);
        const ext = extensionOf(originalFilename);

        // 1. Check if Moodle returned a JSON Web Service error (often with HTTP 200 OK!)
        if (
          declaredContentType.toLowerCase().includes('application/json') ||
          (totalBytes > 0 &&
            totalBytes < 16384 &&
            ext !== 'json' &&
            headBuf[0] === 0x7b /* '{' */)
        ) {
          let parsedErr: any = null;
          try {
            const rawJson = fs.readFileSync(stagingPath, 'utf-8');
            const candidate = JSON.parse(rawJson);
            if (
              candidate &&
              typeof candidate === 'object' &&
              ('error' in candidate || 'errorcode' in candidate || 'exception' in candidate)
            ) {
              parsedErr = candidate;
            }
          } catch {
            // Not JSON error envelope
          }

          if (parsedErr) {
            const errCode = String(parsedErr.errorcode || '').toLowerCase();
            const errMsg = redactSecrets(
              String(parsedErr.error || parsedErr.message || 'Erro retornado pelo Moodle'),
              this.getSecretsList()
            );

            if (
              allowRetry &&
              errCode === 'invalidtoken' &&
              this.config.username &&
              this.config.password
            ) {
              fs.rmSync(stagingPath, { force: true });
              stagingPath = undefined;
              await this.ensureToken(true);
              return this.downloadFile(fileUrl, options, false);
            }

            if (errCode === 'invalidtoken' || errCode === 'requireloginerror') {
              throw new MoodleDownloadError(
                'auth_failed',
                `Falha de autenticação no Moodle (${errCode}): ${errMsg}`,
                response.status
              );
            }
            if (
              errCode === 'nopermissions' ||
              errCode === 'accessexception' ||
              errCode === 'coursecontextnotvalid' ||
              errCode === 'errorcoursecontextnotvalid'
            ) {
              throw new MoodleDownloadError(
                'access_denied',
                `Acesso negado pelo Moodle (${errCode}): ${errMsg}`,
                response.status
              );
            }
            if (
              errCode === 'filenotfound' ||
              errCode === 'storedfilecannotread' ||
              errCode === 'invalidrecord'
            ) {
              throw new MoodleDownloadError(
                'not_found',
                `Arquivo não encontrado no Moodle (${errCode}): ${errMsg}`,
                response.status
              );
            }
            throw new MoodleDownloadError(
              'moodle_ws_error',
              `Erro do Moodle (${errCode || parsedErr.exception}): ${errMsg}`,
              response.status
            );
          }
        }

        // 2. Check HTTP error status codes
        if (!response.ok) {
          if (response.status === 401) {
            throw new MoodleDownloadError(
              'auth_failed',
              'Não autorizado (HTTP 401) ao baixar arquivo do Moodle.',
              401
            );
          }
          if (response.status === 403) {
            throw new MoodleDownloadError(
              'access_denied',
              'Acesso negado (HTTP 403) ao baixar arquivo do Moodle.',
              403
            );
          }
          if (response.status === 404) {
            throw new MoodleDownloadError(
              'not_found',
              'Arquivo não encontrado (HTTP 404) no Moodle.',
              404
            );
          }
          throw new MoodleDownloadError(
            'http_error',
            `Falha HTTP ${response.status} ao baixar arquivo do Moodle.`,
            response.status
          );
        }

        // 3. Detect HTML login/error pages returned in place of non-HTML files
        const sniff = sniffMimeFromBytes(headBuf, ext, declaredContentType);
        const expectsHtml = ext === 'html' || ext === 'htm' || ext === 'xhtml';
        if (
          !expectsHtml &&
          (sniff.looksLikeHtml || declaredContentType.toLowerCase().includes('text/html'))
        ) {
          throw new MoodleDownloadError(
            'html_error_page',
            'O servidor retornou uma página HTML (tela de login ou página de erro) em vez do arquivo binário/documento esperado.',
            response.status
          );
        }

        // 4. Verify PDF magic signature when a PDF was requested/declared
        const expectsPdf =
          ext === 'pdf' || declaredContentType.toLowerCase().includes('application/pdf');
        if (expectsPdf && !sniff.hasPdfSignature) {
          throw new MoodleDownloadError(
            'invalid_file_format',
            'O arquivo baixado possui extensão ou tipo PDF, mas não contém cabeçalho binário %PDF- válido.',
            response.status
          );
        }

        const sha256 = hash.digest('hex');
        const entry = this.fileStore.commitStagedFile({
          stagingPath,
          originalFilename,
          safeFilename,
          mimeType: sniff.mimeType,
          declaredMimeType: declaredContentType || undefined,
          sizeBytes: totalBytes,
          sha256,
          canonicalFileUrl: canonicalUrl,
          ttlSeconds: options.ttlSeconds,
        });
        stagingPath = undefined;

        const effectiveBaseUrl =
          options.publicBaseUrl ?? getEffectivePublicBaseUrl(this.config.publicBaseUrl);
        const reference = this.fileStore.toReferenceMetadata(entry, effectiveBaseUrl);

        return {
          ok: true,
          status: 'downloaded',
          entry,
          file: reference,
          canonicalFileUrl: canonicalUrl,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      if (stagingPath) {
        try {
          fs.rmSync(stagingPath, { force: true });
        } catch {
          // ignore
        }
      }

      if (err instanceof MoodleDownloadError) {
        return {
          ok: false,
          status: 'failed',
          errorCode: err.code,
          errorMessage: redactSecrets(err.message, this.getSecretsList()),
          httpStatus: err.httpStatus,
          canonicalFileUrl: cleanInputUrl,
        };
      }

      if (
        err?.name === 'AbortError' ||
        err?.name === 'TimeoutError' ||
        err?.cause instanceof MoodleDownloadError
      ) {
        const cause = err?.cause instanceof MoodleDownloadError ? err.cause : undefined;
        return {
          ok: false,
          status: 'failed',
          errorCode: cause?.code ?? 'timeout',
          errorMessage: redactSecrets(
            cause?.message ??
              `Tempo limite excedido (${effectiveTimeoutMs} ms) ao baixar arquivo do Moodle.`,
            this.getSecretsList()
          ),
          canonicalFileUrl: cleanInputUrl,
        };
      }

      return {
        ok: false,
        status: 'failed',
        errorCode: 'network_error',
        errorMessage: this.sanitizeErrorMessage(err),
        canonicalFileUrl: cleanInputUrl,
      };
    }
  }

  /**
   * Downloads a file into TempFileStore (or reuses an unexpired cached copy) AND runs
   * non-destructive text/OCR extraction on it, preserving the original file reference
   * (`downloadUrl`, `resourceUri`, `sha256`).
   */
  public async downloadAndExtractFile(
    fileUrl: string,
    options: {
      filename?: string;
      mimetype?: string;
      maxChars?: number;
      timeoutMs?: number;
      maxBytes?: number;
      publicBaseUrl?: string;
      forceDownload?: boolean;
      ocrMode?: OcrMode;
      ocrLanguages?: string[];
      maxOcrPages?: number;
      ocrTimeoutMs?: number;
      ocrPageTimeoutMs?: number;
    } = {}
  ): Promise<ExtractedFileResult> {
    const cleanUrl = stripTokenFromUrl(fileUrl);
    const fileKey = computeFileKey(cleanUrl);
    const dlOutcome = await this.downloadFile(fileUrl, {
      filename: options.filename,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      publicBaseUrl: options.publicBaseUrl,
      forceDownload: options.forceDownload,
    });

    if (!dlOutcome.ok) {
      const { originalFilename, safeFilename } = sanitizeFilenames(options.filename || 'arquivo');
      return {
        filename: originalFilename,
        originalFilename,
        safeFilename,
        fileurl: dlOutcome.canonicalFileUrl || cleanUrl,
        fileKey,
        mimetype: options.mimetype,
        downloadStatus: 'failed',
        extractionStatus: 'not_attempted',
        extractionMethod: 'none',
        needsOcr: false,
        errorCode: dlOutcome.errorCode,
        errorMessage: dlOutcome.errorMessage,
        note: `Falha no download (${dlOutcome.errorCode}): ${dlOutcome.errorMessage}`,
      };
    }

    const res = await this.extractFromStoredFile(
      dlOutcome.entry,
      dlOutcome.file,
      options.maxChars ?? 45_000,
      {
        ocrMode: options.ocrMode,
        ocrLanguages: options.ocrLanguages,
        maxOcrPages: options.maxOcrPages,
        ocrTimeoutMs: options.ocrTimeoutMs,
        ocrPageTimeoutMs: options.ocrPageTimeoutMs,
      }
    );
    if (dlOutcome.reusedCachedFile) {
      res.reusedCachedFile = true;
    }
    return res;
  }

  /**
   * Reprocesses an already-downloaded file stored in TempFileStore by `fileId` without
   * making a new HTTP download to Moodle.
   */
  public async extractByFileId(
    fileId: string,
    options: {
      maxChars?: number;
      publicBaseUrl?: string;
      ocrMode?: OcrMode;
      ocrLanguages?: string[];
      maxOcrPages?: number;
      ocrTimeoutMs?: number;
      ocrPageTimeoutMs?: number;
    } = {}
  ): Promise<ExtractedFileResult> {
    const entry = this.fileStore.getByFileId(fileId);
    if (!entry) {
      return {
        filename: fileId,
        originalFilename: fileId,
        fileurl: '',
        fileKey: '',
        downloadStatus: 'failed',
        extractionStatus: 'not_attempted',
        extractionMethod: 'none',
        needsOcr: false,
        errorCode: 'not_found',
        errorMessage:
          'Arquivo temporário não encontrado ou expirado para o fileId informado. Informe fileurl para baixá-lo novamente.',
        note: 'Arquivo temporário expirado ou inexistente.',
      };
    }
    recordCacheHit();
    const effectiveBaseUrl =
      options.publicBaseUrl ?? getEffectivePublicBaseUrl(this.config.publicBaseUrl);
    const ref = this.fileStore.toReferenceMetadata(entry, effectiveBaseUrl);
    const res = await this.extractFromStoredFile(entry, ref, options.maxChars ?? 60_000, {
      ocrMode: options.ocrMode,
      ocrLanguages: options.ocrLanguages,
      maxOcrPages: options.maxOcrPages,
      ocrTimeoutMs: options.ocrTimeoutMs,
      ocrPageTimeoutMs: options.ocrPageTimeoutMs,
    });
    res.reusedCachedFile = true;
    return res;
  }

  public async extractFromStoredFile(
    entry: StoredFileEntry,
    ref: FileReferenceMetadata,
    maxChars = 45_000,
    ocrOptions: {
      ocrMode?: OcrMode;
      ocrLanguages?: string[];
      maxOcrPages?: number;
      ocrTimeoutMs?: number;
      ocrPageTimeoutMs?: number;
    } = {}
  ): Promise<ExtractedFileResult> {
    const effectiveOcrMode: OcrMode = ocrOptions.ocrMode ?? 'off';
    const baseFields = {
      filename: entry.originalFilename,
      originalFilename: entry.originalFilename,
      safeFilename: entry.safeFilename,
      fileurl: entry.canonicalFileUrl,
      fileKey: computeFileKey(entry.canonicalFileUrl),
      mimetype: entry.mimeType,
      declaredMimeType: entry.declaredMimeType,
      filesize: entry.sizeBytes,
      downloadStatus: 'downloaded' as const,
      fileId: ref.fileId,
      ...(ref.downloadUrl ? { downloadUrl: ref.downloadUrl } : {}),
      resourceUri: ref.resourceUri,
      ...(ref.savedPath ? { savedPath: ref.savedPath } : {}),
      sha256: ref.sha256,
      expiresAt: ref.expiresAt,
      ttlSeconds: ref.ttlSeconds,
    };

    const ext = extensionOf(entry.originalFilename);
    const contentType = entry.mimeType.toLowerCase();

    // Image files: support local Tesseract OCR when ocrMode != 'off', preserving legacy behavior on 'off'
    if (IMAGE_EXTENSIONS.has(ext) || contentType.startsWith('image/')) {
      if (effectiveOcrMode === 'off') {
        return {
          ...baseFields,
          extractionStatus: 'downloaded_needs_ocr',
          extractionMethod: 'none',
          needsOcr: true,
          note: 'Arquivo de imagem baixado e preservado. Use ocrMode="auto" para OCR automático no servidor ou downloadUrl para análise visual.',
        };
      }
      const imgOcr = await extractImageWithOcr({
        diskPath: entry.diskPath,
        maxChars,
        ocrMode: effectiveOcrMode,
        ocrLanguages: ocrOptions.ocrLanguages,
        settings: this.getOcrSettings({
          timeoutMs: ocrOptions.ocrTimeoutMs,
          pageTimeoutMs: ocrOptions.ocrPageTimeoutMs,
          maxPages: ocrOptions.maxOcrPages,
        }),
        sanitizeError: (err) => this.sanitizeErrorMessage(err),
      });
      return {
        ...baseFields,
        ...imgOcr,
      };
    }

    if (ext === 'pdf' || contentType.includes('application/pdf')) {
      const pdfOcr = await extractPdfWithOcr({
        diskPath: entry.diskPath,
        sha256: entry.sha256,
        filesize: entry.sizeBytes,
        maxChars,
        ocrMode: effectiveOcrMode,
        ocrLanguages: ocrOptions.ocrLanguages,
        maxOcrPages: ocrOptions.maxOcrPages,
        settings: this.getOcrSettings({
          timeoutMs: ocrOptions.ocrTimeoutMs,
          pageTimeoutMs: ocrOptions.ocrPageTimeoutMs,
          maxPages: ocrOptions.maxOcrPages,
        }),
        sanitizeError: (err) => this.sanitizeErrorMessage(err),
      });
      return {
        ...baseFields,
        ...pdfOcr,
      };
    }

    const bytes = new Uint8Array(fs.readFileSync(entry.diskPath));

    if (ext === 'docx' || contentType.includes('wordprocessingml')) {
      return this.extractDocxStored(bytes, baseFields, maxChars);
    }

    if (ext === 'odt' || contentType.includes('opendocument.text')) {
      return this.extractOdtStored(bytes, baseFields, maxChars);
    }

    if (ext === 'pptx' || contentType.includes('presentationml')) {
      return this.extractPptxStored(bytes, baseFields, maxChars);
    }

    if (ext === 'zip' || contentType.includes('application/zip')) {
      return this.extractZipStored(bytes, baseFields, maxChars);
    }

    if (
      TEXT_EXTENSIONS.has(ext) ||
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript')
    ) {
      const rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const cleaned =
        ext === 'html' || ext === 'htm' || contentType.includes('text/html')
          ? htmlToText(rawText)
          : rawText;
      const truncated = cleaned.length > maxChars;
      return {
        ...baseFields,
        extractionStatus: 'downloaded_with_text',
        extractionMethod: 'plain_text',
        needsOcr: false,
        extractedText: truncated ? `${cleaned.slice(0, maxChars)}\n...[truncado]` : cleaned,
        truncated,
      };
    }

    return {
      ...baseFields,
      extractionStatus: 'unsupported_binary',
      extractionMethod: 'none',
      needsOcr: false,
      note: `Download concluído e arquivo original preservado (${entry.mimeType || ext || 'binário'}). Extração textual não aplicável para este formato; utilize downloadUrl para processar o arquivo original.`,
    };
  }

  private async extractPdfStored(
    bytes: Uint8Array,
    baseFields: Omit<
      ExtractedFileResult,
      'extractionStatus' | 'extractionMethod' | 'needsOcr'
    >,
    maxChars: number
  ): Promise<ExtractedFileResult> {
    try {
      const { getDocumentProxy } = await import('unpdf');
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      const pdf: any = await getDocumentProxy(owned, {
        isEvalSupported: false,
        enableXfa: false,
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
      } as any);

      try {
        const numPages: number = pdf.numPages;
        const maxPages = Math.min(numPages, 100);
        const chunks: string[] = [];
        const emptyPageNumbers: number[] = [];
        let pagesWithTextCount = 0;
        let meaningfulChars = 0;
        let totalLen = 0;
        let truncated = false;

        for (let p = 1; p <= maxPages; p++) {
          const page = await pdf.getPage(p);
          const textContent = await page.getTextContent();
          const lineParts: string[] = [];
          for (const item of textContent.items) {
            if ('str' in item) {
              lineParts.push(item.str);
              if (item.hasEOL) lineParts.push('\n');
              else lineParts.push(' ');
            }
          }
          const pageText = lineParts.join('').replace(/[ \t]+\n/g, '\n').trim();
          const nonWs = pageText.replace(/\s+/g, '');
          meaningfulChars += nonWs.length;

          if (nonWs.length >= 5) {
            pagesWithTextCount++;
          } else {
            emptyPageNumbers.push(p);
          }

          if (pageText) {
            const formatted = `--- [Página ${p}/${numPages}] ---\n${pageText}`;
            if (!truncated) {
              if (totalLen + formatted.length > maxChars) {
                chunks.push(formatted.slice(0, Math.max(0, maxChars - totalLen)));
                truncated = true;
              } else {
                chunks.push(formatted);
                totalLen += formatted.length + 2;
              }
            }
          }
        }

        const extractedText = chunks.join('\n\n').trim();

        // Distinguish native text vs image-only PDF needing OCR
        if (meaningfulChars < 20) {
          return {
            ...baseFields,
            extractionStatus: 'downloaded_needs_ocr',
            extractionMethod: 'none',
            needsOcr: true,
            pageCount: numPages,
            pagesWithTextCount,
            emptyPageNumbers,
            extractedText: extractedText || undefined,
            note:
              `Download concluído (${numPages} página(s), ${baseFields.filesize} bytes), porém o PDF não possui camada de texto nativo útil ` +
              `(documento digitalizado ou exportado como imagem). Use downloadUrl (ou chame download_moodle_file) para obter o PDF original e aplicar OCR/renderização.`,
          };
        }

        return {
          ...baseFields,
          extractionStatus: 'downloaded_with_text',
          extractionMethod: 'native_pdf',
          needsOcr: emptyPageNumbers.length > 0,
          pageCount: numPages,
          pagesWithTextCount,
          ...(emptyPageNumbers.length > 0 ? { emptyPageNumbers } : {}),
          extractedText,
          truncated,
          ...(emptyPageNumbers.length > 0
            ? {
                note: `Texto nativo extraído de ${pagesWithTextCount}/${maxPages} página(s). As páginas [${emptyPageNumbers.join(', ')}] não contêm texto nativo (podem conter figuras/diagramas que exigem renderização ou OCR via downloadUrl).`,
              }
            : {}),
        };
      } finally {
        if (typeof pdf.destroy === 'function') {
          await pdf.destroy();
        }
      }
    } catch (err: any) {
      const parserError = this.sanitizeErrorMessage(err);
      return {
        ...baseFields,
        extractionStatus: 'downloaded_parser_error',
        extractionMethod: 'none',
        needsOcr: false,
        parserError,
        note: `Download do PDF concluído e arquivo original preservado (SHA-256: ${baseFields.sha256}), mas o parser de texto falhou (${parserError}). O PDF continua acessível para leitura/reparo local via downloadUrl.`,
      };
    }
  }

  private extractDocxStored(
    bytes: Uint8Array,
    baseFields: Omit<
      ExtractedFileResult,
      'extractionStatus' | 'extractionMethod' | 'needsOcr'
    >,
    maxChars: number
  ): ExtractedFileResult {
    try {
      const entries = unzipSync(bytes, {
        filter: (file) => file.name === 'word/document.xml',
      });
      const docXml = entries['word/document.xml'];
      if (!docXml) {
        return {
          ...baseFields,
          extractionStatus: 'downloaded_parser_error',
          extractionMethod: 'none',
          needsOcr: false,
          parserError: 'Arquivo DOCX não contém word/document.xml.',
        };
      }
      const xmlStr = new TextDecoder('utf-8').decode(docXml);
      const text = xmlStr
        .replace(/<\/w:p>/gi, '\n')
        .replace(/<w:br[^>]*\/?>/gi, '\n')
        .replace(/<w:tab[^>]*\/?>/gi, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/gi, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (!text) {
        return {
          ...baseFields,
          extractionStatus: 'downloaded_needs_ocr',
          extractionMethod: 'none',
          needsOcr: true,
          note: 'Arquivo DOCX sem texto extraível (pode conter apenas imagens embutidas).',
        };
      }

      const truncated = text.length > maxChars;
      return {
        ...baseFields,
        extractionStatus: 'downloaded_with_text',
        extractionMethod: 'docx_xml',
        needsOcr: false,
        extractedText: truncated ? `${text.slice(0, maxChars)}\n...[truncado]` : text,
        truncated,
      };
    } catch (err: any) {
      const parserError = this.sanitizeErrorMessage(err);
      return {
        ...baseFields,
        extractionStatus: 'downloaded_parser_error',
        extractionMethod: 'none',
        needsOcr: false,
        parserError,
      };
    }
  }

  private extractOdtStored(
    bytes: Uint8Array,
    baseFields: Omit<
      ExtractedFileResult,
      'extractionStatus' | 'extractionMethod' | 'needsOcr'
    >,
    maxChars: number
  ): ExtractedFileResult {
    try {
      const entries = unzipSync(bytes, {
        filter: (file) => file.name === 'content.xml',
      });
      const contentXml = entries['content.xml'];
      if (!contentXml) {
        return {
          ...baseFields,
          extractionStatus: 'downloaded_parser_error',
          extractionMethod: 'none',
          needsOcr: false,
          parserError: 'Arquivo ODT sem content.xml.',
        };
      }
      const xmlStr = new TextDecoder('utf-8').decode(contentXml);
      const text = xmlStr
        .replace(/<\/text:(p|h)>/gi, '\n')
        .replace(/<text:line-break[^>]*\/?>/gi, '\n')
        .replace(/<text:tab[^>]*\/?>/gi, '\t')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const truncated = text.length > maxChars;
      return {
        ...baseFields,
        extractionStatus: text ? 'downloaded_with_text' : 'downloaded_needs_ocr',
        extractionMethod: text ? 'odt_xml' : 'none',
        needsOcr: !text,
        extractedText: truncated ? `${text.slice(0, maxChars)}\n...[truncado]` : text || undefined,
        truncated,
      };
    } catch (err: any) {
      return {
        ...baseFields,
        extractionStatus: 'downloaded_parser_error',
        extractionMethod: 'none',
        needsOcr: false,
        parserError: this.sanitizeErrorMessage(err),
      };
    }
  }

  private extractPptxStored(
    bytes: Uint8Array,
    baseFields: Omit<
      ExtractedFileResult,
      'extractionStatus' | 'extractionMethod' | 'needsOcr'
    >,
    maxChars: number
  ): ExtractedFileResult {
    try {
      const entries = unzipSync(bytes, {
        filter: (file) => /^ppt\/slides\/slide\d+\.xml$/i.test(file.name),
      });
      const slideNames = Object.keys(entries).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true })
      );
      const slidesText: string[] = [];
      for (const sName of slideNames) {
        const xmlStr = new TextDecoder('utf-8').decode(entries[sName]);
        const sText = xmlStr
          .replace(/<\/a:p>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (sText) {
          slidesText.push(`--- [${sName}] ---\n${sText}`);
        }
      }
      const fullText = slidesText.join('\n\n');
      const truncated = fullText.length > maxChars;
      return {
        ...baseFields,
        extractionStatus: fullText ? 'downloaded_with_text' : 'downloaded_needs_ocr',
        extractionMethod: fullText ? 'pptx_xml' : 'none',
        needsOcr: !fullText,
        extractedText: truncated
          ? `${fullText.slice(0, maxChars)}\n...[truncado]`
          : fullText || undefined,
        truncated,
      };
    } catch (err: any) {
      return {
        ...baseFields,
        extractionStatus: 'downloaded_parser_error',
        extractionMethod: 'none',
        needsOcr: false,
        parserError: this.sanitizeErrorMessage(err),
      };
    }
  }

  private async extractZipStored(
    bytes: Uint8Array,
    baseFields: Omit<
      ExtractedFileResult,
      'extractionStatus' | 'extractionMethod' | 'needsOcr'
    >,
    maxChars: number
  ): Promise<ExtractedFileResult> {
    try {
      const allEntries = unzipSync(bytes, {
        filter: (file) => file.originalSize <= 15 * 1024 * 1024,
      });
      const entryNames = Object.keys(allEntries).filter((name) => !name.endsWith('/'));
      const parts: string[] = [
        `Arquivo ZIP contendo ${entryNames.length} arquivo(s):`,
        entryNames.map((n) => `  - ${n}`).join('\n'),
        '',
      ];
      let currentLen = parts.join('\n').length;
      let truncated = false;

      for (const entryName of entryNames) {
        if (
          entryName.includes('__MACOSX') ||
          entryName.includes('node_modules/') ||
          entryName.includes('.git/')
        ) {
          continue;
        }
        const ext = extensionOf(entryName);
        const entryBytes = allEntries[entryName];
        if (!entryBytes || entryBytes.byteLength === 0) continue;

        let entryText: string | undefined;
        if (TEXT_EXTENSIONS.has(ext)) {
          entryText = new TextDecoder('utf-8', { fatal: false }).decode(entryBytes);
        } else if (ext === 'pdf') {
          const pdfRes = await this.extractPdfStored(
            entryBytes,
            { ...baseFields, filename: entryName, originalFilename: entryName },
            Math.max(4000, maxChars - currentLen)
          );
          entryText = pdfRes.extractedText ?? pdfRes.note;
        } else if (ext === 'docx') {
          const docxRes = this.extractDocxStored(
            entryBytes,
            { ...baseFields, filename: entryName, originalFilename: entryName },
            Math.max(4000, maxChars - currentLen)
          );
          entryText = docxRes.extractedText ?? docxRes.note;
        }

        if (entryText) {
          const block = `=== Arquivo: ${entryName} ===\n${entryText.trim()}`;
          if (currentLen + block.length > maxChars) {
            const remaining = Math.max(0, maxChars - currentLen);
            if (remaining > 200) {
              parts.push(`${block.slice(0, remaining)}\n...[truncado]`);
            }
            truncated = true;
            break;
          }
          parts.push(block);
          currentLen += block.length + 2;
        }
      }

      return {
        ...baseFields,
        extractionStatus: 'downloaded_with_text',
        extractionMethod: 'zip_archive',
        needsOcr: false,
        extractedText: parts.join('\n\n'),
        truncated,
      };
    } catch (err: any) {
      return {
        ...baseFields,
        extractionStatus: 'downloaded_parser_error',
        extractionMethod: 'none',
        needsOcr: false,
        parserError: this.sanitizeErrorMessage(err),
      };
    }
  }

  /**
   * Loads and caches enrolled users and group memberships for a course so group
   * submissions (`userid === 0`, `groupid > 0`) always have full member/group links,
   * strictly excluding teachers/managers from student group member arrays.
   */
  public async getCourseParticipantsContext(
    courseId: number,
    forceRefresh = false
  ): Promise<{
    usersById: Map<number, EnrolledUserSummary>;
    groupsById: Map<number, GroupInfo>;
  }> {
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.courseParticipantsCache.get(courseId);
      if (cached && cached.expiresAt > now) {
        recordCacheHit();
        return { usersById: cached.usersById, groupsById: cached.groupsById };
      }
    }

    const usersById = new Map<number, EnrolledUserSummary>();
    const groupsById = new Map<number, GroupInfo>();

    try {
      const rawUsers = await this.call<any[]>('core_enrol_get_enrolled_users', {
        courseid: courseId,
      });
      for (const u of rawUsers || []) {
        const userGroups = (u.groups || []).map((g: any) => ({
          id: Number(g.id),
          name: String(g.name || `Grupo ${g.id}`),
        }));
        const roles = (u.roles || []).map((r: any) => String(r.shortname || r.name || ''));
        const nonStudent = isNonStudentCourseRole(roles);
        usersById.set(Number(u.id), {
          id: Number(u.id),
          fullname: String(u.fullname || ''),
          email: u.email ? String(u.email) : undefined,
          username: u.username ? String(u.username) : undefined,
          groups: userGroups,
          roles,
        });

        for (const g of userGroups) {
          let groupEntry = groupsById.get(g.id);
          if (!groupEntry) {
            groupEntry = { id: g.id, name: g.name, members: [], hasNonStudentMembers: false };
            groupsById.set(g.id, groupEntry);
          }
          if (nonStudent) {
            groupEntry.hasNonStudentMembers = true;
          } else {
            groupEntry.members.push({
              id: Number(u.id),
              fullname: String(u.fullname || ''),
              email: u.email ? String(u.email) : undefined,
            });
          }
        }
      }

      this.courseParticipantsCache.set(courseId, {
        expiresAt: now + 5 * 60 * 1000,
        usersById,
        groupsById,
      });
    } catch {
      // Return empty maps if course enrollment inspection is restricted
    }

    return { usersById, groupsById };
  }

  private parseRawAssignmentMeta(a: any): AssignmentSummaryMeta {
    return {
      id: Number(a.id),
      cmid: a.cmid ? Number(a.cmid) : undefined,
      name: String(a.name || ''),
      maxGrade: Number(a.grade ?? 0),
      teamsubmission: Boolean(a.teamsubmission),
      teamsubmissiongroupingid: Number(a.teamsubmissiongroupingid || 0),
      preventsubmissionnotingroup: Boolean(a.preventsubmissionnotingroup),
      requireallteammemberssubmit: Boolean(a.requireallteammemberssubmit),
      markingworkflow: Boolean(a.markingworkflow),
      markingallocation: Boolean(a.markingallocation),
      blindmarking: Boolean(a.blindmarking),
      duedate: a.duedate !== undefined ? Number(a.duedate) : undefined,
      configs: Array.isArray(a.configs)
        ? a.configs.map((cfg: any) => ({
            plugin: String(cfg.plugin || ''),
            subtype: String(cfg.subtype || ''),
            name: String(cfg.name || ''),
            value: String(cfg.value ?? ''),
          }))
        : undefined,
    };
  }

  /**
   * Resolves assignment metadata + courseId + group/student maps, even when the caller
   * only passes `assignmentId` without `courseId`.
   */
  public async resolveAssignmentContext(
    assignmentId: number,
    courseIdHint?: number,
    forceRefresh = false
  ): Promise<AssignmentContext | undefined> {
    const now = Date.now();
    const effectiveCourseHint = courseIdHint ?? this.config.defaultCourseId;

    // Fast path: if already indexed and not forceRefresh, avoid extra mod_assign_get_assignments call
    if (!forceRefresh && this.assignmentIndexCache && this.assignmentIndexCache.expiresAt > now) {
      const cachedMeta = this.assignmentIndexCache.byAssignmentId.get(assignmentId);
      if (cachedMeta && (!effectiveCourseHint || cachedMeta.courseId === effectiveCourseHint)) {
        recordCacheHit();
        const { courseId: cId, courseName: cName, ...assignMeta } = cachedMeta;
        const { usersById, groupsById } = await this.getCourseParticipantsContext(cId, false);
        return {
          courseId: cId,
          courseName: cName,
          assignment: assignMeta,
          usersById,
          groupsById,
        };
      }
    }

    if (effectiveCourseHint) {
      const assignRes = await this.call<any>('mod_assign_get_assignments', {
        courseids: [effectiveCourseHint],
      });
      const courseObj = assignRes?.courses?.[0];
      const found = (courseObj?.assignments || []).find((a: any) => Number(a.id) === assignmentId);
      if (found) {
        const parsedMeta = this.parseRawAssignmentMeta(found);
        if (!this.assignmentIndexCache || this.assignmentIndexCache.expiresAt <= now) {
          this.assignmentIndexCache = {
            expiresAt: now + 5 * 60 * 1000,
            byAssignmentId: new Map(),
          };
        }
        for (const item of courseObj?.assignments || []) {
          const itemMeta = this.parseRawAssignmentMeta(item);
          this.assignmentIndexCache.byAssignmentId.set(itemMeta.id, {
            ...itemMeta,
            courseId: effectiveCourseHint,
            courseName: courseObj?.fullname,
          });
        }
        const { usersById, groupsById } = await this.getCourseParticipantsContext(
          effectiveCourseHint,
          forceRefresh
        );
        return {
          courseId: effectiveCourseHint,
          courseName: courseObj?.fullname,
          assignment: parsedMeta,
          usersById,
          groupsById,
        };
      }
    }

    // Check cached global assignment index or build it from user's enrolled courses
    if (forceRefresh || !this.assignmentIndexCache || this.assignmentIndexCache.expiresAt <= now) {
      const byAssignmentId = new Map<
        number,
        AssignmentSummaryMeta & {
          courseId: number;
          courseName?: string;
        }
      >();

      try {
        const siteInfo = await this.getSiteInfo();
        const courses = await this.call<any[]>('core_enrol_get_users_courses', {
          userid: siteInfo.userid,
        });
        const courseIds = (courses || []).map((c: any) => Number(c.id)).filter(Boolean);
        if (courseIds.length > 0) {
          const assignRes = await this.call<any>('mod_assign_get_assignments', {
            courseids: courseIds,
          });
          for (const c of assignRes?.courses || []) {
            for (const a of c.assignments || []) {
              const itemMeta = this.parseRawAssignmentMeta(a);
              byAssignmentId.set(itemMeta.id, {
                ...itemMeta,
                courseId: Number(c.id),
                courseName: c.fullname,
              });
            }
          }
        }
        this.assignmentIndexCache = {
          expiresAt: now + 5 * 60 * 1000,
          byAssignmentId,
        };
      } catch {
        // ignore discovery error
      }
    }

    const indexed = this.assignmentIndexCache?.byAssignmentId.get(assignmentId);
    if (!indexed) return undefined;

    const { courseId: cId, courseName: cName, ...assignMeta } = indexed;
    const { usersById, groupsById } = await this.getCourseParticipantsContext(cId, forceRefresh);
    return {
      courseId: cId,
      courseName: cName,
      assignment: assignMeta,
      usersById,
      groupsById,
    };
  }
}
