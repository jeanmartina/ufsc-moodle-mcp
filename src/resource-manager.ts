import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MoodleClient, MoodleConfig, redactSecrets, htmlToText } from './moodle.js';
import { MoodleWebSession, extractMoodleFormErrors } from './group-manager.js';

export type MoodleResourceErrorCode =
  | 'auth_failed'
  | 'insufficient_permissions'
  | 'module_not_found'
  | 'not_a_resource'
  | 'filename_mismatch'
  | 'fetch_failed'
  | 'invalid_pdf'
  | 'file_too_large'
  | 'moodle_api_error'
  | 'verification_failed';

export class MoodleResourceError extends Error {
  public readonly code: MoodleResourceErrorCode;
  public readonly details?: Record<string, any>;

  constructor(code: MoodleResourceErrorCode, message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'MoodleResourceError';
    this.code = code;
    this.details = details;
  }
}

export interface ResourceFileInfo {
  filename: string;
  sizeBytes: number;
  mimetype: string;
  fileurl: string;
  timemodified: string;
  sha256?: string;
}

export interface ReplaceCourseResourceFileParams {
  courseId: number;
  courseModuleId: number;
  sourceFileUri?: string;
  sourceBase64?: string;
  sourceFileHeaders?: Record<string, string>;
  expectedCurrentFilename?: string;
  newFilename?: string;
  dryRun?: boolean;
  operationId?: string;
}

export interface VerifyCourseResourceFileParams {
  courseId: number;
  courseModuleId: number;
  expectedFilename?: string;
  expectedSha256?: string;
  expectedSizeBytes?: number;
}

export interface VerifyCourseResourceFileResult {
  verified: boolean;
  courseId: number;
  courseModuleId: number;
  resourceName: string;
  section: number;
  visible: boolean;
  resourceViewUrl: string;
  file: ResourceFileInfo & { sha256: string; isValidPdf: boolean };
  checks: {
    moduleExists: boolean;
    isModResource: boolean;
    filenameMatches: boolean;
    sizeMatches: boolean;
    sha256Matches: boolean;
    pdfIntegrityValid: boolean;
    urlPreserved: boolean;
  };
  failureReasons?: string[];
}

export interface ReplaceCourseResourceFileResult {
  success: boolean;
  dryRun: boolean;
  operationId?: string;
  courseId: number;
  courseModuleId: number;
  resourceName: string;
  resourceViewUrl: string;
  previousFile: ResourceFileInfo;
  newFile: ResourceFileInfo & { sha256: string };
  verification?: VerifyCourseResourceFileResult;
  status: 'completed' | 'dry_run_success' | 'idempotent_replay';
  message: string;
}

/**
 * Validates whether the buffer represents a genuine, uncorrupted, and unencrypted PDF.
 */
export async function validatePdfBuffer(
  buffer: Uint8Array
): Promise<{
  isValid: boolean;
  sha256: string;
  sizeBytes: number;
  pageCount?: number;
  isEncrypted?: boolean;
  error?: string;
}> {
  const sizeBytes = buffer.byteLength;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  if (sizeBytes < 32) {
    return {
      isValid: false,
      sha256: hash,
      sizeBytes,
      isEncrypted: false,
      error: 'O arquivo possui tamanho insuficiente para um PDF válido.',
    };
  }

  // Check magic bytes %PDF-
  const headerSlice = Buffer.from(buffer.slice(0, Math.min(1024, sizeBytes))).toString('latin1');
  if (!headerSlice.includes('%PDF-')) {
    return {
      isValid: false,
      sha256: hash,
      sizeBytes,
      isEncrypted: false,
      error: 'Cabeçalho inválido: ausência da assinatura %PDF- no início do arquivo.',
    };
  }

  // Check %%EOF marker near end of file
  const tailSlice = Buffer.from(buffer.slice(Math.max(0, sizeBytes - 2048))).toString('latin1');
  if (!tailSlice.includes('%%EOF') && !tailSlice.includes('%EOF')) {
    return {
      isValid: false,
      sha256: hash,
      sizeBytes,
      isEncrypted: false,
      error: 'Arquivo PDF truncado: marcador de final de arquivo (%%EOF) ausente.',
    };
  }

  // Check encryption dictionary marker
  const fullHeaderOrTail =
    headerSlice + ' ' + tailSlice + ' ' + Buffer.from(buffer.slice(0, Math.min(8192, sizeBytes))).toString('latin1');
  if (/\/Encrypt\b/i.test(fullHeaderOrTail)) {
    return {
      isValid: false,
      sha256: hash,
      sizeBytes,
      isEncrypted: true,
      error: 'O PDF está protegido por senha/criptografia.',
    };
  }

  // Parse structural integrity using unpdf
  try {
    const { getDocumentProxy } = await import('unpdf');
    const owned = new Uint8Array(buffer.byteLength);
    owned.set(buffer);
    const pdf: any = await getDocumentProxy(owned, {
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    } as any);

    if (!pdf || typeof pdf.numPages !== 'number' || pdf.numPages < 1) {
      return {
        isValid: false,
        sha256: hash,
        sizeBytes,
        isEncrypted: false,
        error: 'PDF sem páginas válidas ou corrompido.',
      };
    }

    return {
      isValid: true,
      sha256: hash,
      sizeBytes,
      pageCount: pdf.numPages,
      isEncrypted: false,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/password|encrypt/i.test(msg)) {
      return {
        isValid: false,
        sha256: hash,
        sizeBytes,
        isEncrypted: true,
        error: 'O PDF está protegido por senha/criptografia.',
      };
    }
    return {
      isValid: false,
      sha256: hash,
      sizeBytes,
      isEncrypted: false,
      error: `Falha na interpretação estrutural do PDF: ${msg}`,
    };
  }
}

/**
 * Resolves source PDF bytes from HTTP/HTTPS URL, Data URI, Base64 string, or Local File URI.
 */
export async function resolveSourceFile(params: {
  sourceFileUri?: string;
  sourceBase64?: string;
  sourceFileHeaders?: Record<string, string>;
  maxBytes?: number;
  newFilename?: string;
}): Promise<{ buffer: Uint8Array; filename?: string; mimeType: string }> {
  const maxBytes = params.maxBytes || 100 * 1024 * 1024; // 100 MB default limit

  // 1. Direct Base64 string
  if (params.sourceBase64) {
    let clean = params.sourceBase64.trim();
    let mimeType = 'application/pdf';
    const match = /^data:([^;]+);base64,(.*)$/is.exec(clean);
    if (match) {
      mimeType = match[1].toLowerCase();
      clean = match[2];
    }
    const buf = Buffer.from(clean, 'base64');
    if (buf.byteLength > maxBytes) {
      throw new MoodleResourceError(
        'file_too_large',
        `O arquivo excede o limite máximo permitido de ${maxBytes} bytes.`
      );
    }
    return { buffer: new Uint8Array(buf), mimeType, filename: params.newFilename };
  }

  const uri = params.sourceFileUri?.trim();
  if (!uri) {
    throw new MoodleResourceError(
      'fetch_failed',
      'Nenhum sourceFileUri ou sourceBase64 fornecido para obter o novo arquivo.'
    );
  }

  // 2. Data URI
  if (uri.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/is.exec(uri);
    if (!match) {
      throw new MoodleResourceError(
        'fetch_failed',
        'Formato de Data URI inválido. Esperado "data:<mime>;base64,<dados>".'
      );
    }
    const mimeType = match[1].toLowerCase();
    const buf = Buffer.from(match[2], 'base64');
    if (buf.byteLength > maxBytes) {
      throw new MoodleResourceError(
        'file_too_large',
        `O arquivo excede o limite máximo permitido de ${maxBytes} bytes.`
      );
    }
    return { buffer: new Uint8Array(buf), mimeType, filename: params.newFilename };
  }

  // 3. HTTP or HTTPS URL (e.g. Google Drive PDF export URL, signed S3/GCS download URL, etc.)
  if (/^https?:\/\//i.test(uri)) {
    try {
      const headers = new Headers(params.sourceFileHeaders);
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'UFSC-Moodle-MCP/1.3 (ResourceUpdater)');
      }

      const res = await fetch(uri, {
        method: 'GET',
        headers,
        redirect: 'follow',
      });

      if (!res.ok) {
        throw new Error(`Servidor remoto respondeu com status HTTP ${res.status} (${res.statusText})`);
      }

      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > maxBytes) {
        throw new MoodleResourceError('file_too_large', `O arquivo baixado excede o limite de ${maxBytes} bytes.`);
      }

      // Try extract filename from Content-Disposition header
      let filename: string | undefined;
      const disposition = res.headers.get('content-disposition');
      if (disposition) {
        const fnMatch = /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i.exec(disposition);
        if (fnMatch) filename = decodeURIComponent(fnMatch[1].trim());
      }
      if (!filename) {
        try {
          const parsedUrl = new URL(uri);
          const base = path.basename(parsedUrl.pathname);
          if (base && base.endsWith('.pdf')) filename = base;
        } catch {
          // Ignore URL parse error
        }
      }

      const mimeType = (res.headers.get('content-type') || 'application/pdf').split(';')[0].trim().toLowerCase();
      return { buffer: new Uint8Array(arrayBuf), filename, mimeType };
    } catch (err: any) {
      if (err instanceof MoodleResourceError) throw err;
      throw new MoodleResourceError('fetch_failed', `Falha ao obter o arquivo da URL indicada (${uri}): ${err.message}`);
    }
  }

  // 4. File URI or local path
  if (uri.startsWith('file://') || uri.startsWith('/')) {
    const filePath = uri.startsWith('file://') ? new URL(uri).pathname : uri;
    if (!fs.existsSync(filePath)) {
      throw new MoodleResourceError('fetch_failed', `Arquivo local não encontrado: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new MoodleResourceError('fetch_failed', `O caminho especificado não é um arquivo regular: ${filePath}`);
    }
    if (stat.size > maxBytes) {
      throw new MoodleResourceError('file_too_large', `O arquivo excede o limite máximo permitido de ${maxBytes} bytes.`);
    }
    const buf = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    return { buffer: new Uint8Array(buf), filename, mimeType: 'application/pdf' };
  }

  throw new MoodleResourceError(
    'fetch_failed',
    `Esquema de URI não suportado: "${uri.slice(0, 30)}...". Suporta http://, https://, data:, file:// ou base64.`
  );
}

const sharedResourceManagers = new WeakMap<MoodleClient, MoodleResourceManager>();

export function getOrCreateResourceManager(
  client: MoodleClient,
  config?: MoodleConfig
): MoodleResourceManager {
  let mgr = sharedResourceManagers.get(client);
  if (!mgr) {
    mgr = new MoodleResourceManager(client, config);
    sharedResourceManagers.set(client, mgr);
  }
  return mgr;
}

export class MoodleResourceManager {
  private readonly client: MoodleClient;
  private readonly config: MoodleConfig;
  public readonly webSession: MoodleWebSession;
  private readonly auditLogPath?: string;
  private readonly idempotencyStore = new Map<string, ReplaceCourseResourceFileResult>();

  constructor(client: MoodleClient, config?: MoodleConfig) {
    this.client = client;
    this.config = config ?? client.getConfig();
    this.webSession = new MoodleWebSession({
      siteUrl: this.config.siteUrl,
      username: this.config.username,
      password: this.config.password,
    });
    this.auditLogPath =
      this.config.resourceAuditLogPath ||
      process.env.MOODLE_RESOURCE_AUDIT_LOG_PATH?.trim() ||
      (fs.existsSync('/config') ? '/config/resource-audit.jsonl' : undefined);
  }

  /**
   * Validates whether the authenticated user holds editing teacher / manager permissions in the course.
   */
  public async checkCourseEditingPermission(courseId: number): Promise<{
    userId: number;
    username: string;
    fullname: string;
    roles: string[];
  }> {
    const siteInfo = await this.client.getSiteInfo();
    const userId = siteInfo.userid;

    // Check course enrollment
    let userRoles: string[] = [];
    try {
      const rawUsers = await this.client.call<any[]>('core_enrol_get_enrolled_users', {
        courseid: courseId,
      });
      const me = (rawUsers || []).find((u: any) => Number(u.id) === userId);
      if (me && Array.isArray(me.roles)) {
        userRoles = me.roles.map((r: any) => String(r.shortname || r.name || '').toLowerCase());
      }
    } catch (err: any) {
      // If enrolled users cannot be listed, check if site admin
    }

    const editingRoles = ['editingteacher', 'teacher', 'manager', 'coursecreator', 'admin'];
    const hasEditingRole = userRoles.some((r) => editingRoles.includes(r));

    if (!hasEditingRole && userRoles.length > 0) {
      throw new MoodleResourceError(
        'insufficient_permissions',
        `Permissão insuficiente: o usuário autenticado (${siteInfo.username}, ID ${userId}) não possui papel docente com permissão de edição na disciplina ${courseId}. Papéis encontrados: [${userRoles.join(', ')}].`,
        { courseId, userId, userRoles }
      );
    }

    return {
      userId,
      username: siteInfo.username,
      fullname: siteInfo.fullname,
      roles: userRoles,
    };
  }

  /**
   * Finds the target mod_resource module in course contents and extracts its current file metadata.
   */
  public async findModResource(
    courseId: number,
    courseModuleId: number
  ): Promise<{ module: any; currentFile: ResourceFileInfo; section: number }> {
    const sections = await this.client.call<any[]>('core_course_get_contents', {
      courseid: courseId,
    });

    let targetModule: any;
    let sectionNum = 0;

    for (const sec of sections || []) {
      for (const mod of sec.modules || []) {
        if (Number(mod.id) === courseModuleId) {
          targetModule = mod;
          sectionNum = Number(sec.section ?? 0);
          break;
        }
      }
      if (targetModule) break;
    }

    if (!targetModule) {
      throw new MoodleResourceError(
        'module_not_found',
        `Módulo com ID ${courseModuleId} não foi encontrado na disciplina ${courseId}.`,
        { courseId, courseModuleId }
      );
    }

    if (String(targetModule.modname || '').toLowerCase() !== 'resource') {
      throw new MoodleResourceError(
        'not_a_resource',
        `O módulo ${courseModuleId} é do tipo "${targetModule.modname}", mas a operação exige exclusivamente o tipo "resource" (mod_resource).`,
        { courseId, courseModuleId, modname: targetModule.modname }
      );
    }

    const files = (targetModule.contents || []).filter((c: any) => c.type === 'file');
    if (files.length === 0) {
      throw new MoodleResourceError(
        'moodle_api_error',
        `O recurso ${courseModuleId} não possui arquivos associados no Moodle.`,
        { courseId, courseModuleId }
      );
    }

    const f = files[0];
    const currentFile: ResourceFileInfo = {
      filename: String(f.filename || 'recurso.pdf'),
      sizeBytes: Number(f.filesize || 0),
      mimetype: String(f.mimetype || 'application/pdf'),
      fileurl: String(f.fileurl || ''),
      timemodified: String(f.timemodified || ''),
    };

    return { module: targetModule, currentFile, section: sectionNum };
  }

  /**
   * Verifies the course resource file live on Moodle without trusting intermediate write states.
   */
  public async verifyCourseResourceFile(
    params: VerifyCourseResourceFileParams
  ): Promise<VerifyCourseResourceFileResult> {
    const { module, currentFile, section } = await this.findModResource(
      params.courseId,
      params.courseModuleId
    );

    // Download current file bytes using Moodle authentication to calculate genuine SHA-256
    let actualSha256 = '';
    let isValidPdf = false;
    let downloadError: string | undefined;

    try {
      const outcome = await this.client.downloadFile(currentFile.fileurl);
      if (outcome.ok) {
        const fullBuffer = fs.readFileSync(outcome.entry.diskPath);
        const val = await validatePdfBuffer(new Uint8Array(fullBuffer));
        actualSha256 = val.sha256;
        isValidPdf = val.isValid;
        if (!val.isValid) downloadError = val.error;
      } else {
        downloadError = outcome.errorMessage;
      }
    } catch (err: any) {
      downloadError = err.message;
    }

    const checks = {
      moduleExists: Boolean(module),
      isModResource: String(module?.modname).toLowerCase() === 'resource',
      filenameMatches: params.expectedFilename
        ? currentFile.filename.trim().toLowerCase() === params.expectedFilename.trim().toLowerCase()
        : true,
      sizeMatches: params.expectedSizeBytes ? currentFile.sizeBytes === params.expectedSizeBytes : true,
      sha256Matches: params.expectedSha256
        ? actualSha256.toLowerCase() === params.expectedSha256.toLowerCase()
        : true,
      pdfIntegrityValid: isValidPdf,
      urlPreserved: module?.url
        ? String(module.url).includes(`id=${params.courseModuleId}`)
        : true,
    };

    const failureReasons: string[] = [];
    if (!checks.moduleExists) failureReasons.push('Módulo não encontrado no curso');
    if (!checks.isModResource) failureReasons.push('Módulo não é do tipo mod_resource');
    if (!checks.filenameMatches) {
      failureReasons.push(`Nome do arquivo ("${currentFile.filename}") diverge do esperado ("${params.expectedFilename}")`);
    }
    if (!checks.sizeMatches) {
      failureReasons.push(`Tamanho do arquivo (${currentFile.sizeBytes} bytes) diverge do esperado (${params.expectedSizeBytes} bytes)`);
    }
    if (!checks.sha256Matches) {
      failureReasons.push(`Hash SHA-256 (${actualSha256}) diverge do esperado (${params.expectedSha256})`);
    }
    if (!checks.pdfIntegrityValid) {
      failureReasons.push(`Integridade do PDF inválida: ${downloadError || 'erro desconhecido'}`);
    }
    if (!checks.urlPreserved) failureReasons.push('URL pública do recurso não foi preservada');

    const verified = Object.values(checks).every(Boolean);

    return {
      verified,
      courseId: params.courseId,
      courseModuleId: params.courseModuleId,
      resourceName: String(module.name || ''),
      section,
      visible: Boolean(module.visible !== false && module.visible !== 0),
      resourceViewUrl: String(module.url || `${this.config.siteUrl}/mod/resource/view.php?id=${params.courseModuleId}`),
      file: {
        ...currentFile,
        sha256: actualSha256,
        isValidPdf,
      },
      checks,
      failureReasons: failureReasons.length > 0 ? failureReasons : undefined,
    };
  }

  /**
   * Replaces an existing course resource PDF with a new file.
   */
  public async replaceCourseResourceFile(
    params: ReplaceCourseResourceFileParams
  ): Promise<ReplaceCourseResourceFileResult> {
    const dryRun = Boolean(params.dryRun);

    // 1. Idempotency Check
    if (params.operationId && this.idempotencyStore.has(params.operationId)) {
      const cached = this.idempotencyStore.get(params.operationId)!;
      // Re-verify if current file still matches
      try {
        const check = await this.verifyCourseResourceFile({
          courseId: params.courseId,
          courseModuleId: params.courseModuleId,
          expectedSha256: cached.newFile.sha256,
        });
        if (check.verified) {
          return {
            ...cached,
            status: 'idempotent_replay',
            message: `Operação ${params.operationId} já executada anteriormente com sucesso. O recurso já contém o arquivo atualizado.`,
          };
        }
      } catch {
        // If re-verify fails, continue execution
      }
    }

    // 2. Validate user permissions in the course
    const actor = await this.checkCourseEditingPermission(params.courseId);

    // 3. Find target resource and inspect current file
    const { module, currentFile } = await this.findModResource(
      params.courseId,
      params.courseModuleId
    );

    // 4. Expected filename check
    if (params.expectedCurrentFilename) {
      const expected = params.expectedCurrentFilename.trim().toLowerCase();
      const current = currentFile.filename.trim().toLowerCase();
      if (expected !== current) {
        throw new MoodleResourceError(
          'filename_mismatch',
          `Proteção contra alteração indevida: o arquivo atual do recurso é "${currentFile.filename}", mas esperava-se "${params.expectedCurrentFilename}".`,
          { expected: params.expectedCurrentFilename, current: currentFile.filename }
        );
      }
    }

    // 5. Obtain and resolve new PDF bytes
    const source = await resolveSourceFile({
      sourceFileUri: params.sourceFileUri,
      sourceBase64: params.sourceBase64,
      sourceFileHeaders: params.sourceFileHeaders,
      maxBytes: this.config.maxDownloadBytes,
    });

    // 6. Validate PDF integrity, magic bytes, structure, and hash
    const pdfValidation = await validatePdfBuffer(source.buffer);
    if (!pdfValidation.isValid) {
      throw new MoodleResourceError(
        'invalid_pdf',
        `O arquivo fornecido não é um PDF válido e íntegro: ${pdfValidation.error}`,
        { error: pdfValidation.error, sha256: pdfValidation.sha256 }
      );
    }

    // Determine target filename (ensure .pdf extension)
    let targetFilename = params.newFilename?.trim() || source.filename || currentFile.filename;
    if (!targetFilename.toLowerCase().endsWith('.pdf')) {
      targetFilename += '.pdf';
    }

    const resourceViewUrl = String(
      module.url || `${this.config.siteUrl}/mod/resource/view.php?id=${params.courseModuleId}`
    );

    const newFileInfo: ResourceFileInfo & { sha256: string } = {
      filename: targetFilename,
      sizeBytes: pdfValidation.sizeBytes,
      mimetype: 'application/pdf',
      fileurl: currentFile.fileurl,
      timemodified: new Date().toISOString(),
      sha256: pdfValidation.sha256,
    };

    // 7. DryRun Early Return
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        operationId: params.operationId,
        courseId: params.courseId,
        courseModuleId: params.courseModuleId,
        resourceName: String(module.name || ''),
        resourceViewUrl,
        previousFile: currentFile,
        newFile: newFileInfo,
        status: 'dry_run_success',
        message:
          `[Dry-Run] Verificações concluídas com sucesso para o recurso "${module.name}" (ID ${params.courseModuleId}). ` +
          `O novo PDF (${targetFilename}, ${pdfValidation.sizeBytes} bytes, SHA-256: ${pdfValidation.sha256.slice(0, 16)}...) ` +
          `é válido e o usuário possui autorização. Nenhuma modificação foi efetuada no Moodle.`,
      };
    }

    // 8. Execute Replacement via Moodle Draft Area & modedit.php Controller
    if (!this.webSession.hasCredentials() && !this.config.token) {
      throw new MoodleResourceError(
        'auth_failed',
        'Credenciais (MOODLE_USERNAME/MOODLE_PASSWORD ou MOODLE_API_TOKEN) não configuradas para executar a substituição no Moodle.'
      );
    }

    // Upload to draft area
    const draft = await this.webSession.uploadDraftFile({
      filename: targetFilename,
      buffer: source.buffer,
      mimeType: 'application/pdf',
      token: this.config.token,
    });

    // Request the official modedit.php form for this resource
    const editPage = await this.webSession.requestPage(
      `/course/modedit.php?update=${params.courseModuleId}`
    );

    if (editPage.status !== 200 || !/name=["']_qf__mod_resource_mod_form["']/i.test(editPage.html)) {
      const errs = extractMoodleFormErrors(editPage.html);
      throw new MoodleResourceError(
        'moodle_api_error',
        `Não foi possível abrir o formulário de edição do recurso /course/modedit.php?update=${params.courseModuleId}: ${errs.join('; ') || 'falha de acesso ou permissão negada'}.`
      );
    }

    // Parse all form elements from the page HTML
    const formFields = new URLSearchParams();
    for (const tag of editPage.html.matchAll(/<input[^>]+>/gi)) {
      const name = tag[0].match(/name=["']([^"']+)["']/i)?.[1];
      const val = tag[0].match(/value=["']([^"']*)["']/i)?.[1] ?? '';
      const type = tag[0].match(/type=["']([^"']+)["']/i)?.[1]?.toLowerCase() || 'text';
      if (!name) continue;

      if (type === 'checkbox' || type === 'radio') {
        if (/\bchecked\b/i.test(tag[0])) {
          formFields.set(name, val || '1');
        }
      } else if (type !== 'submit' && type !== 'button' && type !== 'image') {
        formFields.set(name, val);
      }
    }

    for (const tag of editPage.html.matchAll(/<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
      const name = tag[1];
      const optMatch =
        tag[2].match(/<option[^>]*\bselected\b[^>]*value=["']([^"']*)["']/i) ||
        tag[2].match(/<option[^>]*value=["']([^"']*)["']/i);
      if (optMatch) {
        formFields.set(name, optMatch[1]);
      }
    }

    for (const tag of editPage.html.matchAll(/<textarea[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/textarea>/gi)) {
      formFields.set(tag[1], tag[2]);
    }

    // Replace the files parameter with our newly prepared draft item ID
    formFields.set('files', String(draft.draftItemId));
    formFields.set('submitbutton', 'Save and return to course');

    // Submit POST request to save the updated resource
    const saveRes = await this.webSession.requestPage('/course/modedit.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formFields.toString(),
    });

    if (/name=["']_qf__mod_resource_mod_form["']/i.test(saveRes.html)) {
      const formErrors = extractMoodleFormErrors(saveRes.html);
      throw new MoodleResourceError(
        'moodle_api_error',
        `O formulário do Moodle rejeitou a atualização do recurso: ${formErrors.join('; ') || 'erro de validação ao salvar modedit.php'}.`
      );
    }

    // 9. Perform Independent Verification
    const verification = await this.verifyCourseResourceFile({
      courseId: params.courseId,
      courseModuleId: params.courseModuleId,
      expectedSha256: pdfValidation.sha256,
      expectedSizeBytes: pdfValidation.sizeBytes,
    });

    if (!verification.verified) {
      throw new MoodleResourceError(
        'verification_failed',
        `A gravação no Moodle foi submetida, mas a verificação independente pós-atualização falhou: ${(verification.failureReasons || []).join('; ')}`,
        { verification }
      );
    }

    const result: ReplaceCourseResourceFileResult = {
      success: true,
      dryRun: false,
      operationId: params.operationId,
      courseId: params.courseId,
      courseModuleId: params.courseModuleId,
      resourceName: String(module.name || ''),
      resourceViewUrl,
      previousFile: currentFile,
      newFile: verification.file,
      verification,
      status: 'completed',
      message:
        `Arquivo PDF do recurso "${module.name}" (ID ${params.courseModuleId}) atualizado com sucesso. ` +
        `Novo arquivo: "${verification.file.filename}" (${verification.file.sizeBytes} bytes, SHA-256: ${verification.file.sha256}). ` +
        `Link público preservado e verificado ao vivo no Moodle.`,
    };

    // 10. Audit logging
    this.recordAudit({
      timestamp: new Date().toISOString(),
      operationId: params.operationId,
      actor: { userId: actor.userId, username: actor.username },
      courseId: params.courseId,
      courseModuleId: params.courseModuleId,
      resourceName: module.name,
      previousFile: currentFile,
      newFile: verification.file,
      verified: verification.verified,
      status: 'completed',
    });

    // 11. Record in idempotency cache
    if (params.operationId) {
      this.idempotencyStore.set(params.operationId, result);
    }

    return result;
  }

  private recordAudit(entry: Record<string, any>): void {
    if (!this.auditLogPath) return;
    try {
      const dir = path.dirname(this.auditLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const secrets = [this.config.token, this.config.password, process.env.MCP_AUTH_TOKEN];
      const raw = redactSecrets(JSON.stringify(entry), secrets);
      fs.appendFileSync(this.auditLogPath, raw + '\n', 'utf-8');
    } catch {
      // Audit write failures must not break the main operation
    }
  }
}
