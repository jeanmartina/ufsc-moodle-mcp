import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GroupAuditEntry } from '../src/group-audit.js';
import { createMoodleHttpServer, type MoodleHttpServerInstance } from '../src/http-app.js';
import type { MoodleConfig } from '../src/moodle.js';

const SECRET_MOODLE_TOKEN = 'SECRET_GROUP_TEST_WSTOKEN_778899001122';
const SECRET_MOODLE_PASSWORD = 'SECRET_GROUP_TEST_CAS_PASSWORD_445566';
const MCP_BEARER_TOKEN = 'MCP_GROUP_TEST_BEARER_1234567890';

interface MockUser {
  id: number;
  username: string;
  fullname: string;
  email: string;
  roles: string[];
}

interface MockGroup {
  id: number;
  courseid: number;
  name: string;
  description: string;
  idnumber: string;
  enrolmentkey: string;
  memberIds: Set<number>;
}

interface MockGrouping {
  id: number;
  courseid: number;
  name: string;
  description: string;
  idnumber: string;
  groupIds: Set<number>;
}

interface MockGroupSelectModule {
  cmid: number;
  instanceId: number;
  courseId: number;
  name: string;
  targetGroupingId: number;
  minMembers: number;
  maxMembers: number;
  studentCanCreate: boolean;
  studentCanJoin: boolean;
  studentCanLeave: boolean;
  deleteEmptyGroups: boolean;
  timeDueYear: number;
}

class StatefulMockMoodleServer {
  public server!: http.Server;
  public baseUrl = '';
  public transportMode: 'web_controller_fallback' | 'full_ws' = 'web_controller_fallback';
  public currentActorUserId = 9001; // 9001 = teacher, 38610 = student (no managegroups)
  public failAddForUserIds = new Set<number>();

  private nextGroupId = 70314;
  private validSessions = new Set<string>();
  private readonly sesskey = 'MOCK_SESSKEY_998877';

  public readonly users = new Map<number, MockUser>();
  public readonly courseEnrollments = new Map<number, Set<number>>();
  public readonly groups = new Map<number, MockGroup>();
  public readonly groupings = new Map<number, MockGrouping>();
  public readonly groupSelectModules = new Map<number, MockGroupSelectModule>();

  constructor() {
    this.resetSeedData();
  }

  public resetSeedData(): void {
    this.users.clear();
    this.courseEnrollments.clear();
    this.groups.clear();
    this.groupings.clear();
    this.groupSelectModules.clear();
    this.failAddForUserIds.clear();
    this.currentActorUserId = 9001;
    this.nextGroupId = 70314;

    // Actor 9001: Professor with editingteacher / moodle/course:managegroups
    this.users.set(9001, {
      id: 9001,
      username: 'professor.exemplo',
      fullname: 'Prof. Exemplo Moodle',
      email: 'professor.exemplo@ufsc.br',
      roles: ['editingteacher'],
    });

    // Enrolled students in course 49472
    const seedStudents: MockUser[] = [
      {
        id: 38610,
        username: '21200000',
        fullname: 'Pedro Aluno Exemplo (21200000)',
        email: 'pedro.exemplo@grad.ufsc.br',
        roles: ['student'],
      },
      {
        id: 40001,
        username: '22100001',
        fullname: 'Ana Clara Silva (22100001)',
        email: 'ana@grad.ufsc.br',
        roles: ['student'],
      },
      {
        id: 40002,
        username: '22100002',
        fullname: 'Bruno Costa (22100002)',
        email: 'bruno@grad.ufsc.br',
        roles: ['student'],
      },
      {
        id: 40003,
        username: '22100003',
        fullname: 'Carla Souza (22100003)',
        email: 'carla@grad.ufsc.br',
        roles: ['student'],
      },
      {
        id: 40004,
        username: '22100004',
        fullname: 'Diego Rocha (22100004)',
        email: 'diego@grad.ufsc.br',
        roles: ['student'],
      },
      {
        id: 40005,
        username: '22100005',
        fullname: 'Elena Martins (22100005)',
        email: 'elena@grad.ufsc.br',
        roles: ['student'],
      },
    ];
    for (const s of seedStudents) {
      this.users.set(s.id, s);
    }

    this.courseEnrollments.set(
      49472,
      new Set([9001, ...seedStudents.map((s) => s.id)])
    );
    // Second course 50000 with restricted grouping 55
    this.courseEnrollments.set(50000, new Set([9001, 38610, 40001]));

    // Seed groups in 49472 mirroring live INE5429: Grupo 1..3, Grupo 5..9 (Grupo 4 deleted!)
    const seedGroups: Array<{ id: number; name: string; members: number[] }> = [
      { id: 70305, name: 'Grupo 1', members: [40001, 40002] },
      { id: 70306, name: 'Grupo 2', members: [40003] },
      { id: 70307, name: 'Grupo 3', members: [] },
      { id: 70309, name: 'Grupo 5', members: [] },
      { id: 70310, name: 'Grupo 6', members: [] },
      { id: 70311, name: 'Grupo 7', members: [] },
      { id: 70312, name: 'Grupo 8', members: [] },
      { id: 70313, name: 'Grupo 9', members: [] },
    ];
    for (const sg of seedGroups) {
      this.groups.set(sg.id, {
        id: sg.id,
        courseid: 49472,
        name: sg.name,
        description: '',
        idnumber: '',
        enrolmentkey: '',
        memberIds: new Set(sg.members),
      });
    }

    // Grouping 55 in course 50000
    this.groupings.set(55, {
      id: 55,
      courseid: 50000,
      name: 'Agrupamento Trabalho Final',
      description: 'Somente grupos do projeto',
      idnumber: 'GP55',
      groupIds: new Set(),
    });

    // Activity 1569070 in course 49472 (mirrors "Registro da Escolha do Grupo", targetGrouping=0, maxMembers=3)
    this.groupSelectModules.set(1569070, {
      cmid: 1569070,
      instanceId: 2275,
      courseId: 49472,
      name: 'Registro da Escolha do Grupo',
      targetGroupingId: 0,
      minMembers: 1,
      maxMembers: 3,
      studentCanCreate: false,
      studentCanJoin: true,
      studentCanLeave: true,
      deleteEmptyGroups: true,
      timeDueYear: 2027,
    });

    // Activity 2569000 in course 50000 with targetGroupingId = 55 and maxMembers = 2
    this.groupSelectModules.set(2569000, {
      cmid: 2569000,
      instanceId: 3001,
      courseId: 50000,
      name: 'Escolha de Duplas com Agrupamento',
      targetGroupingId: 55,
      minMembers: 2,
      maxMembers: 2,
      studentCanCreate: false,
      studentCanJoin: true,
      studentCanLeave: false,
      deleteEmptyGroups: false,
      timeDueYear: 2027,
    });
  }

  private actorHasManageGroups(courseId: number): boolean {
    const enrolled = this.courseEnrollments.get(courseId);
    if (!enrolled || !enrolled.has(this.currentActorUserId)) return false;
    const actor = this.users.get(this.currentActorUserId);
    return Boolean(actor?.roles.includes('editingteacher') || actor?.roles.includes('manager'));
  }

  private isWebAuthenticated(req: http.IncomingMessage): boolean {
    const cookie = req.headers.cookie || '';
    const m = /MoodleSession=([^;\s]+)/.exec(cookie);
    return Boolean(m && this.validSessions.has(m[1]));
  }

  public async start(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const ch of req) {
        chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const postParams = new URLSearchParams(rawBody);

      // 1. Web login controller (/login/index.php)
      if (url.pathname === '/login/index.php') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body>
              <form action="${this.baseUrl}/login/index.php" method="post">
                <input type="hidden" name="logintoken" value="LOGIN_TOK_123" />
                <input type="text" name="username" value="" />
                <input type="password" name="password" value="" />
              </form>
            </body></html>
          `);
          return;
        }

        const u = postParams.get('username');
        const p = postParams.get('password');
        if (u === 'professor.exemplo' && p === SECRET_MOODLE_PASSWORD) {
          const sid = `SID_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          this.validSessions.add(sid);
          res.writeHead(303, {
            'Set-Cookie': `MoodleSession=${sid}; Path=/; HttpOnly`,
            Location: `${this.baseUrl}/my/`,
          });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><input type="hidden" name="logintoken" value="FAIL" /></body></html>');
        return;
      }

      if (url.pathname === '/my/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Dashboard</body></html>');
        return;
      }

      // 2. Web controllers requiring MoodleSession
      if (
        url.pathname.startsWith('/group/') ||
        url.pathname.startsWith('/course/modedit.php') ||
        url.pathname.startsWith('/mod/groupselect/')
      ) {
        if (!this.isWebAuthenticated(req)) {
          res.writeHead(303, { Location: `${this.baseUrl}/login/index.php` });
          res.end();
          return;
        }

        // /course/modedit.php?update=<cmid>
        if (url.pathname === '/course/modedit.php') {
          const cmid = Number(url.searchParams.get('update'));
          const mod = this.groupSelectModules.get(cmid);
          if (!mod || !this.actorHasManageGroups(mod.courseId)) {
            res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>nopermissions</body></html>');
            return;
          }
          const gpOptions = [
            `<option value="0" ${mod.targetGroupingId === 0 ? 'selected' : ''}>Todos os grupos</option>`,
            ...[...this.groupings.values()]
              .filter((gp) => gp.courseid === mod.courseId)
              .map(
                (gp) =>
                  `<option value="${gp.id}" ${mod.targetGroupingId === gp.id ? 'selected' : ''}>${gp.name}</option>`
              ),
          ].join('\n');

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body>
              <form>
                <select name="targetgrouping">${gpOptions}</select>
                <input type="text" name="minmembers" value="${mod.minMembers}" />
                <input type="text" name="maxmembers" value="${mod.maxMembers}" />
                <input type="checkbox" name="timedue[enabled]" value="1" checked />
                <select name="timedue[year]"><option value="${mod.timeDueYear}" selected>${mod.timeDueYear}</option></select>
                <select name="timedue[month]"><option value="11" selected>11</option></select>
                <select name="timedue[day]"><option value="15" selected>15</option></select>
                <select name="timedue[hour]"><option value="23" selected>23</option></select>
                <select name="timedue[minute]"><option value="48" selected>48</option></select>
                <input type="checkbox" name="studentcanjoin" value="1" ${mod.studentCanJoin ? 'checked' : ''} />
                <input type="checkbox" name="studentcanleave" value="1" ${mod.studentCanLeave ? 'checked' : ''} />
                <input type="checkbox" name="studentcancreate" value="1" ${mod.studentCanCreate ? 'checked' : ''} />
                <input type="checkbox" name="deleteemptygroups" value="1" ${mod.deleteEmptyGroups ? 'checked' : ''} />
              </form>
            </body></html>
          `);
          return;
        }

        // /mod/groupselect/view.php?id=<cmid>
        if (url.pathname === '/mod/groupselect/view.php') {
          const cmid = Number(url.searchParams.get('id'));
          const mod = this.groupSelectModules.get(cmid);
          if (!mod) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const rows = [...this.groups.values()]
            .filter((g) => {
              if (g.courseid !== mod.courseId) return false;
              if (mod.targetGroupingId > 0) {
                return Boolean(this.groupings.get(mod.targetGroupingId)?.groupIds.has(g.id));
              }
              return true;
            })
            .map(
              (g) =>
                `<tr><td>${g.name}</td><td>${g.description}</td><td>${g.memberIds.size}/${mod.maxMembers}</td></tr>`
            )
            .join('\n');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><table>${rows}</table></body></html>`);
          return;
        }

        // /group/group.php
        if (url.pathname === '/group/group.php') {
          const courseId = Number(
            req.method === 'GET' ? url.searchParams.get('courseid') : postParams.get('courseid')
          );
          if (!this.actorHasManageGroups(courseId)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><div class="errormessage">Sorry, you do not currently have permissions to do that (Manage groups).</div></body></html>');
            return;
          }

          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <html><body>
                <form action="${this.baseUrl}/group/group.php" method="post">
                  <input type="hidden" name="sesskey" value="${this.sesskey}" />
                  <input type="hidden" name="_qf__group_form" value="1" />
                  <input type="hidden" name="description_editor[itemid]" value="777" />
                  <input type="submit" name="submitbutton" value="Salvar mudanças" />
                </form>
              </body></html>
            `);
            return;
          }

          if (postParams.get('sesskey') !== this.sesskey) {
            res.writeHead(403);
            res.end('Invalid sesskey');
            return;
          }

          const gName = (postParams.get('name') || '').trim();
          const exists = [...this.groups.values()].some(
            (g) => g.courseid === courseId && g.name.toLowerCase() === gName.toLowerCase()
          );
          if (!gName || exists) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <html><body>
                <input type="hidden" name="_qf__group_form" value="1" />
                <div class="invalid-feedback">Um grupo com este nome já existe neste curso</div>
              </body></html>
            `);
            return;
          }

          const newId = this.nextGroupId++;
          this.groups.set(newId, {
            id: newId,
            courseid: courseId,
            name: gName,
            description: postParams.get('description_editor[text]') || '',
            idnumber: postParams.get('idnumber') || '',
            enrolmentkey: postParams.get('enrolmentkey') || '',
            memberIds: new Set(),
          });

          res.writeHead(303, { Location: `${this.baseUrl}/group/index.php?id=${courseId}` });
          res.end();
          return;
        }

        if (url.pathname === '/group/index.php') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body>Groups index</body></html>');
          return;
        }

        // /group/assign.php?id=<groupingId>
        if (url.pathname === '/group/assign.php') {
          const groupingId = Number(url.searchParams.get('id') || postParams.get('id'));
          const gp = this.groupings.get(groupingId);
          if (!gp || !this.actorHasManageGroups(gp.courseid)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }

          if (req.method === 'POST' && postParams.get('sesskey') === this.sesskey) {
            for (const gidStr of postParams.getAll('addselect[]')) {
              gp.groupIds.add(Number(gidStr));
            }
          }

          const assignedOpts = [...gp.groupIds]
            .map((gid) => `<option value="${gid}">${this.groups.get(gid)?.name || gid}</option>`)
            .join('');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body>
              <form method="post">
                <input type="hidden" name="sesskey" value="${this.sesskey}" />
                <select name="removeselect[]" id="removeselect">${assignedOpts}</select>
                <input type="submit" name="add" value="Adicionar" />
              </form>
            </body></html>
          `);
          return;
        }

        // /group/members.php?group=<groupId>
        if (url.pathname === '/group/members.php') {
          const groupId = Number(url.searchParams.get('group') || postParams.get('group'));
          const grp = this.groups.get(groupId);
          if (!grp || !this.actorHasManageGroups(grp.courseid)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body>nopermissions</body></html>');
            return;
          }

          if (req.method === 'POST') {
            if (postParams.get('sesskey') !== this.sesskey) {
              res.writeHead(403);
              res.end('Invalid sesskey');
              return;
            }
            if (postParams.has('add')) {
              for (const uidStr of postParams.getAll('addselect[]')) {
                const uid = Number(uidStr);
                if (this.failAddForUserIds.has(uid)) {
                  res.writeHead(500, { 'Content-Type': 'text/plain' });
                  res.end('Simulated upstream Moodle database lock error');
                  return;
                }
                if (this.courseEnrollments.get(grp.courseid)?.has(uid)) {
                  grp.memberIds.add(uid);
                }
              }
            }
            if (postParams.has('remove')) {
              for (const uidStr of postParams.getAll('removeselect[]')) {
                grp.memberIds.delete(Number(uidStr));
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <html><body>
              <form id="assignform" method="post">
                <input type="hidden" name="sesskey" value="${this.sesskey}" />
                <input type="submit" name="add" value="Adicionar" />
                <input type="submit" name="remove" value="Remover" />
              </form>
            </body></html>
          `);
          return;
        }
      }

      // 3. Official Moodle REST Web Services (/webservice/rest/server.php)
      if (url.pathname === '/webservice/rest/server.php') {
        if (postParams.get('wstoken') !== SECRET_MOODLE_TOKEN) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }));
          return;
        }

        const wsfunction = postParams.get('wsfunction') || '';
        const sendJson = (payload: unknown) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        };

        const baseWsFunctions = [
          'core_webservice_get_site_info',
          'core_enrol_get_users_courses',
          'core_enrol_get_enrolled_users',
          'core_course_get_contents',
          'core_course_get_course_module',
          'core_course_get_user_administration_options',
          'core_group_get_course_groups',
          'core_group_get_course_groupings',
          'core_group_get_activity_allowed_groups',
        ];
        const fullWsExtras = [
          'core_group_create_groups',
          'core_group_get_group_members',
          'core_group_add_group_members',
          'core_group_delete_group_members',
          'core_group_assign_grouping',
          'core_group_get_groupings',
        ];
        const activeFunctions =
          this.transportMode === 'full_ws'
            ? [...baseWsFunctions, ...fullWsExtras]
            : baseWsFunctions;

        if (!activeFunctions.includes(wsfunction)) {
          sendJson({
            exception: 'webservice_access_exception',
            errorcode: 'accessexception',
            message: `Access control exception (${wsfunction} not available on token)`,
          });
          return;
        }

        const actor = this.users.get(this.currentActorUserId)!;

        switch (wsfunction) {
          case 'core_webservice_get_site_info':
            sendJson({
              userid: actor.id,
              username: actor.username,
              fullname: actor.fullname,
              sitename: 'Moodle UFSC Mock',
              siteurl: this.baseUrl,
              functions: activeFunctions.map((name) => ({ name, version: '4.5' })),
            });
            return;

          case 'core_enrol_get_users_courses':
            sendJson([
              { id: 49472, shortname: 'INE5429-07208 (20262)', fullname: 'Segurança em Computação' },
              { id: 50000, shortname: 'INE5458-08208 (20262)', fullname: 'Tópicos Especiais' },
            ]);
            return;

          case 'core_course_get_user_administration_options': {
            const cid = Number(postParams.get('courseids[0]'));
            const canManage = this.actorHasManageGroups(cid);
            sendJson({
              courses: [
                {
                  id: cid,
                  options: [
                    { name: 'update', available: canManage },
                    { name: 'groups', available: canManage },
                  ],
                },
              ],
            });
            return;
          }

          case 'core_enrol_get_enrolled_users': {
            const cid = Number(postParams.get('courseid'));
            const enrolledIds = this.courseEnrollments.get(cid) ?? new Set<number>();
            const courseGroups = [...this.groups.values()].filter((g) => g.courseid === cid);
            const result = [...enrolledIds].map((uid) => {
              const u = this.users.get(uid)!;
              const memberOf = courseGroups
                .filter((g) => g.memberIds.has(uid))
                .map((g) => ({ id: g.id, name: g.name }));
              return {
                id: u.id,
                username: u.username,
                fullname: u.fullname,
                email: u.email,
                roles: u.roles.map((r) => ({ shortname: r, name: r })),
                ...(memberOf.length > 0 ? { groups: memberOf } : {}),
              };
            });
            sendJson(result);
            return;
          }

          case 'core_course_get_contents': {
            const cid = Number(postParams.get('courseid'));
            const mods = [...this.groupSelectModules.values()]
              .filter((m) => m.courseId === cid)
              .map((m) => ({
                id: m.cmid,
                instance: m.instanceId,
                name: m.name,
                modname: 'groupselect',
                visible: 1,
              }));
            sendJson([{ id: 1, name: 'Geral', modules: mods }]);
            return;
          }

          case 'core_course_get_course_module': {
            const cmid = Number(postParams.get('cmid'));
            const mod = this.groupSelectModules.get(cmid);
            if (!mod) {
              sendJson({ exception: 'dml_missing_record_exception', errorcode: 'invalidrecord', message: 'Can not find data record in database table course_modules.' });
              return;
            }
            sendJson({
              cm: {
                id: mod.cmid,
                course: mod.courseId,
                module: 32,
                name: mod.name,
                modname: 'groupselect',
                instance: mod.instanceId,
                visible: 1,
                groupmode: 0,
                groupingid: mod.targetGroupingId,
              },
            });
            return;
          }

          case 'core_group_get_course_groups': {
            const cid = Number(postParams.get('courseid'));
            const list = [...this.groups.values()]
              .filter((g) => g.courseid === cid)
              .map((g) => ({
                id: g.id,
                courseid: g.courseid,
                name: g.name,
                description: g.description,
                descriptionformat: 1,
                enrolmentkey: g.enrolmentkey,
                idnumber: g.idnumber,
              }));
            sendJson(list);
            return;
          }

          case 'core_group_get_course_groupings': {
            const cid = Number(postParams.get('courseid'));
            const list = [...this.groupings.values()]
              .filter((gp) => gp.courseid === cid)
              .map((gp) => ({
                id: gp.id,
                courseid: gp.courseid,
                name: gp.name,
                description: gp.description,
                idnumber: gp.idnumber,
              }));
            sendJson(list);
            return;
          }

          case 'core_group_get_groupings': {
            const gpId = Number(postParams.get('groupingids[0]'));
            const gp = this.groupings.get(gpId);
            if (!gp) {
              sendJson([]);
              return;
            }
            sendJson([
              {
                id: gp.id,
                courseid: gp.courseid,
                name: gp.name,
                groups: [...gp.groupIds].map((gid) => ({
                  id: gid,
                  name: this.groups.get(gid)?.name || '',
                })),
              },
            ]);
            return;
          }

          case 'core_group_get_activity_allowed_groups': {
            const cmid = Number(postParams.get('cmid'));
            const mod = this.groupSelectModules.get(cmid);
            if (!mod) {
              sendJson({ groups: [] });
              return;
            }
            const allowed = [...this.groups.values()]
              .filter((g) => {
                if (g.courseid !== mod.courseId) return false;
                if (mod.targetGroupingId > 0) {
                  return Boolean(this.groupings.get(mod.targetGroupingId)?.groupIds.has(g.id));
                }
                return true;
              })
              .map((g) => ({ id: g.id, name: g.name, courseid: g.courseid }));
            sendJson({ groups: allowed, canaccessallgroups: true });
            return;
          }

          case 'core_group_create_groups': {
            const cid = Number(postParams.get('groups[0][courseid]'));
            if (!this.actorHasManageGroups(cid)) {
              sendJson({ exception: 'required_capability_exception', errorcode: 'nopermissions', message: 'Sorry, you do not currently have permissions to do that (Manage groups)' });
              return;
            }
            const name = (postParams.get('groups[0][name]') || '').trim();
            const newId = this.nextGroupId++;
            const created: MockGroup = {
              id: newId,
              courseid: cid,
              name,
              description: postParams.get('groups[0][description]') || '',
              idnumber: postParams.get('groups[0][idnumber]') || '',
              enrolmentkey: postParams.get('groups[0][enrolmentkey]') || '',
              memberIds: new Set(),
            };
            this.groups.set(newId, created);
            sendJson([{ id: newId, courseid: cid, name }]);
            return;
          }

          case 'core_group_assign_grouping': {
            const gpId = Number(postParams.get('assignments[0][groupingid]'));
            const gId = Number(postParams.get('assignments[0][groupid]'));
            this.groupings.get(gpId)?.groupIds.add(gId);
            sendJson(null);
            return;
          }

          case 'core_group_get_group_members': {
            const gId = Number(postParams.get('groupids[0]'));
            const grp = this.groups.get(gId);
            sendJson([{ groupid: gId, userids: grp ? [...grp.memberIds] : [] }]);
            return;
          }

          case 'core_group_add_group_members': {
            const gId = Number(postParams.get('members[0][groupid]'));
            const uId = Number(postParams.get('members[0][userid]'));
            const grp = this.groups.get(gId);
            if (!grp || !this.actorHasManageGroups(grp.courseid)) {
              sendJson({ exception: 'required_capability_exception', errorcode: 'nopermissions', message: 'nopermissions' });
              return;
            }
            if (this.failAddForUserIds.has(uId)) {
              sendJson({ exception: 'moodle_exception', errorcode: 'dmlwriteexception', message: 'Simulated WS write error' });
              return;
            }
            grp.memberIds.add(uId);
            sendJson(null);
            return;
          }

          case 'core_group_delete_group_members': {
            const gId = Number(postParams.get('members[0][groupid]'));
            const uId = Number(postParams.get('members[0][userid]'));
            this.groups.get(gId)?.memberIds.delete(uId);
            sendJson(null);
            return;
          }
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address() as { port: number };
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  public async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

async function callJsonTool(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = (res.content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === 'text'
  );
  const parsed = JSON.parse(textBlock?.text || '{}');
  return { isError: Boolean(res.isError), body: parsed, rawText: textBlock?.text || '' };
}

describe('UFSC Moodle MCP Group Management & mod_groupselect Suite', () => {
  const mockMoodle = new StatefulMockMoodleServer();
  let mcpServer: MoodleHttpServerInstance;
  let mcpClient: Client;
  let tempDir: string;
  let auditLogPath: string;

  async function rebuildMcpClient(mode: 'web_controller_fallback' | 'full_ws'): Promise<void> {
    if (mcpClient) {
      await mcpClient.close().catch(() => {});
    }
    if (mcpServer) {
      await mcpServer.close().catch(() => {});
    }

    mockMoodle.transportMode = mode;

    const config: MoodleConfig = {
      siteUrl: mockMoodle.baseUrl,
      restEndpoint: `${mockMoodle.baseUrl}/webservice/rest/server.php`,
      token: SECRET_MOODLE_TOKEN,
      username: 'professor.exemplo',
      password: SECRET_MOODLE_PASSWORD,
      tempDir,
      fileTtlSeconds: 600,
      maxDownloadBytes: 10 * 1024 * 1024,
      downloadTimeoutMs: 10_000,
      auditLogPath,
    };

    mcpServer = createMoodleHttpServer({ config, authToken: MCP_BEARER_TOKEN });
    await new Promise<void>((resolve) => {
      mcpServer.httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (mcpServer.httpServer.address() as { port: number }).port;
    const mcpUrl = new URL(`http://127.0.0.1:${port}/${MCP_BEARER_TOKEN}`);

    mcpClient = new Client({ name: 'group-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await mcpClient.connect(transport);
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-groups-test-'));
    auditLogPath = path.join(tempDir, 'group-audit.jsonl');
    await mockMoodle.start();
    await rebuildMcpClient('web_controller_fallback');
  });

  afterAll(async () => {
    if (mcpClient) await mcpClient.close().catch(() => {});
    if (mcpServer) await mcpServer.close().catch(() => {});
    await mockMoodle.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('1. inspects course groups, mod_groupselect configuration, and generates unique name skipping deleted gap (Grupo 4 -> Grupo 10)', async () => {
    const tools = await mcpClient.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'get_course_groups',
        'get_group_members',
        'create_course_group',
        'add_group_member',
        'remove_group_member',
        'create_group_with_members',
      ])
    );

    const { isError, body } = await callJsonTool(mcpClient, 'get_course_groups', {
      courseId: 49472,
      activityCmid: 1569070,
    });

    expect(isError).toBe(false);
    expect(body.courseId).toBe(49472);
    expect(body.groupsCount).toBe(8);
    expect(body.nextSuggestedGroupName).toBe('Grupo 10');
    expect(body.permissions.hasManageGroups).toBe(true);

    expect(body.groupSelectActivities).toHaveLength(1);
    const gs = body.groupSelectActivities[0];
    expect(gs.cmid).toBe(1569070);
    expect(gs.targetGroupingId).toBe(0);
    expect(gs.minMembers).toBe(1);
    expect(gs.maxMembers).toBe(3);
    expect(gs.permissions.studentCanCreate).toBe(false);
    expect(gs.permissions.studentCanJoin).toBe(true);
    expect(gs.permissions.deleteEmptyGroups).toBe(true);
  });

  it('2. creates a unique group via web-controller fallback, adds student 38610, confirms state, and enforces idempotency on retries', async () => {
    // Create unique group (auto-named "Grupo 10")
    const create1 = await callJsonTool(mcpClient, 'create_course_group', {
      courseId: 49472,
      activityCmid: 1569070,
      idempotencyKey: 'idem-create-grupo10',
    });
    expect(create1.isError).toBe(false);
    expect(create1.body.status).toBe('created');
    expect(create1.body.created).toBe(true);
    expect(create1.body.groupName).toBe('Grupo 10');
    expect(create1.body.availableInActivity).toBe(true);
    expect(create1.body.maxMembers).toBe(3);
    const newGroupId = create1.body.groupId as number;

    // Repeat create_course_group with same idempotencyKey (simulating timeout retry) -> NO Grupo 11 created!
    const createRetry = await callJsonTool(mcpClient, 'create_course_group', {
      courseId: 49472,
      activityCmid: 1569070,
      idempotencyKey: 'idem-create-grupo10',
    });
    expect(createRetry.isError).toBe(false);
    expect(createRetry.body.idempotentReplay).toBe(true);
    expect(createRetry.body.created).toBe(false);
    expect(createRetry.body.groupId).toBe(newGroupId);
    expect(createRetry.body.groupName).toBe('Grupo 10');

    // Add student 38610
    const add1 = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: newGroupId,
      userId: 38610,
      courseId: 49472,
      activityCmid: 1569070,
      idempotencyKey: 'idem-add-38610',
    });
    expect(add1.isError).toBe(false);
    expect(add1.body.status).toBe('added');
    expect(add1.body.addedMembers).toHaveLength(1);
    expect(add1.body.addedMembers[0].id).toBe(38610);
    expect(add1.body.confirmedMembers.map((m: any) => m.id)).toEqual([38610]);
    expect(add1.body.remainingSlots).toBe(2);
    expect(add1.body.availableInActivity).toBe(true);

    // Repeat add_group_member -> idempotent replay without error or duplicate
    const addRetry = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: newGroupId,
      userId: 38610,
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(addRetry.isError).toBe(false);
    expect(addRetry.body.status).toBe('already_member_idempotent');
    expect(addRetry.body.idempotentReplay).toBe(true);
    expect(addRetry.body.confirmedMembers).toHaveLength(1);

    // Re-query get_group_members to verify persisted state
    const membersCheck = await callJsonTool(mcpClient, 'get_group_members', {
      groupId: newGroupId,
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(membersCheck.isError).toBe(false);
    expect(membersCheck.body.memberCount).toBe(1);
    expect(membersCheck.body.availableInActivity).toBe(true);
    expect(membersCheck.body.members[0].fullname).toContain('Pedro Aluno Exemplo');

    // Remove and re-remove idempotently
    const rem1 = await callJsonTool(mcpClient, 'remove_group_member', {
      groupId: newGroupId,
      userId: 38610,
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(rem1.isError).toBe(false);
    expect(rem1.body.status).toBe('removed');
    expect(rem1.body.confirmedMembers).toHaveLength(0);

    const remRetry = await callJsonTool(mcpClient, 'remove_group_member', {
      groupId: newGroupId,
      userId: 38610,
      courseId: 49472,
    });
    expect(remRetry.isError).toBe(false);
    expect(remRetry.body.status).toBe('already_absent_idempotent');
    expect(remRetry.body.idempotentReplay).toBe(true);
  });

  it('3. blocks overwriting/reusing pre-existing groups, non-existent groups, unenrolled students, multi-group conflicts, and maxMembers overflow', async () => {
    // 3a. Pre-existing group name conflict (Grupo 1)
    const conflict = await callJsonTool(mcpClient, 'create_course_group', {
      courseId: 49472,
      name: 'Grupo 1',
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.body.errorCode).toBe('group_name_conflict');
    expect(conflict.body.suggestedUniqueName).toBe('Grupo 11');

    // 3b. Non-existent group (group_not_found)
    const missingGrp = await callJsonTool(mcpClient, 'get_group_members', {
      groupId: 999999,
      courseId: 49472,
    });
    expect(missingGrp.isError).toBe(true);
    expect(missingGrp.body.errorCode).toBe('group_not_found');

    const missingAdd = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: 999999,
      userId: 38610,
      courseId: 49472,
    });
    expect(missingAdd.isError).toBe(true);
    expect(missingAdd.body.errorCode).toBe('group_not_found');

    // 3c. Student not enrolled in course (user_not_enrolled)
    const unenrolled = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: 70307, // Grupo 3 (empty)
      userId: 888888,
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(unenrolled.isError).toBe(true);
    expect(unenrolled.body.errorCode).toBe('user_not_enrolled');

    // 3d. Student already in another group in same mod_groupselect (40001 is in Grupo 1)
    const dupGroup = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: 70307, // Grupo 3
      userId: 40001,
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(dupGroup.isError).toBe(true);
    expect(dupGroup.body.errorCode).toBe('user_already_in_another_group');

    // 3e. Max participant limit exceeded (Grupo 1 already has 2/3 members; adding 2 more = 4 > 3)
    const overflow = await callJsonTool(mcpClient, 'add_group_member', {
      groupId: 70305, // Grupo 1 (has 40001, 40002)
      userIds: [40004, 40005],
      courseId: 49472,
      activityCmid: 1569070,
    });
    expect(overflow.isError).toBe(true);
    expect(overflow.body.errorCode).toBe('max_members_exceeded');

    // Also pre-blocked in create_group_with_members before creating any group
    const groupsBefore = mockMoodle.groups.size;
    const createOverflow = await callJsonTool(mcpClient, 'create_group_with_members', {
      courseId: 49472,
      activityCmid: 1569070,
      userIds: [38610, 40004, 40005, 9001], // 4 > maxMembers(3)
    });
    expect(createOverflow.isError).toBe(true);
    expect(createOverflow.body.errorCode).toBe('max_members_exceeded');
    expect(mockMoodle.groups.size).toBe(groupsBefore);
  });

  it('4. enforces moodle/course:managegroups capability (insufficient_permissions)', async () => {
    mockMoodle.currentActorUserId = 38610; // Switch authenticated identity to student
    try {
      // Rebuild client so cached siteInfo reflects student identity
      await rebuildMcpClient('web_controller_fallback');

      const deniedCreate = await callJsonTool(mcpClient, 'create_course_group', {
        courseId: 49472,
        activityCmid: 1569070,
      });
      expect(deniedCreate.isError).toBe(true);
      expect(deniedCreate.body.errorCode).toBe('insufficient_permissions');

      const deniedAdd = await callJsonTool(mcpClient, 'add_group_member', {
        groupId: 70307,
        userId: 38610,
        courseId: 49472,
      });
      expect(deniedAdd.isError).toBe(true);
      expect(deniedAdd.body.errorCode).toBe('insufficient_permissions');
    } finally {
      mockMoodle.currentActorUserId = 9001;
      await rebuildMcpClient('web_controller_fallback');
    }
  });

  it('5. handles partial failure during create_group_with_members and recovers idempotently on retry', async () => {
    // Simulate transient Moodle error when adding user 40005, while 40004 succeeds
    mockMoodle.failAddForUserIds.add(40005);

    const partial = await callJsonTool(mcpClient, 'create_group_with_members', {
      courseId: 49472,
      activityCmid: 1569070,
      userIds: [40004, 40005],
      idempotencyKey: 'idem-partial-dupla',
    });

    expect(partial.isError).toBe(true);
    expect(partial.body.status).toBe('partial_failure');
    expect(partial.body.groupCreated).toBe(true);
    expect(partial.body.groupName).toBe('Grupo 11');
    expect(partial.body.addedMembers.map((m: any) => m.id)).toEqual([40004]);
    expect(partial.body.failedMembers).toHaveLength(1);
    expect(partial.body.failedMembers[0].userId).toBe(40005);
    expect(partial.body.confirmedMembers.map((m: any) => m.id)).toEqual([40004]);

    const createdGroupId = partial.body.groupId as number;

    // Clear upstream fault and retry the exact same call with the same idempotencyKey:
    // Must reuse Grupo 11 (not create Grupo 12), keep 40004, and add 40005!
    mockMoodle.failAddForUserIds.delete(40005);

    const recovered = await callJsonTool(mcpClient, 'create_group_with_members', {
      courseId: 49472,
      activityCmid: 1569070,
      userIds: [40004, 40005],
      idempotencyKey: 'idem-partial-dupla',
    });

    expect(recovered.isError).toBe(false);
    expect(recovered.body.status).toBe('created_with_members');
    expect(recovered.body.groupId).toBe(createdGroupId);
    expect(recovered.body.groupCreated).toBe(false);
    expect(recovered.body.alreadyMembers.map((m: any) => m.id)).toEqual([40004]);
    expect(recovered.body.addedMembers.map((m: any) => m.id)).toEqual([40005]);
    expect(recovered.body.confirmedMembers.map((m: any) => m.id).sort()).toEqual([40004, 40005]);

    // Also verify prevalidateAllMembers=false partial failure when 1 student is enrolled and 1 is unenrolled
    const mixedPartial = await callJsonTool(mcpClient, 'create_group_with_members', {
      courseId: 49472,
      activityCmid: 1569070,
      userIds: [38610, 777666],
      prevalidateAllMembers: false,
      idempotencyKey: 'idem-mixed-partial',
    });
    expect(mixedPartial.isError).toBe(true);
    expect(mixedPartial.body.status).toBe('partial_failure');
    expect(mixedPartial.body.groupCreated).toBe(true);
    expect(mixedPartial.body.addedMembers.map((m: any) => m.id)).toEqual([38610]);
    expect(mixedPartial.body.failedMembers).toEqual([
      expect.objectContaining({ userId: 777666, errorCode: 'user_not_enrolled' }),
    ]);
    expect(mixedPartial.body.confirmedMembers.map((m: any) => m.id)).toEqual([38610]);
  });

  it('6. supports full official Moodle WS mode and auto-assigns new groups to mod_groupselect targetGroupingId > 0', async () => {
    await rebuildMcpClient('full_ws');

    // Course 50000 has mod_groupselect cmid=2569000 restricted to groupingId=55 and maxMembers=2
    const created = await callJsonTool(mcpClient, 'create_group_with_members', {
      courseId: 50000,
      activityCmid: 2569000,
      name: 'Dupla Criptografia 01',
      userIds: [38610, 40001],
      idempotencyKey: 'ws-grouping-55-test',
    });

    expect(created.isError).toBe(false);
    expect(created.body.status).toBe('created_with_members');
    expect(created.body.availableInActivity).toBe(true);
    expect(created.body.maxMembers).toBe(2);
    expect(created.body.remainingSlots).toBe(0);
    expect(created.body.confirmedMembers).toHaveLength(2);
    expect(mockMoodle.groupings.get(55)?.groupIds.has(created.body.groupId)).toBe(true);
  });

  it('7. writes structured JSONL audit log entries with zero secret leakage', async () => {
    expect(fs.existsSync(auditLogPath)).toBe(true);
    const rawAudit = fs.readFileSync(auditLogPath, 'utf8');
    expect(rawAudit).not.toContain(SECRET_MOODLE_TOKEN);
    expect(rawAudit).not.toContain(SECRET_MOODLE_PASSWORD);
    expect(rawAudit).not.toContain(MCP_BEARER_TOKEN);

    const entries = rawAudit
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as GroupAuditEntry);

    expect(entries.length).toBeGreaterThanOrEqual(8);
    const outcomes = new Set(entries.map((e) => e.outcome));
    expect(outcomes.has('succeeded')).toBe(true);
    expect(outcomes.has('idempotent_replay')).toBe(true);
    expect(outcomes.has('partial_failure')).toBe(true);
    expect(outcomes.has('failed')).toBe(true);

    const transports = new Set(entries.map((e) => e.transportUsed));
    expect(transports.has('moodle_web_controller')).toBe(true);
    expect(transports.has('moodle_ws')).toBe(true);
  });
});
