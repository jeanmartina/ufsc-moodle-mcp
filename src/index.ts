#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadMoodleConfig, MoodleClient } from './moodle.js';
import { createServer } from './server.js';

export { createServer } from './server.js';
export { loadMoodleConfig, MoodleClient } from './moodle.js';
export { TempFileStore, sanitizeFilenames, buildContentDisposition } from './file-store.js';
export { createMoodleHttpServer } from './http-app.js';
export { GroupAuditStore } from './group-audit.js';
export {
  MoodleGroupManager,
  MoodleGroupError,
  getOrCreateGroupManager,
  generateUniqueGroupName,
} from './group-manager.js';
export {
  checkOcrCapabilities,
  extractPdfWithOcr,
  extractImageWithOcr,
  type OcrMode,
  type OcrCapabilities,
  type OcrPageResult,
  type OcrVisualBlock,
} from './ocr.js';
export {
  buildAssignmentConsolidatedData,
  getAssignmentGradingOverview,
  fetchSubmissionComments,
  computeAggregatedGroupGrading,
} from './assignment-resolver.js';
export {
  GradingBatchManager,
  MoodleGradingError,
  getOrCreateGradingBatchManager,
} from './grading-batch.js';

async function main(): Promise<void> {
  const config = loadMoodleConfig();
  const sharedClient = new MoodleClient(config);
  serveStdio(() => createServer(config, sharedClient));
  console.error(`ufsc-moodle-mcp v1.2.1: connected via stdio (site: ${config.siteUrl})`);
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const entryReal = path.resolve(process.argv[1]);
    const selfReal = path.resolve(fileURLToPath(import.meta.url));
    return entryReal === selfReal;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  main().catch((error: unknown) => {
    console.error('ufsc-moodle-mcp: fatal error:', error);
    process.exit(1);
  });
}
