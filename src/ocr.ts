import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCacheHit } from './request-context.js';

export type OcrMode = 'off' | 'auto' | 'force' | 'status';

export type OcrSpatialRegion =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'px' | 'pt';
  pageWidth: number;
  pageHeight: number;
  normX: number;
  normY: number;
  normWidth: number;
  normHeight: number;
}

export interface OcrVisualBlock {
  blockIndex: number;
  readingOrder: number;
  region: OcrSpatialRegion;
  bbox: OcrBoundingBox;
  textSource: 'native' | 'ocr';
  confidence?: number;
  text: string;
}

export interface OcrPageResult {
  pageNumber: number;
  textSource: 'native' | 'ocr' | 'none';
  charCount: number;
  confidence?: number;
  width: number;
  height: number;
  unit: 'px' | 'pt';
  text: string;
  blocks: OcrVisualBlock[];
}

export interface OcrPageFailure {
  pageNumber: number;
  errorCode: 'ocr_timeout' | 'ocr_render_failed' | 'ocr_engine_failed' | 'ocr_unavailable';
  reason: string;
}

export interface OcrUnprocessedPage {
  pageNumber: number;
  reason: 'max_ocr_pages_limit' | 'ocr_mode_off' | 'ocr_mode_status' | 'ocr_disabled';
}

export interface OcrCapabilities {
  enabled: boolean;
  available: boolean;
  tesseractAvailable: boolean;
  tesseractVersion?: string;
  pdftoppmAvailable: boolean;
  pdftoppmVersion?: string;
  installedLanguages: string[];
  defaultLanguages: string[];
  maxPages: number;
  dpi: number;
  timeoutMs: number;
  pageTimeoutMs: number;
  maxConcurrency: number;
}

export interface OcrConfigSettings {
  enabled: boolean;
  maxPages: number;
  dpi: number;
  timeoutMs: number;
  pageTimeoutMs?: number;
  maxConcurrency: number;
  defaultLanguages: string[];
  tempBaseDir?: string;
  tesseractBin?: string;
  pdftoppmBin?: string;
}

export interface OcrDocumentOutcome {
  extractionStatus:
    | 'downloaded_with_text'
    | 'downloaded_needs_ocr'
    | 'downloaded_ocr_no_text'
    | 'downloaded_ocr_error'
    | 'downloaded_parser_error';
  extractionMethod:
    | 'native_pdf'
    | 'ocr_pdf'
    | 'hybrid_pdf_ocr'
    | 'ocr_image'
    | 'none';
  textExtractionComplete: boolean;
  ocrStatus:
    | 'not_requested'
    | 'diagnostic_only'
    | 'not_needed'
    | 'completed'
    | 'completed_no_text'
    | 'partial_failure'
    | 'failed'
    | 'unavailable';
  ocrMode: OcrMode;
  ocrLanguagesUsed?: string[];
  ocrBudgetMs?: number;
  ocrPageTimeoutMs?: number;
  ocrRetryCount?: number;
  ocrFallbackUsed?: boolean;
  needsOcr: boolean;
  pageCount?: number;
  pagesWithTextCount?: number;
  nativeTextPageNumbers?: number[];
  ocrProcessedPageNumbers?: number[];
  emptyPageNumbers?: number[];
  unprocessedPages?: OcrUnprocessedPage[];
  failedPages?: OcrPageFailure[];
  ocrConfidence?: number;
  extractedText?: string;
  truncated?: boolean;
  pages?: OcrPageResult[];
  parserError?: string;
  parserErrorCode?: 'pdf_password_protected' | 'pdf_corrupted_or_unreadable';
  ocrError?: string;
  note?: string;
}

const MAX_RENDER_DIMENSION_PX = 3600;
const MAX_SUBPROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_BLOCKS_PER_PAGE = 250;
const VALID_LANG_REGEX = /^[a-z]{3}(?:_[a-z0-9]+)?$/;

class ConcurrencySemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public async acquire(limit: number): Promise<() => void> {
    const cap = Math.max(1, limit);
    if (this.active < cap) {
      this.active++;
      return this.createRelease();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

const ocrSemaphore = new ConcurrencySemaphore();

interface CachedOcrEntry {
  expiresAtMs: number;
  rawFullPages: OcrPageResult[];
  pageCount: number;
  pagesWithTextCount: number;
  nativeTextPageNumbers: number[];
  ocrProcessedPageNumbers: number[];
  emptyPageNumbers: number[];
  unprocessedPages: OcrUnprocessedPage[];
  failedPages: OcrPageFailure[];
  ocrLanguagesUsed: string[];
  ocrConfidence?: number;
  ocrBudgetMs?: number;
  ocrPageTimeoutMs?: number;
  ocrRetryCount?: number;
  ocrFallbackUsed?: boolean;
}

const ocrResultCache = new Map<string, CachedOcrEntry>();

let cachedProbeKey = '';
let cachedProbeResult:
  | {
      tesseractAvailable: boolean;
      tesseractVersion?: string;
      pdftoppmAvailable: boolean;
      pdftoppmVersion?: string;
      installedLanguages: string[];
    }
  | undefined;

class SubprocessExecError extends Error {
  public readonly kind: 'timeout' | 'not_found' | 'exit_error';
  public readonly stderr: string;

  constructor(kind: 'timeout' | 'not_found' | 'exit_error', message: string, stderr = '') {
    super(message);
    this.name = 'SubprocessExecError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

function runCommandSafe(
  bin: string,
  args: string[],
  timeoutMs: number,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          OMP_THREAD_LIMIT: '2',
          LC_ALL: 'C.UTF-8',
        },
      });
    } catch (err: any) {
      reject(
        new SubprocessExecError(
          err?.code === 'ENOENT' ? 'not_found' : 'exit_error',
          err?.message || String(err)
        )
      );
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(
        new SubprocessExecError(
          'timeout',
          `Tempo limite de execução do OCR excedido (${timeoutMs} ms) ao executar ${path.basename(bin)}.`
        )
      );
    }, Math.max(50, timeoutMs));
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_SUBPROCESS_OUTPUT_BYTES) {
        const take = Math.min(chunk.length, MAX_SUBPROCESS_OUTPUT_BYTES - stdoutLen);
        stdoutChunks.push(chunk.subarray(0, take));
        stdoutLen += take;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_SUBPROCESS_OUTPUT_BYTES) {
        const take = Math.min(chunk.length, MAX_SUBPROCESS_OUTPUT_BYTES - stderrLen);
        stderrChunks.push(chunk.subarray(0, take));
        stderrLen += take;
      }
    });

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new SubprocessExecError(
          err?.code === 'ENOENT' ? 'not_found' : 'exit_error',
          err?.message || String(err)
        )
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new SubprocessExecError(
            'exit_error',
            `${path.basename(bin)} encerrou com código ${code ?? signal}: ${stderr.trim().slice(0, 300)}`,
            stderr
          )
        );
      }
    });
  });
}

export async function checkOcrCapabilities(
  settings: OcrConfigSettings,
  forceRefresh = false
): Promise<OcrCapabilities> {
  const tesseractBin = settings.tesseractBin || 'tesseract';
  const pdftoppmBin = settings.pdftoppmBin || 'pdftoppm';
  const probeKey = `${tesseractBin}|${pdftoppmBin}`;

  if (forceRefresh || !cachedProbeResult || cachedProbeKey !== probeKey) {
    let tesseractAvailable = false;
    let tesseractVersion: string | undefined;
    let installedLanguages: string[] = [];
    let pdftoppmAvailable = false;
    let pdftoppmVersion: string | undefined;

    try {
      const ver = await runCommandSafe(tesseractBin, ['--version'], 5000);
      const combined = `${ver.stdout}\n${ver.stderr}`.trim();
      const firstLine = combined.split(/\r?\n/)[0]?.trim();
      if (firstLine) {
        tesseractAvailable = true;
        tesseractVersion = firstLine;
      }
      const langsOut = await runCommandSafe(tesseractBin, ['--list-langs'], 5000);
      installedLanguages = `${langsOut.stdout}\n${langsOut.stderr}`
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => VALID_LANG_REGEX.test(l) && l !== 'osd');
    } catch {
      tesseractAvailable = false;
    }

    try {
      const ppm = await runCommandSafe(pdftoppmBin, ['-v'], 5000);
      const combined = `${ppm.stdout}\n${ppm.stderr}`.trim();
      const firstLine = combined.split(/\r?\n/)[0]?.trim();
      pdftoppmAvailable = true;
      pdftoppmVersion = firstLine || 'pdftoppm';
    } catch {
      pdftoppmAvailable = false;
    }

    cachedProbeKey = probeKey;
    cachedProbeResult = {
      tesseractAvailable,
      tesseractVersion,
      pdftoppmAvailable,
      pdftoppmVersion,
      installedLanguages,
    };
  }

  return {
    enabled: settings.enabled,
    available:
      settings.enabled &&
      cachedProbeResult.tesseractAvailable &&
      cachedProbeResult.pdftoppmAvailable &&
      cachedProbeResult.installedLanguages.length > 0,
    tesseractAvailable: cachedProbeResult.tesseractAvailable,
    ...(cachedProbeResult.tesseractVersion
      ? { tesseractVersion: cachedProbeResult.tesseractVersion }
      : {}),
    pdftoppmAvailable: cachedProbeResult.pdftoppmAvailable,
    ...(cachedProbeResult.pdftoppmVersion
      ? { pdftoppmVersion: cachedProbeResult.pdftoppmVersion }
      : {}),
    installedLanguages: cachedProbeResult.installedLanguages,
    defaultLanguages: settings.defaultLanguages,
    maxPages: settings.maxPages,
    dpi: settings.dpi,
    timeoutMs: settings.timeoutMs,
    pageTimeoutMs: settings.pageTimeoutMs ?? 60_000,
    maxConcurrency: settings.maxConcurrency,
  };
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundNorm(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Math.round(value * 10000) / 10000));
}

function classifySpatialRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number
): OcrSpatialRegion {
  const pw = Math.max(1, pageWidth);
  const ph = Math.max(1, pageHeight);
  const cx = (x + width / 2) / pw;
  const cy = (y + height / 2) / ph;

  const row = cy < 0.3334 ? 'top' : cy < 0.6667 ? 'middle' : 'bottom';
  const col = cx < 0.3334 ? 'left' : cx < 0.6667 ? 'center' : 'right';
  return `${row}-${col}` as OcrSpatialRegion;
}

function buildBoundingBox(
  x: number,
  y: number,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
  unit: 'px' | 'pt'
): OcrBoundingBox {
  const pw = Math.max(1, pageWidth);
  const ph = Math.max(1, pageHeight);
  const clampedX = Math.max(0, roundCoord(x));
  const clampedY = Math.max(0, roundCoord(y));
  const clampedW = Math.max(0, roundCoord(width));
  const clampedH = Math.max(0, roundCoord(height));
  return {
    x: clampedX,
    y: clampedY,
    width: clampedW,
    height: clampedH,
    unit,
    pageWidth: roundCoord(pw),
    pageHeight: roundCoord(ph),
    normX: roundNorm(clampedX / pw),
    normY: roundNorm(clampedY / ph),
    normWidth: roundNorm(clampedW / pw),
    normHeight: roundNorm(clampedH / ph),
  };
}

function sortAndIndexBlocks(
  rawBlocks: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    pageWidth: number;
    pageHeight: number;
    unit: 'px' | 'pt';
    textSource: 'native' | 'ocr';
    confidence?: number;
    text: string;
  }>
): OcrVisualBlock[] {
  const bandTolerance = rawBlocks.length > 0 ? Math.max(8, rawBlocks[0].pageHeight * 0.018) : 12;
  const sorted = [...rawBlocks].sort((a, b) => {
    if (Math.abs(a.y - b.y) > bandTolerance) {
      return a.y - b.y;
    }
    return a.x - b.x;
  });

  const capped = sorted.slice(0, MAX_BLOCKS_PER_PAGE);
  return capped.map((b, idx) => ({
    blockIndex: idx + 1,
    readingOrder: idx + 1,
    region: classifySpatialRegion(b.x, b.y, b.width, b.height, b.pageWidth, b.pageHeight),
    bbox: buildBoundingBox(b.x, b.y, b.width, b.height, b.pageWidth, b.pageHeight, b.unit),
    textSource: b.textSource,
    ...(b.confidence !== undefined ? { confidence: Math.round(b.confidence * 10) / 10 } : {}),
    text: b.text,
  }));
}

function extractNativeBlocksFromPdfItems(
  items: any[],
  pageWidthPt: number,
  pageHeightPt: number
): { pageText: string; blocks: OcrVisualBlock[] } {
  const lineParts: string[] = [];
  interface PositionedSpan {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
  }
  const spans: PositionedSpan[] = [];

  for (const item of items) {
    if (!('str' in item)) continue;
    const str = String(item.str || '');
    lineParts.push(str);
    if (item.hasEOL) lineParts.push('\n');
    else lineParts.push(' ');

    const trimmed = str.trim();
    if (!trimmed) continue;

    const tr = Array.isArray(item.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
    const tx = Number(tr[4] || 0);
    const ty = Number(tr[5] || 0);
    const fontH = Math.max(6, Math.abs(Number(item.height || tr[3] || 10)));
    const spanW = Math.max(4, Math.abs(Number(item.width || trimmed.length * fontH * 0.5)));
    const topY = Math.max(0, pageHeightPt - ty - fontH);

    spans.push({
      x: tx,
      y: topY,
      width: spanW,
      height: fontH,
      text: trimmed,
    });
  }

  const pageText = lineParts.join('').replace(/[ \t]+\n/g, '\n').trim();
  if (spans.length === 0) {
    return { pageText, blocks: [] };
  }

  // Merge spans that sit on the same visual line/paragraph box (useful for Miro/Canvas cards)
  const merged: Array<{
    x: number;
    y: number;
    right: number;
    bottom: number;
    lines: string[];
  }> = [];

  for (const sp of spans) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const sameVerticalNear =
        sp.y >= prev.y - sp.height * 0.8 && sp.y <= prev.bottom + sp.height * 1.4;
      const horizOverlapOrNear =
        sp.x <= prev.right + Math.max(24, sp.height * 2.5) &&
        sp.x + sp.width >= prev.x - Math.max(24, sp.height * 2.5);
      if (sameVerticalNear && horizOverlapOrNear) {
        const isNewLine = sp.y > prev.bottom - sp.height * 0.35;
        if (isNewLine) {
          prev.lines.push(sp.text);
        } else {
          prev.lines[prev.lines.length - 1] = `${prev.lines[prev.lines.length - 1]} ${sp.text}`;
        }
        prev.x = Math.min(prev.x, sp.x);
        prev.y = Math.min(prev.y, sp.y);
        prev.right = Math.max(prev.right, sp.x + sp.width);
        prev.bottom = Math.max(prev.bottom, sp.y + sp.height);
        continue;
      }
    }
    merged.push({
      x: sp.x,
      y: sp.y,
      right: sp.x + sp.width,
      bottom: sp.y + sp.height,
      lines: [sp.text],
    });
  }

  const blocks = sortAndIndexBlocks(
    merged.map((m) => ({
      x: m.x,
      y: m.y,
      width: m.right - m.x,
      height: m.bottom - m.y,
      pageWidth: pageWidthPt,
      pageHeight: pageHeightPt,
      unit: 'pt' as const,
      textSource: 'native' as const,
      text: m.lines.join('\n'),
    }))
  );

  return {
    pageText: pageText || blocks.map((b) => b.text).join('\n'),
    blocks,
  };
}

function parseTesseractTsv(tsvContent: string): {
  pageWidth: number;
  pageHeight: number;
  pageText: string;
  confidence?: number;
  blocks: OcrVisualBlock[];
} {
  const lines = tsvContent.split(/\r?\n/);
  let pageWidth = 1;
  let pageHeight = 1;

  interface WordItem {
    blockNum: number;
    parNum: number;
    lineNum: number;
    left: number;
    top: number;
    width: number;
    height: number;
    conf: number;
    text: string;
  }

  const words: WordItem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;

    const level = Number(cols[0]);
    const blockNum = Number(cols[2]);
    const parNum = Number(cols[3]);
    const lineNum = Number(cols[4]);
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const width = Number(cols[8]);
    const height = Number(cols[9]);
    const conf = Number(cols[10]);
    const rawText = cols.slice(11).join('\t').trim();

    if (level === 1 && width > 0 && height > 0) {
      pageWidth = width;
      pageHeight = height;
      continue;
    }

    if (level === 5 && rawText.length > 0) {
      words.push({
        blockNum,
        parNum,
        lineNum,
        left,
        top,
        width,
        height,
        conf,
        text: rawText,
      });
    }
  }

  if (words.length === 0) {
    return {
      pageWidth,
      pageHeight,
      pageText: '',
      blocks: [],
    };
  }

  // Group words by `(blockNum, parNum)` and reconstruct lines inside each block
  const grouped = new Map<
    string,
    {
      minX: number;
      minY: number;
      maxRight: number;
      maxBottom: number;
      confValues: number[];
      byLine: Map<number, string[]>;
    }
  >();

  const allConfValues: number[] = [];

  for (const w of words) {
    const key = `${w.blockNum}:${w.parNum}`;
    let g = grouped.get(key);
    if (!g) {
      g = {
        minX: w.left,
        minY: w.top,
        maxRight: w.left + w.width,
        maxBottom: w.top + w.height,
        confValues: [],
        byLine: new Map(),
      };
      grouped.set(key, g);
    } else {
      g.minX = Math.min(g.minX, w.left);
      g.minY = Math.min(g.minY, w.top);
      g.maxRight = Math.max(g.maxRight, w.left + w.width);
      g.maxBottom = Math.max(g.maxBottom, w.top + w.height);
    }

    if (Number.isFinite(w.conf) && w.conf >= 0) {
      g.confValues.push(w.conf);
      allConfValues.push(w.conf);
    }

    let lineArr = g.byLine.get(w.lineNum);
    if (!lineArr) {
      lineArr = [];
      g.byLine.set(w.lineNum, lineArr);
    }
    lineArr.push(w.text);
  }

  const rawBlocks = Array.from(grouped.values()).map((g) => {
    const lineTexts = Array.from(g.byLine.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, arr]) => arr.join(' '));
    const avgConf =
      g.confValues.length > 0
        ? g.confValues.reduce((acc, v) => acc + v, 0) / g.confValues.length
        : undefined;
    return {
      x: g.minX,
      y: g.minY,
      width: g.maxRight - g.minX,
      height: g.maxBottom - g.minY,
      pageWidth,
      pageHeight,
      unit: 'px' as const,
      textSource: 'ocr' as const,
      confidence: avgConf,
      text: lineTexts.join('\n').trim(),
    };
  });

  const blocks = sortAndIndexBlocks(rawBlocks);
  const pageText = blocks.map((b) => b.text).join('\n\n').trim();
  const pageConf =
    allConfValues.length > 0
      ? Math.round(
          (allConfValues.reduce((acc, v) => acc + v, 0) / allConfValues.length) * 10
        ) / 10
      : undefined;

  return {
    pageWidth,
    pageHeight,
    pageText,
    confidence: pageConf,
    blocks,
  };
}

function resolveRequestedLanguages(
  requested: string[] | undefined,
  installed: string[],
  defaults: string[]
): string[] {
  const candidates = (requested && requested.length > 0 ? requested : defaults)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => VALID_LANG_REGEX.test(l));

  if (installed.length === 0) {
    return candidates.length > 0 ? candidates : ['eng'];
  }

  const installedSet = new Set(installed);
  const matched = candidates.filter((l) => installedSet.has(l));
  if (matched.length > 0) {
    return Array.from(new Set(matched));
  }
  if (installedSet.has('eng')) return ['eng'];
  return [installed[0]];
}

function formatPagesIntoBoundedText(
  pages: OcrPageResult[],
  totalPages: number,
  maxChars: number
): { extractedText: string; truncated: boolean } {
  const chunks: string[] = [];
  let totalLen = 0;
  let truncated = false;

  for (const p of pages) {
    if (!p.text) continue;
    const sourceLabel = p.textSource === 'ocr' ? 'OCR' : 'Nativo';
    const header =
      totalPages > 0
        ? `--- [Página ${p.pageNumber}/${totalPages} | ${sourceLabel}] ---`
        : `--- [${sourceLabel}] ---`;
    const block = `${header}\n${p.text}`;
    if (!truncated) {
      if (totalLen + block.length > maxChars) {
        const remaining = Math.max(0, maxChars - totalLen);
        if (remaining > 0) {
          chunks.push(`${block.slice(0, remaining)}\n...[truncado]`);
        }
        truncated = true;
      } else {
        chunks.push(block);
        totalLen += block.length + 2;
      }
    }
  }

  return {
    extractedText: chunks.join('\n\n').trim(),
    truncated,
  };
}

export async function extractPdfWithOcr(params: {
  diskPath: string;
  sha256: string;
  filesize: number;
  maxChars: number;
  ocrMode: OcrMode;
  ocrLanguages?: string[];
  maxOcrPages?: number;
  settings: OcrConfigSettings;
  sanitizeError: (err: unknown) => string;
}): Promise<OcrDocumentOutcome> {
  const { diskPath, sha256, filesize, maxChars, ocrMode, settings, sanitizeError } = params;

  // 1. Parse PDF structure and native text per page via unpdf
  let numPages = 0;
  const nativePages: Array<{
    pageNumber: number;
    widthPt: number;
    heightPt: number;
    pageText: string;
    nonWsCount: number;
    blocks: OcrVisualBlock[];
  }> = [];

  try {
    const bytes = new Uint8Array(fs.readFileSync(diskPath));
    const { getDocumentProxy } = await import('unpdf');
    const pdf: any = await getDocumentProxy(bytes, {
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    } as any);

    try {
      numPages = Number(pdf.numPages || 0);
      const inspectCap = Math.min(numPages, 150);
      for (let p = 1; p <= inspectCap; p++) {
        const page = await pdf.getPage(p);
        const view: number[] = Array.isArray(page.view) ? page.view : [0, 0, 595, 842];
        const widthPt = Math.max(1, Math.abs(Number(view[2] || 595) - Number(view[0] || 0)));
        const heightPt = Math.max(1, Math.abs(Number(view[3] || 842) - Number(view[1] || 0)));
        const textContent = await page.getTextContent();
        const { pageText, blocks } = extractNativeBlocksFromPdfItems(
          textContent.items || [],
          widthPt,
          heightPt
        );
        const nonWsCount = pageText.replace(/\s+/g, '').length;
        nativePages.push({
          pageNumber: p,
          widthPt,
          heightPt,
          pageText,
          nonWsCount,
          blocks,
        });
      }
    } finally {
      if (typeof pdf.destroy === 'function') {
        await pdf.destroy();
      }
    }
  } catch (err: any) {
    const rawMsg = sanitizeError(err);
    const isPassword =
      err?.name === 'PasswordException' || /password|encrypted|senha/i.test(rawMsg);
    return {
      extractionStatus: 'downloaded_parser_error',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'failed',
      ocrMode,
      needsOcr: false,
      parserError: rawMsg,
      parserErrorCode: isPassword ? 'pdf_password_protected' : 'pdf_corrupted_or_unreadable',
      note: isPassword
        ? `Download concluído e PDF original preservado (SHA-256: ${sha256}), mas o documento está protegido por senha (${rawMsg}).`
        : `Download do PDF concluído e arquivo original preservado (SHA-256: ${sha256}), mas o parser de texto falhou (${rawMsg}). O PDF continua acessível para leitura/reparo local via downloadUrl.`,
    };
  }

  const nativeTextPageNumbers = nativePages
    .filter((p) => p.nonWsCount >= 20)
    .map((p) => p.pageNumber);
  const pagesWithAnyNativeText = nativePages.filter((p) => p.nonWsCount >= 5).length;
  const emptyNativePageNumbers = nativePages
    .filter((p) => p.nonWsCount < 5)
    .map((p) => p.pageNumber);
  const lowNativePageNumbers = nativePages
    .filter((p) => p.nonWsCount < 20)
    .map((p) => p.pageNumber);
  const totalNativeMeaningfulChars = nativePages.reduce((acc, p) => acc + p.nonWsCount, 0);

  // 2. Mode 'off': preserve exact v1.1.0 native extraction behavior & notes
  if (ocrMode === 'off') {
    const chunks: string[] = [];
    let totalLen = 0;
    let truncated = false;
    for (const p of nativePages) {
      if (!p.pageText) continue;
      const formatted = `--- [Página ${p.pageNumber}/${numPages}] ---\n${p.pageText}`;
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
    const extractedText = chunks.join('\n\n').trim();

    if (totalNativeMeaningfulChars < 20) {
      return {
        extractionStatus: 'downloaded_needs_ocr',
        extractionMethod: 'none',
        textExtractionComplete: false,
        ocrStatus: 'not_requested',
        ocrMode: 'off',
        needsOcr: true,
        pageCount: numPages,
        pagesWithTextCount: pagesWithAnyNativeText,
        emptyPageNumbers: emptyNativePageNumbers,
        extractedText: extractedText || undefined,
        note:
          `Download concluído (${numPages} página(s), ${filesize} bytes), porém o PDF não possui camada de texto nativo útil ` +
          `(documento digitalizado ou exportado como imagem). Use ocrMode="auto" para executar OCR automaticamente no servidor MCP ou use downloadUrl para obter o PDF original.`,
      };
    }

    return {
      extractionStatus: 'downloaded_with_text',
      extractionMethod: 'native_pdf',
      textExtractionComplete: emptyNativePageNumbers.length === 0,
      ocrStatus: 'not_requested',
      ocrMode: 'off',
      needsOcr: emptyNativePageNumbers.length > 0,
      pageCount: numPages,
      pagesWithTextCount: pagesWithAnyNativeText,
      ...(emptyNativePageNumbers.length > 0 ? { emptyPageNumbers: emptyNativePageNumbers } : {}),
      extractedText,
      truncated,
      ...(emptyNativePageNumbers.length > 0
        ? {
            note: `Texto nativo extraído de ${pagesWithAnyNativeText}/${nativePages.length} página(s). As páginas [${emptyNativePageNumbers.join(', ')}] não contêm texto nativo (use ocrMode="auto" para aplicar OCR apenas às páginas sem texto).`,
          }
        : {}),
    };
  }

  // 3. Mode 'status': diagnostic without executing OCR
  const caps = await checkOcrCapabilities(settings);
  if (ocrMode === 'status') {
    const pagesSummary: OcrPageResult[] = nativePages.map((p) => ({
      pageNumber: p.pageNumber,
      textSource: p.nonWsCount >= 5 ? 'native' : 'none',
      charCount: p.pageText.length,
      width: roundCoord(p.widthPt),
      height: roundCoord(p.heightPt),
      unit: 'pt',
      text: p.pageText,
      blocks: p.blocks,
    }));
    const { extractedText, truncated } = formatPagesIntoBoundedText(
      pagesSummary,
      numPages,
      maxChars
    );
    const needsOcr = totalNativeMeaningfulChars < 20 || lowNativePageNumbers.length > 0;
    return {
      extractionStatus: totalNativeMeaningfulChars < 20 ? 'downloaded_needs_ocr' : 'downloaded_with_text',
      extractionMethod: totalNativeMeaningfulChars >= 20 ? 'native_pdf' : 'none',
      textExtractionComplete: false,
      ocrStatus: 'diagnostic_only',
      ocrMode: 'status',
      ocrLanguagesUsed: resolveRequestedLanguages(
        params.ocrLanguages,
        caps.installedLanguages,
        settings.defaultLanguages
      ),
      needsOcr,
      pageCount: numPages,
      pagesWithTextCount: pagesWithAnyNativeText,
      nativeTextPageNumbers,
      ocrProcessedPageNumbers: [],
      emptyPageNumbers: emptyNativePageNumbers,
      unprocessedPages: lowNativePageNumbers.map((pageNumber) => ({
        pageNumber,
        reason: 'ocr_mode_status' as const,
      })),
      extractedText: extractedText || undefined,
      truncated,
      pages: pagesSummary,
      note: needsOcr
        ? `Diagnóstico concluído: ${lowNativePageNumbers.length} de ${numPages} página(s) necessitam de OCR (${caps.available ? 'OCR local disponível' : 'OCR local indisponível'}).`
        : `Diagnóstico concluído: todas as ${numPages} página(s) já possuem texto nativo extraível.`,
    };
  }

  // 4. Mode 'auto' or 'force'
  const pagesCandidateForOcr =
    ocrMode === 'force'
      ? nativePages.map((p) => p.pageNumber)
      : lowNativePageNumbers;

  // Fast path: 'auto' when EVERY page already has rich native text!
  if (ocrMode === 'auto' && pagesCandidateForOcr.length === 0) {
    const finalPages: OcrPageResult[] = nativePages.map((p) => ({
      pageNumber: p.pageNumber,
      textSource: 'native',
      charCount: p.pageText.length,
      width: roundCoord(p.widthPt),
      height: roundCoord(p.heightPt),
      unit: 'pt',
      text: p.pageText,
      blocks: p.blocks,
    }));
    const { extractedText, truncated } = formatPagesIntoBoundedText(finalPages, numPages, maxChars);
    return {
      extractionStatus: 'downloaded_with_text',
      extractionMethod: 'native_pdf',
      textExtractionComplete: true,
      ocrStatus: 'not_needed',
      ocrMode: 'auto',
      needsOcr: false,
      pageCount: numPages,
      pagesWithTextCount: finalPages.length,
      nativeTextPageNumbers,
      ocrProcessedPageNumbers: [],
      emptyPageNumbers: [],
      extractedText,
      truncated,
      pages: finalPages,
    };
  }

  // Check if OCR is disabled or local tools are missing
  if (!caps.available) {
    const reasonCode = !settings.enabled ? 'ocr_disabled' : 'ocr_unavailable';
    const fallbackPages: OcrPageResult[] = nativePages.map((p) => ({
      pageNumber: p.pageNumber,
      textSource: p.nonWsCount >= 5 ? 'native' : 'none',
      charCount: p.pageText.length,
      width: roundCoord(p.widthPt),
      height: roundCoord(p.heightPt),
      unit: 'pt',
      text: p.pageText,
      blocks: p.blocks,
    }));
    const { extractedText, truncated } = formatPagesIntoBoundedText(
      fallbackPages,
      numPages,
      maxChars
    );
    return {
      extractionStatus:
        extractedText.replace(/\s+/g, '').length >= 20
          ? 'downloaded_with_text'
          : 'downloaded_ocr_error',
      extractionMethod: extractedText.replace(/\s+/g, '').length >= 20 ? 'native_pdf' : 'none',
      textExtractionComplete: false,
      ocrStatus: 'unavailable',
      ocrMode,
      needsOcr: true,
      pageCount: numPages,
      pagesWithTextCount: pagesWithAnyNativeText,
      nativeTextPageNumbers,
      ocrProcessedPageNumbers: [],
      emptyPageNumbers: emptyNativePageNumbers,
      unprocessedPages: !settings.enabled
        ? pagesCandidateForOcr.map((pageNumber) => ({ pageNumber, reason: 'ocr_disabled' }))
        : undefined,
      failedPages: settings.enabled
        ? pagesCandidateForOcr.map((pageNumber) => ({
            pageNumber,
            errorCode: 'ocr_unavailable',
            reason: `Ferramentas locais de OCR indisponíveis (tesseract=${caps.tesseractAvailable}, pdftoppm=${caps.pdftoppmAvailable}).`,
          }))
        : undefined,
      extractedText: extractedText || undefined,
      truncated,
      pages: fallbackPages,
      ocrError: `OCR local não pôde ser executado (${reasonCode}). O PDF original permanece preservado via downloadUrl/resourceUri.`,
    };
  }

  const effectiveMaxOcrPages = Math.max(
    1,
    Math.min(params.maxOcrPages ?? settings.maxPages, settings.maxPages)
  );
  const effectiveDpi = Math.max(72, Math.min(settings.dpi, 300));
  const langsToUse = resolveRequestedLanguages(
    params.ocrLanguages,
    caps.installedLanguages,
    settings.defaultLanguages
  );

  const cacheKey = `${sha256}|${ocrMode}|${langsToUse.join('+')}|${effectiveMaxOcrPages}|${effectiveDpi}`;
  const cached = ocrResultCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    recordCacheHit();
    return buildOutcomeFromComputedPages({
      ocrMode,
      numPages: cached.pageCount,
      finalPages: cached.rawFullPages,
      nativeTextPageNumbers: cached.nativeTextPageNumbers,
      ocrProcessedPageNumbers: cached.ocrProcessedPageNumbers,
      emptyPageNumbers: cached.emptyPageNumbers,
      unprocessedPages: cached.unprocessedPages,
      failedPages: cached.failedPages,
      ocrLanguagesUsed: cached.ocrLanguagesUsed,
      ocrConfidence: cached.ocrConfidence,
      ocrBudgetMs: cached.ocrBudgetMs,
      ocrPageTimeoutMs: cached.ocrPageTimeoutMs,
      ocrRetryCount: cached.ocrRetryCount,
      ocrFallbackUsed: cached.ocrFallbackUsed,
      maxChars,
    });
  }

  const pagesToOcr = pagesCandidateForOcr.slice(0, effectiveMaxOcrPages);
  const skippedDueToLimit = pagesCandidateForOcr.slice(effectiveMaxOcrPages);
  const unprocessedPages: OcrUnprocessedPage[] = skippedDueToLimit.map((pageNumber) => ({
    pageNumber,
    reason: 'max_ocr_pages_limit',
  }));
  const failedPages: OcrPageFailure[] = [];
  const ocrByPage = new Map<
    number,
    {
      pageWidth: number;
      pageHeight: number;
      pageText: string;
      confidence?: number;
      blocks: OcrVisualBlock[];
    }
  >();

  const releaseSemaphore = await ocrSemaphore.acquire(settings.maxConcurrency);
  const tempRoot = settings.tempBaseDir || path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const jobDir = fs.mkdtempSync(path.join(tempRoot, 'ocr_job_'));

  const configuredDocTimeout = Math.max(500, settings.timeoutMs ?? 120_000);
  const basePageTimeout = Math.max(250, settings.pageTimeoutMs ?? 60_000);
  const numPagesToOcr = Math.max(1, pagesToOcr.length);

  const effectiveDocBudgetMs =
    configuredDocTimeout < 5_000
      ? configuredDocTimeout
      : Math.min(600_000, Math.max(configuredDocTimeout, numPagesToOcr * basePageTimeout));

  const pageTimeoutMs = Math.min(basePageTimeout, effectiveDocBudgetMs);
  const deadlineMs = Date.now() + effectiveDocBudgetMs;
  let retryCount = 0;
  let fallbackUsed = false;

  try {
    try {
      fs.chmodSync(jobDir, 0o700);
    } catch {
      // ignore
    }

    const isolatedPdfPath = path.join(jobDir, 'source.pdf');
    fs.copyFileSync(diskPath, isolatedPdfPath);

    const pdftoppmBin = settings.pdftoppmBin || 'pdftoppm';
    const tesseractBin = settings.tesseractBin || 'tesseract';

    for (const pageNum of pagesToOcr) {
      const remainingGlobalMs = deadlineMs - Date.now();
      if (remainingGlobalMs <= 500) {
        failedPages.push({
          pageNumber: pageNum,
          errorCode: 'ocr_timeout',
          reason: `Tempo limite total de OCR (${effectiveDocBudgetMs} ms) esgotado antes de concluir a página ${pageNum}.`,
        });
        continue;
      }

      const pageMeta = nativePages.find((p) => p.pageNumber === pageNum);
      const maxDimPt = Math.max(pageMeta?.widthPt ?? 595, pageMeta?.heightPt ?? 842);
      const safePageDpi = Math.min(
        effectiveDpi,
        Math.max(72, Math.floor((MAX_RENDER_DIMENSION_PX * 72) / Math.max(1, maxDimPt)))
      );

      const pngBase = path.join(jobDir, `page_${pageNum}`);
      const pngPath = `${pngBase}.png`;
      const tsvBase = path.join(jobDir, `ocr_${pageNum}`);
      const tsvPath = `${tsvBase}.tsv`;

      let resolvedPng = pngPath;

      try {
        const renderTimeoutMs = Math.min(
          30_000,
          Math.max(5000, Math.floor(Math.min(pageTimeoutMs, remainingGlobalMs) * 0.4))
        );

        await runCommandSafe(
          pdftoppmBin,
          [
            '-png',
            '-singlefile',
            '-r',
            String(safePageDpi),
            '-f',
            String(pageNum),
            '-l',
            String(pageNum),
            isolatedPdfPath,
            pngBase,
          ],
          renderTimeoutMs,
          jobDir
        );

        if (!fs.existsSync(resolvedPng)) {
          const fallbackCandidate = fs
            .readdirSync(jobDir)
            .find((f) => f.startsWith(`page_${pageNum}`) && f.endsWith('.png'));
          if (fallbackCandidate) {
            resolvedPng = path.join(jobDir, fallbackCandidate);
          }
        }

        if (!fs.existsSync(resolvedPng)) {
          failedPages.push({
            pageNumber: pageNum,
            errorCode: 'ocr_render_failed',
            reason: `pdftoppm não gerou imagem PNG para a página ${pageNum}.`,
          });
          continue;
        }

        const afterRenderRemainingMs = deadlineMs - Date.now();
        if (afterRenderRemainingMs <= 500) {
          failedPages.push({
            pageNumber: pageNum,
            errorCode: 'ocr_timeout',
            reason: `Tempo limite de OCR (${effectiveDocBudgetMs} ms) atingido após renderizar a página ${pageNum}.`,
          });
          continue;
        }

        const tesseractTimeoutMs = Math.min(pageTimeoutMs, afterRenderRemainingMs);

        try {
          await runCommandSafe(
            tesseractBin,
            [resolvedPng, tsvBase, '-l', langsToUse.join('+'), '--psm', '3', 'tsv'],
            tesseractTimeoutMs,
            jobDir
          );

          if (fs.existsSync(tsvPath)) {
            const tsvRaw = fs.readFileSync(tsvPath, 'utf8');
            const parsed = parseTesseractTsv(tsvRaw);
            ocrByPage.set(pageNum, parsed);
          } else {
            failedPages.push({
              pageNumber: pageNum,
              errorCode: 'ocr_engine_failed',
              reason: `Tesseract não produziu arquivo TSV para a página ${pageNum}.`,
            });
          }
        } catch (firstAttemptErr: any) {
          const isTimeout =
            firstAttemptErr instanceof SubprocessExecError && firstAttemptErr.kind === 'timeout';

          // Controlled retry with language fallback if multi-language was requested and timed out or failed
          const remainingForRetry = deadlineMs - Date.now();
          const canFallback =
            langsToUse.length > 1 &&
            fs.existsSync(resolvedPng) &&
            remainingForRetry >= 10_000;

          if (canFallback) {
            retryCount++;
            fallbackUsed = true;
            try {
              fs.rmSync(tsvPath, { force: true });
            } catch {
              // ignore
            }

            const primaryLang = langsToUse[0];
            const retryTimeoutMs = Math.min(pageTimeoutMs, remainingForRetry);

            try {
              await runCommandSafe(
                tesseractBin,
                [resolvedPng, tsvBase, '-l', primaryLang, '--psm', '3', 'tsv'],
                retryTimeoutMs,
                jobDir
              );

              if (fs.existsSync(tsvPath)) {
                const tsvRaw = fs.readFileSync(tsvPath, 'utf8');
                const parsed = parseTesseractTsv(tsvRaw);
                ocrByPage.set(pageNum, parsed);
              } else {
                failedPages.push({
                  pageNumber: pageNum,
                  errorCode: 'ocr_engine_failed',
                  reason: `Tesseract com idioma fallback "${primaryLang}" não produziu arquivo TSV para a página ${pageNum}.`,
                });
              }
            } catch (retryErr: any) {
              const retryIsTimeout =
                retryErr instanceof SubprocessExecError && retryErr.kind === 'timeout';
              failedPages.push({
                pageNumber: pageNum,
                errorCode: retryIsTimeout ? 'ocr_timeout' : 'ocr_engine_failed',
                reason: `Retry com fallback (${primaryLang}) falhou: ${sanitizeError(retryErr)}`,
              });
            }
          } else {
            failedPages.push({
              pageNumber: pageNum,
              errorCode: isTimeout ? 'ocr_timeout' : 'ocr_engine_failed',
              reason: sanitizeError(firstAttemptErr),
            });
          }
        }
      } catch (pageErr: any) {
        const isTimeout = pageErr instanceof SubprocessExecError && pageErr.kind === 'timeout';
        failedPages.push({
          pageNumber: pageNum,
          errorCode: isTimeout ? 'ocr_timeout' : 'ocr_render_failed',
          reason: sanitizeError(pageErr),
        });
      } finally {
        try {
          fs.rmSync(pngPath, { force: true });
          if (resolvedPng !== pngPath) fs.rmSync(resolvedPng, { force: true });
          fs.rmSync(tsvPath, { force: true });
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
    releaseSemaphore();
  }

  // Assemble unified page list without duplicating native & OCR content!
  const finalPages: OcrPageResult[] = [];
  const finalNativePages: number[] = [];
  const finalOcrPages: number[] = [];
  const finalEmptyPages: number[] = [];
  const pageConfidences: number[] = [];

  for (const np of nativePages) {
    const ocrData = ocrByPage.get(np.pageNumber);
    if (ocrMode === 'force' && ocrData) {
      finalOcrPages.push(np.pageNumber);
      if (ocrData.confidence !== undefined) pageConfidences.push(ocrData.confidence);
      const nonWs = ocrData.pageText.replace(/\s+/g, '').length;
      if (nonWs < 5) finalEmptyPages.push(np.pageNumber);
      finalPages.push({
        pageNumber: np.pageNumber,
        textSource: nonWs > 0 ? 'ocr' : 'none',
        charCount: ocrData.pageText.length,
        ...(ocrData.confidence !== undefined ? { confidence: ocrData.confidence } : {}),
        width: ocrData.pageWidth,
        height: ocrData.pageHeight,
        unit: 'px',
        text: ocrData.pageText,
        blocks: ocrData.blocks,
      });
    } else if (ocrMode === 'auto' && np.nonWsCount < 20 && ocrData) {
      finalOcrPages.push(np.pageNumber);
      if (ocrData.confidence !== undefined) pageConfidences.push(ocrData.confidence);
      const nonWs = ocrData.pageText.replace(/\s+/g, '').length;
      if (nonWs < 5) finalEmptyPages.push(np.pageNumber);
      finalPages.push({
        pageNumber: np.pageNumber,
        textSource: nonWs > 0 ? 'ocr' : 'none',
        charCount: ocrData.pageText.length,
        ...(ocrData.confidence !== undefined ? { confidence: ocrData.confidence } : {}),
        width: ocrData.pageWidth,
        height: ocrData.pageHeight,
        unit: 'px',
        text: ocrData.pageText,
        blocks: ocrData.blocks,
      });
    } else {
      // Native page (or page where OCR was skipped/failed)
      if (np.nonWsCount >= 5) {
        finalNativePages.push(np.pageNumber);
      } else {
        finalEmptyPages.push(np.pageNumber);
      }
      finalPages.push({
        pageNumber: np.pageNumber,
        textSource: np.nonWsCount >= 5 ? 'native' : 'none',
        charCount: np.pageText.length,
        width: roundCoord(np.widthPt),
        height: roundCoord(np.heightPt),
        unit: 'pt',
        text: np.pageText,
        blocks: np.blocks,
      });
    }
  }

  const ocrConfidence =
    pageConfidences.length > 0
      ? Math.round(
          (pageConfidences.reduce((acc, v) => acc + v, 0) / pageConfidences.length) * 10
        ) / 10
      : undefined;

  // Cache only when there were no transient page failures
  if (failedPages.length === 0) {
    if (ocrResultCache.size >= 64) {
      const oldestKey = ocrResultCache.keys().next().value;
      if (oldestKey) ocrResultCache.delete(oldestKey);
    }
    ocrResultCache.set(cacheKey, {
      expiresAtMs: Date.now() + 30 * 60 * 1000,
      rawFullPages: finalPages,
      pageCount: numPages,
      pagesWithTextCount: finalPages.filter((p) => p.text.replace(/\s+/g, '').length >= 5).length,
      nativeTextPageNumbers: finalNativePages,
      ocrProcessedPageNumbers: finalOcrPages,
      emptyPageNumbers: finalEmptyPages,
      unprocessedPages,
      failedPages,
      ocrLanguagesUsed: langsToUse,
      ocrConfidence,
      ocrBudgetMs: effectiveDocBudgetMs,
      ocrPageTimeoutMs: pageTimeoutMs,
      ocrRetryCount: retryCount,
      ocrFallbackUsed: fallbackUsed,
    });
  }

  return buildOutcomeFromComputedPages({
    ocrMode,
    numPages,
    finalPages,
    nativeTextPageNumbers: finalNativePages,
    ocrProcessedPageNumbers: finalOcrPages,
    emptyPageNumbers: finalEmptyPages,
    unprocessedPages,
    failedPages,
    ocrLanguagesUsed: langsToUse,
    ocrConfidence,
    ocrBudgetMs: effectiveDocBudgetMs,
    ocrPageTimeoutMs: pageTimeoutMs,
    ocrRetryCount: retryCount,
    ocrFallbackUsed: fallbackUsed,
    maxChars,
  });
}

function buildOutcomeFromComputedPages(params: {
  ocrMode: OcrMode;
  numPages: number;
  finalPages: OcrPageResult[];
  nativeTextPageNumbers: number[];
  ocrProcessedPageNumbers: number[];
  emptyPageNumbers: number[];
  unprocessedPages: OcrUnprocessedPage[];
  failedPages: OcrPageFailure[];
  ocrLanguagesUsed: string[];
  ocrConfidence?: number;
  ocrBudgetMs?: number;
  ocrPageTimeoutMs?: number;
  ocrRetryCount?: number;
  ocrFallbackUsed?: boolean;
  maxChars: number;
}): OcrDocumentOutcome {
  const {
    ocrMode,
    numPages,
    finalPages,
    nativeTextPageNumbers,
    ocrProcessedPageNumbers,
    emptyPageNumbers,
    unprocessedPages,
    failedPages,
    ocrLanguagesUsed,
    ocrConfidence,
    ocrBudgetMs,
    ocrPageTimeoutMs,
    ocrRetryCount,
    ocrFallbackUsed,
    maxChars,
  } = params;

  const { extractedText, truncated } = formatPagesIntoBoundedText(finalPages, numPages, maxChars);
  const meaningfulTotal = extractedText.replace(/\s+/g, '').length;
  const pagesWithTextCount = finalPages.filter(
    (p) => p.text.replace(/\s+/g, '').length >= 5
  ).length;

  const hasNative = finalPages.some(
    (p) => p.textSource === 'native' && p.text.replace(/\s+/g, '').length >= 5
  );
  const hasOcr = finalPages.some(
    (p) => p.textSource === 'ocr' && p.text.replace(/\s+/g, '').length >= 5
  );

  const extractionMethod: OcrDocumentOutcome['extractionMethod'] =
    hasNative && hasOcr
      ? 'hybrid_pdf_ocr'
      : hasOcr
        ? 'ocr_pdf'
        : hasNative
          ? 'native_pdf'
          : 'none';

  const hasFailures = failedPages.length > 0;
  const hasUnprocessed = unprocessedPages.length > 0;

  if (meaningfulTotal < 10) {
    if (hasFailures) {
      return {
        extractionStatus: 'downloaded_ocr_error',
        extractionMethod: 'none',
        textExtractionComplete: false,
        ocrStatus: 'failed',
        ocrMode,
        ocrLanguagesUsed,
        ...(ocrBudgetMs ? { ocrBudgetMs } : {}),
        ...(ocrPageTimeoutMs ? { ocrPageTimeoutMs } : {}),
        ...(ocrRetryCount ? { ocrRetryCount } : {}),
        ...(ocrFallbackUsed ? { ocrFallbackUsed } : {}),
        needsOcr: true,
        pageCount: numPages,
        pagesWithTextCount,
        nativeTextPageNumbers,
        ocrProcessedPageNumbers,
        emptyPageNumbers,
        ...(hasUnprocessed ? { unprocessedPages } : {}),
        failedPages,
        ...(ocrConfidence !== undefined ? { ocrConfidence } : {}),
        pages: finalPages,
        ocrError: `Falha ao executar OCR em ${failedPages.length} página(s): ${failedPages
          .map((f) => `p.${f.pageNumber} (${f.errorCode}: ${f.reason})`)
          .join('; ')}. Falha de OCR NÃO implica documento vazio; o PDF original continua disponível em downloadUrl/resourceUri.`,
        note: `OCR falhou em ${failedPages.length} página(s). O PDF original segue preservado em downloadUrl/resourceUri.`,
      };
    }

    return {
      extractionStatus: 'downloaded_ocr_no_text',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'completed_no_text',
      ocrMode,
      ocrLanguagesUsed,
      ...(ocrBudgetMs ? { ocrBudgetMs } : {}),
      ...(ocrPageTimeoutMs ? { ocrPageTimeoutMs } : {}),
      ...(ocrRetryCount ? { ocrRetryCount } : {}),
      ...(ocrFallbackUsed ? { ocrFallbackUsed } : {}),
      needsOcr: hasUnprocessed,
      pageCount: numPages,
      pagesWithTextCount,
      nativeTextPageNumbers,
      ocrProcessedPageNumbers,
      emptyPageNumbers,
      ...(hasUnprocessed ? { unprocessedPages } : {}),
      ...(ocrConfidence !== undefined ? { ocrConfidence } : {}),
      extractedText: extractedText || undefined,
      pages: finalPages,
      note: `OCR executado localmente em ${ocrProcessedPageNumbers.length} página(s), porém nenhum texto legível suficiente foi reconhecido (documento em branco, caligrafia ilegível ou diagrama puramente gráfico). O PDF original permanece disponível via downloadUrl/resourceUri.`,
    };
  }

  const textExtractionComplete = !hasFailures && !hasUnprocessed;

  return {
    extractionStatus: 'downloaded_with_text',
    extractionMethod,
    textExtractionComplete,
    ocrStatus: hasFailures ? 'partial_failure' : 'completed',
    ocrMode,
    ocrLanguagesUsed,
    ...(ocrBudgetMs ? { ocrBudgetMs } : {}),
    ...(ocrPageTimeoutMs ? { ocrPageTimeoutMs } : {}),
    ...(ocrRetryCount ? { ocrRetryCount } : {}),
    ...(ocrFallbackUsed ? { ocrFallbackUsed } : {}),
    needsOcr: hasFailures || hasUnprocessed,
    pageCount: numPages,
    pagesWithTextCount,
    nativeTextPageNumbers,
    ocrProcessedPageNumbers,
    ...(emptyPageNumbers.length > 0 ? { emptyPageNumbers } : {}),
    ...(hasUnprocessed ? { unprocessedPages } : {}),
    ...(hasFailures ? { failedPages } : {}),
    ...(ocrConfidence !== undefined ? { ocrConfidence } : {}),
    extractedText,
    truncated,
    pages: finalPages,
    ...(hasFailures
      ? {
          ocrError: `OCR concluído parcialmente: ${failedPages.length} página(s) falharam (${failedPages
            .map((f) => `p.${f.pageNumber}: ${f.errorCode}`)
            .join(', ')}).`,
        }
      : {}),
  };
}

export async function extractImageWithOcr(params: {
  diskPath: string;
  maxChars: number;
  ocrMode: OcrMode;
  ocrLanguages?: string[];
  settings: OcrConfigSettings;
  sanitizeError: (err: unknown) => string;
}): Promise<OcrDocumentOutcome> {
  const { diskPath, maxChars, ocrMode, settings, sanitizeError } = params;

  if (ocrMode === 'off') {
    return {
      extractionStatus: 'downloaded_needs_ocr',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'not_requested',
      ocrMode: 'off',
      needsOcr: true,
      note: 'Arquivo de imagem baixado e preservado. Use ocrMode="auto" para OCR local no servidor ou downloadUrl para análise visual.',
    };
  }

  const caps = await checkOcrCapabilities(settings);
  if (ocrMode === 'status') {
    return {
      extractionStatus: 'downloaded_needs_ocr',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'diagnostic_only',
      ocrMode: 'status',
      needsOcr: true,
      pageCount: 1,
      pagesWithTextCount: 0,
      emptyPageNumbers: [1],
      note: `Arquivo de imagem requer OCR (${caps.tesseractAvailable ? 'Tesseract disponível' : 'Tesseract indisponível'}).`,
    };
  }

  if (!settings.enabled || !caps.tesseractAvailable || caps.installedLanguages.length === 0) {
    return {
      extractionStatus: 'downloaded_ocr_error',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'unavailable',
      ocrMode,
      needsOcr: true,
      ocrError: 'Tesseract OCR local não está disponível para processar imagem.',
    };
  }

  const langsToUse = resolveRequestedLanguages(
    params.ocrLanguages,
    caps.installedLanguages,
    settings.defaultLanguages
  );

  const releaseSemaphore = await ocrSemaphore.acquire(settings.maxConcurrency);
  const tempRoot = settings.tempBaseDir || path.join(os.tmpdir(), 'ufsc-moodle-mcp-files');
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const jobDir = fs.mkdtempSync(path.join(tempRoot, 'ocr_img_'));

  try {
    const isolatedImg = path.join(jobDir, 'source_img');
    fs.copyFileSync(diskPath, isolatedImg);
    const tsvBase = path.join(jobDir, 'ocr_out');
    const tsvPath = `${tsvBase}.tsv`;

    await runCommandSafe(
      settings.tesseractBin || 'tesseract',
      [isolatedImg, tsvBase, '-l', langsToUse.join('+'), '--psm', '3', 'tsv'],
      settings.timeoutMs,
      jobDir
    );

    const tsvRaw = fs.readFileSync(tsvPath, 'utf8');
    const parsed = parseTesseractTsv(tsvRaw);
    const pageObj: OcrPageResult = {
      pageNumber: 1,
      textSource: parsed.pageText.trim() ? 'ocr' : 'none',
      charCount: parsed.pageText.length,
      ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
      width: parsed.pageWidth,
      height: parsed.pageHeight,
      unit: 'px',
      text: parsed.pageText,
      blocks: parsed.blocks,
    };
    const { extractedText, truncated } = formatPagesIntoBoundedText([pageObj], 1, maxChars);

    if (extractedText.replace(/\s+/g, '').length < 3) {
      return {
        extractionStatus: 'downloaded_ocr_no_text',
        extractionMethod: 'none',
        textExtractionComplete: false,
        ocrStatus: 'completed_no_text',
        ocrMode,
        ocrLanguagesUsed: langsToUse,
        needsOcr: false,
        pageCount: 1,
        pagesWithTextCount: 0,
        ocrProcessedPageNumbers: [1],
        emptyPageNumbers: [1],
        ...(parsed.confidence !== undefined ? { ocrConfidence: parsed.confidence } : {}),
        pages: [pageObj],
      };
    }

    return {
      extractionStatus: 'downloaded_with_text',
      extractionMethod: 'ocr_image',
      textExtractionComplete: true,
      ocrStatus: 'completed',
      ocrMode,
      ocrLanguagesUsed: langsToUse,
      needsOcr: false,
      pageCount: 1,
      pagesWithTextCount: 1,
      ocrProcessedPageNumbers: [1],
      ...(parsed.confidence !== undefined ? { ocrConfidence: parsed.confidence } : {}),
      extractedText,
      truncated,
      pages: [pageObj],
    };
  } catch (err: any) {
    const isTimeout = err instanceof SubprocessExecError && err.kind === 'timeout';
    return {
      extractionStatus: 'downloaded_ocr_error',
      extractionMethod: 'none',
      textExtractionComplete: false,
      ocrStatus: 'failed',
      ocrMode,
      ocrLanguagesUsed: langsToUse,
      needsOcr: true,
      failedPages: [
        {
          pageNumber: 1,
          errorCode: isTimeout ? 'ocr_timeout' : 'ocr_engine_failed',
          reason: sanitizeError(err),
        },
      ],
      ocrError: sanitizeError(err),
    };
  } finally {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    releaseSemaphore();
  }
}
