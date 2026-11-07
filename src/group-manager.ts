import {
  GroupAuditStore,
  type GroupAuditEntry,
  type GroupAuditOutcome,
} from './group-audit.js';
import { htmlToText, MoodleClient, redactSecrets } from './moodle.js';

export type GroupErrorCode =
  | 'insufficient_permissions'
  | 'group_not_found'
  | 'group_course_mismatch'
  | 'group_name_conflict'
  | 'invalid_group_name'
  | 'user_not_enrolled'
  | 'user_already_in_another_group'
  | 'max_members_exceeded'
  | 'activity_not_found'
  | 'partial_failure'
  | 'state_confirmation_failed'
  | 'auth_failed'
  | 'moodle_api_error';

export class MoodleGroupError extends Error {
  public readonly code: GroupErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: GroupErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MoodleGroupError';
    this.code = code;
    this.details = details;
  }
}

export interface GroupMemberDetail {
  id: number;
  fullname: string;
  email?: string;
  username?: string;
  roles: string[];
}

export interface CourseGroupSummary {
  id: number;
  courseId: number;
  name: string;
  description: string;
  idnumber: string;
  hasEnrolmentKey: boolean;
  memberCount?: number;
  maxMembers?: number | null;
  availableInActivity?: boolean;
  members?: GroupMemberDetail[];
}

export interface GroupSelectPermissions {
  studentCanJoin: boolean;
  studentCanLeave: boolean;
  studentCanCreate: boolean;
  studentCanSetGroupName: boolean;
  studentCanSetDesc: boolean;
  studentCanSetEnrolmentKey: boolean;
  deleteEmptyGroups: boolean;
  assignTeachers: boolean;
}

export interface GroupSelectConfig {
  cmid: number;
  instanceId: number;
  courseId: number;
  name: string;
  modname: string;
  visible: boolean;
  groupMode: number;
  moduleGroupingId: number;
  targetGroupingId: number;
  targetGroupingName: string;
  minMembers: number;
  maxMembers: number; // 0 means unlimited in mod_groupselect
  perGroupMaxLimits: Record<string, number>;
  timeAvailable: string | null;
  timeDue: string | null;
  isOpenForSelection: boolean;
  availabilityRestrictions: unknown | null;
  permissions: GroupSelectPermissions;
  allowedGroupIds: number[];
  configSource: 'ws_and_modedit' | 'ws_and_view' | 'ws_only';
}

export interface ManageGroupsPermissionStatus {
  userId: number;
  username: string;
  fullname: string;
  hasManageGroups: boolean;
  roles: string[];
  verificationSource: 'moodle_web_capability' | 'moodle_admin_options' | 'course_roles';
}

interface EnrolledCourseUser {
  id: number;
  fullname: string;
  email?: string;
  username?: string;
  roles: string[];
  groups: Array<{ id: number; name: string }>;
}

/**
 * Generates a unique, non-colliding group name based on existing groups in the course.
 * Uses `max(existingNumber) + 1` rather than `groups.length + 1` or gap-filling so deleted
 * group numbers are never improperly reused and existing groups are never overwritten.
 */
export function generateUniqueGroupName(
  existingGroups: Array<{ name: string }>,
  preferredPrefix?: string
): string {
  const existingLower = new Set(existingGroups.map((g) => g.name.trim().toLowerCase()));

  if (preferredPrefix && preferredPrefix.trim()) {
    const rawPrefix = preferredPrefix;
    const escaped = rawPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\s*(\\d+)\\s*$`, 'i');
    let maxNum = 0;
    let padWidth = 0;
    let matchedCount = 0;
    for (const g of existingGroups) {
      const m = re.exec(g.name.trim());
      if (m) {
        matchedCount++;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
        if (m[1].startsWith('0') && m[1].length > padWidth) padWidth = m[1].length;
      }
    }
    const sep = /\s$/.test(rawPrefix) || rawPrefix.endsWith('-') || rawPrefix.endsWith('_') ? '' : ' ';
    let next = matchedCount > 0 ? maxNum + 1 : 1;
    while (true) {
      const numStr = padWidth > 0 ? String(next).padStart(padWidth, '0') : String(next);
      const candidate = `${rawPrefix}${sep}${numStr}`.trim();
      if (!existingLower.has(candidate.toLowerCase())) {
        return candidate;
      }
      next++;
    }
  }

  // Infer dominant prefix from existing numbered groups (e.g. "Grupo 1".."Grupo 9")
  const prefixStats = new Map<
    string,
    { displayPrefix: string; count: number; maxNum: number; padWidth: number }
  >();

  for (const g of existingGroups) {
    const m = /^(.*?)(\d+)\s*$/.exec(g.name.trim());
    if (!m) continue;
    const rawPfx = m[1] || 'Grupo ';
    const normKey = rawPfx.trim().toLowerCase() || 'grupo';
    const num = Number(m[2]);
    if (!Number.isFinite(num)) continue;

    const cur = prefixStats.get(normKey) ?? {
      displayPrefix: rawPfx || 'Grupo ',
      count: 0,
      maxNum: 0,
      padWidth: 0,
    };
    cur.count++;
    if (num > cur.maxNum) cur.maxNum = num;
    if (m[2].startsWith('0') && m[2].length > cur.padWidth) {
      cur.padWidth = m[2].length;
    }
    prefixStats.set(normKey, cur);
  }

  let best = {
    displayPrefix: 'Grupo ',
    count: 0,
    maxNum: 0,
    padWidth: 0,
  };
  for (const stat of prefixStats.values()) {
    if (stat.count > best.count) {
      best = stat;
    }
  }

  let nextNum = best.maxNum + 1;
  while (true) {
    const numStr =
      best.padWidth > 0 ? String(nextNum).padStart(best.padWidth, '0') : String(nextNum);
    const candidate = `${best.displayPrefix}${numStr}`.trim();
    if (!existingLower.has(candidate.toLowerCase())) {
      return candidate;
    }
    nextNum++;
  }
}

/**
 * Maintains an authenticated Moodle web session (supporting both UFSC CAS SSO and
 * standard Moodle login forms) strictly for official Moodle controllers (/group/group.php,
 * /group/members.php, /group/assign.php, /course/modedit.php, /mod/groupselect/view.php)
 * when the external Web Service token (moodle_mobile_app) does not expose write functions.
 */
class MoodleWebSession {
  private readonly siteUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly cookieJar = new Map<string, string>();
  private authenticatedAtMs = 0;

  constructor(params: { siteUrl: string; username?: string; password?: string }) {
    this.siteUrl = params.siteUrl.replace(/\/+$/, '');
    this.username = params.username;
    this.password = params.password;
  }

  public hasCredentials(): boolean {
    return Boolean(this.username && this.password);
  }

  private saveCookies(headers: Headers, urlStr: string): void {
    const host = new URL(urlStr).hostname;
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const firstPart = raw.split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        this.cookieJar.set(`${host}:${name}`, val);
      }
    }
  }

  private buildCookieHeader(urlStr: string): string {
    const host = new URL(urlStr).hostname;
    const pairs: string[] = [];
    for (const [k, v] of this.cookieJar.entries()) {
      if (k.startsWith(`${host}:`)) {
        pairs.push(`${k.slice(host.length + 1)}=${v}`);
      }
    }
    return pairs.join('; ');
  }

  private async fetchFollow(
    initialUrl: string,
    init?: RequestInit
  ): Promise<{ url: string; status: number; html: string }> {
    let curUrl = initialUrl;
    let curInit = init;
    for (let hop = 0; hop < 15; hop++) {
      const headers = new Headers(curInit?.headers);
      const ck = this.buildCookieHeader(curUrl);
      if (ck) headers.set('Cookie', ck);
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'UFSC-Moodle-MCP/1.2');
      }

      const res = await fetch(curUrl, {
        ...curInit,
        headers,
        redirect: 'manual',
      });
      this.saveCookies(res.headers, curUrl);

      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        curUrl = new URL(location, curUrl).href;
        curInit = { method: 'GET' };
        continue;
      }

      const html = await res.text();
      return { url: curUrl, status: res.status, html };
    }
    throw new MoodleGroupError(
      'moodle_api_error',
      'Excesso de redirecionamentos HTTP durante comunicação com o Moodle.'
    );
  }

  private isLoginPage(urlStr: string, html: string): boolean {
    if (urlStr.includes('sistemas.ufsc.br/login') || urlStr.includes('/login/index.php')) {
      return true;
    }
    return /<form[^>]*id=["']fm1["']/i.test(html) || /name=["']logintoken["']/i.test(html);
  }

  public async ensureAuthenticated(force = false): Promise<void> {
    if (!this.username || !this.password) {
      throw new MoodleGroupError(
        'auth_failed',
        'Credenciais MOODLE_USERNAME/MOODLE_PASSWORD não configuradas para executar esta operação via controlador oficial do Moodle (o token moodle_mobile_app da UFSC não expõe escrita direta em core_group_*).'
      );
    }

    if (!force && this.authenticatedAtMs > 0 && Date.now() - this.authenticatedAtMs < 20 * 60_000) {
      return;
    }

    if (force) {
      this.cookieJar.clear();
    }

    const step1 = await this.fetchFollow(`${this.siteUrl}/login/index.php?authCAS=CAS`);

    // Case 1: Redirected to UFSC CAS SSO login form (<form id="fm1">)
    if (step1.url.includes('sistemas.ufsc.br') || /<form[^>]*id=["']fm1["']/i.test(step1.html)) {
      const formFields: Record<string, string> = {};
      for (const m of step1.html.matchAll(/<input[^>]+>/gi)) {
        const nm = /name=["']([^"']+)["']/i.exec(m[0]);
        const vl = /value=["']([^"']*)["']/i.exec(m[0]);
        if (nm) formFields[nm[1]] = vl ? vl[1] : '';
      }
      formFields.username = this.username;
      formFields.password = this.password;
      if (!formFields._eventId) formFields._eventId = 'submit';

      const actMatch = /<form[^>]*id=["']fm1["'][^>]*action=["']([^"']+)["']/i.exec(step1.html);
      const postUrl = actMatch
        ? new URL(actMatch[1].replace(/&amp;/g, '&'), step1.url).href
        : step1.url;

      const step2 = await this.fetchFollow(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formFields).toString(),
      });

      if (this.isLoginPage(step2.url, step2.html)) {
        throw new MoodleGroupError(
          'auth_failed',
          'Falha na autenticação CAS SSO no Moodle (verifique usuário e senha).'
        );
      }
      this.authenticatedAtMs = Date.now();
      return;
    }

    // Case 2: Standard Moodle login page (/login/index.php with optional logintoken)
    if (step1.url.includes('/login/index.php') || /name=["']password["']/i.test(step1.html)) {
      const formFields: Record<string, string> = {
        username: this.username,
        password: this.password,
      };
      const loginToken = /<input[^>]*name=["']logintoken["'][^>]*value=["']([^"']+)["']/i.exec(
        step1.html
      );
      if (loginToken?.[1]) {
        formFields.logintoken = loginToken[1];
      }
      const actMatch = /<form[^>]*action=["']([^"']*\/login\/index\.php[^"']*)["']/i.exec(
        step1.html
      );
      const postUrl = actMatch
        ? new URL(actMatch[1].replace(/&amp;/g, '&'), step1.url).href
        : `${this.siteUrl}/login/index.php`;

      const step2 = await this.fetchFollow(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formFields).toString(),
      });

      if (this.isLoginPage(step2.url, step2.html)) {
        throw new MoodleGroupError(
          'auth_failed',
          'Falha na autenticação web no Moodle (usuário/senha rejeitados).'
        );
      }
      this.authenticatedAtMs = Date.now();
      return;
    }

    // Already logged in
    this.authenticatedAtMs = Date.now();
  }

  public async requestPage(
    pathOrUrl: string,
    init?: RequestInit,
    allowReauth = true
  ): Promise<{ url: string; status: number; html: string }> {
    await this.ensureAuthenticated(false);
    const fullUrl = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.siteUrl}/${pathOrUrl.replace(/^\/+/, '')}`;
    const res = await this.fetchFollow(fullUrl, init);
    if (allowReauth && this.isLoginPage(res.url, res.html)) {
      await this.ensureAuthenticated(true);
      return this.fetchFollow(fullUrl, init);
    }
    return res;
  }
}

function parseSelectedOption(
  html: string,
  selectName: string
): { value: string; label: string } | undefined {
  const escaped = selectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selRe = new RegExp(`<select[^>]*name=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i');
  const match = selRe.exec(html);
  if (!match) return undefined;
  const body = match[1];
  for (const opt of body.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const attrs = opt[1];
    if (/\bselected\b/i.test(attrs)) {
      const val = /value=["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      return { value: val, label: htmlToText(opt[2]).trim() };
    }
  }
  return undefined;
}

function parseInputValue(html: string, inputName: string): string | undefined {
  const escaped = inputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<input[^>]*name=["']${escaped}["'][^>]*>`, 'gi');
  let lastVal: string | undefined;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    const val = /value=["']([^"']*)["']/i.exec(tag)?.[1];
    if (val !== undefined) lastVal = val;
  }
  return lastVal;
}

function parseCheckboxChecked(html: string, inputName: string, defaultValue = false): boolean {
  const escaped = inputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `<input[^>]*type=["']checkbox["'][^>]*name=["']${escaped}["'][^>]*>|<input[^>]*name=["']${escaped}["'][^>]*type=["']checkbox["'][^>]*>`,
    'i'
  );
  const m = re.exec(html);
  if (!m) return defaultValue;
  return /\bchecked\b/i.test(m[0]);
}

function parseMoodleDateTimeSelector(html: string, prefix: string): string | null {
  const enabled = parseCheckboxChecked(html, `${prefix}[enabled]`, false);
  if (!enabled) return null;
  const year = Number(parseSelectedOption(html, `${prefix}[year]`)?.value);
  const month = Number(parseSelectedOption(html, `${prefix}[month]`)?.value);
  const day = Number(parseSelectedOption(html, `${prefix}[day]`)?.value);
  const hour = Number(parseSelectedOption(html, `${prefix}[hour]`)?.value ?? 0);
  const minute = Number(parseSelectedOption(html, `${prefix}[minute]`)?.value ?? 0);
  if (!year || !month || !day) return null;
  // Interpret in local server time / ISO representation
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;
}

function extractMoodleFormErrors(html: string): string[] {
  const errs: string[] = [];
  for (const m of html.matchAll(
    /<(?:div|span)[^>]*(?:id=["']id_error_[^"']+["']|class=["'][^"']*(?:errormessage|invalid-feedback)[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|span)>/gi
  )) {
    const txt = htmlToText(m[1]).trim();
    if (txt && !errs.includes(txt)) {
      errs.push(txt);
    }
  }
  return errs;
}

const sharedManagers = new WeakMap<MoodleClient, MoodleGroupManager>();

export function getOrCreateGroupManager(client: MoodleClient): MoodleGroupManager {
  let mgr = sharedManagers.get(client);
  if (!mgr) {
    mgr = new MoodleGroupManager(client);
    sharedManagers.set(client, mgr);
  }
  return mgr;
}

export class MoodleGroupManager {
  private readonly client: MoodleClient;
  private readonly webSession: MoodleWebSession;
  public readonly auditStore: GroupAuditStore;

  constructor(client: MoodleClient, auditStore?: GroupAuditStore) {
    this.client = client;
    const cfg = client.getConfig();
    this.webSession = new MoodleWebSession({
      siteUrl: cfg.siteUrl,
      username: cfg.username,
      password: cfg.password,
    });
    this.auditStore =
      auditStore ??
      new GroupAuditStore({
        auditLogPath: cfg.auditLogPath,
        fallbackDir: client.fileStore.getBaseDir(),
        secrets: [cfg.token, cfg.password],
      });
  }

  private async getActorInfo(): Promise<{ userId: number; username: string; fullname: string }> {
    const info = await this.client.getSiteInfo();
    return {
      userId: info.userid,
      username: info.username,
      fullname: info.fullname,
    };
  }

  /**
   * Fetches live (uncached) enrolled users in a course.
   */
  private async fetchLiveEnrolledUsers(courseId: number): Promise<Map<number, EnrolledCourseUser>> {
    this.client.invalidateCourseParticipantsCache(courseId);
    const rawUsers = await this.client.call<any[]>('core_enrol_get_enrolled_users', {
      courseid: courseId,
    });
    const map = new Map<number, EnrolledCourseUser>();
    for (const u of rawUsers || []) {
      const uid = Number(u.id);
      map.set(uid, {
        id: uid,
        fullname: String(u.fullname || ''),
        email: u.email ? String(u.email) : undefined,
        username: u.username ? String(u.username) : undefined,
        roles: (u.roles || []).map((r: any) => String(r.shortname || r.name || '')),
        groups: (u.groups || []).map((g: any) => ({
          id: Number(g.id),
          name: String(g.name || `Grupo ${g.id}`),
        })),
      });
    }
    return map;
  }

  /**
   * Validates whether the authenticated Moodle account holds `moodle/course:managegroups`
   * in `courseId`. Throws `MoodleGroupError('insufficient_permissions')` when `requireManage` is true.
   */
  public async checkManageGroupsPermission(
    courseId: number,
    requireManage = true
  ): Promise<ManageGroupsPermissionStatus> {
    const actor = await this.getActorInfo();
    let roles: string[] = [];
    try {
      const users = await this.fetchLiveEnrolledUsers(courseId);
      roles = users.get(actor.userId)?.roles ?? [];
    } catch {
      // May still be a site-wide manager not directly enrolled
    }

    const teacherOrManagerRoles = new Set([
      'editingteacher',
      'teacher',
      'manager',
      'coursecreator',
    ]);
    const hasTeacherRole = roles.some((r) => teacherOrManagerRoles.has(r.toLowerCase()));

    // 1. Check Moodle's course administration options via WS if available
    let adminUpdateAllowed: boolean | undefined;
    if (await this.client.hasWsFunction('core_course_get_user_administration_options')) {
      try {
        const adm = await this.client.call<any>('core_course_get_user_administration_options', {
          courseids: [courseId],
        });
        const opts: Array<{ name: string; available: boolean }> =
          adm?.courses?.[0]?.options || [];
        const updateOpt = opts.find((o) => o.name === 'update' || o.name === 'roles');
        if (updateOpt !== undefined) {
          adminUpdateAllowed = Boolean(updateOpt.available);
        }
      } catch {
        // ignore if unavailable
      }
    }

    // 2. If web controller will be used and credentials exist, verify Moodle's authoritative
    //    `require_capability('moodle/course:managegroups', $context)` on /group/group.php
    const hasWsCreate = await this.client.hasWsFunction('core_group_create_groups');
    if (!hasWsCreate && this.webSession.hasCredentials()) {
      const page = await this.webSession.requestPage(`/group/group.php?courseid=${courseId}`);
      const hasGroupForm = /name=["']_qf__group_form["']/i.test(page.html);
      if (!hasGroupForm) {
        if (requireManage) {
          throw new MoodleGroupError(
            'insufficient_permissions',
            `Permissão insuficiente: a conta autenticada (${actor.username}, userId=${actor.userId}) não possui moodle/course:managegroups na disciplina ${courseId}.`,
            { courseId, userId: actor.userId, roles }
          );
        }
        return {
          ...actor,
          hasManageGroups: false,
          roles,
          verificationSource: 'moodle_web_capability',
        };
      }
      return {
        ...actor,
        hasManageGroups: true,
        roles,
        verificationSource: 'moodle_web_capability',
      };
    }

    const hasManageGroups =
      adminUpdateAllowed !== undefined ? adminUpdateAllowed || hasTeacherRole : hasTeacherRole;

    if (!hasManageGroups && requireManage) {
      throw new MoodleGroupError(
        'insufficient_permissions',
        `Permissão insuficiente: a conta autenticada (${actor.username}, userId=${actor.userId}) não possui moodle/course:managegroups na disciplina ${courseId}.`,
        { courseId, userId: actor.userId, roles }
      );
    }

    return {
      ...actor,
      hasManageGroups,
      roles,
      verificationSource:
        adminUpdateAllowed !== undefined ? 'moodle_admin_options' : 'course_roles',
    };
  }

  /**
   * Inspects a `mod_groupselect` course module (`cmid`), returning associated groupings,
   * min/max participant limits, enrollment/selection dates, and student group-creation rules.
   */
  public async inspectGroupSelectActivity(
    cmid: number,
    expectedCourseId?: number
  ): Promise<GroupSelectConfig> {
    let cmRes: any;
    try {
      cmRes = await this.client.call<any>('core_course_get_course_module', { cmid });
    } catch (err: any) {
      throw new MoodleGroupError(
        'activity_not_found',
        `Atividade inexistente ou inacessível no Moodle (cmid=${cmid}): ${this.client.sanitizeErrorMessage(err)}`,
        { cmid }
      );
    }

    const cm = cmRes?.cm;
    if (!cm) {
      throw new MoodleGroupError(
        'activity_not_found',
        `Módulo de curso cmid=${cmid} não encontrado no Moodle.`,
        { cmid }
      );
    }

    const courseId = Number(cm.course);
    if (expectedCourseId !== undefined && courseId !== expectedCourseId) {
      throw new MoodleGroupError(
        'activity_not_found',
        `O módulo cmid=${cmid} pertence à disciplina ${courseId}, não à disciplina informada (${expectedCourseId}).`,
        { cmid, activityCourseId: courseId, expectedCourseId }
      );
    }

    let allowedGroupIds: number[] = [];
    try {
      const allowed = await this.client.call<any>('core_group_get_activity_allowed_groups', {
        cmid,
      });
      allowedGroupIds = (allowed?.groups || []).map((g: any) => Number(g.id));
    } catch {
      // Fallback populated later if needed
    }

    let availabilityRestrictions: unknown | null = null;
    if (cm.availability) {
      try {
        availabilityRestrictions =
          typeof cm.availability === 'string' ? JSON.parse(cm.availability) : cm.availability;
      } catch {
        availabilityRestrictions = cm.availability;
      }
    }

    let targetGroupingId = Number(cm.groupingid || 0);
    let targetGroupingName = targetGroupingId === 0 ? 'Todos os grupos' : `Agrupamento ${targetGroupingId}`;
    let minMembers = 0;
    let maxMembers = 0;
    const perGroupMaxLimits: Record<string, number> = {};
    let timeAvailable: string | null = null;
    let timeDue: string | null = null;
    let configSource: GroupSelectConfig['configSource'] = 'ws_only';

    const permissions: GroupSelectPermissions = {
      studentCanJoin: true,
      studentCanLeave: true,
      studentCanCreate: false,
      studentCanSetGroupName: false,
      studentCanSetDesc: false,
      studentCanSetEnrolmentKey: false,
      deleteEmptyGroups: false,
      assignTeachers: false,
    };

    if (this.webSession.hasCredentials()) {
      // 1. Read exact configuration from modedit.php if allowed
      try {
        const editPage = await this.webSession.requestPage(`/course/modedit.php?update=${cmid}`);
        if (editPage.status === 200 && /name=["']maxmembers["']/i.test(editPage.html)) {
          configSource = 'ws_and_modedit';
          const tg = parseSelectedOption(editPage.html, 'targetgrouping');
          if (tg) {
            targetGroupingId = Number(tg.value || 0);
            targetGroupingName = tg.label || targetGroupingName;
          }
          const minRaw = parseInputValue(editPage.html, 'minmembers');
          if (minRaw !== undefined && /^\d+$/.test(minRaw.trim())) {
            minMembers = Number(minRaw.trim());
          }
          const maxRaw = parseInputValue(editPage.html, 'maxmembers');
          if (maxRaw !== undefined && /^\d+$/.test(maxRaw.trim())) {
            maxMembers = Number(maxRaw.trim());
          }
          timeAvailable = parseMoodleDateTimeSelector(editPage.html, 'timeavailable');
          timeDue = parseMoodleDateTimeSelector(editPage.html, 'timedue');

          permissions.studentCanJoin = parseCheckboxChecked(editPage.html, 'studentcanjoin', true);
          permissions.studentCanLeave = parseCheckboxChecked(
            editPage.html,
            'studentcanleave',
            true
          );
          permissions.studentCanCreate = parseCheckboxChecked(
            editPage.html,
            'studentcancreate',
            false
          );
          permissions.studentCanSetGroupName = parseCheckboxChecked(
            editPage.html,
            'studentcansetgroupname',
            false
          );
          permissions.studentCanSetDesc = parseCheckboxChecked(
            editPage.html,
            'studentcansetdesc',
            false
          );
          permissions.studentCanSetEnrolmentKey = parseCheckboxChecked(
            editPage.html,
            'studentcansetenrolmentkey',
            false
          );
          permissions.deleteEmptyGroups = parseCheckboxChecked(
            editPage.html,
            'deleteemptygroups',
            false
          );
          permissions.assignTeachers = parseCheckboxChecked(
            editPage.html,
            'assignteachers',
            false
          );
        }
      } catch {
        // Ignore modedit error and still try view.php
      }

      // 2. Also read view.php?id=<cmid> to capture per-group limits (e.g. "2/3")
      if (String(cm.modname) === 'groupselect') {
        try {
          const viewPage = await this.webSession.requestPage(
            `/mod/groupselect/view.php?id=${cmid}`
          );
          if (viewPage.status === 200) {
            if (configSource === 'ws_only') configSource = 'ws_and_view';
            const cleanHtml = viewPage.html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '');
            for (const tr of cleanHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
              const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
                htmlToText(c[1]).replace(/\s+/g, ' ').trim()
              );
              if (cells.length >= 3) {
                const gName = cells[0];
                const ratioMatch = /^(\d+)\s*\/\s*(\d+)$/.exec(cells[2]);
                if (gName && ratioMatch) {
                  const limit = Number(ratioMatch[2]);
                  perGroupMaxLimits[gName] = limit;
                  if (maxMembers === 0 && limit > 0) {
                    maxMembers = limit;
                  }
                }
              }
            }
          }
        } catch {
          // Ignore view.php error
        }
      }
    }

    // 3. If mod_groupselect restricts to a specific targetGroupingId > 0, resolve the exact
    //    groups assigned to that grouping (via core_group_get_groupings WS or /group/assign.php).
    if (targetGroupingId > 0) {
      if (await this.client.hasWsFunction('core_group_get_groupings')) {
        try {
          const gpRes = await this.client.call<any[]>('core_group_get_groupings', {
            groupingids: [targetGroupingId],
            returngroups: 1,
          });
          const gpGroups = gpRes?.[0]?.groups;
          if (Array.isArray(gpGroups)) {
            allowedGroupIds = gpGroups.map((g: any) => Number(g.id));
          }
        } catch {
          // Keep existing allowedGroupIds fallback
        }
      } else if (this.webSession.hasCredentials()) {
        try {
          const assignPage = await this.webSession.requestPage(
            `/group/assign.php?id=${targetGroupingId}`
          );
          const remSelect = /<select[^>]*name=["']removeselect\[\]["'][^>]*>([\s\S]*?)<\/select>/i.exec(
            assignPage.html
          );
          if (remSelect) {
            const ids: number[] = [];
            for (const opt of remSelect[1].matchAll(/<option[^>]*value=["'](\d+)["'][^>]*>/gi)) {
              ids.push(Number(opt[1]));
            }
            allowedGroupIds = ids;
          }
        } catch {
          // Keep existing allowedGroupIds fallback
        }
      }
    }

    const nowMs = Date.now();
    const openOk = !timeAvailable || Date.parse(timeAvailable) <= nowMs;
    const dueOk = !timeDue || Date.parse(timeDue) >= nowMs;

    return {
      cmid: Number(cm.id),
      instanceId: Number(cm.instance),
      courseId,
      name: String(cm.name || ''),
      modname: String(cm.modname || ''),
      visible: Boolean(cm.visible),
      groupMode: Number(cm.groupmode ?? 0),
      moduleGroupingId: Number(cm.groupingid ?? 0),
      targetGroupingId,
      targetGroupingName,
      minMembers,
      maxMembers,
      perGroupMaxLimits,
      timeAvailable,
      timeDue,
      isOpenForSelection: openOk && dueOk,
      availabilityRestrictions,
      permissions,
      allowedGroupIds,
      configSource,
    };
  }

  /**
   * Discovers all `mod_groupselect` activities in `courseId` (or inspects a single `activityCmid`).
   */
  public async getCourseGroupSelectConfigs(
    courseId: number,
    activityCmid?: number
  ): Promise<GroupSelectConfig[]> {
    if (activityCmid !== undefined) {
      return [await this.inspectGroupSelectActivity(activityCmid, courseId)];
    }

    try {
      const sections = await this.client.call<any[]>('core_course_get_contents', {
        courseid: courseId,
      });
      const cmids: number[] = [];
      for (const sec of sections || []) {
        for (const mod of sec.modules || []) {
          if (mod.modname === 'groupselect' && mod.id) {
            cmids.push(Number(mod.id));
          }
        }
      }
      const configs: GroupSelectConfig[] = [];
      for (const id of cmids) {
        try {
          configs.push(await this.inspectGroupSelectActivity(id, courseId));
        } catch {
          // Ignore inaccessible module
        }
      }
      return configs;
    } catch {
      return [];
    }
  }

  private async fetchRawCourseGroups(courseId: number): Promise<any[]> {
    const raw = await this.client.call<any[]>('core_group_get_course_groups', {
      courseid: courseId,
    });
    return Array.isArray(raw) ? raw : [];
  }

  private async resolveGroupAndCourse(
    groupId: number,
    courseIdHint?: number
  ): Promise<{ group: any; courseId: number }> {
    const effectiveHint = courseIdHint ?? this.client.getDefaultCourseId();
    if (effectiveHint !== undefined) {
      const groups = await this.fetchRawCourseGroups(effectiveHint);
      const found = groups.find((g) => Number(g.id) === groupId);
      if (found) {
        return { group: found, courseId: effectiveHint };
      }

      // Check if groupId actually exists in another course to report exact mismatch vs not_found
      if (courseIdHint !== undefined) {
        const elsewhere = await this.findGroupAcrossEnrolledCourses(groupId);
        if (elsewhere) {
          throw new MoodleGroupError(
            'group_course_mismatch',
            `O grupo groupId=${groupId} ("${elsewhere.group.name}") pertence à disciplina ${elsewhere.courseId}, não à disciplina ${courseIdHint}.`,
            { groupId, actualCourseId: elsewhere.courseId, requestedCourseId: courseIdHint }
          );
        }
      }
      throw new MoodleGroupError(
        'group_not_found',
        `Grupo inexistente (groupId=${groupId}) na disciplina ${effectiveHint}.`,
        { groupId, courseId: effectiveHint }
      );
    }

    const foundAnywhere = await this.findGroupAcrossEnrolledCourses(groupId);
    if (!foundAnywhere) {
      throw new MoodleGroupError(
        'group_not_found',
        `Grupo inexistente no Moodle (groupId=${groupId}).`,
        { groupId }
      );
    }
    return foundAnywhere;
  }

  private async findGroupAcrossEnrolledCourses(
    groupId: number
  ): Promise<{ group: any; courseId: number } | undefined> {
    try {
      const siteInfo = await this.client.getSiteInfo();
      const courses = await this.client.call<any[]>('core_enrol_get_users_courses', {
        userid: siteInfo.userid,
      });
      for (const c of courses || []) {
        const cid = Number(c.id);
        try {
          const groups = await this.fetchRawCourseGroups(cid);
          const hit = groups.find((g) => Number(g.id) === groupId);
          if (hit) return { group: hit, courseId: cid };
        } catch {
          // continue searching
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async fetchConfirmedMembersForGroup(
    courseId: number,
    groupId: number,
    preloadedUsers?: Map<number, EnrolledCourseUser>
  ): Promise<GroupMemberDetail[]> {
    const usersMap = preloadedUsers ?? (await this.fetchLiveEnrolledUsers(courseId));

    // Prefer official core_group_get_group_members WS function when enabled on the token
    if (await this.client.hasWsFunction('core_group_get_group_members')) {
      const wsRes = await this.client.call<Array<{ groupid: number; userids: number[] }>>(
        'core_group_get_group_members',
        { groupids: [groupId] }
      );
      const userIds = wsRes?.[0]?.userids ?? [];
      return userIds
        .map((uid) => {
          const u = usersMap.get(Number(uid));
          return {
            id: Number(uid),
            fullname: u?.fullname ?? `Usuário ${uid}`,
            email: u?.email,
            username: u?.username,
            roles: u?.roles ?? [],
          };
        })
        .sort((a, b) => a.fullname.localeCompare(b.fullname, 'pt-BR'));
    }

    // Fallback to official core_enrol_get_enrolled_users group membership data
    const members: GroupMemberDetail[] = [];
    for (const u of usersMap.values()) {
      if (u.groups.some((g) => g.id === groupId)) {
        members.push({
          id: u.id,
          fullname: u.fullname,
          email: u.email,
          username: u.username,
          roles: u.roles,
        });
      }
    }
    members.sort((a, b) => a.fullname.localeCompare(b.fullname, 'pt-BR'));
    return members;
  }

  private resolveEffectiveMaxMembersForGroup(
    groupName: string,
    groupId: number,
    configs: GroupSelectConfig[],
    explicitMaxMembers?: number
  ): { maxMembers: number | null; governingActivity?: GroupSelectConfig } {
    if (explicitMaxMembers !== undefined && explicitMaxMembers > 0) {
      return { maxMembers: explicitMaxMembers, governingActivity: configs[0] };
    }

    for (const cfg of configs) {
      const applies =
        cfg.targetGroupingId === 0 ||
        cfg.allowedGroupIds.includes(groupId);
      if (!applies) continue;

      const perGroup = cfg.perGroupMaxLimits[groupName];
      if (perGroup !== undefined && perGroup > 0) {
        return { maxMembers: perGroup, governingActivity: cfg };
      }
      if (cfg.maxMembers > 0) {
        return { maxMembers: cfg.maxMembers, governingActivity: cfg };
      }
      return { maxMembers: null, governingActivity: cfg };
    }

    return { maxMembers: null };
  }

  // ============================================================================
  // 1. get_course_groups
  // ============================================================================
  public async getCourseGroups(params: {
    courseId?: number;
    activityCmid?: number;
    includeMembers?: boolean;
    includeGroupSelect?: boolean;
  }) {
    let resolvedCourseId = params.courseId;
    let explicitActivityCfg: GroupSelectConfig | undefined;

    if (params.activityCmid !== undefined) {
      explicitActivityCfg = await this.inspectGroupSelectActivity(
        params.activityCmid,
        params.courseId
      );
      resolvedCourseId = explicitActivityCfg.courseId;
    }

    const courseId = this.client.resolveCourseId(resolvedCourseId);
    const includeMembers = params.includeMembers ?? true;
    const includeGroupSelect = params.includeGroupSelect ?? true;

    const [rawGroups, rawGroupings, usersMap, permissions, groupSelectActivities] =
      await Promise.all([
        this.fetchRawCourseGroups(courseId),
        this.client
          .call<any[]>('core_group_get_course_groupings', { courseid: courseId })
          .catch(() => []),
        includeMembers
          ? this.fetchLiveEnrolledUsers(courseId)
          : Promise.resolve(new Map<number, EnrolledCourseUser>()),
        this.checkManageGroupsPermission(courseId, false),
        explicitActivityCfg
          ? Promise.resolve([explicitActivityCfg])
          : includeGroupSelect
            ? this.getCourseGroupSelectConfigs(courseId)
            : Promise.resolve([] as GroupSelectConfig[]),
      ]);

    const primaryActivity = explicitActivityCfg ?? groupSelectActivities[0];
    const allowedSet = primaryActivity ? new Set(primaryActivity.allowedGroupIds) : undefined;

    const groups: CourseGroupSummary[] = [];
    for (const g of rawGroups) {
      const gid = Number(g.id);
      const name = String(g.name || '');
      const members = includeMembers
        ? await this.fetchConfirmedMembersForGroup(courseId, gid, usersMap)
        : undefined;
      const { maxMembers } = this.resolveEffectiveMaxMembersForGroup(
        name,
        gid,
        groupSelectActivities
      );

      const availableInActivity = primaryActivity
        ? primaryActivity.targetGroupingId === 0 || (allowedSet ? allowedSet.has(gid) : true)
        : undefined;

      groups.push({
        id: gid,
        courseId,
        name,
        description: htmlToText(g.description),
        idnumber: String(g.idnumber || ''),
        hasEnrolmentKey: Boolean(g.enrolmentkey),
        ...(members ? { memberCount: members.length, members } : {}),
        ...(maxMembers !== null ? { maxMembers } : {}),
        ...(availableInActivity !== undefined ? { availableInActivity } : {}),
      });
    }

    return {
      courseId,
      groupsCount: groups.length,
      nextSuggestedGroupName: generateUniqueGroupName(groups),
      permissions,
      groupings: (Array.isArray(rawGroupings) ? rawGroupings : []).map((gp: any) => ({
        id: Number(gp.id),
        name: String(gp.name || ''),
        idnumber: String(gp.idnumber || ''),
        description: htmlToText(gp.description),
      })),
      groupSelectActivities,
      groups,
    };
  }

  // ============================================================================
  // 2. get_group_members
  // ============================================================================
  public async getGroupMembers(params: {
    groupId: number;
    courseId?: number;
    activityCmid?: number;
  }) {
    const { group, courseId } = await this.resolveGroupAndCourse(params.groupId, params.courseId);
    const groupSelectConfigs = await this.getCourseGroupSelectConfigs(
      courseId,
      params.activityCmid
    );
    const members = await this.fetchConfirmedMembersForGroup(courseId, Number(group.id));
    const groupName = String(group.name || '');
    const { maxMembers, governingActivity } = this.resolveEffectiveMaxMembersForGroup(
      groupName,
      Number(group.id),
      groupSelectConfigs
    );

    let availableInActivity: boolean | undefined;
    if (governingActivity) {
      if (governingActivity.targetGroupingId > 0) {
        availableInActivity = governingActivity.allowedGroupIds.includes(Number(group.id));
      } else if (governingActivity.allowedGroupIds.length > 0) {
        availableInActivity = governingActivity.allowedGroupIds.includes(Number(group.id));
      } else {
        availableInActivity = true;
      }
    } else if (groupSelectConfigs.length > 0) {
      // Group exists in course, but was not included in the target grouping of the activity!
      availableInActivity = false;
    }

    const effectiveActivity = governingActivity ?? groupSelectConfigs[0];

    return {
      courseId,
      groupId: Number(group.id),
      groupName,
      description: htmlToText(group.description),
      idnumber: String(group.idnumber || ''),
      memberCount: members.length,
      maxMembers,
      remainingSlots: maxMembers !== null ? Math.max(0, maxMembers - members.length) : null,
      ...(effectiveActivity
        ? {
            activityCmid: effectiveActivity.cmid,
            activityName: effectiveActivity.name,
            availableInActivity,
          }
        : {}),
      members,
    };
  }

  // ============================================================================
  // Low-level Moodle mutations (WS-first, Official Web Controller fallback)
  // ============================================================================
  private async executeMoodleCreateGroup(params: {
    courseId: number;
    name: string;
    description: string;
    idnumber: string;
    enrolmentKey?: string;
  }): Promise<'moodle_ws' | 'moodle_web_controller'> {
    if (await this.client.hasWsFunction('core_group_create_groups')) {
      try {
        await this.client.call('core_group_create_groups', {
          groups: [
            {
              courseid: params.courseId,
              name: params.name,
              description: params.description,
              descriptionformat: 1,
              ...(params.idnumber ? { idnumber: params.idnumber } : {}),
              ...(params.enrolmentKey ? { enrolmentkey: params.enrolmentKey } : {}),
            },
          ],
        });
        return 'moodle_ws';
      } catch (err: any) {
        const msg = this.client.sanitizeErrorMessage(err);
        if (/nopermissions|required_capability|managegroups/i.test(msg)) {
          throw new MoodleGroupError('insufficient_permissions', msg, {
            courseId: params.courseId,
          });
        }
        throw new MoodleGroupError('moodle_api_error', msg);
      }
    }

    // Official Moodle /group/group.php controller over authenticated session
    const formPage = await this.webSession.requestPage(
      `/group/group.php?courseid=${params.courseId}`
    );
    const sesskey = parseInputValue(formPage.html, 'sesskey');
    if (!sesskey || !/name=["']_qf__group_form["']/i.test(formPage.html)) {
      throw new MoodleGroupError(
        'insufficient_permissions',
        `Não foi possível abrir o formulário oficial de criação de grupo (/group/group.php) na disciplina ${params.courseId}. Verifique a permissão moodle/course:managegroups.`
      );
    }

    const descItemId = parseInputValue(formPage.html, 'description_editor[itemid]') || '0';
    const submitLabel = parseInputValue(formPage.html, 'submitbutton') || 'Salvar mudanças';

    const body = new URLSearchParams({
      id: '',
      courseid: String(params.courseId),
      sesskey,
      _qf__group_form: '1',
      mform_isexpanded_id_general: '1',
      name: params.name,
      idnumber: params.idnumber || '',
      'description_editor[text]': params.description
        ? `<p>${params.description}</p>`
        : '',
      'description_editor[format]': '1',
      'description_editor[itemid]': descItemId,
      enrolmentkey: params.enrolmentKey || '',
      submitbutton: submitLabel,
    });

    const postRes = await this.webSession.requestPage('/group/group.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (/name=["']_qf__group_form["']/i.test(postRes.html)) {
      const formErrors = extractMoodleFormErrors(postRes.html);
      throw new MoodleGroupError(
        'moodle_api_error',
        `O Moodle recusou a criação do grupo "${params.name}": ${formErrors.join('; ') || 'erro de validação no formulário /group/group.php'}.`
      );
    }

    return 'moodle_web_controller';
  }

  private async executeMoodleAssignGrouping(
    groupingId: number,
    groupId: number
  ): Promise<void> {
    if (groupingId <= 0) return;

    if (await this.client.hasWsFunction('core_group_assign_grouping')) {
      await this.client.call('core_group_assign_grouping', {
        assignments: [{ groupingid: groupingId, groupid: groupId }],
      });
      return;
    }

    const page = await this.webSession.requestPage(`/group/assign.php?id=${groupingId}`);
    const sesskey = parseInputValue(page.html, 'sesskey');
    if (!sesskey) {
      throw new MoodleGroupError(
        'moodle_api_error',
        `Não foi possível associar o grupo ${groupId} ao agrupamento ${groupingId} (/group/assign.php).`
      );
    }
    const addLabel = parseInputValue(page.html, 'add') || 'Adicionar';
    const body = new URLSearchParams({
      id: String(groupingId),
      sesskey,
      add: addLabel,
    });
    body.append('addselect[]', String(groupId));

    await this.webSession.requestPage(`/group/assign.php?id=${groupingId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  private async executeMoodleAddMember(
    groupId: number,
    userId: number
  ): Promise<'moodle_ws' | 'moodle_web_controller'> {
    if (await this.client.hasWsFunction('core_group_add_group_members')) {
      try {
        await this.client.call('core_group_add_group_members', {
          members: [{ groupid: groupId, userid: userId }],
        });
        return 'moodle_ws';
      } catch (err: any) {
        const msg = this.client.sanitizeErrorMessage(err);
        if (/nopermissions|required_capability|managegroups/i.test(msg)) {
          throw new MoodleGroupError('insufficient_permissions', msg);
        }
        throw new MoodleGroupError('moodle_api_error', msg);
      }
    }

    const page = await this.webSession.requestPage(`/group/members.php?group=${groupId}`);
    const sesskey = parseInputValue(page.html, 'sesskey');
    if (!sesskey || !/<form[^>]*id=["']assignform["']/i.test(page.html)) {
      throw new MoodleGroupError(
        'insufficient_permissions',
        `Não foi possível acessar /group/members.php?group=${groupId} (verifique moodle/course:managegroups).`
      );
    }

    const addLabel = parseInputValue(page.html, 'add') || 'Adicionar';
    const body = new URLSearchParams({
      group: String(groupId),
      sesskey,
      add: addLabel,
    });
    body.append('addselect[]', String(userId));

    await this.webSession.requestPage(`/group/members.php?group=${groupId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return 'moodle_web_controller';
  }

  private async executeMoodleRemoveMember(
    groupId: number,
    userId: number
  ): Promise<'moodle_ws' | 'moodle_web_controller'> {
    if (await this.client.hasWsFunction('core_group_delete_group_members')) {
      try {
        await this.client.call('core_group_delete_group_members', {
          members: [{ groupid: groupId, userid: userId }],
        });
        return 'moodle_ws';
      } catch (err: any) {
        const msg = this.client.sanitizeErrorMessage(err);
        if (/nopermissions|required_capability|managegroups/i.test(msg)) {
          throw new MoodleGroupError('insufficient_permissions', msg);
        }
        throw new MoodleGroupError('moodle_api_error', msg);
      }
    }

    const page = await this.webSession.requestPage(`/group/members.php?group=${groupId}`);
    const sesskey = parseInputValue(page.html, 'sesskey');
    if (!sesskey || !/<form[^>]*id=["']assignform["']/i.test(page.html)) {
      throw new MoodleGroupError(
        'insufficient_permissions',
        `Não foi possível acessar /group/members.php?group=${groupId} (verifique moodle/course:managegroups).`
      );
    }

    const removeLabel = parseInputValue(page.html, 'remove') || 'Remover';
    const body = new URLSearchParams({
      group: String(groupId),
      sesskey,
      remove: removeLabel,
    });
    body.append('removeselect[]', String(userId));

    await this.webSession.requestPage(`/group/members.php?group=${groupId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    return 'moodle_web_controller';
  }

  // ============================================================================
  // 3. create_course_group
  // ============================================================================
  public async createCourseGroup(params: {
    courseId?: number;
    name?: string;
    autoGenerateName?: boolean;
    namePrefix?: string;
    description?: string;
    idnumber?: string;
    enrolmentKey?: string;
    groupingId?: number;
    activityCmid?: number;
    idempotencyKey?: string;
  }) {
    let resolvedCourseId = params.courseId;
    let activityCfg: GroupSelectConfig | undefined;

    if (params.activityCmid !== undefined) {
      activityCfg = await this.inspectGroupSelectActivity(params.activityCmid, params.courseId);
      resolvedCourseId = activityCfg.courseId;
    }

    const courseId = this.client.resolveCourseId(resolvedCourseId);

    return this.auditStore.withCourseLock(courseId, async () => {
      const actor = await this.getActorInfo().catch(() => undefined);
      let transportUsed: GroupAuditEntry['transportUsed'] = 'none';

      try {
        await this.checkManageGroupsPermission(courseId, true);

        if (!activityCfg) {
          const allGs = await this.getCourseGroupSelectConfigs(courseId);
          if (allGs.length === 1) activityCfg = allGs[0];
        }

        const existingGroups = await this.fetchRawCourseGroups(courseId);

        // 1. Check idempotencyKey replay first (safe retry after timeout even with auto-generated name!)
        if (params.idempotencyKey) {
          const prev = this.auditStore.findCreatedGroupByIdempotencyKey(
            courseId,
            params.idempotencyKey
          );
          if (prev) {
            const stillExists = existingGroups.find((g) => Number(g.id) === prev.groupId);
            if (stillExists) {
              const effectiveGroupingId =
                params.groupingId ?? activityCfg?.targetGroupingId ?? 0;
              if (effectiveGroupingId > 0) {
                await this.executeMoodleAssignGrouping(effectiveGroupingId, Number(stillExists.id));
              }
              const confirmed = await this.getGroupMembers({
                groupId: Number(stillExists.id),
                courseId,
                activityCmid: activityCfg?.cmid,
              });
              const audit = this.auditStore.record({
                operation: 'create_course_group',
                outcome: 'idempotent_replay',
                courseId,
                activityCmid: activityCfg?.cmid,
                actor,
                groupId: confirmed.groupId,
                groupName: confirmed.groupName,
                idempotencyKey: params.idempotencyKey,
                confirmedMemberIds: confirmed.members.map((m) => m.id),
                transportUsed: 'none',
              });
              return {
                status: 'already_created_idempotent' as const,
                created: false,
                idempotentReplay: true,
                courseId,
                groupId: confirmed.groupId,
                groupName: confirmed.groupName,
                description: confirmed.description,
                idnumber: confirmed.idnumber,
                groupingId: effectiveGroupingId || null,
                activityCmid: activityCfg?.cmid ?? null,
                availableInActivity: confirmed.availableInActivity ?? true,
                maxMembers: confirmed.maxMembers,
                confirmedState: confirmed,
                transportUsed: 'none' as const,
                auditId: audit.auditId,
              };
            }
          }
        }

        // 2. Determine target group name vs auto-generation
        let targetName: string;
        if (params.name !== undefined) {
          targetName = params.name.trim();
          if (!targetName) {
            throw new MoodleGroupError(
              'invalid_group_name',
              'O nome do grupo não pode ser vazio.'
            );
          }

          // Check if a group with this name (or idnumber) already exists in Moodle
          const conflictByName = existingGroups.find(
            (g) => String(g.name || '').trim().toLowerCase() === targetName.toLowerCase()
          );
          const conflictByIdNumber =
            params.idnumber && params.idnumber.trim()
              ? existingGroups.find(
                  (g) =>
                    String(g.idnumber || '').trim() === params.idnumber!.trim()
                )
              : undefined;

          const existingMatch = conflictByIdNumber || conflictByName;
          if (existingMatch) {
            // Distinguish idempotent retry of an MCP-created group vs pre-existing course group!
            const mcpRecent = this.auditStore.findRecentMcpCreatedGroupByName(
              courseId,
              String(existingMatch.name)
            );
            const matchesIdNumber =
              Boolean(params.idnumber?.trim()) &&
              String(existingMatch.idnumber || '').trim() === params.idnumber!.trim();

            if ((mcpRecent && mcpRecent.groupId === Number(existingMatch.id)) || matchesIdNumber) {
              const confirmed = await this.getGroupMembers({
                groupId: Number(existingMatch.id),
                courseId,
                activityCmid: activityCfg?.cmid,
              });
              const audit = this.auditStore.record({
                operation: 'create_course_group',
                outcome: 'idempotent_replay',
                courseId,
                activityCmid: activityCfg?.cmid,
                actor,
                groupId: confirmed.groupId,
                groupName: confirmed.groupName,
                idempotencyKey: params.idempotencyKey,
                confirmedMemberIds: confirmed.members.map((m) => m.id),
                transportUsed: 'none',
              });
              return {
                status: 'already_created_idempotent' as const,
                created: false,
                idempotentReplay: true,
                courseId,
                groupId: confirmed.groupId,
                groupName: confirmed.groupName,
                description: confirmed.description,
                idnumber: confirmed.idnumber,
                groupingId: (params.groupingId ?? activityCfg?.targetGroupingId) || null,
                activityCmid: activityCfg?.cmid ?? null,
                availableInActivity: confirmed.availableInActivity ?? true,
                maxMembers: confirmed.maxMembers,
                confirmedState: confirmed,
                transportUsed: 'none' as const,
                auditId: audit.auditId,
              };
            }

            throw new MoodleGroupError(
              'group_name_conflict',
              `Já existe um grupo com o nome "${existingMatch.name}" (groupId=${existingMatch.id}) na disciplina ${courseId}. Para evitar sobrescrever ou reutilizar incorretamente um grupo existente, escolha outro nome ou omita "name" para gerar automaticamente "${generateUniqueGroupName(existingGroups, params.namePrefix)}".`,
              {
                courseId,
                conflictingGroupId: Number(existingMatch.id),
                conflictingGroupName: String(existingMatch.name),
                suggestedUniqueName: generateUniqueGroupName(existingGroups, params.namePrefix),
              }
            );
          }
        } else {
          if (params.autoGenerateName === false) {
            throw new MoodleGroupError(
              'invalid_group_name',
              'Informe "name" ou mantenha autoGenerateName=true para gerar um nome único automaticamente.'
            );
          }
          targetName = generateUniqueGroupName(existingGroups, params.namePrefix);
        }

        // 3. Create the group in Moodle
        transportUsed = await this.executeMoodleCreateGroup({
          courseId,
          name: targetName,
          description: params.description ?? '',
          idnumber: params.idnumber ?? '',
          enrolmentKey: params.enrolmentKey,
        });

        // 4. Confirm group creation in Moodle via official REST API
        const updatedGroups = await this.fetchRawCourseGroups(courseId);
        const createdGroup = updatedGroups.find(
          (g) => String(g.name || '').trim().toLowerCase() === targetName.toLowerCase()
        );
        if (!createdGroup) {
          throw new MoodleGroupError(
            'state_confirmation_failed',
            `A criação do grupo "${targetName}" foi enviada, mas o grupo não foi encontrado na confirmação via core_group_get_course_groups.`
          );
        }

        const createdGroupId = Number(createdGroup.id);

        // 5. Assign to target grouping if required by parameter or mod_groupselect
        const effectiveGroupingId = params.groupingId ?? activityCfg?.targetGroupingId ?? 0;
        if (effectiveGroupingId > 0) {
          await this.executeMoodleAssignGrouping(effectiveGroupingId, createdGroupId);
        }

        // 6. Final state confirmation (including availability in mod_groupselect!)
        const confirmed = await this.getGroupMembers({
          groupId: createdGroupId,
          courseId,
          activityCmid: activityCfg?.cmid,
        });

        if (activityCfg && confirmed.availableInActivity === false) {
          throw new MoodleGroupError(
            'state_confirmation_failed',
            `O grupo "${targetName}" (groupId=${createdGroupId}) foi criado, mas não apareceu como disponível na atividade "${activityCfg.name}" (cmid=${activityCfg.cmid}).`
          );
        }

        const audit = this.auditStore.record({
          operation: 'create_course_group',
          outcome: 'succeeded',
          courseId,
          activityCmid: activityCfg?.cmid,
          actor,
          groupId: createdGroupId,
          groupName: confirmed.groupName,
          idempotencyKey: params.idempotencyKey,
          confirmedMemberIds: confirmed.members.map((m) => m.id),
          transportUsed,
        });

        return {
          status: 'created' as const,
          created: true,
          idempotentReplay: false,
          courseId,
          groupId: createdGroupId,
          groupName: confirmed.groupName,
          description: confirmed.description,
          idnumber: confirmed.idnumber,
          groupingId: effectiveGroupingId || null,
          activityCmid: activityCfg?.cmid ?? null,
          availableInActivity: confirmed.availableInActivity ?? true,
          maxMembers: confirmed.maxMembers,
          confirmedState: confirmed,
          transportUsed,
          auditId: audit.auditId,
        };
      } catch (err: any) {
        const gErr =
          err instanceof MoodleGroupError
            ? err
            : new MoodleGroupError('moodle_api_error', this.client.sanitizeErrorMessage(err));
        this.auditStore.record({
          operation: 'create_course_group',
          outcome: 'failed',
          courseId,
          activityCmid: activityCfg?.cmid,
          actor,
          groupName: params.name,
          idempotencyKey: params.idempotencyKey,
          transportUsed,
          errorCode: gErr.code,
          errorMessage: gErr.message,
        });
        throw gErr;
      }
    });
  }

  // ============================================================================
  // 4. add_group_member
  // ============================================================================
  public async addGroupMember(params: {
    groupId: number;
    userIds: number[];
    courseId?: number;
    activityCmid?: number;
    allowMultipleGroups?: boolean;
    maxMembersOverride?: number;
    idempotencyKey?: string;
  }) {
    const uniqueTargetIds = Array.from(new Set(params.userIds.map((id) => Number(id))));
    if (uniqueTargetIds.length === 0) {
      throw new MoodleGroupError(
        'moodle_api_error',
        'Informe ao menos um userId para adicionar ao grupo.'
      );
    }

    const { group, courseId } = await this.resolveGroupAndCourse(params.groupId, params.courseId);
    const groupId = Number(group.id);
    const groupName = String(group.name || '');

    return this.auditStore.withCourseLock(courseId, async () => {
      const actor = await this.getActorInfo().catch(() => undefined);
      let transportUsed: GroupAuditEntry['transportUsed'] = 'none';

      try {
        await this.checkManageGroupsPermission(courseId, true);

        const [usersMap, groupSelectConfigs] = await Promise.all([
          this.fetchLiveEnrolledUsers(courseId),
          this.getCourseGroupSelectConfigs(courseId, params.activityCmid),
        ]);

        // 1. Validate that EVERY user belongs to the course
        for (const uid of uniqueTargetIds) {
          if (!usersMap.has(uid)) {
            throw new MoodleGroupError(
              'user_not_enrolled',
              `O usuário userId=${uid} não está matriculado na disciplina ${courseId}.`,
              { courseId, groupId, userId: uid }
            );
          }
        }

        // 2. Inspect current confirmed members for idempotency
        const beforeMembers = await this.fetchConfirmedMembersForGroup(
          courseId,
          groupId,
          usersMap
        );
        const alreadyMemberSet = new Set(beforeMembers.map((m) => m.id));
        const alreadyMembers: GroupMemberDetail[] = [];
        const toAddIds: number[] = [];

        for (const uid of uniqueTargetIds) {
          if (alreadyMemberSet.has(uid)) {
            const u = usersMap.get(uid)!;
            alreadyMembers.push({
              id: u.id,
              fullname: u.fullname,
              email: u.email,
              username: u.username,
              roles: u.roles,
            });
          } else {
            toAddIds.push(uid);
          }
        }

        const { maxMembers, governingActivity } = this.resolveEffectiveMaxMembersForGroup(
          groupName,
          groupId,
          groupSelectConfigs,
          params.maxMembersOverride
        );

        // 3. Enforce single-group rule within governing mod_groupselect unless allowMultipleGroups=true
        if (governingActivity && !params.allowMultipleGroups && toAddIds.length > 0) {
          const scopeGroupIds =
            governingActivity.targetGroupingId === 0
              ? null // all groups in course
              : new Set(governingActivity.allowedGroupIds);

          for (const uid of toAddIds) {
            const u = usersMap.get(uid)!;
            const otherGroups = u.groups.filter(
              (g) => g.id !== groupId && (scopeGroupIds === null || scopeGroupIds.has(g.id))
            );
            if (otherGroups.length > 0) {
              throw new MoodleGroupError(
                'user_already_in_another_group',
                `O aluno ${u.fullname} (userId=${uid}) já pertence ao grupo "${otherGroups[0].name}" (groupId=${otherGroups[0].id}) na atividade "${governingActivity.name}".`,
                {
                  courseId,
                  groupId,
                  userId: uid,
                  existingGroups: otherGroups,
                }
              );
            }
          }
        }

        // 4. Enforce maxMembers limit configured by professor
        if (maxMembers !== null && maxMembers > 0 && toAddIds.length > 0) {
          const projectedTotal = beforeMembers.length + toAddIds.length;
          if (projectedTotal > maxMembers) {
            throw new MoodleGroupError(
              'max_members_exceeded',
              `Limite máximo de participantes excedido para o grupo "${groupName}" (groupId=${groupId}): o grupo já possui ${beforeMembers.length} participante(s), tentou-se adicionar ${toAddIds.length}, mas o limite configurado${governingActivity ? ` na atividade "${governingActivity.name}" (cmid=${governingActivity.cmid})` : ''} é de no máximo ${maxMembers} participante(s).`,
              {
                courseId,
                groupId,
                groupName,
                currentMemberCount: beforeMembers.length,
                attemptedAddCount: toAddIds.length,
                maxMembers,
                activityCmid: governingActivity?.cmid,
              }
            );
          }
        }

        // 5. If all requested users were already in the group -> idempotent replay!
        if (toAddIds.length === 0) {
          const confirmed = await this.getGroupMembers({
            groupId,
            courseId,
            activityCmid: governingActivity?.cmid,
          });
          const audit = this.auditStore.record({
            operation: 'add_group_member',
            outcome: 'idempotent_replay',
            courseId,
            activityCmid: governingActivity?.cmid,
            actor,
            groupId,
            groupName,
            idempotencyKey: params.idempotencyKey,
            requestedUserIds: uniqueTargetIds,
            addedUserIds: [],
            alreadyMemberUserIds: alreadyMembers.map((m) => m.id),
            confirmedMemberIds: confirmed.members.map((m) => m.id),
            transportUsed: 'none',
          });
          return {
            status: 'already_member_idempotent' as const,
            idempotentReplay: true,
            courseId,
            groupId,
            groupName,
            addedMembers: [] as GroupMemberDetail[],
            alreadyMembers,
            failedMembers: [] as Array<{ userId: number; errorCode: string; errorMessage: string }>,
            confirmedMembers: confirmed.members,
            memberCount: confirmed.memberCount,
            maxMembers: confirmed.maxMembers,
            remainingSlots: confirmed.remainingSlots,
            availableInActivity: confirmed.availableInActivity,
            transportUsed: 'none' as const,
            auditId: audit.auditId,
          };
        }

        // 6. Execute additions in Moodle
        const addedIds: number[] = [];
        const failedMembers: Array<{ userId: number; errorCode: string; errorMessage: string }> =
          [];

        for (const uid of toAddIds) {
          try {
            transportUsed = await this.executeMoodleAddMember(groupId, uid);
            addedIds.push(uid);
          } catch (memberErr: any) {
            const gErr =
              memberErr instanceof MoodleGroupError
                ? memberErr
                : new MoodleGroupError(
                    'moodle_api_error',
                    this.client.sanitizeErrorMessage(memberErr)
                  );
            failedMembers.push({
              userId: uid,
              errorCode: gErr.code,
              errorMessage: gErr.message,
            });
          }
        }

        // 7. Re-query Moodle to confirm final persisted membership state
        const confirmed = await this.getGroupMembers({
          groupId,
          courseId,
          activityCmid: governingActivity?.cmid,
        });
        const confirmedSet = new Set(confirmed.members.map((m) => m.id));

        for (const uid of addedIds) {
          if (!confirmedSet.has(uid)) {
            failedMembers.push({
              userId: uid,
              errorCode: 'state_confirmation_failed',
              errorMessage: `A inclusão de userId=${uid} não pôde ser confirmada na leitura subsequente do grupo no Moodle.`,
            });
          }
        }

        const confirmedAdded = confirmed.members.filter(
          (m) => addedIds.includes(m.id) && confirmedSet.has(m.id)
        );

        const outcome: GroupAuditOutcome =
          failedMembers.length === 0
            ? 'succeeded'
            : confirmedAdded.length > 0
              ? 'partial_failure'
              : 'failed';

        const audit = this.auditStore.record({
          operation: 'add_group_member',
          outcome,
          courseId,
          activityCmid: governingActivity?.cmid,
          actor,
          groupId,
          groupName,
          idempotencyKey: params.idempotencyKey,
          requestedUserIds: uniqueTargetIds,
          addedUserIds: confirmedAdded.map((m) => m.id),
          alreadyMemberUserIds: alreadyMembers.map((m) => m.id),
          failedUserIds: failedMembers,
          confirmedMemberIds: confirmed.members.map((m) => m.id),
          transportUsed,
        });

        if (failedMembers.length > 0 && confirmedAdded.length === 0) {
          throw new MoodleGroupError(
            failedMembers[0].errorCode as GroupErrorCode,
            failedMembers[0].errorMessage,
            { courseId, groupId, failedMembers, auditId: audit.auditId }
          );
        }

        return {
          status: failedMembers.length > 0 ? ('partial_failure' as const) : ('added' as const),
          idempotentReplay: false,
          courseId,
          groupId,
          groupName,
          addedMembers: confirmedAdded,
          alreadyMembers,
          failedMembers,
          confirmedMembers: confirmed.members,
          memberCount: confirmed.memberCount,
          maxMembers: confirmed.maxMembers,
          remainingSlots: confirmed.remainingSlots,
          availableInActivity: confirmed.availableInActivity,
          transportUsed,
          auditId: audit.auditId,
        };
      } catch (err: any) {
        if (err instanceof MoodleGroupError && err.details?.auditId) {
          throw err;
        }
        const gErr =
          err instanceof MoodleGroupError
            ? err
            : new MoodleGroupError('moodle_api_error', this.client.sanitizeErrorMessage(err));
        this.auditStore.record({
          operation: 'add_group_member',
          outcome: 'failed',
          courseId,
          activityCmid: params.activityCmid,
          actor,
          groupId,
          groupName,
          idempotencyKey: params.idempotencyKey,
          requestedUserIds: uniqueTargetIds,
          transportUsed,
          errorCode: gErr.code,
          errorMessage: gErr.message,
        });
        throw gErr;
      }
    });
  }

  // ============================================================================
  // 5. remove_group_member
  // ============================================================================
  public async removeGroupMember(params: {
    groupId: number;
    userIds: number[];
    courseId?: number;
    activityCmid?: number;
    idempotencyKey?: string;
  }) {
    const uniqueTargetIds = Array.from(new Set(params.userIds.map((id) => Number(id))));
    if (uniqueTargetIds.length === 0) {
      throw new MoodleGroupError(
        'moodle_api_error',
        'Informe ao menos um userId para remover do grupo.'
      );
    }

    const { group, courseId } = await this.resolveGroupAndCourse(params.groupId, params.courseId);
    const groupId = Number(group.id);
    const groupName = String(group.name || '');

    return this.auditStore.withCourseLock(courseId, async () => {
      const actor = await this.getActorInfo().catch(() => undefined);
      let transportUsed: GroupAuditEntry['transportUsed'] = 'none';

      try {
        await this.checkManageGroupsPermission(courseId, true);
        const usersMap = await this.fetchLiveEnrolledUsers(courseId);

        for (const uid of uniqueTargetIds) {
          if (!usersMap.has(uid)) {
            throw new MoodleGroupError(
              'user_not_enrolled',
              `O usuário userId=${uid} não está matriculado na disciplina ${courseId}.`,
              { courseId, groupId, userId: uid }
            );
          }
        }

        const beforeMembers = await this.fetchConfirmedMembersForGroup(
          courseId,
          groupId,
          usersMap
        );
        const presentMap = new Map(beforeMembers.map((m) => [m.id, m]));
        const toRemoveIds: number[] = [];
        const alreadyAbsentIds: number[] = [];

        for (const uid of uniqueTargetIds) {
          if (presentMap.has(uid)) {
            toRemoveIds.push(uid);
          } else {
            alreadyAbsentIds.push(uid);
          }
        }

        if (toRemoveIds.length === 0) {
          const confirmed = await this.getGroupMembers({
            groupId,
            courseId,
            activityCmid: params.activityCmid,
          });
          const audit = this.auditStore.record({
            operation: 'remove_group_member',
            outcome: 'idempotent_replay',
            courseId,
            activityCmid: params.activityCmid,
            actor,
            groupId,
            groupName,
            idempotencyKey: params.idempotencyKey,
            requestedUserIds: uniqueTargetIds,
            removedUserIds: [],
            confirmedMemberIds: confirmed.members.map((m) => m.id),
            transportUsed: 'none',
          });
          return {
            status: 'already_absent_idempotent' as const,
            idempotentReplay: true,
            courseId,
            groupId,
            groupName,
            removedMembers: [] as GroupMemberDetail[],
            alreadyAbsentUserIds: alreadyAbsentIds,
            failedMembers: [] as Array<{ userId: number; errorCode: string; errorMessage: string }>,
            confirmedMembers: confirmed.members,
            memberCount: confirmed.memberCount,
            auditId: audit.auditId,
          };
        }

        const removedCandidates: GroupMemberDetail[] = [];
        const failedMembers: Array<{ userId: number; errorCode: string; errorMessage: string }> =
          [];

        for (const uid of toRemoveIds) {
          try {
            transportUsed = await this.executeMoodleRemoveMember(groupId, uid);
            removedCandidates.push(presentMap.get(uid)!);
          } catch (remErr: any) {
            const gErr =
              remErr instanceof MoodleGroupError
                ? remErr
                : new MoodleGroupError(
                    'moodle_api_error',
                    this.client.sanitizeErrorMessage(remErr)
                  );
            failedMembers.push({
              userId: uid,
              errorCode: gErr.code,
              errorMessage: gErr.message,
            });
          }
        }

        // Confirm state in Moodle
        const confirmed = await this.getGroupMembers({
          groupId,
          courseId,
          activityCmid: params.activityCmid,
        });
        const stillPresent = new Set(confirmed.members.map((m) => m.id));

        const confirmedRemoved: GroupMemberDetail[] = [];
        for (const m of removedCandidates) {
          if (stillPresent.has(m.id)) {
            failedMembers.push({
              userId: m.id,
              errorCode: 'state_confirmation_failed',
              errorMessage: `O usuário userId=${m.id} permaneceu listado no grupo após a tentativa de remoção.`,
            });
          } else {
            confirmedRemoved.push(m);
          }
        }

        const audit = this.auditStore.record({
          operation: 'remove_group_member',
          outcome:
            failedMembers.length === 0
              ? 'succeeded'
              : confirmedRemoved.length > 0
                ? 'partial_failure'
                : 'failed',
          courseId,
          activityCmid: params.activityCmid,
          actor,
          groupId,
          groupName,
          idempotencyKey: params.idempotencyKey,
          requestedUserIds: uniqueTargetIds,
          removedUserIds: confirmedRemoved.map((m) => m.id),
          failedUserIds: failedMembers,
          confirmedMemberIds: confirmed.members.map((m) => m.id),
          transportUsed,
        });

        if (failedMembers.length > 0 && confirmedRemoved.length === 0) {
          throw new MoodleGroupError(
            failedMembers[0].errorCode as GroupErrorCode,
            failedMembers[0].errorMessage,
            { courseId, groupId, failedMembers, auditId: audit.auditId }
          );
        }

        return {
          status: failedMembers.length > 0 ? ('partial_failure' as const) : ('removed' as const),
          idempotentReplay: false,
          courseId,
          groupId,
          groupName,
          removedMembers: confirmedRemoved,
          alreadyAbsentUserIds: alreadyAbsentIds,
          failedMembers,
          confirmedMembers: confirmed.members,
          memberCount: confirmed.memberCount,
          auditId: audit.auditId,
        };
      } catch (err: any) {
        if (err instanceof MoodleGroupError && err.details?.auditId) {
          throw err;
        }
        const gErr =
          err instanceof MoodleGroupError
            ? err
            : new MoodleGroupError('moodle_api_error', this.client.sanitizeErrorMessage(err));
        this.auditStore.record({
          operation: 'remove_group_member',
          outcome: 'failed',
          courseId,
          activityCmid: params.activityCmid,
          actor,
          groupId,
          groupName,
          idempotencyKey: params.idempotencyKey,
          requestedUserIds: uniqueTargetIds,
          transportUsed,
          errorCode: gErr.code,
          errorMessage: gErr.message,
        });
        throw gErr;
      }
    });
  }

  // ============================================================================
  // 6. create_group_with_members (Composite / Transactional with Partial-Failure Reporting)
  // ============================================================================
  public async createGroupWithMembers(params: {
    courseId?: number;
    name?: string;
    autoGenerateName?: boolean;
    namePrefix?: string;
    description?: string;
    idnumber?: string;
    enrolmentKey?: string;
    groupingId?: number;
    userIds: number[];
    activityCmid?: number;
    allowMultipleGroups?: boolean;
    idempotencyKey?: string;
    prevalidateAllMembers?: boolean;
  }) {
    let resolvedCourseId = params.courseId;
    let activityCfg: GroupSelectConfig | undefined;

    if (params.activityCmid !== undefined) {
      activityCfg = await this.inspectGroupSelectActivity(params.activityCmid, params.courseId);
      resolvedCourseId = activityCfg.courseId;
    }

    const courseId = this.client.resolveCourseId(resolvedCourseId);
    const uniqueUserIds = Array.from(new Set(params.userIds.map((id) => Number(id))));
    const prevalidateAll = params.prevalidateAllMembers ?? true;

    // 1. Pre-flight check BEFORE creating the group so invalid permissions or maxMembers
    //    (and invalid enrollments when prevalidateAllMembers=true) never create an orphan group!
    await this.checkManageGroupsPermission(courseId, true);

    if (!activityCfg) {
      const allGs = await this.getCourseGroupSelectConfigs(courseId);
      if (allGs.length === 1) activityCfg = allGs[0];
    }

    if (activityCfg && activityCfg.maxMembers > 0 && uniqueUserIds.length > activityCfg.maxMembers) {
      const actor = await this.getActorInfo().catch(() => undefined);
      const msg = `Limite máximo de participantes excedido antes de criar o grupo: foram informados ${uniqueUserIds.length} participante(s), mas a atividade "${activityCfg.name}" (cmid=${activityCfg.cmid}) permite no máximo ${activityCfg.maxMembers}.`;
      this.auditStore.record({
        operation: 'create_group_with_members',
        outcome: 'failed',
        courseId,
        activityCmid: activityCfg.cmid,
        actor,
        groupName: params.name,
        idempotencyKey: params.idempotencyKey,
        requestedUserIds: uniqueUserIds,
        transportUsed: 'none',
        errorCode: 'max_members_exceeded',
        errorMessage: msg,
      });
      throw new MoodleGroupError('max_members_exceeded', msg, {
        courseId,
        attemptedCount: uniqueUserIds.length,
        maxMembers: activityCfg.maxMembers,
        activityCmid: activityCfg.cmid,
      });
    }

    const usersMap = await this.fetchLiveEnrolledUsers(courseId);
    if (prevalidateAll) {
      for (const uid of uniqueUserIds) {
        if (!usersMap.has(uid)) {
          const actor = await this.getActorInfo().catch(() => undefined);
          const msg = `Operação abortada antes da criação do grupo: o usuário userId=${uid} não está matriculado na disciplina ${courseId}.`;
          this.auditStore.record({
            operation: 'create_group_with_members',
            outcome: 'failed',
            courseId,
            activityCmid: activityCfg?.cmid,
            actor,
            groupName: params.name,
            idempotencyKey: params.idempotencyKey,
            requestedUserIds: uniqueUserIds,
            transportUsed: 'none',
            errorCode: 'user_not_enrolled',
            errorMessage: msg,
          });
          throw new MoodleGroupError('user_not_enrolled', msg, {
            courseId,
            userId: uid,
          });
        }
      }
    }

    // 2. Create (or idempotently recover) the group
    const groupRes = await this.createCourseGroup({
      courseId,
      name: params.name,
      autoGenerateName: params.autoGenerateName,
      namePrefix: params.namePrefix,
      description: params.description,
      idnumber: params.idnumber,
      enrolmentKey: params.enrolmentKey,
      groupingId: params.groupingId,
      activityCmid: activityCfg?.cmid,
      idempotencyKey: params.idempotencyKey,
    });

    if (uniqueUserIds.length === 0) {
      return {
        status: groupRes.created ? ('created' as const) : ('idempotent_replay' as const),
        courseId,
        groupId: groupRes.groupId,
        groupName: groupRes.groupName,
        groupCreated: groupRes.created,
        availableInActivity: groupRes.availableInActivity,
        maxMembers: groupRes.maxMembers,
        addedMembers: [] as GroupMemberDetail[],
        alreadyMembers: [] as GroupMemberDetail[],
        failedMembers: [] as Array<{ userId: number; errorCode: string; errorMessage: string }>,
        confirmedMembers: groupRes.confirmedState.members,
        memberCount: groupRes.confirmedState.memberCount,
        auditId: groupRes.auditId,
      };
    }

    // 3. Add members one by one (or batch) while capturing any partial failures cleanly
    const validIdsToAttempt: number[] = [];
    const preFailedMembers: Array<{ userId: number; errorCode: string; errorMessage: string }> = [];

    for (const uid of uniqueUserIds) {
      if (!usersMap.has(uid)) {
        preFailedMembers.push({
          userId: uid,
          errorCode: 'user_not_enrolled',
          errorMessage: `O usuário userId=${uid} não está matriculado na disciplina ${courseId}.`,
        });
      } else {
        validIdsToAttempt.push(uid);
      }
    }

    let addedMembers: GroupMemberDetail[] = [];
    let alreadyMembers: GroupMemberDetail[] = [];
    const allFailedMembers = [...preFailedMembers];
    let compositeTransport: GroupAuditEntry['transportUsed'] = groupRes.transportUsed;

    if (validIdsToAttempt.length > 0) {
      try {
        const addRes = await this.addGroupMember({
          courseId,
          groupId: groupRes.groupId,
          userIds: validIdsToAttempt,
          activityCmid: activityCfg?.cmid,
          allowMultipleGroups: params.allowMultipleGroups,
          idempotencyKey: params.idempotencyKey
            ? `${params.idempotencyKey}:members`
            : undefined,
        });
        addedMembers = addRes.addedMembers;
        alreadyMembers = addRes.alreadyMembers;
        allFailedMembers.push(...addRes.failedMembers);
        if (addRes.transportUsed !== 'none') {
          compositeTransport = addRes.transportUsed;
        }
      } catch (addErr: any) {
        const gErr =
          addErr instanceof MoodleGroupError
            ? addErr
            : new MoodleGroupError('moodle_api_error', this.client.sanitizeErrorMessage(addErr));
        for (const uid of validIdsToAttempt) {
          allFailedMembers.push({
            userId: uid,
            errorCode: gErr.code,
            errorMessage: gErr.message,
          });
        }
      }
    }

    const finalConfirmed = await this.getGroupMembers({
      groupId: groupRes.groupId,
      courseId,
      activityCmid: activityCfg?.cmid,
    });

    const hasFailures = allFailedMembers.length > 0;
    const actor = await this.getActorInfo().catch(() => undefined);
    const compositeAudit = this.auditStore.record({
      operation: 'create_group_with_members',
      outcome: hasFailures
        ? 'partial_failure'
        : !groupRes.created && addedMembers.length === 0
          ? 'idempotent_replay'
          : 'succeeded',
      courseId,
      activityCmid: activityCfg?.cmid,
      actor,
      groupId: groupRes.groupId,
      groupName: groupRes.groupName,
      idempotencyKey: params.idempotencyKey,
      requestedUserIds: uniqueUserIds,
      addedUserIds: addedMembers.map((m) => m.id),
      alreadyMemberUserIds: alreadyMembers.map((m) => m.id),
      failedUserIds: allFailedMembers,
      confirmedMemberIds: finalConfirmed.members.map((m) => m.id),
      transportUsed: compositeTransport,
    });

    return {
      status: hasFailures
        ? ('partial_failure' as const)
        : !groupRes.created && addedMembers.length === 0
          ? ('idempotent_replay' as const)
          : ('created_with_members' as const),
      courseId,
      groupId: groupRes.groupId,
      groupName: groupRes.groupName,
      groupCreated: groupRes.created,
      activityCmid: activityCfg?.cmid ?? null,
      availableInActivity: finalConfirmed.availableInActivity ?? groupRes.availableInActivity,
      maxMembers: finalConfirmed.maxMembers,
      remainingSlots: finalConfirmed.remainingSlots,
      addedMembers,
      alreadyMembers,
      failedMembers: allFailedMembers,
      confirmedMembers: finalConfirmed.members,
      memberCount: finalConfirmed.memberCount,
      auditId: compositeAudit.auditId,
    };
  }
}
