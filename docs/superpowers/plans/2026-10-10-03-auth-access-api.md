# Hydra Browsers v1 — Plan 03: Auth, Access, and API Base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the login sessions, the brute-force protection, the admin user actions, the session access rules, the agent tokens, the Fastify app with its two host scopes and its dashboard API routes, the audit SSE stream, the static dashboard serving, `main.ts`, and the `hydra` CLI of `@hydra/server`.

**Architecture:** Four service modules (`auth/`, `users/`, `access/`, `tokens/`) hold all rules and own their queries on the shared Drizzle schema; each service gets a `deps` object. `api/` turns HTTP requests into service calls and turns errors into the spec error format. `buildApp` creates one Fastify instance with a public-host scope (dashboard and API; plan 05 adds the MCP endpoint), a live-host scope (plan 06 fills it), and `/healthz` and `/readyz` without a host constraint.

**Tech Stack:** Node.js 24.21.0, TypeScript 6.0.3 (strict ESM), Fastify 5.12.5, `@fastify/static` 10.1.5, zod 4.6.5, drizzle-orm 0.45.3 with better-sqlite3 13.0.3, pino 10.4.0, Vitest 5.0.3, tsx 4.23.15.

**Spec:** `docs/superpowers/specs/2026-10-10-hydra-browsers-design.md`, sections 3.1 (modules, CLI), 6.3, 6.4, 6.5, 6.6, 6.8 (dashboard origin), 12 (error format and the routes of this plan), 13.3 (daily jobs), 14, and the parts of 15.1 and 15.2 that belong to these modules.

**Index:** `docs/superpowers/plans/2026-10-10-00-index.md`, sections 2, 3, 4, 5.8, 5.9, and 5.12.

## Global Constraints

- Exact versions only, no ranges (spec 3.4.1). This plan adds `fastify` `5.12.5` and `@fastify/static` `10.1.5` (the versions of plan 01, "Library versions for later plans"). pnpm enforces the 7-day minimum release age.
- No other runtime dependencies (index 2.3). Cookies, the CSRF check, the rate limiter, and SSE are small helpers in the repo. `@fastify/static` is permitted for the dashboard build (reason in Task 15).
- Do not commit (AGENTS.md rule 1). Each task ends with the Checkpoint step of index section 3. Do not edit the spec.
- TypeScript strict ESM. Relative imports end in `.js`. No `enum`, `namespace`, or constructor parameter properties (`erasableSyntaxOnly`).
- Services get a `deps` object. Time comes only from `Clock`. Services throw `HydraError`. Only `api/errors.ts` builds HTTP error responses (index 2.4). Database functions are synchronous; Argon2 calls are asynchronous.
- Error format (spec 12.2): `{ "error": { "code": "<code>", "message": "<text>", "fields": { … } } }`; `fields` only for `validation_failed`.
- Login session cookie (spec 6.4): `__Host-hydra_session`, 32 random bytes base64url, `HttpOnly; Secure; SameSite=Lax; Path=/`. The database stores only the HMAC (subkey `loginSession`). Idle timeout 12 h, maximum life 7 days, a new value at each login, logout deletes the row.
- CSRF (spec 6.4, index 5.9): each `/api/*` request that is not `GET`/`HEAD` needs `Origin` equal to `HYDRA_PUBLIC_URL`, `Content-Type: application/json`, and a JSON body, else 403 `csrf_failed`. The dashboard sends `{}` when it has no data.
- Brute force (spec 6.4): 10 login attempts per minute for each IP; for each pair of email and IP, after 5 failures a 15 min wait that doubles with each further failure up to 24 h (429 `rate_limited` with `Retry-After`), also for an email that does not exist; the account locks after 100 failures in a row; a wrong password, an unknown email, and a locked account give the same 401 body after an Argon2 verify.
- Password rules (spec 6.3): 12 to 128 characters, not in the bundled common password list (case-insensitive), not equal to the email.
- A user without `session.read` gets 404 `not_found`, never 403 (spec 6.5). A disabled user has no rights.
- Dashboard headers (spec 6.8): `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src <HYDRA_LIVE_URL>; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`, `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- Prettier: `printWidth` 100, `singleQuote`, `semi`, `trailingComma: all`. ESLint: the flat config of plan 01 (`tseslint.configs.recommended`). The code of this plan also passes `tseslint.configs.recommendedTypeChecked`.

## What plans 01 and 02 give this plan

| Import | From |
|---|---|
| All of index 5.1, and `AUDIT_STATUSES`, `AUDIT_PAGE_DEFAULT_LIMIT`, `AUDIT_PAGE_MAX_LIMIT` (plan 02, index issue 7) | `@hydra/shared` |
| `Clock`, `systemClock` | `packages/server/src/lib/clock.ts` |
| `HydraError` | `packages/server/src/lib/errors.ts` |
| `Logger`, `createLogger` | `packages/server/src/lib/logger.ts` |
| `Config`, `ConfigError`, `loadConfig` | `packages/server/src/config/index.ts` |
| `Subkeys`, `deriveSubkeys`, `hmac`, `randomBase64Url`, `newUlid`, `newSid`, `newAgentToken`, `generateRootKey`, `PasswordHasher` | `packages/server/src/crypto/index.ts` |
| `Db`, `openDb` (async: `Promise<OpenedDb>`), `openSqlite`, `DB_FILE`, `backupDb` | `packages/server/src/db/index.ts` |
| `users`, `loginSessions`, `sessions`, `sessionMembers`, `agentTokens`, `liveGrants`, `auditEvents`, `SessionRow` | `packages/server/src/db/schema.ts` |
| `EventBus`, `HydraEvent` | `packages/server/src/events/index.ts` |
| `AuditWriter`, `AuditInput`, `runAuditRetention`, `toAuditEvent` | `packages/server/src/audit/index.ts` |
| `FakeClock` (default start 2026-10-10 12:00 UTC), `testConfig()`, `createTestDb()` (synchronous) | `packages/server/test/helpers/{clock,config,db}.ts` |

Plan 01 gives the root dev tools (TypeScript 6.0.3, Vitest 5.0.3, tsx 4.23.15, ESLint, Prettier), the Vitest wiring of the `@hydra/source` condition, and `packages/server/package.json` with the `build` script `tsc -p tsconfig.build.json`.

Before Task 1, check that plans 01 and 02 are in place:

Run: `pnpm --filter @hydra/server test`
Expected: PASS (the tests of plan 02).

## Verified facts (scratch checks on 2026-10-10)

- All code of this plan ran, task by task in this order, in a scratch workspace with the contracts of index 5.1 to 5.7 (shaped as plan 02 writes them, with the async `openDb`). After each task, `tsc` (TypeScript 6.0.3 and 7.0.2), Vitest 5.0.3, ESLint 10.12.0 with typescript-eslint 8.71.0 (`recommended` and `recommendedTypeChecked`), and `prettier --check` (3.9.9) passed: 274 tests at the end.
- pnpm 12.9.0 with the settings of spec 3.4.3 adds `fastify@5.12.5` and `@fastify/static@10.1.5` without trust-policy or release-age errors and without install scripts. The transitive `light-my-request` resolves to 6.6.0 (6.8.0 was published on 2026-10-10).
- Fastify 5.12.5:
  - An `onRoute` hook in an encapsulated scope that sets `route.constraints.host` applies to every route of that scope, also to the routes of `@fastify/static` (it uses `fastify-plugin`). Requests for any other host reach the root not-found handler.
  - The host constraint compares the whole `Host` header: `hydra.localhost:8080` does not match `hydra.localhost`. `config.publicUrl.host` contains the port when the URL has one.
  - **`POST /%61pi/auth/login` runs the route `/api/auth/login`, and `request.url` stays `/%61pi/auth/login`.** Hooks must test `request.routeOptions.url` (the route pattern), never the raw URL.
  - `trustProxy: ['10.42.0.0/16']` (a CIDR list) takes the client address from `X-Forwarded-For` only if the peer is in the list; `trustProxy: []` trusts nobody. `inject({ remoteAddress })` sets the peer.
  - The default JSON parser throws `FST_ERR_CTP_EMPTY_JSON_BODY` (empty body), `FST_ERR_CTP_INVALID_JSON_BODY` (broken JSON), and `FST_ERR_CTP_BODY_TOO_LARGE` (413). It parses `text/plain` bodies too, so the CSRF check must test the `Content-Type`. DELETE bodies are parsed. A malformed URL (`/api/%zz`) does not reach `setErrorHandler`; the `frameworkErrors` option formats it.
  - `Fastify({ loggerInstance: pinoLogger })` returns `FastifyInstance<…, pino.Logger>`, which is not assignable to `FastifyInstance`. Assigning the logger to a `FastifyBaseLogger` variable first fixes the type.
  - A sync handler can return a value or `reply.code(…).send(…)`; a sync hook with `done` passes thrown errors to the error handler.
  - `reply.hijack()` and writes to `reply.raw` work with `inject({ payloadAsStream: true })`; headers set by earlier hooks are in `reply.getHeaders()`. `app.close()` waits for open SSE sockets, so a `preClose` hook must close them.
- `@fastify/static` 10.1.5: `setHeaders(reply, path, stat)` gets the Fastify reply (not the raw response). `wildcard: false` registers one route for each file at start; a missing root only logs a warning. Headers set in an `onRequest` hook stay on files and on 304 responses. `/../x` and `/%2e%2e/x` do not leave the root.
- zod 4.6.5: `ZodError.issues[].path` is an array (empty for the root). `z.coerce.number()` turns query strings into numbers.
- SecLists: `Passwords/Common-Credentials/10-million-password-list-top-100000.txt` was removed on 2025-05-08 (commit `4ff3ff8ef6b1c429db800e4a9b9deeac7425c5b6`, "Removed duplicate wordlists"; the content lives on as `xato-net-10-million-passwords-100000.txt`). The pinned commit `f0ab72480bfda61feaa9131f6ef2f08a0dea78d6` (2024-01-07, `gh api repos/danielmiessler/SecLists/commits?path=…`) is the last commit that changed the file; the parent of the removal commit has the same bytes. File: SHA-256 `e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188`, 781,959 bytes, 100,007 lines, ASCII, LF line ends; 489 entries have 12 or more characters.
- `@node-rs/argon2` with m = 64 MiB, t = 3: one hash takes about 110 ms and one verify about 60 ms on an M-series Mac. Integration tests use the real `PasswordHasher`; unit tests use `plainHasher` (Task 3).
- Other processes on this machine can hold ports (`127.0.0.1:18080` was taken during the checks). The smoke runs of Tasks 16 and 17 pick a free port.

## File Structure

All paths are in `packages/server/`.

| File | Responsibility | Task |
|---|---|---|
| `package.json` | `build` copies the password list (1); `fastify` (8); `@fastify/static` (15); `bin` and the `hydra` script (17) | 1, 8, 15, 17 |
| `src/auth/common-passwords.txt` | The pinned SecLists list | 1 |
| `src/auth/passwords.ts` | Password rules, one-time passwords | 1 |
| `src/auth/cookies.ts` | Cookie parse and serialize, the login session cookie | 2 |
| `src/auth/csrf.ts` | The header part of the CSRF check | 2 |
| `src/auth/rate-limit.ts` | `RateLimiter`, `RateLimitedError` | 2 |
| `src/auth/throttle.ts` | Login throttle for each pair of email and IP | 2 |
| `src/auth/types.ts` | `AuthedUser`, `LoginContext` | 3 |
| `src/auth/service.ts` | `AuthService`: login, logout, resolve, password change, lock, cleanup | 3 |
| `src/auth/index.ts` | Public interface of `auth/` | 3 |
| `src/access/rules.ts` | The table of spec 6.5: `authorize`, `effectiveRole`, `rightsOf`, `nekoProfileOf` | 4 |
| `src/access/service.ts`, `src/access/index.ts` | `AccessService`: session view, `requireSession`, members | 5 |
| `src/tokens/service.ts`, `src/tokens/index.ts` | `TokensService` | 6 |
| `src/users/service.ts`, `src/users/index.ts` | `UsersService` | 7 |
| `src/api/errors.ts` | Errors → HTTP responses (spec 12.2) | 8 |
| `src/api/context.ts` | `request.login`, `requireLogin`, `requireAdmin`, `requestInfo` | 8 |
| `src/api/sse.ts` | `openSse`, `closeAllSse` | 8 |
| `src/static/headers.ts` | The dashboard headers of spec 6.8 | 9 |
| `src/api/health.ts` | `/healthz`, `/readyz` | 9 |
| `src/api/auth.ts` | Login, logout, me, password routes | 9 |
| `src/app.ts` | `AppDeps`, `buildApp` (Tasks 10 to 13 and 15 add their routes) | 9 |
| `src/api/users.ts` | Admin user routes | 10 |
| `src/api/members.ts` | Member routes | 11 |
| `src/api/tokens.ts` | Token routes | 12 |
| `src/api/audit.ts` | Audit list and the audit SSE stream | 13 |
| `src/static/index.ts` | `registerStatic` (dashboard build, SPA fallback) | 15 |
| `src/main.ts` | Composition, listen, daily jobs, SIGTERM | 16 |
| `src/cli/prompt.ts`, `src/cli/commands.ts`, `src/cli/main.ts` | The `hydra` CLI | 17 |
| `test/helpers/seed.ts` | `seedUser`, `seedSession`, `plainHasher` (Task 3); `loginAs` (Task 9) | 3, 9 |
| `test/helpers/app.ts` | `createTestApp`, `apiRequest`, `errorOf` | 9 |
| `test/integration/*.test.ts` | Integration tests of spec 15.2 for these modules | 9 to 15 |

Unit tests are next to the code (`src/**/*.test.ts`).

## Decisions where the spec is silent

- `POST /api/auth/login` answers 200 with `Me` (the body of `GET /api/auth/me`) and the `Set-Cookie` header. A login that carries a valid old cookie ends that old login session.
- Create routes answer 201. DELETE routes, logout, and the password change answer 204 without a body.
- `GET /api/users` returns `UserSummary[]` sorted by email. `GET /api/sessions/:sid/tokens` returns `Token[]`: all tokens of the session, newest first, revoked and expired ones too.
- A disabled user cannot log in: 401 `invalid_credentials` (audit reason `disabled`), with the same Argon2 verify. `resolve()` also ends the login sessions of a disabled user.
- `POST /api/auth/password`: a wrong current password gives 400 `password_rejected`; at most 10 attempts per minute for each user (429); the new password must differ from the current one.
- An admin cannot change the own `role` or `status` (409 `conflict`), so the team cannot lose its last admin by accident. The display name can change.
- The login session cookie has no `Max-Age` (spec 6.4 lists the attributes); the server enforces the 12 h idle timeout and the 7 days.
- `last_seen_at` is written at most one time per minute for each login session (like `last_used_at` of tokens).
- Adding the owner as a member or adding an existing member gives 409 `conflict`; an unknown email gives 404 `not_found`; changing or removing the owner gives 409 `conflict` (spec 6.5: "The owner cannot be removed or changed").
- Revoking a revoked token is a no-op (204, no second audit event, no second bus event).
- The daily cleanup job also deletes expired `live_grants` rows (`AuthService.cleanupExpired`).
- SSE streams close at once when the gateway stops (`preClose` hook). The 10 s grace of spec 14 applies to open HTTP requests here, and to the MCP streams and WebSockets of plans 05 and 06.
- `hydra user create` without `--admin` creates a member; `--name` sets the display name (default: the part of the email before `@`). `hydra user reset-password --email <e>` asks for the new password two times, ends the lock and all login sessions, and clears `must_change_password`. Without a TTY, the CLI reads one line for each password (`printf 'pw\npw\n' | hydra …`).
- The dashboard build folder is `AppDeps.webRoot`. `main.ts` uses `<server package root>/public` if it has `index.html`, else it serves only the API (development uses the Vite dev server).
- `/healthz` and `/readyz` log only warnings (`logLevel: 'warn'`), because the kubelet calls them every few seconds.

## Review Focus

Failure modes that the spec implies and that a person meets first. Each line names the test that pins it.

1. A percent-encoded API path (`POST /%61pi/auth/logout`) must not skip the CSRF check or the `must_change_password` gate: Fastify routes it to `/api/auth/logout` while `request.url` stays encoded. Pinned by `csrf.test.ts` "cannot be skipped with a percent-encoded path" (Task 9) and `context.test.ts` "uses the route pattern, not the raw URL" (Task 8).
2. A second login in the same browser must end the login session of the old cookie and give a new value. Pinned by `auth.test.ts` "gives a new cookie value at each login and ends the login session of the old cookie" (Task 9).
3. An admin who disables or demotes the own account would leave the team without an admin, and the CLI cannot enable a user. Pinned by `service.test.ts` "does not let an admin change the own role or status" (Task 7) and `users.test.ts` (Task 10).
4. Emails with other case or spaces (`' Alice@Example.COM '`) must find the same account at login, user create, member add, and CLI reset. Pinned by `auth/service.test.ts` (Task 3), `access/service.test.ts` (Task 5), `users/service.test.ts` (Task 7), `auth.test.ts` (Task 9), and `commands.test.ts` (Task 17).
5. Open SSE streams must not block `app.close()` (gateway stop and test teardown). Pinned by `sse.test.ts` "closeAllSse ends every open stream of the server" (Task 8), by `audit.test.ts` (Task 13, whose open streams end in `t.close()`), and by the smoke run of Task 16.

## Spec deviations

1. **HTTP 413** for a body over 1 MiB uses the code `validation_failed` (with `fields.body`). Spec 12.2 maps `validation_failed` to 400 and has no code for 413; spec 8.2 names 413 for the body limit. Index issue 4 proposes a code.
2. **HTTP 500**: an unexpected error answers `{ "error": { "code": "internal", "message": "Internal server error." } }`. Spec 12.2 has no row for 500, and `internal` is not in its code list. Index issue 4.
3. **Module dependencies** (spec 3.1 table): `access/` and `tokens/` import only the types `AuthedUser` and `LoginContext` from `auth/types.ts` (type-only imports, erased at runtime). `users/` calls `revokeAllCreatedBy` of `TokensService` through the structural interface `TokenRevoker`, without an import of `tokens/`, because spec 6.3 requires a disable to revoke the tokens and the table lists only `auth`, `db`, `audit`, and `events` for `users/`. `main.ts` wires the real `TokensService` in.

## Index issues

1. **`AppDeps.webRoot: string | null`** (new field of plan 03). `buildApp` serves the dashboard build from it, or no dashboard for `null` (tests, development). `main.ts` uses `<server package root>/public` when it has `index.html`. **Plan 08:** copy the files of `packages/web/dist/` into `public/` next to `dist/` in the gateway image (with `pnpm deploy … /app`: `/app/public`).
2. **Additions to index 5.8:**
   - `AuthService.cleanupExpired(): { loginSessions: number; liveGrants: number }` (daily job of spec 13.3). It also deletes expired `live_grants`; plan 06 may move that part into `LiveService`.
   - `AccessService.can(userId, sessionId, action): boolean`: reads the user row again (role, status) and applies `authorize`. `TokensService.isValid`, the audit SSE stream, and plans 05 and 06 (on `rights.changed`) can use it.
   - `TokensService.revokeInSession(context, view, tokenId): void`: the `token.revoke_own`/`token.revoke_any` rule of `DELETE /api/sessions/:sid/tokens/:tokenId`.
   - `UsersService.createWithPassword(input)` and `UsersService.setPassword(email, password)` for the CLI.
   - `RateLimiter.retryAfterMs(key)` and `class RateLimitedError extends HydraError { retryAfterSeconds }`: `api/errors.ts` sends `Retry-After` for it. Plan 05 can throw it for the token limit (spec 6.6).
   - Exported helpers: `parseCookies` and `serializeCookie` (plan 06 can use them for `__Host-hydra_live_<sid>`), `checkCsrf`, `normalizeEmail`, `toAuthedUser`, `rightOnlyFromAdmin`, and the type `PasswordHashing` (the four methods of `PasswordHasher`, so unit tests can pass `plainHasher`).
3. **`effectiveRole` order** is owner, then the global admin role, then the member role. Thus `nekoProfileOf(effectiveRole(user, view))` gives `admin` for an admin who is also a viewer member, and `SessionResource.myRole` (plan 04) is `'admin'` for an admin who is also a member. The comment in index 5.1 ("'admin': access only through the global admin role") reads as if `myRole` should show the member role in that case; with that reading, `nekoProfileOf(myRole)` would give the Neko `user` profile to an admin.
4. **`ERROR_CODES` has no code for HTTP 500 and 413** (spec deviations 1 and 2). Proposal: add `internal` (500) and `payload_too_large` (413) to `ERROR_CODES` and `ERROR_STATUS`, and then change `api/errors.ts`.
5. **List responses and status codes** are not in index 5.1: `GET /api/users` → `UserSummary[]`, `GET /api/sessions/:sid/tokens` → `Token[]` (bare arrays). Create routes → 201; DELETE, logout, and password change → 204. Plan 07 must parse `z.array(UserSummarySchema)` and `z.array(TokenSchema)`.
6. **Audit read:** index 5.7 has no read function, and plan 03 owns no file in `audit/`. `api/audit.ts` has `listAuditEvents(db, sessionId, query)` (one query with LEFT JOINs for the actor name) and uses `toAuditEvent` of plan 02, so the REST list and the SSE events have the same shape. The querystring uses a local zod schema with coerced numbers (`AuditQueryParamsSchema`); the shared `AuditQuerySchema` stays for the web client.
7. **`api/context.ts` exports more than index 5.9:** `requestInfo(request): RequestInfo` (method and route pattern), `routeKey(request)`, and `PASSWORD_CHANGE_ROUTES`. Plans 04 to 06 should call `deps.access.requireSession(context, sid, action, requestInfo(request))`; the `admin.session_access` exemptions match route patterns and real paths.
8. **File ownership:** plans 04 to 06 must change `test/helpers/app.ts` (`createTestApp` builds the deps; they add `kube`, `sessions`, `activity`, `mcpStreams`, and `live` with test doubles) and should add their routes to the route lists of `test/integration/route-rules.test.ts`. The table of index section 4 lists neither file for them.
9. **Development (plans 01 and 07, spec 11.7):** the host constraint compares the whole `Host` header, port included. With the Vite dev server, `HYDRA_PUBLIC_URL` must be the origin that the browser uses (for example `http://hydra.localhost:5173`), and the Vite proxy must keep the `Host` header (no `changeOrigin`). Otherwise every API request gets 404, and the CSRF `Origin` check fails.
10. **`hydra` in the gateway image (plan 08):** `package.json` gets `"bin": { "hydra": "./dist/cli/main.js" }`, and the file starts with `#!/usr/bin/env node`. The distroless image has no `/usr/bin/env` and no shell, so plan 08 must put `hydra` on `PATH` in another way (for example a symlink to a launcher that runs `/nodejs/bin/node /app/dist/cli/main.js`).
11. **`openSse(reply, { clock, heartbeatMs })`** keeps `clock` for the shared signature; the heartbeat uses an `unref()` timer. The new export `closeAllSse(server)` closes the open streams in the `preClose` hook of `buildApp`.
12. **Test helper additions (index 5.12):** `test/helpers/app.ts` also exports `apiRequest`, `errorOf`, `ApiRequest`, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, `LIVE_HOST`, and `TEST_START`; `test/helpers/seed.ts` also exports `plainHasher` and `DEFAULT_PASSWORD`. `seedUser` takes `{ db, clock, hasher }` and `seedSession` takes `{ db, clock, config }` (structural types; `AppDeps` fits), so unit tests can seed without an app. `loginAs` uses a new client address for each call (TEST-NET-2), so the login limit per IP does not affect tests. `seedSession` gives sessions in `starting`, `running`, and `stopping` the lowest free media port.
13. **Plan 02 changes applied:** `openDb` is async (plan 02 index issue 1), so `main.ts` and the CLI `await` it; `hydra db backup` uses `openSqlite` and `backupDb` (plan 02 index issue 3), after a check that `hydra.db` exists, because `openSqlite` creates a missing file.

---

### Task 1: Common password list and password rules

Spec 6.3 (password rules); index 5.8 (common passwords).

**Files:**
- Create: `packages/server/src/auth/common-passwords.txt` (download)
- Create: `packages/server/src/auth/passwords.ts`
- Test: `packages/server/src/auth/passwords.test.ts`
- Modify: `packages/server/package.json` (`build` script)

**Interfaces:**
- Consumes: `randomBase64Url(bytes: number): string` (`src/crypto/index.ts`), `HydraError` (`src/lib/errors.ts`).
- Produces: `checkPasswordRules(password: string, email: string): void` (throws `HydraError` `password_rejected`), `isCommonPassword(password: string): boolean`, `passwordLength(password: string): number` (code points), `generateOneTimePassword(): string` (24 base64url characters), `PASSWORD_MIN_LENGTH` (12), `PASSWORD_MAX_LENGTH` (128).

- [ ] **Step 1: Download the list and check it**

Run (from the repository root):

```bash
curl -fsSL -o packages/server/src/auth/common-passwords.txt \
  https://raw.githubusercontent.com/danielmiessler/SecLists/f0ab72480bfda61feaa9131f6ef2f08a0dea78d6/Passwords/Common-Credentials/10-million-password-list-top-100000.txt
shasum -a 256 packages/server/src/auth/common-passwords.txt
wc -lc packages/server/src/auth/common-passwords.txt
```

Expected:

```
e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188  packages/server/src/auth/common-passwords.txt
  100007  781959 packages/server/src/auth/common-passwords.txt
```

If the SHA-256 is different, stop and delete the file. On Linux, use `sha256sum` instead of `shasum -a 256`. The file is in the repository from now on; the test of Step 3 checks its SHA-256 again.

- [ ] **Step 2: Copy the list in the build**

`tsc` emits only JavaScript, and `passwords.ts` reads the list next to itself (`dist/auth/` in production). In `packages/server/package.json`, change the `build` script:

```json
"build": "tsc -p tsconfig.build.json && cp src/auth/common-passwords.txt dist/auth/common-passwords.txt",
```

- [ ] **Step 3: Write the failing test**

`packages/server/src/auth/passwords.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HydraError } from '../lib/errors.js';
import {
  checkPasswordRules,
  generateOneTimePassword,
  isCommonPassword,
  passwordLength,
} from './passwords.js';

const EMAIL = 'alice@example.com';

function rejection(password: string, email = EMAIL): HydraError {
  try {
    checkPasswordRules(password, email);
  } catch (error) {
    if (error instanceof HydraError) return error;
    throw error;
  }
  throw new Error('expected password_rejected');
}

describe('common password list', () => {
  it('is the pinned SecLists file', () => {
    const file = readFileSync(new URL('./common-passwords.txt', import.meta.url));
    expect(createHash('sha256').update(file).digest('hex')).toBe(
      'e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188',
    );
  });

  it('matches without regard to case', () => {
    expect(isCommonPassword('password1234')).toBe(true);
    expect(isCommonPassword('PASSWORD1234')).toBe(true);
    expect(isCommonPassword('correct horse battery staple')).toBe(false);
  });
});

describe('checkPasswordRules', () => {
  it('accepts a long password that is not common', () => {
    expect(() => checkPasswordRules('correct horse battery staple', EMAIL)).not.toThrow();
  });

  it('rejects fewer than 12 characters', () => {
    const error = rejection('elevenchars');
    expect(error.code).toBe('password_rejected');
    expect(error.status).toBe(400);
    expect(error.message).toBe('The password must have 12 to 128 characters.');
  });

  it('accepts exactly 12 and exactly 128 characters', () => {
    expect(() => checkPasswordRules('k3#Lm9!qZ2@x', EMAIL)).not.toThrow();
    expect(() => checkPasswordRules('a'.repeat(127) + 'b', EMAIL)).not.toThrow();
  });

  it('rejects more than 128 characters', () => {
    expect(rejection('a'.repeat(129)).message).toBe('The password must have 12 to 128 characters.');
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '😀'.repeat(12);
    expect(emoji.length).toBe(24);
    expect(passwordLength(emoji)).toBe(12);
    expect(() => checkPasswordRules(emoji, EMAIL)).not.toThrow();
    expect(rejection('😀'.repeat(11)).code).toBe('password_rejected');
  });

  it('rejects a common password in any case', () => {
    expect(rejection('Password1234').message).toBe(
      'This password is too common. Choose another one.',
    );
    expect(rejection('QWERTY123456').code).toBe('password_rejected');
  });

  it('rejects the email as the password, in any case', () => {
    expect(rejection('Alice@Example.com').message).toBe(
      'The password must not be equal to the email.',
    );
  });

  it('has no composition rules', () => {
    expect(() => checkPasswordRules('aaaaaaaaaaaaaaaab', EMAIL)).not.toThrow();
  });
});

describe('generateOneTimePassword', () => {
  it('gives 24 base64url characters that pass the rules', () => {
    const value = generateOneTimePassword();
    expect(value).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(() => checkPasswordRules(value, EMAIL)).not.toThrow();
    expect(generateOneTimePassword()).not.toBe(value);
  });
});
```

- [ ] **Step 4: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/auth/passwords.test.ts`
Expected: FAIL with `Error: Cannot find module './passwords.js' imported from …/src/auth/passwords.test.ts`.

- [ ] **Step 5: Write the implementation**

`packages/server/src/auth/passwords.ts`:

```ts
import { readFileSync } from 'node:fs';
import { randomBase64Url } from '../crypto/index.js';
import { HydraError } from '../lib/errors.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// SecLists 10-million-password-list-top-100000.txt at commit f0ab724 (see the plan, Task 1).
const COMMON_PASSWORDS_FILE = new URL('./common-passwords.txt', import.meta.url);

let commonPasswords: Set<string> | undefined;

/** Length in Unicode code points, as NIST SP 800-63B counts characters. */
export function passwordLength(password: string): number {
  return [...password].length;
}

function loadCommonPasswords(): Set<string> {
  const entries = new Set<string>();
  for (const line of readFileSync(COMMON_PASSWORDS_FILE, 'utf8').split('\n')) {
    const entry = line.replace(/\r$/, '').toLowerCase();
    const length = passwordLength(entry);
    // Shorter or longer entries can never pass the length rule, so the set does not keep them.
    if (length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH) entries.add(entry);
  }
  return entries;
}

export function isCommonPassword(password: string): boolean {
  commonPasswords ??= loadCommonPasswords();
  return commonPasswords.has(password.toLowerCase());
}

/** Spec section 6.3. Throws HydraError password_rejected. */
export function checkPasswordRules(password: string, email: string): void {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new HydraError(
      'password_rejected',
      `The password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    );
  }
  if (password.toLowerCase() === email.trim().toLowerCase()) {
    throw new HydraError('password_rejected', 'The password must not be equal to the email.');
  }
  if (isCommonPassword(password)) {
    throw new HydraError('password_rejected', 'This password is too common. Choose another one.');
  }
}

/** One-time password for a new user or a reset: 18 random bytes, 24 base64url characters. */
export function generateOneTimePassword(): string {
  return randomBase64Url(18);
}
```

- [ ] **Step 6: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/auth/passwords.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 7: Check that the build copies the list**

Run: `pnpm --filter "@hydra/server..." run build && ls packages/server/dist/auth/common-passwords.txt`
Expected: the build succeeds, and `ls` prints `packages/server/dist/auth/common-passwords.txt`.

- [ ] **Step 8: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 2: Cookie helpers, CSRF check, rate limiter, login throttle

Spec 6.4 (cookie, CSRF, brute-force protection); index 5.8 (`RateLimiter`), 5.9 (CSRF hook).

**Files:**
- Create: `packages/server/src/auth/cookies.ts`, `packages/server/src/auth/csrf.ts`, `packages/server/src/auth/rate-limit.ts`, `packages/server/src/auth/throttle.ts`
- Test: `packages/server/src/auth/cookies.test.ts`, `packages/server/src/auth/csrf.test.ts`, `packages/server/src/auth/rate-limit.test.ts`, `packages/server/src/auth/throttle.test.ts`

**Interfaces:**
- Consumes: `Clock` (`src/lib/clock.ts`), `HydraError`, `FakeClock` (`test/helpers/clock.ts`).
- Produces:
  - `SESSION_COOKIE = '__Host-hydra_session'`; `parseCookies(header: string | undefined): Record<string, string>`; `serializeCookie(name, value, options: CookieOptions): string` with `CookieOptions = { sameSite: 'Strict' | 'Lax'; maxAge?; path?; httpOnly?; secure? }`; `sessionCookie(value)`; `clearedSessionCookie()`.
  - `checkCsrf(request: { method: string; headers: IncomingHttpHeaders }, publicOrigin: string): void` (throws `csrf_failed`).
  - `class RateLimiter { constructor(options: { limit; windowMs; clock }); take(key): boolean; retryAfterMs(key): number }`; `class RateLimitedError extends HydraError { retryAfterSeconds: number; constructor(retryAfterMs, message?) }`.
  - `class LoginThrottle { constructor(options: { clock }); waitMs(key): number; fail(key): number; reset(key): void }`; `throttleWaitMs(failures): number`.

- [ ] **Step 1: Write the failing tests**

`packages/server/src/auth/cookies.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  parseCookies,
  serializeCookie,
  sessionCookie,
} from './cookies.js';

describe('parseCookies', () => {
  it('returns an empty object for a missing header', () => {
    expect(Object.keys(parseCookies(undefined))).toEqual([]);
    expect(Object.keys(parseCookies(''))).toEqual([]);
  });

  it('parses several cookies and trims spaces', () => {
    const cookies = parseCookies(`a=1;  ${SESSION_COOKIE}=abc_-123 ; b="quoted"`);
    expect(cookies.a).toBe('1');
    expect(cookies[SESSION_COOKIE]).toBe('abc_-123');
    expect(cookies.b).toBe('quoted');
  });

  it('keeps the first value of a repeated name', () => {
    expect(parseCookies('a=first; a=second').a).toBe('first');
  });

  it('ignores parts without a name or without "="', () => {
    expect(parseCookies('=x; junk; c=3')).toEqual(Object.assign(Object.create(null), { c: '3' }));
  });

  it('is safe against prototype keys', () => {
    const cookies = parseCookies('__proto__=x; constructor=y');
    expect(cookies.__proto__).toBe('x');
    expect(cookies.constructor).toBe('y');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not decode values', () => {
    expect(parseCookies('a=%E0%A4%A').a).toBe('%E0%A4%A');
  });
});

describe('serializeCookie', () => {
  it('builds the login session cookie of spec section 6.4', () => {
    expect(sessionCookie('abc')).toBe(
      '__Host-hydra_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('clears the login session cookie with Max-Age=0', () => {
    expect(clearedSessionCookie()).toBe(
      '__Host-hydra_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('supports Strict, Max-Age, and turning off the default flags', () => {
    expect(
      serializeCookie('x', 'y', {
        sameSite: 'Strict',
        maxAge: 30.9,
        httpOnly: false,
        secure: false,
      }),
    ).toBe('x=y; Path=/; Max-Age=30; SameSite=Strict');
  });

  it('rejects names and values that RFC 6265 does not permit', () => {
    expect(() => serializeCookie('a b', 'y', { sameSite: 'Lax' })).toThrow(/name/);
    expect(() => serializeCookie('a', 'x;y', { sameSite: 'Lax' })).toThrow(/value/);
    expect(() => serializeCookie('a', 'x y', { sameSite: 'Lax' })).toThrow(/value/);
  });
});
```

`packages/server/src/auth/csrf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HydraError } from '../lib/errors.js';
import { checkCsrf } from './csrf.js';

const ORIGIN = 'https://hydra.example.com';
const good = { origin: ORIGIN, 'content-type': 'application/json' };

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HydraError ? error.code : 'other';
  }
}

describe('checkCsrf', () => {
  it('skips GET and HEAD', () => {
    expect(codeOf(() => checkCsrf({ method: 'GET', headers: {} }, ORIGIN))).toBeNull();
    expect(codeOf(() => checkCsrf({ method: 'HEAD', headers: {} }, ORIGIN))).toBeNull();
  });

  it('accepts the public origin with JSON, also with a charset', () => {
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: good }, ORIGIN))).toBeNull();
    const headers = { origin: ORIGIN, 'content-type': 'Application/JSON; charset=utf-8' };
    expect(codeOf(() => checkCsrf({ method: 'DELETE', headers }, ORIGIN))).toBeNull();
  });

  it('rejects a missing or different Origin', () => {
    const noOrigin = { 'content-type': 'application/json' };
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: noOrigin }, ORIGIN))).toBe(
      'csrf_failed',
    );
    const live = { ...good, origin: 'https://live.hydra.example.com' };
    expect(codeOf(() => checkCsrf({ method: 'PATCH', headers: live }, ORIGIN))).toBe('csrf_failed');
    const nullOrigin = { ...good, origin: 'null' };
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: nullOrigin }, ORIGIN))).toBe(
      'csrf_failed',
    );
  });

  it('rejects a missing or different Content-Type', () => {
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: { origin: ORIGIN } }, ORIGIN))).toBe(
      'csrf_failed',
    );
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const headers = { origin: ORIGIN, 'content-type': type };
      expect(codeOf(() => checkCsrf({ method: 'POST', headers }, ORIGIN))).toBe('csrf_failed');
    }
  });
});
```

`packages/server/src/auth/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('permits `limit` takes in the window and rejects the next one', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, clock });
    expect([limiter.take('ip'), limiter.take('ip'), limiter.take('ip')]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take('ip')).toBe(false);
  });

  it('counts each key on its own', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, clock });
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('slides: a take expires exactly windowMs after it happened', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, clock });
    limiter.take('ip');
    clock.advance(30_000);
    limiter.take('ip');
    expect(limiter.take('ip')).toBe(false);
    clock.advance(29_999);
    expect(limiter.take('ip')).toBe(false);
    clock.advance(1);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
  });

  it('does not count rejected takes', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, clock });
    limiter.take('ip');
    for (let i = 0; i < 5; i += 1) expect(limiter.take('ip')).toBe(false);
    clock.advance(1_000);
    expect(limiter.take('ip')).toBe(true);
  });

  it('reports the time until the next take can succeed', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, clock });
    expect(limiter.retryAfterMs('ip')).toBe(0);
    limiter.take('ip');
    clock.advance(10_000);
    limiter.take('ip');
    expect(limiter.retryAfterMs('ip')).toBe(50_000);
    clock.advance(50_000);
    expect(limiter.retryAfterMs('ip')).toBe(0);
  });
});

describe('RateLimitedError', () => {
  it('is a 429 rate_limited error with whole seconds, at least 1', () => {
    const error = new RateLimitedError(1_500);
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(2);
    expect(new RateLimitedError(0).retryAfterSeconds).toBe(1);
  });
});
```

`packages/server/src/auth/throttle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { LoginThrottle, throttleWaitMs } from './throttle.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('throttleWaitMs', () => {
  it('waits 15 min after 5 failures and doubles each further failure, up to 24 h', () => {
    expect([1, 2, 3, 4].map(throttleWaitMs)).toEqual([0, 0, 0, 0]);
    expect(throttleWaitMs(5)).toBe(15 * MIN);
    expect(throttleWaitMs(6)).toBe(30 * MIN);
    expect(throttleWaitMs(7)).toBe(HOUR);
    expect(throttleWaitMs(8)).toBe(2 * HOUR);
    expect(throttleWaitMs(9)).toBe(4 * HOUR);
    expect(throttleWaitMs(10)).toBe(8 * HOUR);
    expect(throttleWaitMs(11)).toBe(16 * HOUR);
    expect(throttleWaitMs(12)).toBe(24 * HOUR);
    expect(throttleWaitMs(13)).toBe(24 * HOUR);
    expect(throttleWaitMs(5000)).toBe(24 * HOUR);
  });
});

describe('LoginThrottle', () => {
  it('permits 5 failures, then makes the pair wait', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 4; i += 1) {
      expect(throttle.fail('a@x.com|1.1.1.1')).toBe(0);
      expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(0);
    }
    expect(throttle.fail('a@x.com|1.1.1.1')).toBe(15 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(15 * MIN);
    clock.advance(10 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(5 * MIN);
    clock.advance(5 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(0);
    expect(throttle.fail('a@x.com|1.1.1.1')).toBe(30 * MIN);
  });

  it('keeps pairs apart, so another IP is not affected', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 5; i += 1) throttle.fail('a@x.com|1.1.1.1');
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(15 * MIN);
    expect(throttle.waitMs('a@x.com|2.2.2.2')).toBe(0);
  });

  it('resets the pair after a good login', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 4; i += 1) throttle.fail('k');
    throttle.reset('k');
    expect(throttle.fail('k')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/auth/cookies.test.ts src/auth/csrf.test.ts src/auth/rate-limit.test.ts src/auth/throttle.test.ts`
Expected: FAIL, 4 failed suites, each with `Error: Cannot find module './cookies.js'` (`./csrf.js`, `./rate-limit.js`, `./throttle.js`).

- [ ] **Step 3: Write the cookie helpers**

The spec forbids a cookie plugin (index 2.3). The parser keeps the first value of a name (RFC 6265 user agents send the most specific cookie first), does not decode values (our values are base64url), and uses an object without a prototype.

`packages/server/src/auth/cookies.ts`:

```ts
export const SESSION_COOKIE = '__Host-hydra_session';

// RFC 6265 section 4.1.1: token characters for the name, cookie-octet for the value.
const NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export interface CookieOptions {
  sameSite: 'Strict' | 'Lax';
  /** Seconds. Omit for a cookie that lives until the browser closes. */
  maxAge?: number;
  /** Default '/'. `__Host-` cookies need '/'. */
  path?: string;
  /** Default true. */
  httpOnly?: boolean;
  /** Default true. `__Host-` cookies need it. */
  secure?: boolean;
}

/** Parses a `Cookie` request header. The first value of a name wins. Values are not decoded. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>;
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== '' && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/** Builds a `Set-Cookie` header value. Throws for a name or a value that RFC 6265 does not permit. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Cookie name is not valid: ${name}`);
  if (!VALUE_PATTERN.test(value)) throw new Error(`Cookie value is not valid for ${name}`);
  const parts = [`${name}=${value}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (options.secure ?? true) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

/** Spec section 6.4: HttpOnly, Secure, SameSite=Lax, Path=/. */
export function sessionCookie(value: string): string {
  return serializeCookie(SESSION_COOKIE, value, { sameSite: 'Lax' });
}

export function clearedSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, '', { sameSite: 'Lax', maxAge: 0 });
}
```

- [ ] **Step 4: Write the CSRF check**

The JSON-body part of the check is in the body parser: `api/errors.ts` (Task 8) turns an empty or broken JSON body on an `/api/*` route into `csrf_failed`.

`packages/server/src/auth/csrf.ts`:

```ts
import type { IncomingHttpHeaders } from 'node:http';
import { HydraError } from '../lib/errors.js';

/**
 * CSRF check of spec section 6.4 for a request that is not GET or HEAD: the Origin header must be
 * equal to HYDRA_PUBLIC_URL and the Content-Type must be application/json. The JSON body part is
 * checked by the body parser: `api/errors.ts` turns an empty or broken JSON body into csrf_failed.
 */
export function checkCsrf(
  request: { method: string; headers: IncomingHttpHeaders },
  publicOrigin: string,
): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (request.headers.origin !== publicOrigin || contentType !== 'application/json') {
    throw new HydraError('csrf_failed', 'The request failed the CSRF check.');
  }
}
```

- [ ] **Step 5: Write the rate limiter**

A sliding window: a take expires exactly `windowMs` after it happened, and rejected takes do not count. Old keys are swept every 1000 calls, so many client addresses cannot grow the map without limit.

`packages/server/src/auth/rate-limit.ts`:

```ts
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

const SWEEP_EVERY = 1000;

/** 429 rate_limited. `api/errors.ts` sends `Retry-After` with `retryAfterSeconds`. */
export class RateLimitedError extends HydraError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number, message = 'Too many requests. Try again later.') {
    super('rate_limited', message);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

/**
 * Sliding window limit in memory: at most `limit` takes per key in any `windowMs`.
 * Used for the login limit per IP (spec section 6.4) and the token limit (spec section 6.6).
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #hits = new Map<string, number[]>();
  #calls = 0;

  constructor(options: { limit: number; windowMs: number; clock: Clock }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock;
  }

  /** Counts one request for the key. Returns false if the key is over the limit. */
  take(key: string): boolean {
    const now = this.#clock.now();
    this.#sweep(now);
    const hits = this.#recent(key, now);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  /** Milliseconds until `take(key)` can succeed again. 0 if it can succeed now. */
  retryAfterMs(key: string): number {
    const now = this.#clock.now();
    const hits = this.#recent(key, now);
    if (hits.length < this.#limit) return 0;
    const oldest = hits[hits.length - this.#limit] ?? now;
    return oldest + this.#windowMs - now;
  }

  #recent(key: string, now: number): number[] {
    const start = now - this.#windowMs;
    return (this.#hits.get(key) ?? []).filter((time) => time > start);
  }

  #sweep(now: number): void {
    this.#calls += 1;
    if (this.#calls % SWEEP_EVERY !== 0) return;
    for (const [key, hits] of this.#hits) {
      const newest = hits[hits.length - 1];
      if (newest === undefined || newest <= now - this.#windowMs) this.#hits.delete(key);
    }
  }
}
```

- [ ] **Step 6: Write the login throttle**

Failures 1 to 4 have no wait; the 5th failure starts a 15 min wait; each further failure doubles it, up to 24 h. A good login resets the pair. Entries without a wait and without a failure in the last 24 h are swept.

`packages/server/src/auth/throttle.ts`:

```ts
import type { Clock } from '../lib/clock.js';

/** Failures without a wait. The wait starts after the 5th failure (spec section 6.4). */
export const THROTTLE_FREE_FAILURES = 5;
export const THROTTLE_FIRST_WAIT_MS = 15 * 60 * 1000;
export const THROTTLE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const SWEEP_EVERY = 1000;

interface ThrottleEntry {
  failures: number;
  waitUntil: number;
  lastFailureAt: number;
}

/** Wait after `failures` failures in a row: 0 before the 5th, then 15 min doubling, max 24 h. */
export function throttleWaitMs(failures: number): number {
  if (failures < THROTTLE_FREE_FAILURES) return 0;
  return Math.min(
    THROTTLE_FIRST_WAIT_MS * 2 ** (failures - THROTTLE_FREE_FAILURES),
    THROTTLE_MAX_WAIT_MS,
  );
}

/** Login throttle for each pair of email and IP, in memory (spec section 6.4). */
export class LoginThrottle {
  readonly #clock: Clock;
  readonly #entries = new Map<string, ThrottleEntry>();
  #calls = 0;

  constructor(options: { clock: Clock }) {
    this.#clock = options.clock;
  }

  /** Milliseconds that the key must still wait. 0 if an attempt is permitted now. */
  waitMs(key: string): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.waitUntil - this.#clock.now());
  }

  /** Records a failure. Returns the wait that starts now. */
  fail(key: string): number {
    const now = this.#clock.now();
    this.#sweep(now);
    const entry = this.#entries.get(key) ?? { failures: 0, waitUntil: 0, lastFailureAt: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now;
    const wait = throttleWaitMs(entry.failures);
    entry.waitUntil = now + wait;
    this.#entries.set(key, entry);
    return wait;
  }

  /** A good login resets the pair. */
  reset(key: string): void {
    this.#entries.delete(key);
  }

  #sweep(now: number): void {
    this.#calls += 1;
    if (this.#calls % SWEEP_EVERY !== 0) return;
    for (const [key, entry] of this.#entries) {
      if (entry.waitUntil <= now && entry.lastFailureAt <= now - THROTTLE_MAX_WAIT_MS) {
        this.#entries.delete(key);
      }
    }
  }
}
```

- [ ] **Step 7: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/auth/cookies.test.ts src/auth/csrf.test.ts src/auth/rate-limit.test.ts src/auth/throttle.test.ts`
Expected: PASS, `Test Files  4 passed (4)`, `Tests  24 passed (24)`.

- [ ] **Step 8: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 3: `AuthService` and the seed helpers

Spec 6.3 (first login, rehash), 6.4 (login sessions, throttle, lock), 13.3 (cleanup job); index 5.8, 5.12 (`seedUser`, `seedSession`).

**Files:**
- Create: `packages/server/src/auth/types.ts`, `packages/server/src/auth/service.ts`, `packages/server/src/auth/index.ts`
- Create: `packages/server/test/helpers/seed.ts` (Task 9 adds `loginAs`)
- Test: `packages/server/src/auth/service.test.ts`

**Interfaces:**
- Consumes: `Db`, `users`, `loginSessions`, `liveGrants`, `sessions` (`src/db/`); `hmac`, `newUlid`, `newSid`, `randomBase64Url`, `deriveSubkeys`, `PasswordHasher`, `Subkeys` (`src/crypto/index.ts`); `AuditWriter` (`src/audit/index.ts`); `EventBus`, `HydraEvent` (`src/events/index.ts`); `Clock`; `HydraError`; `MESSAGES.invalidCredentials` (`@hydra/shared`); Tasks 1 and 2.
- Produces:
  - `interface AuthedUser { id; email; displayName; role: GlobalRole; status: UserStatus; mustChangePassword: boolean }`, `interface LoginContext { user: AuthedUser; loginSessionId: string }` (index 5.8).
  - `class AuthService` with `login`, `logout`, `resolve`, `changePassword`, `endLoginSessions` (index 5.8) and `cleanupExpired(): { loginSessions: number; liveGrants: number }`; `AuthDeps = { db; clock; subkeys; hasher: PasswordHashing; audit; bus }`; `type PasswordHashing = Pick<PasswordHasher, 'hash' | 'verify' | 'verifyDummy' | 'needsRehash'>`; `normalizeEmail(email)`; `toAuthedUser(row)`; `LOGIN_SESSION_IDLE_MS`, `LOGIN_SESSION_MAX_MS`, `LOCK_AFTER_FAILURES`.
  - `src/auth/index.ts`: the public interface of `auth/` (other modules import only from it).
  - `test/helpers/seed.ts`: `seedUser(deps: { db; clock; hasher }, input?)`, `seedSession(deps: { db; clock; config }, input)` (index 5.12), `plainHasher`, `DEFAULT_PASSWORD`.

- [ ] **Step 1: Write the seed helpers**

`seedUser` inserts the row directly (with `mustChangePassword: false`); `seedSession` inserts a session row in any state (plan 04 adds the session service).

`packages/server/test/helpers/seed.ts`:

```ts
import { eq, isNotNull } from 'drizzle-orm';
import type { GlobalRole, SessionState, UserStatus } from '@hydra/shared';
import { toAuthedUser, type AuthedUser, type PasswordHashing } from '../../src/auth/index.js';
import type { Config } from '../../src/config/index.js';
import { newSid, newUlid } from '../../src/crypto/index.js';
import type { Db } from '../../src/db/index.js';
import { sessions, users, type SessionRow } from '../../src/db/schema.js';
import type { Clock } from '../../src/lib/clock.js';

/** 28 characters, not in the common password list. */
export const DEFAULT_PASSWORD = 'correct horse battery staple';

/** Fast stand-in for PasswordHasher in unit tests. Never use it outside tests. */
export const plainHasher: PasswordHashing = {
  hash: (password) => Promise.resolve(`plain:${password}`),
  verify: (phc, password) => Promise.resolve(phc === `plain:${password}`),
  verifyDummy: () => Promise.resolve(false as const),
  needsRehash: (phc) => !phc.startsWith('plain:'),
};

let userCounter = 0;

export async function seedUser(
  deps: { db: Db; clock: Clock; hasher: Pick<PasswordHashing, 'hash'> },
  input: {
    email?: string;
    password?: string;
    role?: GlobalRole;
    status?: UserStatus;
    displayName?: string;
  } = {},
): Promise<{ user: AuthedUser; password: string }> {
  userCounter += 1;
  const password = input.password ?? DEFAULT_PASSWORD;
  const now = deps.clock.now();
  const row = {
    id: newUlid(deps.clock),
    email: (input.email ?? `user${userCounter}@example.com`).trim().toLowerCase(),
    displayName: input.displayName ?? `User ${userCounter}`,
    passwordHash: await deps.hasher.hash(password),
    role: input.role ?? 'member',
    status: input.status ?? 'active',
    mustChangePassword: false,
    failedLogins: 0,
    lockedAt: null,
    lastLoginAt: null,
    passwordChangedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof users.$inferInsert;
  deps.db.insert(users).values(row).run();
  return { user: toAuthedUser(row), password };
}

const DESIRED_FOR_STATE: Record<SessionState, SessionRow['desiredState']> = {
  stopped: 'stopped',
  starting: 'running',
  running: 'running',
  stopping: 'stopped',
  error: 'stopped',
  deleting: 'deleted',
  deleted: 'deleted',
};

const HOLDS_PORT: ReadonlySet<SessionState> = new Set(['starting', 'running', 'stopping']);

/** Inserts a session row directly (plan 04 adds the session service). */
export function seedSession(
  deps: { db: Db; clock: Clock; config: Config },
  input: { ownerId: string; name?: string; state?: SessionState },
): SessionRow {
  const state = input.state ?? 'stopped';
  const now = deps.clock.now();
  let mediaPort: number | null = null;
  if (HOLDS_PORT.has(state)) {
    const used = new Set(
      deps.db
        .select({ port: sessions.mediaPort })
        .from(sessions)
        .where(isNotNull(sessions.mediaPort))
        .all()
        .map((row) => row.port),
    );
    const { first, last } = deps.config.mediaPortRange;
    for (let port = first; port <= last && mediaPort === null; port += 1) {
      if (!used.has(port)) mediaPort = port;
    }
  }
  const settings = {
    allowlist: ['example.com'],
    timezone: deps.config.defaultTimezone,
    language: deps.config.defaultLanguage,
    screen: '1920x1080' as const,
  };
  const id = newSid();
  deps.db
    .insert(sessions)
    .values({
      id,
      name: input.name ?? 'Test session',
      ownerId: input.ownerId,
      desiredState: DESIRED_FOR_STATE[state],
      state,
      errorReason: state === 'error' ? 'CrashLoopBackOff: test' : null,
      mediaPort,
      ...settings,
      appliedSettings: settings,
      startedAt: HOLDS_PORT.has(state) ? now : null,
      readyAt: state === 'running' ? now : null,
      createdAt: now,
      updatedAt: now,
      deletedAt: state === 'deleted' ? now : null,
    })
    .run();
  const row = deps.db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) throw new Error('seedSession: the row was not inserted');
  return row;
}
```

- [ ] **Step 2: Write the failing test**

`packages/server/src/auth/service.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HydraEvent } from '../events/index.js';
import { AuditWriter } from '../audit/index.js';
import { deriveSubkeys, hmac, newUlid } from '../crypto/index.js';
import { auditEvents, liveGrants, loginSessions, users } from '../db/schema.js';
import { EventBus } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { testConfig } from '../../test/helpers/config.js';
import { RateLimitedError } from './rate-limit.js';
import { AuthService, LOGIN_SESSION_IDLE_MS, LOGIN_SESSION_MAX_MS } from './service.js';

const HOUR = 60 * 60 * 1000;
const META = { ip: '203.0.113.5', userAgent: 'vitest' };

describe('AuthService', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let bus: EventBus;
  let events: HydraEvent[];
  let auth: AuthService;
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));

  beforeEach(() => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('login.ended', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    auth = new AuthService({ db: testDb.db, clock, subkeys, hasher: plainHasher, audit, bus });
  });

  afterEach(() => testDb.close());

  const seed = (input: Parameters<typeof seedUser>[1] = {}) =>
    seedUser({ db: testDb.db, clock, hasher: plainHasher }, input);

  const auditRows = (kind: string) =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.kind === kind);

  async function failure(promise: Promise<unknown>): Promise<HydraError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof HydraError) return error;
      throw error;
    }
    throw new Error('expected a HydraError');
  }

  describe('login', () => {
    it('creates a login session and stores only the HMAC of the cookie value', async () => {
      const { user, password } = await seed({ email: 'alice@example.com' });
      const { cookieValue, context } = await auth.login(' Alice@Example.COM ', password, META);
      expect(cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(context.user).toEqual(user);
      const row = testDb.db
        .select()
        .from(loginSessions)
        .where(eq(loginSessions.id, context.loginSessionId))
        .get();
      expect(row?.tokenHmac.equals(hmac(subkeys.loginSession, cookieValue))).toBe(true);
      expect(row?.tokenHmac.toString('utf8')).not.toContain(cookieValue);
      expect(row?.expiresAt).toBe(clock.now() + LOGIN_SESSION_MAX_MS);
      expect(row?.ip).toBe(META.ip);
      expect(auditRows('auth.login')[0]?.data).toEqual({ ip: META.ip, userAgent: 'vitest' });
    });

    it('gives a new cookie value at each login', async () => {
      const { user, password } = await seed();
      const first = await auth.login(user.email, password, META);
      const second = await auth.login(user.email, password, META);
      expect(first.cookieValue).not.toBe(second.cookieValue);
      expect(first.context.loginSessionId).not.toBe(second.context.loginSessionId);
    });

    it('gives the same error for a wrong password, an unknown email, a locked and a disabled user', async () => {
      const { user } = await seed({ email: 'alice@example.com' });
      const locked = await seed({ email: 'locked@example.com' });
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now() })
        .where(eq(users.id, locked.user.id))
        .run();
      const disabled = await seed({ email: 'disabled@example.com', status: 'disabled' });
      const errors = [
        await failure(auth.login(user.email, 'wrong password!!', META)),
        await failure(auth.login('nobody@example.com', 'whatever password', META)),
        await failure(auth.login(locked.user.email, locked.password, META)),
        await failure(auth.login(disabled.user.email, disabled.password, META)),
      ];
      for (const error of errors) {
        expect(error.code).toBe('invalid_credentials');
        expect(error.status).toBe(401);
        expect(error.message).toBe('Invalid email or password');
      }
      expect(auditRows('auth.login_failed').map((row) => row.data.reason)).toEqual([
        'wrong_password',
        'unknown_email',
        'locked',
        'disabled',
      ]);
    });

    it('locks the account after 100 failures in a row from many IPs', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 100; i += 1) {
        const ip = `10.1.${Math.floor(i / 200)}.${i % 200}`;
        await failure(auth.login(user.email, 'wrong password!!', { ip, userAgent: 'x' }));
      }
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.failedLogins).toBe(100);
      expect(row?.lockedAt).toBe(clock.now());
      const failed = auditRows('auth.login_failed');
      expect(failed.at(-1)?.data.locked).toBe(true);
      expect(failed.filter((event) => event.data.locked === true)).toHaveLength(1);
      const error = await failure(
        auth.login(user.email, password, { ip: '10.9.9.9', userAgent: 'x' }),
      );
      expect(error.code).toBe('invalid_credentials');
      expect(auditRows('auth.login_failed').at(-1)?.data.reason).toBe('locked');
    });

    it('resets the failure count after a good login before the lock', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 99; i += 1) {
        await failure(
          auth.login(user.email, 'wrong password!!', { ip: `10.2.0.${i}`, userAgent: 'x' }),
        );
      }
      await auth.login(user.email, password, { ip: '10.3.0.1', userAgent: 'x' });
      await failure(auth.login(user.email, 'wrong password!!', { ip: '10.3.0.2', userAgent: 'x' }));
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.failedLogins).toBe(1);
      expect(row?.lockedAt).toBeNull();
    });

    it('throttles a pair of email and IP after 5 failures, also for a good password', async () => {
      const { user, password } = await seed();
      for (let i = 0; i < 5; i += 1)
        await failure(auth.login(user.email, 'wrong password!!', META));
      const throttled = await failure(auth.login(user.email, password, META));
      expect(throttled).toBeInstanceOf(RateLimitedError);
      expect((throttled as RateLimitedError).retryAfterSeconds).toBe(900);
      const otherIp = await auth.login(user.email, password, {
        ip: '198.51.100.9',
        userAgent: 'x',
      });
      expect(otherIp.context.user.id).toBe(user.id);
      clock.advance(15 * 60 * 1000);
      await failure(auth.login(user.email, 'wrong password!!', META));
      const doubled = await failure(auth.login(user.email, password, META));
      expect((doubled as RateLimitedError).retryAfterSeconds).toBe(1800);
    });

    it('throttles an email that does not exist in the same way', async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await failure(auth.login('ghost@example.com', 'whatever pass', META))).code).toBe(
          'invalid_credentials',
        );
      }
      expect((await failure(auth.login('ghost@example.com', 'whatever pass', META))).code).toBe(
        'rate_limited',
      );
    });

    it('permits 10 attempts per minute for each IP', async () => {
      for (let i = 0; i < 10; i += 1) {
        await failure(auth.login(`u${i}@example.com`, 'whatever pass', META));
      }
      const limited = await failure(auth.login('u10@example.com', 'whatever pass', META));
      expect(limited.code).toBe('rate_limited');
      clock.advance(60_000);
      expect((await failure(auth.login('u11@example.com', 'whatever pass', META))).code).toBe(
        'invalid_credentials',
      );
    });

    it('hashes the password again when the parameters changed', async () => {
      const { user, password } = await seed();
      testDb.db
        .update(users)
        .set({ passwordHash: `old:${password}` })
        .where(eq(users.id, user.id))
        .run();
      const legacy = { ...plainHasher, verify: () => Promise.resolve(true) };
      const audit = new AuditWriter({ db: testDb.db, bus, clock });
      const service = new AuthService({
        db: testDb.db,
        clock,
        subkeys,
        hasher: legacy,
        audit,
        bus,
      });
      await service.login(user.email, password, META);
      const row = testDb.db.select().from(users).where(eq(users.id, user.id)).get();
      expect(row?.passwordHash).toBe(`plain:${password}`);
    });
  });

  describe('resolve', () => {
    it('returns the context for a valid cookie and null for others', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      expect(auth.resolve(cookieValue)).toEqual(context);
      expect(auth.resolve(undefined)).toBeNull();
      expect(auth.resolve('not-a-cookie')).toBeNull();
    });

    it('ends a login session after 12 h without a request', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      clock.advance(LOGIN_SESSION_IDLE_MS - 1);
      expect(auth.resolve(cookieValue)).not.toBeNull();
      clock.advance(LOGIN_SESSION_IDLE_MS);
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [context.loginSessionId] },
      ]);
    });

    it('ends a login session 7 days after the login, also when it is used', async () => {
      const { user, password } = await seed();
      const { cookieValue } = await auth.login(user.email, password, META);
      let elapsed = 0;
      while (elapsed + 11 * HOUR < LOGIN_SESSION_MAX_MS) {
        clock.advance(11 * HOUR);
        elapsed += 11 * HOUR;
        expect(auth.resolve(cookieValue)).not.toBeNull();
      }
      clock.advance(LOGIN_SESSION_MAX_MS - elapsed - 1);
      expect(auth.resolve(cookieValue)).not.toBeNull();
      clock.advance(1);
      expect(auth.resolve(cookieValue)).toBeNull();
    });

    it('writes last_seen_at at most one time per minute', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      const lastSeen = () =>
        testDb.db
          .select()
          .from(loginSessions)
          .where(eq(loginSessions.id, context.loginSessionId))
          .get()?.lastSeenAt;
      const start = clock.now();
      clock.advance(59_999);
      auth.resolve(cookieValue);
      expect(lastSeen()).toBe(start);
      clock.advance(1);
      auth.resolve(cookieValue);
      expect(lastSeen()).toBe(start + 60_000);
    });

    it('returns null and ends the login session of a disabled user', async () => {
      const { user, password } = await seed();
      const { cookieValue } = await auth.login(user.email, password, META);
      testDb.db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.id)).run();
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(testDb.db.select().from(loginSessions).all()).toHaveLength(0);
    });
  });

  describe('logout and endLoginSessions', () => {
    it('deletes the row, publishes login.ended, and writes auth.logout', async () => {
      const { user, password } = await seed();
      const { cookieValue, context } = await auth.login(user.email, password, META);
      auth.logout(context);
      expect(auth.resolve(cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [context.loginSessionId] },
      ]);
      expect(auditRows('auth.logout')).toHaveLength(1);
    });

    it('ends all login sessions of a user except one, and publishes nothing if none ended', async () => {
      const { user, password } = await seed();
      const a = await auth.login(user.email, password, META);
      const b = await auth.login(user.email, password, META);
      const c = await auth.login(user.email, password, META);
      auth.endLoginSessions(user.id, a.context.loginSessionId);
      expect(auth.resolve(a.cookieValue)).not.toBeNull();
      expect(auth.resolve(b.cookieValue)).toBeNull();
      expect(auth.resolve(c.cookieValue)).toBeNull();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'login.ended', userId: user.id });
      expect(new Set((events[0] as { loginSessionIds: string[] }).loginSessionIds)).toEqual(
        new Set([b.context.loginSessionId, c.context.loginSessionId]),
      );
      auth.endLoginSessions('nobody');
      expect(events).toHaveLength(1);
    });
  });

  describe('changePassword', () => {
    it('changes the password and ends the other login sessions', async () => {
      const { user, password } = await seed();
      testDb.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id)).run();
      const current = await auth.login(user.email, password, META);
      const other = await auth.login(user.email, password, META);
      await auth.changePassword(current.context, password, 'a new long passphrase');
      expect(auth.resolve(current.cookieValue)?.user.mustChangePassword).toBe(false);
      expect(auth.resolve(other.cookieValue)).toBeNull();
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [other.context.loginSessionId] },
      ]);
      await auth.login(user.email, 'a new long passphrase', META);
      expect(auditRows('auth.password_changed')).toHaveLength(1);
    });

    it('rejects a wrong current password, a weak password, and the same password', async () => {
      const { user, password } = await seed();
      const { context } = await auth.login(user.email, password, META);
      const wrong = await failure(
        auth.changePassword(context, 'not my password', 'another long passphrase'),
      );
      expect(wrong.code).toBe('password_rejected');
      expect(wrong.message).toBe('The current password is not correct.');
      expect((await failure(auth.changePassword(context, password, 'short'))).code).toBe(
        'password_rejected',
      );
      expect((await failure(auth.changePassword(context, password, password))).message).toBe(
        'The new password must be different from the current password.',
      );
    });

    it('permits 10 attempts per minute for each user', async () => {
      const { user, password } = await seed();
      const { context } = await auth.login(user.email, password, META);
      for (let i = 0; i < 10; i += 1) {
        await failure(auth.changePassword(context, 'not my password', 'another long passphrase'));
      }
      expect(
        (await failure(auth.changePassword(context, password, 'another long passphrase'))).code,
      ).toBe('rate_limited');
    });
  });

  describe('cleanupExpired', () => {
    it('deletes expired login sessions and expired live grants only', async () => {
      const { user, password } = await seed();
      const idle = await auth.login(user.email, password, META);
      clock.advance(LOGIN_SESSION_IDLE_MS);
      const fresh = await auth.login(user.email, password, META);
      const session = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: user.id },
      );
      const grant = (id: string, expiresAt: number) => ({
        id,
        loginSessionId: fresh.context.loginSessionId,
        userId: user.id,
        sessionId: session.id,
        nekoProfile: 'admin' as const,
        cookieHmac: Buffer.from(id),
        createdAt: clock.now(),
        expiresAt,
      });
      testDb.db
        .insert(liveGrants)
        .values([grant(newUlid(clock), clock.now() - 1), grant(newUlid(clock), clock.now() + HOUR)])
        .run();
      expect(auth.cleanupExpired()).toEqual({ loginSessions: 1, liveGrants: 1 });
      expect(auth.resolve(fresh.cookieValue)).not.toBeNull();
      expect(testDb.db.select().from(liveGrants).all()).toHaveLength(1);
      expect(events).toEqual([
        { type: 'login.ended', userId: user.id, loginSessionIds: [idle.context.loginSessionId] },
      ]);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/auth/service.test.ts`
Expected: FAIL with `Error: Cannot find module` for `./service.js` or for `../../src/auth/index.js` (imported by `seed.ts`).

- [ ] **Step 4: Write the types**

`packages/server/src/auth/types.ts`:

```ts
import type { GlobalRole, UserStatus } from '@hydra/shared';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: GlobalRole;
  status: UserStatus;
  mustChangePassword: boolean;
}

export interface LoginContext {
  user: AuthedUser;
  loginSessionId: string;
}
```

- [ ] **Step 5: Write the service**

Notes for the reader of the code:
- `login` checks the IP limit, then the pair throttle, then runs the Argon2 verify in all cases (`verifyDummy` for an unknown email). It reads the user row again after the verify, because an admin can lock, disable, or reset the user during the verify.
- The failure count and the lock are one `UPDATE` (`failed_logins + 1` and `CASE WHEN … THEN now`), so parallel failures cannot lose a count; SQLite evaluates `SET` with the old row values.
- The 100th failure writes `locked: true` into the data of its `auth.login_failed` event, so the admin can see when the lock started.

`packages/server/src/auth/service.ts`:

```ts
import { and, eq, lte, ne, or, sql } from 'drizzle-orm';
import { MESSAGES } from '@hydra/shared';
import type { AuditWriter } from '../audit/index.js';
import {
  hmac,
  newUlid,
  randomBase64Url,
  type PasswordHasher,
  type Subkeys,
} from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { liveGrants, loginSessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { checkPasswordRules } from './passwords.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';
import { LoginThrottle } from './throttle.js';
import type { AuthedUser, LoginContext } from './types.js';

export const LOGIN_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const LOGIN_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most one time per minute for each login session. */
export const LAST_SEEN_WRITE_MS = 60_000;
export const LOCK_AFTER_FAILURES = 100;
export const LOGIN_LIMIT_PER_IP = 10;
export const LOGIN_LIMIT_WINDOW_MS = 60_000;
/** Wrong current passwords on POST /api/auth/password, for each user. */
export const PASSWORD_CHANGE_LIMIT = 10;
const USER_AGENT_MAX = 512;

export type PasswordHashing = Pick<
  PasswordHasher,
  'hash' | 'verify' | 'verifyDummy' | 'needsRehash'
>;

export interface AuthDeps {
  db: Db;
  clock: Clock;
  subkeys: Subkeys;
  hasher: PasswordHashing;
  audit: AuditWriter;
  bus: EventBus;
}

type UserRow = typeof users.$inferSelect;
type FailureReason = 'unknown_email' | 'disabled' | 'locked' | 'wrong_password';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toAuthedUser(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
  };
}

export class AuthService {
  readonly #deps: AuthDeps;
  readonly #ipLimiter: RateLimiter;
  readonly #passwordLimiter: RateLimiter;
  readonly #throttle: LoginThrottle;

  constructor(deps: AuthDeps) {
    this.#deps = deps;
    this.#ipLimiter = new RateLimiter({
      limit: LOGIN_LIMIT_PER_IP,
      windowMs: LOGIN_LIMIT_WINDOW_MS,
      clock: deps.clock,
    });
    this.#passwordLimiter = new RateLimiter({
      limit: PASSWORD_CHANGE_LIMIT,
      windowMs: LOGIN_LIMIT_WINDOW_MS,
      clock: deps.clock,
    });
    this.#throttle = new LoginThrottle({ clock: deps.clock });
  }

  async login(
    email: string,
    password: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ cookieValue: string; context: LoginContext }> {
    const { db, hasher, clock, subkeys, audit } = this.#deps;
    const normalized = normalizeEmail(email);
    if (!this.#ipLimiter.take(meta.ip)) {
      throw new RateLimitedError(this.#ipLimiter.retryAfterMs(meta.ip));
    }
    const pairKey = `${normalized}\n${meta.ip}`;
    const waitMs = this.#throttle.waitMs(pairKey);
    if (waitMs > 0) throw new RateLimitedError(waitMs);

    const found = db.select().from(users).where(eq(users.email, normalized)).get();
    // The Argon2 verify runs in all cases, so the response time does not show the reason.
    const passwordOk = found
      ? await hasher.verify(found.passwordHash, password)
      : await hasher.verifyDummy(password);
    // Read the row again: an admin can lock, disable, or reset the user during the verify.
    const user = found ? db.select().from(users).where(eq(users.id, found.id)).get() : undefined;
    const reason = failureReason(user, passwordOk);
    if (reason !== null || !user) {
      this.#recordFailure(user, normalized, pairKey, reason ?? 'unknown_email', meta.ip);
      throw new HydraError('invalid_credentials', MESSAGES.invalidCredentials);
    }

    this.#throttle.reset(pairKey);
    const passwordHash = hasher.needsRehash(user.passwordHash)
      ? await hasher.hash(password)
      : user.passwordHash;
    const now = clock.now();
    const cookieValue = randomBase64Url(32);
    const loginSessionId = newUlid(clock);
    const userAgent = meta.userAgent.slice(0, USER_AGENT_MAX);
    db.transaction((tx) => {
      tx.update(users)
        .set({ failedLogins: 0, lastLoginAt: now, passwordHash })
        .where(eq(users.id, user.id))
        .run();
      tx.insert(loginSessions)
        .values({
          id: loginSessionId,
          userId: user.id,
          tokenHmac: hmac(subkeys.loginSession, cookieValue),
          ip: meta.ip,
          userAgent,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: now + LOGIN_SESSION_MAX_MS,
        })
        .run();
    });
    audit.write({
      kind: 'auth.login',
      actorType: 'user',
      actorId: user.id,
      sessionId: null,
      data: { ip: meta.ip, userAgent },
    });
    return { cookieValue, context: { user: toAuthedUser(user), loginSessionId } };
  }

  /** Spec section 6.4: idle timeout 12 h, maximum life 7 days. Ends a login session that failed. */
  resolve(cookieValue: string | undefined): LoginContext | null {
    if (!cookieValue) return null;
    const { db, clock, subkeys } = this.#deps;
    const row = db
      .select({ session: loginSessions, user: users })
      .from(loginSessions)
      .innerJoin(users, eq(users.id, loginSessions.userId))
      .where(eq(loginSessions.tokenHmac, hmac(subkeys.loginSession, cookieValue)))
      .get();
    if (!row) return null;
    const now = clock.now();
    const expired =
      now >= row.session.expiresAt || now - row.session.lastSeenAt >= LOGIN_SESSION_IDLE_MS;
    if (expired || row.user.status !== 'active') {
      this.#endIds(row.user.id, [row.session.id]);
      return null;
    }
    if (now - row.session.lastSeenAt >= LAST_SEEN_WRITE_MS) {
      db.update(loginSessions)
        .set({ lastSeenAt: now })
        .where(eq(loginSessions.id, row.session.id))
        .run();
    }
    return { user: toAuthedUser(row.user), loginSessionId: row.session.id };
  }

  /** Logout deletes the row (spec section 6.4) and publishes login.ended. */
  logout(context: LoginContext): void {
    const ended = this.#endIds(context.user.id, [context.loginSessionId]);
    if (ended.length > 0) {
      this.#deps.audit.write({
        kind: 'auth.logout',
        actorType: 'user',
        actorId: context.user.id,
        sessionId: null,
        data: {},
      });
    }
  }

  /** Changes the password of the current user and ends all other login sessions of the user. */
  async changePassword(context: LoginContext, current: string, next: string): Promise<void> {
    const { db, hasher, clock, audit } = this.#deps;
    if (!this.#passwordLimiter.take(context.user.id)) {
      throw new RateLimitedError(this.#passwordLimiter.retryAfterMs(context.user.id));
    }
    const user = db.select().from(users).where(eq(users.id, context.user.id)).get();
    if (!user) throw new HydraError('unauthenticated', 'Log in first.');
    checkPasswordRules(next, user.email);
    if (!(await hasher.verify(user.passwordHash, current))) {
      throw new HydraError('password_rejected', 'The current password is not correct.');
    }
    if (next === current) {
      throw new HydraError(
        'password_rejected',
        'The new password must be different from the current password.',
      );
    }
    const passwordHash = await hasher.hash(next);
    const now = clock.now();
    db.update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, user.id))
      .run();
    this.endLoginSessions(user.id, context.loginSessionId);
    audit.write({
      kind: 'auth.password_changed',
      actorType: 'user',
      actorId: user.id,
      sessionId: null,
      data: {},
    });
  }

  /** Ends all login sessions of a user, except one if given. Publishes login.ended. */
  endLoginSessions(userId: string, exceptLoginSessionId?: string): void {
    const where =
      exceptLoginSessionId === undefined
        ? eq(loginSessions.userId, userId)
        : and(eq(loginSessions.userId, userId), ne(loginSessions.id, exceptLoginSessionId));
    const ended = this.#deps.db
      .delete(loginSessions)
      .where(where)
      .returning({ id: loginSessions.id })
      .all()
      .map((row) => row.id);
    if (ended.length > 0) {
      this.#deps.bus.publish({ type: 'login.ended', userId, loginSessionIds: ended });
    }
  }

  /** Daily job (spec section 13.3): deletes expired login sessions and expired live grants. */
  cleanupExpired(): { loginSessions: number; liveGrants: number } {
    const { db, clock, bus } = this.#deps;
    const now = clock.now();
    const expired = db
      .delete(loginSessions)
      .where(
        or(
          lte(loginSessions.expiresAt, now),
          lte(loginSessions.lastSeenAt, now - LOGIN_SESSION_IDLE_MS),
        ),
      )
      .returning({ id: loginSessions.id, userId: loginSessions.userId })
      .all();
    const byUser = new Map<string, string[]>();
    for (const row of expired) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
    for (const [userId, loginSessionIds] of byUser) {
      bus.publish({ type: 'login.ended', userId, loginSessionIds });
    }
    const grants = db.delete(liveGrants).where(lte(liveGrants.expiresAt, now)).run().changes;
    return { loginSessions: expired.length, liveGrants: grants };
  }

  #endIds(userId: string, ids: string[]): string[] {
    const ended: string[] = [];
    for (const id of ids) {
      const deleted = this.#deps.db
        .delete(loginSessions)
        .where(eq(loginSessions.id, id))
        .returning({ id: loginSessions.id })
        .get();
      if (deleted) ended.push(deleted.id);
    }
    if (ended.length > 0) {
      this.#deps.bus.publish({ type: 'login.ended', userId, loginSessionIds: ended });
    }
    return ended;
  }

  #recordFailure(
    user: UserRow | undefined,
    email: string,
    pairKey: string,
    reason: FailureReason,
    ip: string,
  ): void {
    const { db, clock, audit } = this.#deps;
    this.#throttle.fail(pairKey);
    let lockedNow = false;
    if (user) {
      const now = clock.now();
      // One statement, so parallel failures do not lose a count. SET reads the old row values.
      const after = db
        .update(users)
        .set({
          failedLogins: sql`${users.failedLogins} + 1`,
          lockedAt: sql`CASE WHEN ${users.lockedAt} IS NULL AND ${users.failedLogins} + 1 >= ${LOCK_AFTER_FAILURES} THEN ${now} ELSE ${users.lockedAt} END`,
        })
        .where(eq(users.id, user.id))
        .returning({ lockedAt: users.lockedAt })
        .get();
      const lockedAt = after?.lockedAt ?? null;
      lockedNow = user.lockedAt === null && lockedAt !== null;
    }
    audit.write({
      kind: 'auth.login_failed',
      actorType: 'user',
      actorId: user?.id ?? null,
      sessionId: null,
      data: lockedNow ? { email, reason, ip, locked: true } : { email, reason, ip },
    });
  }
}

function failureReason(user: UserRow | undefined, passwordOk: boolean): FailureReason | null {
  if (!user) return 'unknown_email';
  if (user.status !== 'active') return 'disabled';
  if (user.lockedAt !== null) return 'locked';
  if (!passwordOk) return 'wrong_password';
  return null;
}
```

- [ ] **Step 6: Write the public interface of `auth/`**

`packages/server/src/auth/index.ts`:

```ts
export {
  SESSION_COOKIE,
  clearedSessionCookie,
  parseCookies,
  serializeCookie,
  sessionCookie,
  type CookieOptions,
} from './cookies.js';
export { checkCsrf } from './csrf.js';
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkPasswordRules,
  generateOneTimePassword,
  isCommonPassword,
} from './passwords.js';
export { RateLimitedError, RateLimiter } from './rate-limit.js';
export {
  AuthService,
  LOCK_AFTER_FAILURES,
  LOGIN_SESSION_IDLE_MS,
  LOGIN_SESSION_MAX_MS,
  normalizeEmail,
  toAuthedUser,
  type AuthDeps,
  type PasswordHashing,
} from './service.js';
export { LoginThrottle, throttleWaitMs } from './throttle.js';
export type { AuthedUser, LoginContext } from './types.js';
```

- [ ] **Step 7: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/auth`
Expected: PASS, `Test Files  6 passed (6)`, `Tests  55 passed (55)` (20 of them in `service.test.ts`).

- [ ] **Step 8: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 4: The access table (`authorize`)

Spec 6.5 (table, disabled users), 6.7 (Neko profile mapping), 15.1 (`access/`: the full table); index 5.8.

**Files:**
- Create: `packages/server/src/access/rules.ts`
- Test: `packages/server/src/access/rules.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `Action`, `MemberRole`, `NekoProfile`, `SessionRole` (`@hydra/shared`); `AuthedUser` (type, `src/auth/types.ts`).
- Produces: `interface SessionAccessView { id; ownerId; memberRole: MemberRole | null }`; `type EffectiveRole = SessionRole | 'admin'`; `effectiveRole(user, session): EffectiveRole | null`; `authorize(user, session, action): boolean`; `rightsOf(user, session): Action[]`; `nekoProfileOf(role): NekoProfile`; `rightOnlyFromAdmin(user, session, action): boolean`.

- [ ] **Step 1: Write the failing test**

The test copies the table of spec 6.5 cell by cell (12 actions × 4 roles = 48 cells) and checks that it names each action exactly one time.

`packages/server/src/access/rules.test.ts`:

```ts
import { ACTIONS, type Action } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import type { AuthedUser } from '../auth/types.js';
import {
  authorize,
  effectiveRole,
  nekoProfileOf,
  rightOnlyFromAdmin,
  rightsOf,
  type SessionAccessView,
} from './rules.js';

// Spec section 6.5, copied cell by cell: [action, viewer, operator, owner, admin].
const TABLE: Array<[Action, boolean, boolean, boolean, boolean]> = [
  ['session.read', true, true, true, true],
  ['live.watch', true, true, true, true],
  ['live.control', false, true, true, true],
  ['session.lifecycle', false, true, true, true],
  ['session.logs', false, true, true, true],
  ['token.create', false, true, true, true],
  ['token.revoke_own', false, true, true, true],
  ['audit.read', false, true, true, true],
  ['token.revoke_any', false, false, true, true],
  ['session.update', false, false, true, true],
  ['session.share', false, false, true, true],
  ['session.delete', false, false, true, true],
];

const OWNER_ID = 'owner-1';

function user(id: string, overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    role: 'member',
    status: 'active',
    mustChangePassword: false,
    ...overrides,
  };
}

const PRINCIPALS = {
  viewer: {
    user: user('viewer-1'),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: 'viewer' } satisfies SessionAccessView,
  },
  operator: {
    user: user('operator-1'),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: 'operator' } satisfies SessionAccessView,
  },
  owner: {
    user: user(OWNER_ID),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: null } satisfies SessionAccessView,
  },
  admin: {
    user: user('admin-1', { role: 'admin' }),
    session: { id: 's1', ownerId: OWNER_ID, memberRole: null } satisfies SessionAccessView,
  },
};

describe('authorize: the table of spec section 6.5', () => {
  it('covers every action exactly one time', () => {
    expect(TABLE.map(([action]) => action).sort()).toEqual([...ACTIONS].sort());
  });

  const cells = TABLE.flatMap(([action, viewer, operator, owner, admin]) => [
    { action, role: 'viewer' as const, expected: viewer },
    { action, role: 'operator' as const, expected: operator },
    { action, role: 'owner' as const, expected: owner },
    { action, role: 'admin' as const, expected: admin },
  ]);

  it.each(cells)('$role / $action → $expected', ({ action, role, expected }) => {
    const { user: principal, session } = PRINCIPALS[role];
    expect(authorize(principal, session, action)).toBe(expected);
  });

  it.each(ACTIONS)('a user without a role has no right: %s', (action) => {
    const stranger = user('stranger');
    expect(authorize(stranger, PRINCIPALS.owner.session, action)).toBe(false);
  });

  it.each(['viewer', 'operator', 'owner', 'admin'] as const)(
    'a disabled %s has no right',
    (role) => {
      const { user: principal, session } = PRINCIPALS[role];
      const disabled = { ...principal, status: 'disabled' as const };
      for (const action of ACTIONS) expect(authorize(disabled, session, action)).toBe(false);
      expect(effectiveRole(disabled, session)).toBeNull();
      expect(rightsOf(disabled, session)).toEqual([]);
    },
  );
});

describe('effectiveRole, rightsOf, nekoProfileOf', () => {
  it('gives each principal its role', () => {
    expect(effectiveRole(PRINCIPALS.viewer.user, PRINCIPALS.viewer.session)).toBe('viewer');
    expect(effectiveRole(PRINCIPALS.operator.user, PRINCIPALS.operator.session)).toBe('operator');
    expect(effectiveRole(PRINCIPALS.owner.user, PRINCIPALS.owner.session)).toBe('owner');
    expect(effectiveRole(PRINCIPALS.admin.user, PRINCIPALS.admin.session)).toBe('admin');
    expect(effectiveRole(user('x'), PRINCIPALS.owner.session)).toBeNull();
  });

  it('ranks owner over admin, and admin over a member role', () => {
    const admin = user(OWNER_ID, { role: 'admin' });
    expect(effectiveRole(admin, PRINCIPALS.owner.session)).toBe('owner');
    const adminViewer = user('admin-2', { role: 'admin' });
    expect(effectiveRole(adminViewer, { id: 's1', ownerId: OWNER_ID, memberRole: 'viewer' })).toBe(
      'admin',
    );
  });

  it('lists the rights in the order of ACTIONS', () => {
    expect(rightsOf(PRINCIPALS.viewer.user, PRINCIPALS.viewer.session)).toEqual([
      'session.read',
      'live.watch',
    ]);
    expect(rightsOf(PRINCIPALS.owner.user, PRINCIPALS.owner.session)).toEqual([...ACTIONS]);
  });

  it('maps roles to Neko profiles', () => {
    expect(nekoProfileOf('owner')).toBe('admin');
    expect(nekoProfileOf('operator')).toBe('admin');
    expect(nekoProfileOf('admin')).toBe('admin');
    expect(nekoProfileOf('viewer')).toBe('user');
  });
});

describe('rightOnlyFromAdmin', () => {
  const admin = user('admin-1', { role: 'admin' });

  it('is true for an admin without a session role', () => {
    expect(rightOnlyFromAdmin(admin, PRINCIPALS.admin.session, 'session.read')).toBe(true);
  });

  it('is false when the session role gives the right', () => {
    const asOperator = { id: 's1', ownerId: OWNER_ID, memberRole: 'operator' as const };
    expect(rightOnlyFromAdmin(admin, asOperator, 'audit.read')).toBe(false);
    expect(rightOnlyFromAdmin(admin, asOperator, 'session.share')).toBe(true);
    const asOwner = { id: 's1', ownerId: admin.id, memberRole: null };
    expect(rightOnlyFromAdmin(admin, asOwner, 'session.delete')).toBe(false);
  });

  it('is false for members', () => {
    expect(
      rightOnlyFromAdmin(PRINCIPALS.operator.user, PRINCIPALS.operator.session, 'audit.read'),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/access/rules.test.ts`
Expected: FAIL with `Error: Cannot find module './rules.js' imported from …/src/access/rules.test.ts`.

- [ ] **Step 3: Write the implementation**

`authorize()` is the only function that reads `ROLE_RIGHTS` (spec 6.5). `effectiveRole` ranks the owner first, then the global admin role, then the member role (index issue 3).

`packages/server/src/access/rules.ts`:

```ts
import {
  ACTIONS,
  type Action,
  type MemberRole,
  type NekoProfile,
  type SessionRole,
} from '@hydra/shared';
import type { AuthedUser } from '../auth/types.js';

export interface SessionAccessView {
  id: string;
  ownerId: string;
  memberRole: MemberRole | null;
}

export type EffectiveRole = SessionRole | 'admin';

const VIEWER_RIGHTS: readonly Action[] = ['session.read', 'live.watch'];
const OPERATOR_RIGHTS: readonly Action[] = [
  ...VIEWER_RIGHTS,
  'live.control',
  'session.lifecycle',
  'session.logs',
  'token.create',
  'token.revoke_own',
  'audit.read',
];

/** The table of spec section 6.5. `authorize()` is the only place that reads it. */
const ROLE_RIGHTS: Record<EffectiveRole, ReadonlySet<Action>> = {
  viewer: new Set(VIEWER_RIGHTS),
  operator: new Set(OPERATOR_RIGHTS),
  owner: new Set(ACTIONS),
  admin: new Set(ACTIONS),
};

/**
 * The role whose rights apply: owner, then the global admin role, then the member role.
 * Disabled users have no role. An admin who is also a member gets 'admin', because the admin
 * rights are a superset; thus `nekoProfileOf(effectiveRole(...))` is right for this user too.
 */
export function effectiveRole(user: AuthedUser, session: SessionAccessView): EffectiveRole | null {
  if (user.status !== 'active') return null;
  if (session.ownerId === user.id) return 'owner';
  if (user.role === 'admin') return 'admin';
  return session.memberRole;
}

export function authorize(user: AuthedUser, session: SessionAccessView, action: Action): boolean {
  const role = effectiveRole(user, session);
  return role !== null && ROLE_RIGHTS[role].has(action);
}

/** All actions that the user can do on the session, in the order of ACTIONS. */
export function rightsOf(user: AuthedUser, session: SessionAccessView): Action[] {
  return ACTIONS.filter((action) => authorize(user, session, action));
}

/** Spec section 6.7: owner, operator, and admin get the Neko admin profile; viewer gets user. */
export function nekoProfileOf(role: EffectiveRole): NekoProfile {
  return role === 'viewer' ? 'user' : 'admin';
}

/** True if the user has the right only because of the global admin role (index 5.8 rule). */
export function rightOnlyFromAdmin(
  user: AuthedUser,
  session: SessionAccessView,
  action: Action,
): boolean {
  if (user.status !== 'active' || user.role !== 'admin') return false;
  const sessionRole: SessionRole | null =
    session.ownerId === user.id ? 'owner' : session.memberRole;
  return sessionRole === null || !ROLE_RIGHTS[sessionRole].has(action);
}
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/access/rules.test.ts`
Expected: PASS, `Tests  72 passed (72)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 5: `AccessService` (session view, the 404 rule, members)

Spec 6.5 (404 rule, admin audit, owner rules, rights change); index 5.8 (`AccessService`, `admin.session_access` rule).

**Files:**
- Create: `packages/server/src/access/service.ts`, `packages/server/src/access/index.ts`
- Test: `packages/server/src/access/service.test.ts`

**Interfaces:**
- Consumes: Task 4; `Db`, `sessions`, `sessionMembers`, `users`; `AuditWriter`; `EventBus`; `HydraError`; `AddMemberRequest`, `Member`, `MembersResponse`, `MemberRole`, `Action` (`@hydra/shared`); `seedUser`, `seedSession`, `plainHasher` (Task 3).
- Produces: `class AccessService` with `view`, `requireSession`, `listReadable`, `members`, `addMember`, `updateMember`, `removeMember` (index 5.8) and `can(userId, sessionId, action): boolean`; `interface RequestInfo { method: string; path: string }`; `AccessDeps = { db; clock; audit; bus }`; `src/access/index.ts`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/access/service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import { auditEvents } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { AccessService } from './service.js';

const START = { method: 'POST', path: '/api/sessions/:sid/start' };

describe('AccessService', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let access: AccessService;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let viewer: AuthedUser;
  let stranger: AuthedUser;
  let admin: AuthedUser;
  let sid: string;

  const ctx = (user: AuthedUser): LoginContext => ({ user, loginSessionId: 'ls-1' });

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('rights.changed', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    const deps = { db: testDb.db, clock, hasher: plainHasher };
    owner = (await seedUser(deps, { email: 'owner@example.com' })).user;
    operator = (await seedUser(deps, { email: 'operator@example.com' })).user;
    viewer = (await seedUser(deps, { email: 'viewer@example.com' })).user;
    stranger = (await seedUser(deps, { email: 'stranger@example.com' })).user;
    admin = (await seedUser(deps, { email: 'admin@example.com', role: 'admin' })).user;
    sid = seedSession({ db: testDb.db, clock, config: testConfig() }, { ownerId: owner.id }).id;
    access.addMember(ctx(owner), sid, { email: operator.email, role: 'operator' });
    access.addMember(ctx(owner), sid, { email: viewer.email, role: 'viewer' });
    events.length = 0;
  });

  afterEach(() => testDb.close());

  const adminAccessRows = () =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.kind === 'admin.session_access');

  function codeOf(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('view and can', () => {
    it('returns the owner and the member role', () => {
      expect(access.view(viewer.id, sid)).toEqual({
        id: sid,
        ownerId: owner.id,
        memberRole: 'viewer',
      });
      expect(access.view(stranger.id, sid)).toEqual({
        id: sid,
        ownerId: owner.id,
        memberRole: null,
      });
      expect(access.view(owner.id, 'nosuchsession')).toBeNull();
    });

    it('treats a deleted session as missing', () => {
      const deleted = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: owner.id, state: 'deleted' },
      );
      expect(access.view(owner.id, deleted.id)).toBeNull();
      expect(access.can(owner.id, deleted.id, 'session.read')).toBe(false);
    });

    it('checks the current user row', async () => {
      expect(access.can(operator.id, sid, 'token.create')).toBe(true);
      expect(access.can(viewer.id, sid, 'token.create')).toBe(false);
      expect(access.can('nobody', sid, 'session.read')).toBe(false);
      const disabled = await seedUser(
        { db: testDb.db, clock, hasher: plainHasher },
        { status: 'disabled' },
      );
      access.addMember(ctx(owner), sid, { email: disabled.user.email, role: 'operator' });
      expect(access.can(disabled.user.id, sid, 'session.read')).toBe(false);
    });
  });

  describe('requireSession', () => {
    it('returns 404 for a user without session.read, also for a missing session', () => {
      expect(codeOf(() => access.requireSession(ctx(stranger), sid, 'session.read', START))).toBe(
        'not_found',
      );
      expect(codeOf(() => access.requireSession(ctx(stranger), sid, 'session.delete', START))).toBe(
        'not_found',
      );
      expect(
        codeOf(() => access.requireSession(ctx(owner), 'nosuchsession', 'session.read', START)),
      ).toBe('not_found');
    });

    it('returns 403 for a user who can see the session but has no right', () => {
      expect(codeOf(() => access.requireSession(ctx(viewer), sid, 'audit.read', START))).toBe(
        'forbidden',
      );
      expect(codeOf(() => access.requireSession(ctx(operator), sid, 'session.share', START))).toBe(
        'forbidden',
      );
    });

    it('returns 404 for a disabled owner', () => {
      const disabledOwner = { ...owner, status: 'disabled' as const };
      expect(
        codeOf(() => access.requireSession(ctx(disabledOwner), sid, 'session.read', START)),
      ).toBe('not_found');
    });

    it('returns the view when the right exists', () => {
      expect(access.requireSession(ctx(operator), sid, 'audit.read', START).memberRole).toBe(
        'operator',
      );
      expect(adminAccessRows()).toHaveLength(0);
    });

    it('writes admin.session_access when the right comes only from the admin role', () => {
      access.requireSession(ctx(admin), sid, 'session.lifecycle', START);
      const rows = adminAccessRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'user',
        actorId: admin.id,
        sessionId: sid,
        data: { action: 'session.lifecycle', method: 'POST', path: '/api/sessions/:sid/start' },
      });
    });

    it('does not write it for the exempt reads, with a pattern or a real path', () => {
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/sessions/:sid',
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: `/api/sessions/${sid}/members`,
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/sessions',
      });
      access.requireSession(ctx(admin), sid, 'session.read', {
        method: 'GET',
        path: '/api/events',
      });
      expect(adminAccessRows()).toHaveLength(0);
      access.requireSession(ctx(admin), sid, 'audit.read', {
        method: 'GET',
        path: '/api/sessions/:sid/audit',
      });
      expect(adminAccessRows()).toHaveLength(1);
    });

    it('does not write it when an admin member uses a right of the member role', () => {
      access.addMember(ctx(owner), sid, { email: admin.email, role: 'operator' });
      access.requireSession(ctx(admin), sid, 'audit.read', START);
      expect(adminAccessRows()).toHaveLength(0);
      access.requireSession(ctx(admin), sid, 'session.share', START);
      expect(adminAccessRows()).toHaveLength(1);
    });
  });

  describe('listReadable', () => {
    it('lists owned and shared sessions, not deleted ones, and all sessions for admins', () => {
      const config = testConfig();
      const other = seedSession({ db: testDb.db, clock, config }, { ownerId: stranger.id });
      seedSession({ db: testDb.db, clock, config }, { ownerId: viewer.id, state: 'deleted' });
      expect(access.listReadable(viewer, { all: false })).toEqual([sid]);
      expect(access.listReadable(stranger, { all: true })).toEqual([other.id]);
      expect(access.listReadable(admin, { all: false })).toEqual([]);
      expect(access.listReadable(admin, { all: true })).toEqual([sid, other.id]);
      expect(access.listReadable({ ...viewer, status: 'disabled' }, { all: false })).toEqual([]);
    });
  });

  describe('members', () => {
    it('lists the owner and the members', () => {
      expect(access.members(sid)).toEqual({
        owner: {
          userId: owner.id,
          email: owner.email,
          displayName: owner.displayName,
          role: 'owner',
        },
        members: [
          {
            userId: operator.id,
            email: operator.email,
            displayName: operator.displayName,
            role: 'operator',
          },
          {
            userId: viewer.id,
            email: viewer.email,
            displayName: viewer.displayName,
            role: 'viewer',
          },
        ],
      });
    });

    it('adds a member by email in any case and publishes rights.changed', () => {
      const member = access.addMember(ctx(owner), sid, {
        email: ' STRANGER@example.com ',
        role: 'viewer',
      });
      expect(member).toEqual({
        userId: stranger.id,
        email: stranger.email,
        displayName: stranger.displayName,
        role: 'viewer',
      });
      expect(events).toEqual([{ type: 'rights.changed', userId: stranger.id }]);
    });

    it('rejects an unknown email, the owner, and an existing member', () => {
      expect(
        codeOf(() =>
          access.addMember(ctx(owner), sid, { email: 'ghost@example.com', role: 'viewer' }),
        ),
      ).toBe('not_found');
      expect(
        codeOf(() => access.addMember(ctx(owner), sid, { email: owner.email, role: 'viewer' })),
      ).toBe('conflict');
      expect(
        codeOf(() => access.addMember(ctx(owner), sid, { email: viewer.email, role: 'operator' })),
      ).toBe('conflict');
      expect(events).toEqual([]);
    });

    it('changes a member role and publishes rights.changed', () => {
      const member = access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(member.role).toBe('viewer');
      expect(access.view(operator.id, sid)?.memberRole).toBe('viewer');
      expect(events).toEqual([{ type: 'rights.changed', userId: operator.id }]);
      access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(events).toHaveLength(1);
    });

    it('removes a member and publishes rights.changed', () => {
      access.removeMember(ctx(owner), sid, viewer.id);
      expect(access.view(viewer.id, sid)?.memberRole).toBeNull();
      expect(events).toEqual([{ type: 'rights.changed', userId: viewer.id }]);
      const kinds = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .map((row) => row.kind);
      expect(kinds).toContain('session.unshared');
    });

    it('does not change or remove the owner, or a user who is not a member', () => {
      expect(codeOf(() => access.updateMember(ctx(owner), sid, owner.id, 'viewer'))).toBe(
        'conflict',
      );
      expect(codeOf(() => access.removeMember(ctx(owner), sid, owner.id))).toBe('conflict');
      expect(codeOf(() => access.updateMember(ctx(owner), sid, stranger.id, 'viewer'))).toBe(
        'not_found',
      );
      expect(codeOf(() => access.removeMember(ctx(owner), sid, stranger.id))).toBe('not_found');
      expect(events).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/access/service.test.ts`
Expected: FAIL with `Error: Cannot find module './service.js' imported from …/src/access/service.test.ts`.

- [ ] **Step 3: Write the service**

`requireSession` checks `session.read` first, so a user who cannot see the session gets 404 for every action. The `admin.session_access` exemptions (index 5.8) match both route patterns (`/api/sessions/:sid`) and real paths. `addMember` publishes `rights.changed` too (index 5.8), although adding gives rights.

`packages/server/src/access/service.ts`:

```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Action, AddMemberRequest, Member, MemberRole, MembersResponse } from '@hydra/shared';
import type { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import type { Db } from '../db/index.js';
import { sessionMembers, sessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { authorize, rightOnlyFromAdmin, type SessionAccessView } from './rules.js';

export interface AccessDeps {
  db: Db;
  clock: Clock;
  audit: AuditWriter;
  bus: EventBus;
}

export interface RequestInfo {
  method: string;
  /** The route pattern (for example `/api/sessions/:sid/members`) or the path. */
  path: string;
}

/** Requests that do not write admin.session_access (index section 5.8). */
const ADMIN_AUDIT_EXEMPT = [
  /^GET \/api\/sessions\/?$/,
  /^GET \/api\/sessions\/[^/]+\/?$/,
  /^GET \/api\/sessions\/[^/]+\/members\/?$/,
  /^GET \/api\/events\/?$/,
];

function isAdminAuditExempt(request: RequestInfo): boolean {
  const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
  const key = `${method} ${request.path.split('?')[0] ?? ''}`;
  return ADMIN_AUDIT_EXEMPT.some((pattern) => pattern.test(key));
}

function notFound(): HydraError {
  return new HydraError('not_found', 'Session not found.');
}

export class AccessService {
  readonly #deps: AccessDeps;

  constructor(deps: AccessDeps) {
    this.#deps = deps;
  }

  /** Null if the session does not exist or is deleted. */
  view(userId: string, sessionId: string): SessionAccessView | null {
    const { db } = this.#deps;
    const session = db
      .select({ id: sessions.id, ownerId: sessions.ownerId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
      .get();
    if (!session) return null;
    const member = db
      .select({ role: sessionMembers.role })
      .from(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .get();
    return { id: session.id, ownerId: session.ownerId, memberRole: member?.role ?? null };
  }

  /**
   * No session.read → not_found (spec section 6.5, never 403). No right → forbidden.
   * Writes admin.session_access when the right comes only from the global admin role.
   */
  requireSession(
    context: LoginContext,
    sessionId: string,
    action: Action,
    request: RequestInfo,
  ): SessionAccessView {
    const view = this.view(context.user.id, sessionId);
    if (!view || !authorize(context.user, view, 'session.read')) throw notFound();
    if (!authorize(context.user, view, action)) {
      throw new HydraError('forbidden', 'You do not have the right for this action.');
    }
    if (rightOnlyFromAdmin(context.user, view, action) && !isAdminAuditExempt(request)) {
      this.#deps.audit.write({
        kind: 'admin.session_access',
        actorType: 'user',
        actorId: context.user.id,
        sessionId,
        data: { action, method: request.method, path: request.path },
      });
    }
    return view;
  }

  /** Reads the user again from the DB. False for a missing or disabled user or session. */
  can(userId: string, sessionId: string, action: Action): boolean {
    const row = this.#deps.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!row) return false;
    const view = this.view(userId, sessionId);
    return view !== null && authorize(row, view, action);
  }

  /** Session IDs that the user can read. `all` lists all sessions, for admins only. */
  listReadable(user: AuthedUser, options: { all: boolean }): string[] {
    if (user.status !== 'active') return [];
    const { db } = this.#deps;
    const notDeleted = isNull(sessions.deletedAt);
    if (options.all && user.role === 'admin') {
      return db
        .select({ id: sessions.id })
        .from(sessions)
        .where(notDeleted)
        .orderBy(asc(sessions.createdAt))
        .all()
        .map((row) => row.id);
    }
    const owned = db
      .select({ id: sessions.id, createdAt: sessions.createdAt })
      .from(sessions)
      .where(and(eq(sessions.ownerId, user.id), notDeleted))
      .all();
    const shared = db
      .select({ id: sessions.id, createdAt: sessions.createdAt })
      .from(sessionMembers)
      .innerJoin(sessions, eq(sessions.id, sessionMembers.sessionId))
      .where(and(eq(sessionMembers.userId, user.id), notDeleted))
      .all();
    return [...owned, ...shared]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => row.id)
      .filter((id, index, ids) => ids.indexOf(id) === index);
  }

  members(sessionId: string): MembersResponse {
    const { db } = this.#deps;
    const owner = db
      .select({ userId: users.id, email: users.email, displayName: users.displayName })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.ownerId))
      .where(eq(sessions.id, sessionId))
      .get();
    if (!owner) throw notFound();
    const members = db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        role: sessionMembers.role,
      })
      .from(sessionMembers)
      .innerJoin(users, eq(users.id, sessionMembers.userId))
      .where(eq(sessionMembers.sessionId, sessionId))
      .orderBy(asc(sessionMembers.createdAt), asc(users.email))
      .all();
    return { owner: { ...owner, role: 'owner' }, members };
  }

  addMember(context: LoginContext, sessionId: string, input: AddMemberRequest): Member {
    const { db, clock, audit, bus } = this.#deps;
    const ownerId = this.#ownerId(sessionId);
    const user = db
      .select({ id: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .get();
    if (!user) throw new HydraError('not_found', 'No user has this email.');
    if (user.id === ownerId) {
      throw new HydraError('conflict', 'The owner cannot be added as a member.');
    }
    if (this.#memberRole(sessionId, user.id) !== null) {
      throw new HydraError('conflict', 'This user is already a member.');
    }
    db.insert(sessionMembers)
      .values({
        sessionId,
        userId: user.id,
        role: input.role,
        grantedBy: context.user.id,
        createdAt: clock.now(),
      })
      .run();
    audit.write({
      kind: 'session.shared',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { userId: user.id, email: user.email, role: input.role },
    });
    bus.publish({ type: 'rights.changed', userId: user.id });
    return { userId: user.id, email: user.email, displayName: user.displayName, role: input.role };
  }

  updateMember(context: LoginContext, sessionId: string, userId: string, role: MemberRole): Member {
    const { db, audit, bus } = this.#deps;
    if (userId === this.#ownerId(sessionId)) {
      throw new HydraError('conflict', 'The owner cannot be changed.');
    }
    const previous = this.#memberRole(sessionId, userId);
    if (previous === null) throw new HydraError('not_found', 'Member not found.');
    db.update(sessionMembers)
      .set({ role })
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .run();
    const user = db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!user) throw new HydraError('not_found', 'Member not found.');
    if (previous !== role) {
      audit.write({
        kind: 'session.shared',
        actorType: 'user',
        actorId: context.user.id,
        sessionId,
        data: { userId, email: user.email, role, previousRole: previous },
      });
      bus.publish({ type: 'rights.changed', userId });
    }
    return { userId, email: user.email, displayName: user.displayName, role };
  }

  removeMember(context: LoginContext, sessionId: string, userId: string): void {
    const { db, audit, bus } = this.#deps;
    if (userId === this.#ownerId(sessionId)) {
      throw new HydraError('conflict', 'The owner cannot be removed.');
    }
    const removed = db
      .delete(sessionMembers)
      .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
      .returning({ role: sessionMembers.role })
      .get();
    if (!removed) throw new HydraError('not_found', 'Member not found.');
    audit.write({
      kind: 'session.unshared',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { userId, previousRole: removed.role },
    });
    bus.publish({ type: 'rights.changed', userId });
  }

  #ownerId(sessionId: string): string {
    const session = this.#deps.db
      .select({ ownerId: sessions.ownerId })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt)))
      .get();
    if (!session) throw notFound();
    return session.ownerId;
  }

  #memberRole(sessionId: string, userId: string): MemberRole | null {
    return (
      this.#deps.db
        .select({ role: sessionMembers.role })
        .from(sessionMembers)
        .where(and(eq(sessionMembers.sessionId, sessionId), eq(sessionMembers.userId, userId)))
        .get()?.role ?? null
    );
  }
}
```

`packages/server/src/access/index.ts`:

```ts
export {
  authorize,
  effectiveRole,
  nekoProfileOf,
  rightOnlyFromAdmin,
  rightsOf,
  type EffectiveRole,
  type SessionAccessView,
} from './rules.js';
export { AccessService, type AccessDeps, type RequestInfo } from './service.js';
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/access`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  89 passed (89)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 6: `TokensService`

Spec 6.6 (format, storage, expiry, validity, `last_used`), 8.2 step 1 (`resolveAgentPrincipal`); index 5.8.

**Files:**
- Create: `packages/server/src/tokens/service.ts`, `packages/server/src/tokens/index.ts`
- Test: `packages/server/src/tokens/service.test.ts`

**Interfaces:**
- Consumes: `newAgentToken(): { token; prefix }` (`hyd_` + 43 base62 characters; prefix `hyd_` + 8 characters + `…`), `hmac`, `newUlid`, `Subkeys`; `agentTokens`, `users`; `authorize`, `AccessService.can`, `SessionAccessView` (Tasks 4 and 5); `AuditWriter`; `EventBus`; `CreateTokenRequest`, `CreateTokenResponse`, `Token` (`@hydra/shared`; `expiresInDays` is required in the output type).
- Produces: `interface AgentPrincipal { tokenId; userId; sessionId }`; `class TokensService` with `create`, `list`, `revoke`, `revokeAllForSession`, `revokeAllCreatedBy`, `isValid`, `resolve` (index 5.8) and `revokeInSession(context, view, tokenId)`; `parseBearer(authorization): string | null`; `TokensDeps = { db; clock; subkeys; access: Pick<AccessService, 'can'>; audit; bus }`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/tokens/service.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import type { AuthedUser, LoginContext } from '../auth/types.js';
import { deriveSubkeys, hmac } from '../crypto/index.js';
import { agentTokens, auditEvents, sessions, users } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { TokensService, parseBearer } from './service.js';

const DAY = 24 * 60 * 60 * 1000;
const IP = '192.0.2.10';

describe('TokensService', () => {
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let access: AccessService;
  let tokens: TokensService;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let otherOperator: AuthedUser;
  let sid: string;
  let otherSid: string;

  const ctx = (user: AuthedUser): LoginContext => ({ user, loginSessionId: 'ls-1' });
  const view = (user: AuthedUser) => {
    const result = access.view(user.id, sid);
    if (!result) throw new Error('no view');
    return result;
  };

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    bus.subscribe('token.revoked', (event) => events.push(event));
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    tokens = new TokensService({ db: testDb.db, clock, subkeys, access, audit, bus });
    const deps = { db: testDb.db, clock, hasher: plainHasher };
    owner = (await seedUser(deps, { displayName: 'Owner' })).user;
    operator = (await seedUser(deps, { displayName: 'Op One' })).user;
    otherOperator = (await seedUser(deps, { displayName: 'Op Two' })).user;
    const config = testConfig();
    sid = seedSession({ db: testDb.db, clock, config }, { ownerId: owner.id, state: 'running' }).id;
    otherSid = seedSession({ db: testDb.db, clock, config }, { ownerId: owner.id }).id;
    access.addMember(ctx(owner), sid, { email: operator.email, role: 'operator' });
    access.addMember(ctx(owner), sid, { email: otherOperator.email, role: 'operator' });
  });

  afterEach(() => testDb.close());

  const create = (user = operator, expiresInDays: 1 | 7 | 30 | 90 = 30) =>
    tokens.create(ctx(user), sid, { name: 'claude', expiresInDays });

  const row = (id: string) =>
    testDb.db.select().from(agentTokens).where(eq(agentTokens.id, id)).get();

  function codeOf(fn: () => unknown): string | null {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('create', () => {
    it('returns the secret one time and stores only its HMAC', () => {
      const { token, secret } = create();
      expect(secret).toMatch(/^hyd_[0-9A-Za-z]+$/);
      expect(token.prefix).toBe(`${secret.slice(0, 12)}…`);
      expect(token.createdBy).toEqual({ id: operator.id, displayName: 'Op One' });
      const stored = row(token.id);
      expect(stored?.tokenHmac.equals(hmac(subkeys.agentToken, secret))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(secret.slice(4));
      const audit = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'token.created');
      expect(audit?.data).toEqual({
        tokenId: token.id,
        name: 'claude',
        prefix: token.prefix,
        expiresAt: token.expiresAt,
      });
    });

    it.each([1, 7, 30, 90] as const)('expires after %i days', (days) => {
      const { token } = create(operator, days);
      expect(token.expiresAt).toBe(clock.now() + days * DAY);
    });
  });

  describe('list', () => {
    it('lists all tokens of the session, newest first, without secrets', () => {
      const first = create(operator).token;
      clock.advance(1000);
      const second = create(otherOperator).token;
      tokens.revoke(ctx(owner), first.id);
      tokens.create(ctx(owner), otherSid, { name: 'elsewhere', expiresInDays: 1 });
      const listed = tokens.list(sid);
      expect(listed.map((token) => token.id)).toEqual([second.id, first.id]);
      expect(listed[1]?.revokedAt).toBe(clock.now());
      expect(listed[0]?.createdBy.displayName).toBe('Op Two');
      expect(JSON.stringify(listed)).not.toContain('secret');
    });
  });

  describe('resolve', () => {
    it('accepts a valid bearer token for its own session only', () => {
      const { token, secret } = create();
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toEqual({
        tokenId: token.id,
        userId: operator.id,
        sessionId: sid,
      });
      expect(tokens.resolve(`bearer ${secret}`, sid, IP)).not.toBeNull();
      expect(tokens.resolve(`Bearer ${secret}`, otherSid, IP)).toBeNull();
      expect(tokens.resolve(undefined, sid, IP)).toBeNull();
      expect(tokens.resolve(secret, sid, IP)).toBeNull();
      expect(tokens.resolve(`Basic ${secret}`, sid, IP)).toBeNull();
      expect(tokens.resolve('Bearer hyd_doesnotexist', sid, IP)).toBeNull();
    });

    it('rejects an expired token', () => {
      const { secret } = create(operator, 1);
      clock.advance(DAY - 1);
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).not.toBeNull();
      clock.advance(1);
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
    });

    it('rejects a token of a deleted session', () => {
      const { secret } = create();
      testDb.db
        .update(sessions)
        .set({ state: 'deleted', deletedAt: clock.now() })
        .where(eq(sessions.id, sid))
        .run();
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
    });

    it('rejects a token whose creator lost token.create or was disabled', () => {
      const first = create(operator);
      const second = create(otherOperator);
      access.updateMember(ctx(owner), sid, operator.id, 'viewer');
      expect(tokens.resolve(`Bearer ${first.secret}`, sid, IP)).toBeNull();
      expect(tokens.isValid(first.token.id)).toBe(false);
      testDb.db
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, otherOperator.id))
        .run();
      expect(tokens.resolve(`Bearer ${second.secret}`, sid, IP)).toBeNull();
    });

    it('writes last_used_at and last_used_ip at most one time per minute', () => {
      const { token, secret } = create();
      const start = clock.now();
      tokens.resolve(`Bearer ${secret}`, sid, IP);
      expect(row(token.id)).toMatchObject({ lastUsedAt: start, lastUsedIp: IP });
      clock.advance(59_999);
      tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.99');
      expect(row(token.id)).toMatchObject({ lastUsedAt: start, lastUsedIp: IP });
      clock.advance(1);
      tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.99');
      expect(row(token.id)).toMatchObject({ lastUsedAt: start + 60_000, lastUsedIp: '192.0.2.99' });
    });
  });

  describe('revoke', () => {
    it('revokes, writes token.revoked, publishes token.revoked, and is a no-op the second time', () => {
      const { token, secret } = create();
      tokens.revoke(ctx(operator), token.id);
      expect(row(token.id)).toMatchObject({ revokedAt: clock.now(), revokedBy: operator.id });
      expect(tokens.resolve(`Bearer ${secret}`, sid, IP)).toBeNull();
      expect(events).toEqual([{ type: 'token.revoked', tokenId: token.id, sessionId: sid }]);
      tokens.revoke(ctx(operator), token.id);
      expect(events).toHaveLength(1);
      const audits = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .filter((event) => event.kind === 'token.revoked');
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: 'user', actorId: operator.id, sessionId: sid });
    });

    it('records the system as the actor', () => {
      const { token } = create();
      tokens.revoke('system', token.id);
      expect(row(token.id)?.revokedBy).toBeNull();
      const audit = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'token.revoked');
      expect(audit).toMatchObject({ actorType: 'system', actorId: null });
    });

    it('fails for an unknown token', () => {
      expect(codeOf(() => tokens.revoke('system', 'nope'))).toBe('not_found');
    });
  });

  describe('revokeInSession', () => {
    it('lets an operator revoke an own token but not the token of another user', () => {
      const own = create(operator).token;
      const others = create(otherOperator).token;
      tokens.revokeInSession(ctx(operator), view(operator), own.id);
      expect(row(own.id)?.revokedAt).not.toBeNull();
      expect(codeOf(() => tokens.revokeInSession(ctx(operator), view(operator), others.id))).toBe(
        'forbidden',
      );
      expect(row(others.id)?.revokedAt).toBeNull();
    });

    it('lets the owner revoke any token', () => {
      const others = create(otherOperator).token;
      tokens.revokeInSession(ctx(owner), view(owner), others.id);
      expect(row(others.id)?.revokedBy).toBe(owner.id);
    });

    it('returns not_found for a token of another session', () => {
      const elsewhere = tokens.create(ctx(owner), otherSid, { name: 'x', expiresInDays: 1 }).token;
      expect(codeOf(() => tokens.revokeInSession(ctx(owner), view(owner), elsewhere.id))).toBe(
        'not_found',
      );
    });
  });

  describe('bulk revoke', () => {
    it('revokes all active tokens of a session, or of a creator', () => {
      const a = create(operator).token;
      const b = create(otherOperator).token;
      const c = tokens.create(ctx(operator), otherSid, { name: 'x', expiresInDays: 1 });
      tokens.revokeAllCreatedBy(operator.id);
      expect(
        [row(a.id)?.revokedAt, row(c.token.id)?.revokedAt].every((value) => value !== null),
      ).toBe(true);
      expect(row(b.id)?.revokedAt).toBeNull();
      tokens.revokeAllForSession(sid);
      expect(row(b.id)?.revokedAt).not.toBeNull();
      expect(events.map((event) => (event as { tokenId: string }).tokenId).sort()).toEqual(
        [a.id, b.id, c.token.id].sort(),
      );
    });
  });
});

describe('parseBearer', () => {
  it('accepts only the Bearer scheme with a hyd_ token', () => {
    expect(parseBearer('Bearer hyd_abc123')).toBe('hyd_abc123');
    expect(parseBearer('BEARER   hyd_abc123  ')).toBe('hyd_abc123');
    expect(parseBearer('Bearer abc123')).toBeNull();
    expect(parseBearer('Bearer hyd_abc 123')).toBeNull();
    expect(parseBearer('Token hyd_abc123')).toBeNull();
    expect(parseBearer('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/tokens/service.test.ts`
Expected: FAIL with `Error: Cannot find module './service.js' imported from …/src/tokens/service.test.ts`.

- [ ] **Step 3: Write the service**

`resolve` finds the token by its HMAC (unique index), so the lookup does not compare secrets. The validity check is the three conditions of spec 6.6; condition 3 reads the creator again through `AccessService.can`, so a disabled creator or a creator without `token.create` invalidates the token at once.

`packages/server/src/tokens/service.ts`:

```ts
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { CreateTokenRequest, CreateTokenResponse, Token } from '@hydra/shared';
import { authorize, type AccessService, type SessionAccessView } from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { LoginContext } from '../auth/types.js';
import { hmac, newAgentToken, newUlid, type Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { agentTokens, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` and `last_used_ip` are written at most one time per minute (spec section 6.6). */
export const TOKEN_LAST_USED_WRITE_MS = 60_000;

export interface AgentPrincipal {
  tokenId: string;
  userId: string;
  sessionId: string;
}

export interface TokensDeps {
  db: Db;
  clock: Clock;
  subkeys: Subkeys;
  access: Pick<AccessService, 'can'>;
  audit: AuditWriter;
  bus: EventBus;
}

type TokenRow = typeof agentTokens.$inferSelect;

/** Accepts only `Authorization: Bearer hyd_…` (spec section 6.6). The scheme is case-insensitive. */
export function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer +(hyd_[0-9A-Za-z]+) *$/i.exec(authorization);
  return match?.[1] ?? null;
}

function toToken(row: TokenRow, creatorName: string): Token {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdBy: { id: row.createdBy, displayName: creatorName },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export class TokensService {
  readonly #deps: TokensDeps;

  constructor(deps: TokensDeps) {
    this.#deps = deps;
  }

  /** The caller checked token.create. The secret is returned one time and never stored. */
  create(context: LoginContext, sessionId: string, input: CreateTokenRequest): CreateTokenResponse {
    const { db, clock, subkeys, audit } = this.#deps;
    const { token, prefix } = newAgentToken();
    const now = clock.now();
    const row: TokenRow = {
      id: newUlid(clock),
      sessionId,
      createdBy: context.user.id,
      name: input.name.trim(),
      tokenHmac: hmac(subkeys.agentToken, token),
      prefix,
      createdAt: now,
      expiresAt: now + input.expiresInDays * DAY_MS,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedBy: null,
    };
    db.insert(agentTokens).values(row).run();
    audit.write({
      kind: 'token.created',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { tokenId: row.id, name: row.name, prefix, expiresAt: row.expiresAt },
    });
    return { token: toToken(row, context.user.displayName), secret: token };
  }

  /** All tokens of the session, newest first, revoked and expired ones too. */
  list(sessionId: string): Token[] {
    return this.#deps.db
      .select({ token: agentTokens, creatorName: users.displayName })
      .from(agentTokens)
      .innerJoin(users, eq(users.id, agentTokens.createdBy))
      .where(eq(agentTokens.sessionId, sessionId))
      .orderBy(desc(agentTokens.createdAt), desc(agentTokens.id))
      .all()
      .map((row) => toToken(row.token, row.creatorName));
  }

  /** Writes token.revoked and publishes token.revoked. A revoked token stays revoked (no-op). */
  revoke(actor: LoginContext | 'system', tokenId: string): void {
    const { db, clock, audit, bus } = this.#deps;
    const row = db.select().from(agentTokens).where(eq(agentTokens.id, tokenId)).get();
    if (!row) throw new HydraError('not_found', 'Token not found.');
    const actorId = actor === 'system' ? null : actor.user.id;
    const changed = db
      .update(agentTokens)
      .set({ revokedAt: clock.now(), revokedBy: actorId })
      .where(and(eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt)))
      .run().changes;
    if (changed === 0) return;
    audit.write({
      kind: 'token.revoked',
      actorType: actor === 'system' ? 'system' : 'user',
      actorId,
      sessionId: row.sessionId,
      data: { tokenId, name: row.name, prefix: row.prefix },
    });
    bus.publish({ type: 'token.revoked', tokenId, sessionId: row.sessionId });
  }

  /**
   * DELETE /api/sessions/:sid/tokens/:tokenId. The caller checked token.revoke_own with
   * `requireSession`. A token of another user also needs token.revoke_any.
   */
  revokeInSession(context: LoginContext, view: SessionAccessView, tokenId: string): void {
    const row = this.#deps.db
      .select({ createdBy: agentTokens.createdBy })
      .from(agentTokens)
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.sessionId, view.id)))
      .get();
    if (!row) throw new HydraError('not_found', 'Token not found.');
    if (row.createdBy !== context.user.id && !authorize(context.user, view, 'token.revoke_any')) {
      throw new HydraError('forbidden', 'Only the owner can revoke the tokens of other users.');
    }
    this.revoke(context, tokenId);
  }

  revokeAllForSession(sessionId: string): void {
    for (const id of this.#activeIds(eq(agentTokens.sessionId, sessionId)))
      this.revoke('system', id);
  }

  revokeAllCreatedBy(userId: string): void {
    for (const id of this.#activeIds(eq(agentTokens.createdBy, userId))) this.revoke('system', id);
  }

  /** The three conditions of spec section 6.6. */
  isValid(tokenId: string): boolean {
    const row = this.#deps.db.select().from(agentTokens).where(eq(agentTokens.id, tokenId)).get();
    return row !== undefined && this.#valid(row, this.#deps.clock.now());
  }

  /** Bearer check of the MCP endpoint. Null if the token is missing, not valid, or for another session. */
  resolve(authorization: string | undefined, sessionId: string, ip: string): AgentPrincipal | null {
    const { db, clock, subkeys } = this.#deps;
    const token = parseBearer(authorization);
    if (token === null) return null;
    const row = db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.tokenHmac, hmac(subkeys.agentToken, token)))
      .get();
    if (!row || row.sessionId !== sessionId) return null;
    const now = clock.now();
    if (!this.#valid(row, now)) return null;
    if (row.lastUsedAt === null || now - row.lastUsedAt >= TOKEN_LAST_USED_WRITE_MS) {
      db.update(agentTokens)
        .set({ lastUsedAt: now, lastUsedIp: ip })
        .where(eq(agentTokens.id, row.id))
        .run();
    }
    return { tokenId: row.id, userId: row.createdBy, sessionId: row.sessionId };
  }

  #valid(row: TokenRow, now: number): boolean {
    return (
      row.revokedAt === null &&
      row.expiresAt > now &&
      this.#deps.access.can(row.createdBy, row.sessionId, 'token.create')
    );
  }

  #activeIds(where: SQL): string[] {
    return this.#deps.db
      .select({ id: agentTokens.id })
      .from(agentTokens)
      .where(and(where, isNull(agentTokens.revokedAt)))
      .all()
      .map((row) => row.id);
  }
}
```

`packages/server/src/tokens/index.ts`:

```ts
export {
  TOKEN_LAST_USED_WRITE_MS,
  TokensService,
  parseBearer,
  type AgentPrincipal,
  type TokensDeps,
} from './service.js';
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/tokens/service.test.ts`
Expected: PASS, `Tests  19 passed (19)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 7: `UsersService` (admin actions)

Spec 6.3 (admin actions, one-time password, disable, enable), 3.1 (`hydra user create`, `hydra user reset-password`); index 5.8.

**Files:**
- Create: `packages/server/src/users/service.ts`, `packages/server/src/users/index.ts`
- Test: `packages/server/src/users/service.test.ts`

**Interfaces:**
- Consumes: `checkPasswordRules`, `generateOneTimePassword`, `normalizeEmail`, `AuthService.endLoginSessions`, `LoginContext`, `PasswordHashing` (Tasks 1 to 3); `newUlid`; `users`; `AuditWriter`, `AuditInput`; `EventBus`; `CreateUserRequest`, `CreateUserResponse`, `UpdateUserRequest`, `ResetPasswordResponse`, `UserSummary`, `GlobalRole` (`@hydra/shared`). `TokensService` and `AccessService` only in the test.
- Produces: `class UsersService` with `list`, `create`, `update`, `resetPassword`, `unlock` (index 5.8) and `createWithPassword(input)`, `setPassword(email, password)` (CLI); `interface TokenRevoker { revokeAllCreatedBy(userId): void }`; `UsersDeps = { db; clock; hasher: Pick<PasswordHashing, 'hash'>; auth: Pick<AuthService, 'endLoginSessions'>; tokens: TokenRevoker; audit; bus }`; `toUserSummary(row)`.

- [ ] **Step 1: Write the failing test**

`packages/server/src/users/service.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import { AuthService, type AuthedUser, type LoginContext } from '../auth/index.js';
import { deriveSubkeys } from '../crypto/index.js';
import { agentTokens, auditEvents, users } from '../db/schema.js';
import { EventBus, type HydraEvent } from '../events/index.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { TokensService } from '../tokens/index.js';
import { FakeClock } from '../../test/helpers/clock.js';
import { testConfig } from '../../test/helpers/config.js';
import { createTestDb } from '../../test/helpers/db.js';
import { plainHasher, seedSession, seedUser } from '../../test/helpers/seed.js';
import { UsersService } from './service.js';

const META = { ip: '203.0.113.7', userAgent: 'vitest' };

describe('UsersService', () => {
  const subkeys = deriveSubkeys(Buffer.alloc(32, 1));
  let testDb: ReturnType<typeof createTestDb>;
  let clock: FakeClock;
  let events: HydraEvent[];
  let auth: AuthService;
  let access: AccessService;
  let tokens: TokensService;
  let service: UsersService;
  let admin: AuthedUser;
  let adminCtx: LoginContext;

  beforeEach(async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 12));
    testDb = createTestDb(clock);
    const bus = new EventBus(createLogger('fatal'));
    events = [];
    for (const type of ['rights.changed', 'login.ended', 'token.revoked'] as const) {
      bus.subscribe(type, (event) => events.push(event));
    }
    const audit = new AuditWriter({ db: testDb.db, bus, clock });
    auth = new AuthService({ db: testDb.db, clock, subkeys, hasher: plainHasher, audit, bus });
    access = new AccessService({ db: testDb.db, clock, audit, bus });
    tokens = new TokensService({ db: testDb.db, clock, subkeys, access, audit, bus });
    service = new UsersService({
      db: testDb.db,
      clock,
      hasher: plainHasher,
      auth,
      tokens,
      audit,
      bus,
    });
    admin = (
      await seedUser(
        { db: testDb.db, clock, hasher: plainHasher },
        { email: 'admin@example.com', role: 'admin' },
      )
    ).user;
    adminCtx = { user: admin, loginSessionId: 'ls-admin' };
  });

  afterEach(() => testDb.close());

  const seed = (input: Parameters<typeof seedUser>[1] = {}) =>
    seedUser({ db: testDb.db, clock, hasher: plainHasher }, input);
  const userRow = (id: string) => testDb.db.select().from(users).where(eq(users.id, id)).get();
  const auditKinds = () =>
    testDb.db
      .select()
      .from(auditEvents)
      .all()
      .map((row) => row.kind);

  async function codeOf(fn: () => unknown): Promise<string | null> {
    try {
      await fn();
      return null;
    } catch (error) {
      return error instanceof HydraError ? error.code : 'other';
    }
  }

  describe('create', () => {
    it('creates a user with a one-time password that must be changed', async () => {
      const { user, oneTimePassword } = await service.create(adminCtx, {
        email: ' Bob@Example.com ',
        displayName: ' Bob ',
        role: 'member',
      });
      expect(oneTimePassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(user).toMatchObject({
        email: 'bob@example.com',
        displayName: 'Bob',
        role: 'member',
        status: 'active',
        locked: false,
        lastLoginAt: null,
      });
      expect(userRow(user.id)?.mustChangePassword).toBe(true);
      const { context } = await auth.login('bob@example.com', oneTimePassword, META);
      expect(context.user.mustChangePassword).toBe(true);
      const created = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((row) => row.kind === 'user.created');
      expect(created).toMatchObject({
        actorType: 'user',
        actorId: admin.id,
        data: { userId: user.id, email: 'bob@example.com', role: 'member' },
      });
    });

    it('rejects an email that exists, in any case', async () => {
      await seed({ email: 'carol@example.com' });
      expect(
        await codeOf(() =>
          service.create(adminCtx, {
            email: 'CAROL@example.com',
            displayName: 'C',
            role: 'member',
          }),
        ),
      ).toBe('conflict');
    });

    it('creates a user with a typed password for the CLI', async () => {
      const user = await service.createWithPassword({
        email: 'ops@example.com',
        displayName: 'Ops',
        role: 'admin',
        password: 'a long admin passphrase',
      });
      expect(user.role).toBe('admin');
      expect(userRow(user.id)?.mustChangePassword).toBe(false);
      expect(
        await codeOf(() =>
          service.createWithPassword({
            email: 'x@example.com',
            displayName: 'X',
            role: 'member',
            password: 'short',
          }),
        ),
      ).toBe('password_rejected');
      expect(
        await codeOf(() =>
          service.createWithPassword({
            email: 'not-an-email',
            displayName: 'X',
            role: 'member',
            password: 'a long admin passphrase',
          }),
        ),
      ).toBe('validation_failed');
      const created = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .find((row) => row.kind === 'user.created');
      expect(created).toMatchObject({ actorType: 'system', actorId: null });
    });
  });

  describe('list', () => {
    it('lists all users by email with the locked flag', async () => {
      const zed = await seed({ email: 'zed@example.com' });
      await seed({ email: 'amy@example.com' });
      testDb.db.update(users).set({ lockedAt: clock.now() }).where(eq(users.id, zed.user.id)).run();
      const listed = service.list();
      expect(listed.map((user) => user.email)).toEqual([
        'admin@example.com',
        'amy@example.com',
        'zed@example.com',
      ]);
      expect(listed.find((user) => user.email === 'zed@example.com')?.locked).toBe(true);
    });
  });

  describe('update', () => {
    it('changes the display name without a rights event', async () => {
      const { user } = await seed();
      expect(service.update(adminCtx, user.id, { displayName: 'New Name' }).displayName).toBe(
        'New Name',
      );
      expect(events).toEqual([]);
      expect(auditKinds()).toContain('user.updated');
    });

    it('publishes rights.changed for a role change', async () => {
      const { user } = await seed();
      expect(service.update(adminCtx, user.id, { role: 'admin' }).role).toBe('admin');
      expect(events).toEqual([{ type: 'rights.changed', userId: user.id }]);
    });

    it('disables: ends login sessions, revokes tokens, publishes rights.changed; enable keeps tokens revoked', async () => {
      const { user, password } = await seed();
      const owner = (await seed()).user;
      const session = seedSession(
        { db: testDb.db, clock, config: testConfig() },
        { ownerId: owner.id },
      );
      access.addMember({ user: owner, loginSessionId: 'x' }, session.id, {
        email: user.email,
        role: 'operator',
      });
      const login = await auth.login(user.email, password, META);
      const { token } = tokens.create(login.context, session.id, { name: 't', expiresInDays: 7 });
      events.length = 0;
      expect(service.update(adminCtx, user.id, { status: 'disabled' }).status).toBe('disabled');
      expect(auth.resolve(login.cookieValue)).toBeNull();
      const revokedAt = testDb.db
        .select()
        .from(agentTokens)
        .where(eq(agentTokens.id, token.id))
        .get()?.revokedAt;
      expect(revokedAt).toBe(clock.now());
      expect(events.map((event) => event.type)).toEqual([
        'login.ended',
        'token.revoked',
        'rights.changed',
      ]);
      events.length = 0;
      service.update(adminCtx, user.id, { status: 'active' });
      expect(events).toEqual([]);
      expect(
        testDb.db.select().from(agentTokens).where(eq(agentTokens.id, token.id)).get()?.revokedAt,
      ).toBe(revokedAt);
    });

    it('does not let an admin change the own role or status', async () => {
      expect(await codeOf(() => service.update(adminCtx, admin.id, { role: 'member' }))).toBe(
        'conflict',
      );
      expect(await codeOf(() => service.update(adminCtx, admin.id, { status: 'disabled' }))).toBe(
        'conflict',
      );
      expect(
        service.update(adminCtx, admin.id, { displayName: 'Boss', role: 'admin' }).displayName,
      ).toBe('Boss');
    });

    it('returns not_found for an unknown user', async () => {
      expect(await codeOf(() => service.update(adminCtx, 'nope', { role: 'admin' }))).toBe(
        'not_found',
      );
    });
  });

  describe('resetPassword, setPassword, unlock', () => {
    it('resets: new one-time password, all login sessions end, the lock ends', async () => {
      const { user, password } = await seed();
      const a = await auth.login(user.email, password, META);
      const b = await auth.login(user.email, password, { ...META, ip: '203.0.113.8' });
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now(), failedLogins: 100 })
        .where(eq(users.id, user.id))
        .run();
      const { oneTimePassword } = await service.resetPassword(adminCtx, user.id);
      expect(auth.resolve(a.cookieValue)).toBeNull();
      expect(auth.resolve(b.cookieValue)).toBeNull();
      expect(userRow(user.id)).toMatchObject({
        lockedAt: null,
        failedLogins: 0,
        mustChangePassword: true,
      });
      const again = await auth.login(user.email, oneTimePassword, { ...META, ip: '203.0.113.9' });
      expect(again.context.user.mustChangePassword).toBe(true);
      expect(auditKinds()).toContain('user.password_reset');
    });

    it('sets a typed password by email for the CLI', async () => {
      const { user } = await seed({ email: 'dave@example.com' });
      await service.setPassword('DAVE@example.com', 'a brand new passphrase');
      expect(userRow(user.id)?.mustChangePassword).toBe(false);
      await auth.login(user.email, 'a brand new passphrase', META);
      expect(
        await codeOf(() => service.setPassword('ghost@example.com', 'a brand new passphrase')),
      ).toBe('not_found');
      expect(await codeOf(() => service.setPassword(user.email, 'dave@example.com'))).toBe(
        'password_rejected',
      );
    });

    it('unlocks a locked account', async () => {
      const { user } = await seed();
      testDb.db
        .update(users)
        .set({ lockedAt: clock.now(), failedLogins: 100 })
        .where(eq(users.id, user.id))
        .run();
      expect(service.unlock(adminCtx, user.id).locked).toBe(false);
      expect(userRow(user.id)?.failedLogins).toBe(0);
      const updated = testDb.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'user.updated');
      expect(updated.at(-1)?.data).toEqual({ userId: user.id, unlocked: true });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run src/users/service.test.ts`
Expected: FAIL with `Error: Cannot find module './service.js' imported from …/src/users/service.test.ts`.

- [ ] **Step 3: Write the service**

A disable ends the login sessions, revokes the tokens, writes `user.updated`, and then publishes `rights.changed` (spec 6.3); an enable changes only the status. A role change publishes `rights.changed`. The unique email check runs before and after the Argon2 hash, because another request can create the same email during the hash.

`packages/server/src/users/service.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import type {
  CreateUserRequest,
  CreateUserResponse,
  GlobalRole,
  ResetPasswordResponse,
  UpdateUserRequest,
  UserSummary,
} from '@hydra/shared';
import type { AuditInput, AuditWriter } from '../audit/index.js';
import {
  checkPasswordRules,
  generateOneTimePassword,
  normalizeEmail,
  type AuthService,
  type LoginContext,
  type PasswordHashing,
} from '../auth/index.js';
import { newUlid } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

/** The part of TokensService that a disable needs. Structural, so users/ does not import tokens/. */
export interface TokenRevoker {
  revokeAllCreatedBy(userId: string): void;
}

export interface UsersDeps {
  db: Db;
  clock: Clock;
  hasher: Pick<PasswordHashing, 'hash'>;
  auth: Pick<AuthService, 'endLoginSessions'>;
  tokens: TokenRevoker;
  audit: AuditWriter;
  bus: EventBus;
}

type UserRow = typeof users.$inferSelect;
type Actor = Pick<AuditInput, 'actorType' | 'actorId'>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const DISPLAY_NAME_MAX = 64;

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    locked: row.lockedAt !== null,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

function userActor(context: LoginContext): Actor {
  return { actorType: 'user', actorId: context.user.id };
}

const SYSTEM: Actor = { actorType: 'system', actorId: null };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class UsersService {
  readonly #deps: UsersDeps;

  constructor(deps: UsersDeps) {
    this.#deps = deps;
  }

  list(): UserSummary[] {
    return this.#deps.db.select().from(users).orderBy(asc(users.email)).all().map(toUserSummary);
  }

  /** Admin action: the gateway generates a one-time password and shows it one time. */
  async create(actor: LoginContext, input: CreateUserRequest): Promise<CreateUserResponse> {
    const oneTimePassword = generateOneTimePassword();
    const user = await this.#insert(
      { ...input, password: oneTimePassword, mustChangePassword: true },
      userActor(actor),
    );
    return { user, oneTimePassword };
  }

  /** `hydra user create`: the operator types the password. */
  async createWithPassword(input: {
    email: string;
    displayName: string;
    role: GlobalRole;
    password: string;
  }): Promise<UserSummary> {
    checkPasswordRules(input.password, input.email);
    return this.#insert({ ...input, mustChangePassword: false }, SYSTEM);
  }

  /** A role change or a disable publishes rights.changed. A disable also ends the login sessions and revokes the tokens. */
  update(actor: LoginContext, userId: string, input: UpdateUserRequest): UserSummary {
    const { db, clock, auth, tokens, audit, bus } = this.#deps;
    const row = this.#find(userId);
    const roleChanges = input.role !== undefined && input.role !== row.role;
    const statusChanges = input.status !== undefined && input.status !== row.status;
    if (userId === actor.user.id && (roleChanges || statusChanges)) {
      throw new HydraError('conflict', 'You cannot change your own role or status.');
    }
    const patch: Partial<Pick<UserRow, 'displayName' | 'role' | 'status'>> = {};
    const changes: Record<string, { from: string; to: string }> = {};
    const displayName = input.displayName?.trim();
    if (displayName !== undefined && displayName !== row.displayName) {
      if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
        throw new HydraError('validation_failed', 'The request is not valid.', {
          displayName: `Use 1 to ${DISPLAY_NAME_MAX} characters.`,
        });
      }
      patch.displayName = displayName;
      changes.displayName = { from: row.displayName, to: displayName };
    }
    if (input.role !== undefined && roleChanges) {
      patch.role = input.role;
      changes.role = { from: row.role, to: input.role };
    }
    if (input.status !== undefined && statusChanges) {
      patch.status = input.status;
      changes.status = { from: row.status, to: input.status };
    }
    if (Object.keys(changes).length === 0) return toUserSummary(row);
    const updated = db
      .update(users)
      .set({ ...patch, updatedAt: clock.now() })
      .where(eq(users.id, userId))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    if (patch.status === 'disabled') {
      auth.endLoginSessions(userId);
      tokens.revokeAllCreatedBy(userId);
    }
    audit.write({
      ...userActor(actor),
      kind: 'user.updated',
      sessionId: null,
      data: { userId, changes },
    });
    if (patch.role !== undefined || patch.status === 'disabled') {
      bus.publish({ type: 'rights.changed', userId });
    }
    return toUserSummary(updated);
  }

  /** Admin action: new one-time password. Ends all login sessions of the user and the lock. */
  async resetPassword(actor: LoginContext, userId: string): Promise<ResetPasswordResponse> {
    const row = this.#find(userId);
    const oneTimePassword = generateOneTimePassword();
    await this.#setPassword(row, oneTimePassword, true, userActor(actor));
    return { oneTimePassword };
  }

  /** `hydra user reset-password`: the operator types the new password. */
  async setPassword(email: string, password: string): Promise<UserSummary> {
    const row = this.#deps.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .get();
    if (!row) throw new HydraError('not_found', 'No user has this email.');
    checkPasswordRules(password, row.email);
    return this.#setPassword(row, password, false, SYSTEM);
  }

  unlock(actor: LoginContext, userId: string): UserSummary {
    const { db, clock, audit } = this.#deps;
    this.#find(userId);
    const updated = db
      .update(users)
      .set({ lockedAt: null, failedLogins: 0, updatedAt: clock.now() })
      .where(eq(users.id, userId))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    audit.write({
      ...userActor(actor),
      kind: 'user.updated',
      sessionId: null,
      data: { userId, unlocked: true },
    });
    return toUserSummary(updated);
  }

  #find(userId: string): UserRow {
    const row = this.#deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new HydraError('not_found', 'User not found.');
    return row;
  }

  async #insert(
    input: {
      email: string;
      displayName: string;
      role: GlobalRole;
      password: string;
      mustChangePassword: boolean;
    },
    actor: Actor,
  ): Promise<UserSummary> {
    const { db, clock, hasher, audit } = this.#deps;
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!EMAIL_PATTERN.test(email)) {
      throw new HydraError('validation_failed', 'The request is not valid.', {
        email: 'Enter an email address.',
      });
    }
    if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
      throw new HydraError('validation_failed', 'The request is not valid.', {
        displayName: `Use 1 to ${DISPLAY_NAME_MAX} characters.`,
      });
    }
    const exists = () =>
      db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (exists()) throw new HydraError('conflict', 'A user with this email exists.');
    const passwordHash = await hasher.hash(input.password);
    const now = clock.now();
    const row: UserRow = {
      id: newUlid(clock),
      email,
      displayName,
      passwordHash,
      role: input.role,
      status: 'active',
      mustChangePassword: input.mustChangePassword,
      failedLogins: 0,
      lockedAt: null,
      lastLoginAt: null,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      db.insert(users).values(row).run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HydraError('conflict', 'A user with this email exists.');
      }
      throw error;
    }
    audit.write({
      ...actor,
      kind: 'user.created',
      sessionId: null,
      data: { userId: row.id, email, role: row.role },
    });
    return toUserSummary(row);
  }

  async #setPassword(
    row: UserRow,
    password: string,
    mustChangePassword: boolean,
    actor: Actor,
  ): Promise<UserSummary> {
    const { db, clock, hasher, auth, audit } = this.#deps;
    const passwordHash = await hasher.hash(password);
    const now = clock.now();
    const updated = db
      .update(users)
      .set({
        passwordHash,
        mustChangePassword,
        failedLogins: 0,
        lockedAt: null,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, row.id))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    auth.endLoginSessions(row.id);
    audit.write({
      ...actor,
      kind: 'user.password_reset',
      sessionId: null,
      data: { userId: row.id },
    });
    return toUserSummary(updated);
  }
}
```

`packages/server/src/users/index.ts`:

```ts
export { UsersService, toUserSummary, type TokenRevoker, type UsersDeps } from './service.js';
```

- [ ] **Step 4: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run src/users/service.test.ts`
Expected: PASS, `Tests  12 passed (12)`.

- [ ] **Step 5: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 8: API errors, request context, SSE helper

Spec 12.2 (error format), 6.3 (`must_change_password` gate), 10.3 (SSE heartbeat every 25 s); index 2.4, 5.9 (`context.ts`, `sse.ts`).

**Files:**
- Modify: `packages/server/package.json` (dependency `fastify`)
- Create: `packages/server/src/api/errors.ts`, `packages/server/src/api/context.ts`, `packages/server/src/api/sse.ts`
- Test: `packages/server/src/api/errors.test.ts`, `packages/server/src/api/context.test.ts`, `packages/server/src/api/sse.test.ts`

**Interfaces:**
- Consumes: `HydraError`; `RateLimitedError`, `LoginContext`, `AuthedUser` (Task 3); `RequestInfo` (Task 5); `ErrorCode` (`@hydra/shared`); `ZodError` (`zod`); `Clock`.
- Produces:
  - `errors.ts`: `toErrorResponse(error, request): ErrorResponse`, `errorHandler`, `notFoundHandler`, `frameworkErrorHandler`, `zodFields(error)`, `ApiErrorBody`.
  - `context.ts`: the `FastifyRequest.login: LoginContext | null` declaration; `requireLogin(request)`, `requireAdmin(request)` (index 5.9); `requestInfo(request): RequestInfo`; `routeKey(request)`; `PASSWORD_CHANGE_ROUTES`.
  - `sse.ts`: `openSse(reply, { clock, heartbeatMs? }): SseStream` (index 5.9), `closeAllSse(server): number`, `SSE_HEARTBEAT_MS` (25 000).

- [ ] **Step 1: Add Fastify**

Run: `pnpm --filter @hydra/server add fastify@5.12.5`
Expected: the output lists `+ fastify 5.12.5`, and `packages/server/package.json` has `"fastify": "5.12.5"` under `dependencies` (`savePrefix: ""` writes the exact version).

- [ ] **Step 2: Write the failing tests**

`packages/server/src/api/errors.test.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimitedError } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import { toErrorResponse, zodFields } from './errors.js';

const apiRequest = { routeOptions: { url: '/api/auth/login' } } as FastifyRequest;
const mcpRequest = { routeOptions: { url: '/s/:sid/mcp' } } as FastifyRequest;

function fastifyError(code: string, statusCode: number, message = code): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

describe('toErrorResponse', () => {
  it('maps a HydraError to its status and code, without fields', () => {
    const response = toErrorResponse(new HydraError('not_found', 'Session not found.'), apiRequest);
    expect(response).toEqual({
      status: 404,
      body: { error: { code: 'not_found', message: 'Session not found.' } },
      headers: {},
    });
  });

  it('keeps fields only for validation_failed', () => {
    const withFields = new HydraError('validation_failed', 'Bad.', {
      email: 'Enter an email address.',
    });
    expect(toErrorResponse(withFields, apiRequest).body.error.fields).toEqual({
      email: 'Enter an email address.',
    });
    const conflict = new HydraError('conflict', 'Exists.', { email: 'ignored' });
    expect(toErrorResponse(conflict, apiRequest).body.error).not.toHaveProperty('fields');
  });

  it('adds Retry-After for a rate limit', () => {
    const response = toErrorResponse(new RateLimitedError(900_000), apiRequest);
    expect(response.status).toBe(429);
    expect(response.headers).toEqual({ 'retry-after': '900' });
    expect(response.body.error.code).toBe('rate_limited');
  });

  it('maps a zod error to validation_failed with one message for each field', () => {
    const schema = z.object({ email: z.string(), nested: z.object({ n: z.number() }) });
    const result = schema.safeParse({ nested: { n: 'x' } });
    if (result.success) throw new Error('expected a failure');
    const response = toErrorResponse(result.error, apiRequest);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(Object.keys(response.body.error.fields ?? {})).toEqual(['email', 'nested.n']);
  });

  it('names the root "body"', () => {
    const result = z.object({}).safeParse(null);
    if (result.success) throw new Error('expected a failure');
    expect(Object.keys(zodFields(result.error))).toEqual(['body']);
  });

  it('turns an empty or broken JSON body into csrf_failed on /api routes only', () => {
    const empty = fastifyError('FST_ERR_CTP_EMPTY_JSON_BODY', 400);
    const broken = fastifyError('FST_ERR_CTP_INVALID_JSON_BODY', 400);
    expect(toErrorResponse(empty, apiRequest)).toMatchObject({
      status: 403,
      body: { error: { code: 'csrf_failed' } },
    });
    expect(toErrorResponse(broken, apiRequest)).toMatchObject({
      status: 403,
      body: { error: { code: 'csrf_failed' } },
    });
    expect(toErrorResponse(broken, mcpRequest)).toMatchObject({
      status: 400,
      body: { error: { code: 'validation_failed' } },
    });
  });

  it('keeps 413 for a body that is too large', () => {
    const response = toErrorResponse(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413), apiRequest);
    expect(response.status).toBe(413);
    expect(response.body.error).toEqual({
      code: 'validation_failed',
      message: 'The request body is too large.',
      fields: { body: 'The request body is too large.' },
    });
  });

  it('hides unknown errors behind a 500', () => {
    const response = toErrorResponse(new Error('database password is xyz'), apiRequest);
    expect(response).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'Internal server error.' } },
      headers: {},
    });
  });
});
```

`packages/server/src/api/context.test.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthedUser, LoginContext } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import { requestInfo, requireAdmin, requireLogin } from './context.js';

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: 'u1',
    email: 'u1@example.com',
    displayName: 'U1',
    role: 'member',
    status: 'active',
    mustChangePassword: false,
    ...overrides,
  };
}

function request(
  login: LoginContext | null,
  method: string,
  route: string | undefined,
  url = route ?? '/x',
): FastifyRequest {
  return { login, method, url, routeOptions: { url: route } } as unknown as FastifyRequest;
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HydraError ? error.code : 'other';
  }
}

describe('requireLogin', () => {
  it('throws unauthenticated without a login session', () => {
    expect(codeOf(() => requireLogin(request(null, 'GET', '/api/auth/me')))).toBe(
      'unauthenticated',
    );
  });

  it('returns the login context', () => {
    const login = { user: user(), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/users'))).toBe(login);
  });

  it('permits only me, password, and logout while must_change_password is true', () => {
    const login = { user: user({ mustChangePassword: true }), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/auth/me'))).toBe(login);
    expect(requireLogin(request(login, 'POST', '/api/auth/password'))).toBe(login);
    expect(requireLogin(request(login, 'POST', '/api/auth/logout'))).toBe(login);
    for (const [method, route] of [
      ['GET', '/api/users'],
      ['POST', '/api/auth/me'],
      ['HEAD', '/api/auth/me'],
      ['GET', '/api/sessions/:sid/audit'],
    ] as const) {
      expect(codeOf(() => requireLogin(request(login, method, route)))).toBe(
        'password_change_required',
      );
    }
  });

  it('uses the route pattern, not the raw URL', () => {
    const login = { user: user({ mustChangePassword: true }), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/auth/me', '/%61pi/auth/me'))).toBe(login);
    expect(codeOf(() => requireLogin(request(login, 'GET', '/api/users', '/api/auth/me')))).toBe(
      'password_change_required',
    );
  });
});

describe('requireAdmin', () => {
  it('is forbidden for members and returns the context for admins', () => {
    const member = { user: user(), loginSessionId: 'ls1' };
    expect(codeOf(() => requireAdmin(request(member, 'GET', '/api/users')))).toBe('forbidden');
    const admin = { user: user({ role: 'admin' }), loginSessionId: 'ls2' };
    expect(requireAdmin(request(admin, 'GET', '/api/users'))).toBe(admin);
  });
});

describe('requestInfo', () => {
  it('gives the method and the route pattern', () => {
    expect(
      requestInfo(request(null, 'POST', '/api/sessions/:sid/members', '/api/sessions/abc/members')),
    ).toEqual({
      method: 'POST',
      path: '/api/sessions/:sid/members',
    });
  });
});
```

`packages/server/src/api/sse.test.ts`:

```ts
import type { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { closeAllSse, openSse, type SseStream } from './sse.js';

/** Reads the stream until `text` appears. */
function readUntil(stream: Readable, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    stream.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      if (received.includes(text)) resolve(received);
    });
    stream.on('error', reject);
    stream.on('end', () =>
      received.includes(text) ? resolve(received) : reject(new Error(received)),
    );
  });
}

describe('openSse', () => {
  let app: FastifyInstance;
  let opened: SseStream[];

  async function build(heartbeatMs?: number): Promise<void> {
    app = Fastify();
    opened = [];
    app.addHook('onRequest', (_request, reply, done) => {
      reply.header('x-content-type-options', 'nosniff');
      done();
    });
    app.get('/events', (_request, reply) => {
      const stream = openSse(reply, { clock: new FakeClock(), heartbeatMs });
      opened.push(stream);
      stream.send('audit', { id: 1, kind: 'auth.login' });
    });
    await app.ready();
  }

  afterEach(async () => {
    closeAllSse(app.server);
    await app.close();
  });

  it('sends the event-stream headers, hook headers, and events', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const text = await readUntil(response.stream(), '"auth.login"}\n\n');
    expect(text).toBe(': open\n\nevent: audit\ndata: {"id":1,"kind":"auth.login"}\n\n');
  });

  it('sends a ping comment at the heartbeat interval', async () => {
    await build(20);
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(await readUntil(response.stream(), ': ping\n\n')).toContain(': ping\n\n');
  });

  it('ends the response on close() and resolves closed', async () => {
    await build();
    const response = await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    const stream = response.stream();
    const ended = new Promise<void>((resolve) => stream.on('end', resolve));
    stream.resume();
    const sse = opened[0];
    if (!sse) throw new Error('no stream');
    sse.close();
    await sse.closed;
    await ended;
    sse.send('audit', { ignored: true });
    sse.close();
  });

  it('closeAllSse ends every open stream of the server', async () => {
    await build();
    await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    await app.inject({ method: 'GET', url: '/events', payloadAsStream: true });
    expect(closeAllSse(app.server)).toBe(2);
    await Promise.all(opened.map((stream) => stream.closed));
    expect(closeAllSse(app.server)).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/api`
Expected: FAIL, 3 failed suites with `Error: Cannot find module './errors.js'` (`./context.js`, `./sse.js`).

- [ ] **Step 4: Write `errors.ts`**

The only place that turns errors into HTTP responses (index 2.4). An empty or broken JSON body on an `/api/*` route is a CSRF failure (spec 6.4: "a JSON body"); on other routes (plan 05's MCP endpoint) it is `validation_failed`. Unknown errors become a 500 without details, and the error is logged.

`packages/server/src/api/errors.ts`:

```ts
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorCode } from '@hydra/shared';
import { RateLimitedError } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';

/**
 * Spec section 12.2 format. `internal` (HTTP 500) is not in ERROR_CODES: it is only for bugs
 * (see the plan, "Index issues").
 */
export interface ApiErrorBody {
  error: { code: ErrorCode | 'internal'; message: string; fields?: Record<string, string> };
}

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
}

function body(
  code: ErrorCode | 'internal',
  message: string,
  fields?: Record<string, string>,
): ApiErrorBody {
  return { error: fields === undefined ? { code, message } : { code, message, fields } };
}

/** zod issues → `fields`: one message for each path (`a.b.0`), `body` for the root. */
export function zodFields(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'body';
    fields[key] ??= issue.message;
  }
  return fields;
}

function isApiRoute(request: FastifyRequest): boolean {
  return request.routeOptions.url?.startsWith('/api/') ?? false;
}

/** The only place that turns errors into HTTP responses (index section 2.4). */
export function toErrorResponse(error: unknown, request: FastifyRequest): ErrorResponse {
  if (error instanceof HydraError) {
    const headers: Record<string, string> =
      error instanceof RateLimitedError ? { 'retry-after': String(error.retryAfterSeconds) } : {};
    const fields = error.code === 'validation_failed' ? (error.fields ?? {}) : undefined;
    return { status: error.status, body: body(error.code, error.message, fields), headers };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: body('validation_failed', 'The request is not valid.', zodFields(error)),
      headers: {},
    };
  }
  const fastifyError = error as Partial<FastifyError>;
  const code = fastifyError.code;
  if (
    (code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || code === 'FST_ERR_CTP_INVALID_JSON_BODY') &&
    isApiRoute(request)
  ) {
    // Spec section 6.4: a request that is not GET/HEAD must have a JSON body.
    return {
      status: 403,
      body: body('csrf_failed', 'The request body must be JSON.'),
      headers: {},
    };
  }
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    const message = 'The request body is too large.';
    return {
      status: 413,
      body: body('validation_failed', message, { body: message }),
      headers: {},
    };
  }
  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = fastifyError.message ?? 'The request is not valid.';
    return { status, body: body('validation_failed', message, {}), headers: {} };
  }
  return { status: 500, body: body('internal', 'Internal server error.'), headers: {} };
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const response = toErrorResponse(error, request);
  if (response.status >= 500) request.log.error({ err: error }, 'request failed');
  void reply.code(response.status).headers(response.headers).send(response.body);
}

export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send(body('not_found', 'Not found.'));
}

/** Fastify `frameworkErrors`: errors before routing, for example a malformed URL. */
export function frameworkErrorHandler(
  error: FastifyError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  void reply.code(400).send(body('validation_failed', error.message, {}));
}
```

- [ ] **Step 5: Write `context.ts`**

`requireLogin` compares `request.routeOptions.url` (the route pattern), never `request.url`: Fastify routes `/%61pi/auth/me` to `/api/auth/me` (Verified facts).

`packages/server/src/api/context.ts`:

```ts
import type { FastifyRequest } from 'fastify';
import type { RequestInfo } from '../access/index.js';
import type { LoginContext } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    login: LoginContext | null;
  }
}

/** Spec section 6.3: the only routes for a login session with must_change_password. */
export const PASSWORD_CHANGE_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/auth/me',
  'POST /api/auth/password',
  'POST /api/auth/logout',
]);

/** The route pattern, never the raw URL: `/%61pi/...` routes to `/api/...` (see the plan, Task 9). */
export function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? ''}`;
}

export function requireLogin(request: FastifyRequest): LoginContext {
  const login = request.login;
  if (!login) throw new HydraError('unauthenticated', 'Log in first.');
  if (login.user.mustChangePassword && !PASSWORD_CHANGE_ROUTES.has(routeKey(request))) {
    throw new HydraError('password_change_required', 'Change your password first.');
  }
  return login;
}

export function requireAdmin(request: FastifyRequest): LoginContext {
  const login = requireLogin(request);
  if (login.user.role !== 'admin') throw new HydraError('forbidden', 'Only admins can do this.');
  return login;
}

/** For `AccessService.requireSession`: the method and the route pattern. */
export function requestInfo(request: FastifyRequest): RequestInfo {
  return { method: request.method, path: request.routeOptions.url ?? request.url };
}
```

- [ ] **Step 6: Write `sse.ts`**

`openSse` takes over the reply, keeps the headers that hooks set before (the dashboard headers), sends `: open` at once and `: ping` every 25 s (an `unref()` timer, so an open stream does not keep a test process alive). `closeAllSse(server)` is for the `preClose` hook of `buildApp` (Task 9).

`packages/server/src/api/sse.ts`:

```ts
import type { OutgoingHttpHeaders, Server } from 'node:http';
import type { FastifyReply } from 'fastify';
import type { Clock } from '../lib/clock.js';

/** Spec section 10.3: a comment line every 25 s, so proxies do not close an idle stream. */
export const SSE_HEARTBEAT_MS = 25_000;

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  /** Resolves when the stream ends, by `close()` or because the client went away. */
  closed: Promise<void>;
}

// Open streams for each HTTP server, so `app.close()` can end them (preClose hook in app.ts).
const openStreams = new WeakMap<Server, Set<SseStream>>();

/**
 * Takes over the reply and starts a `text/event-stream` response. The headers that hooks set
 * before (the security headers of spec section 6.8) are kept. `clock` is part of the shared
 * signature (index section 5.9); the heartbeat uses a timer.
 */
export function openSse(
  reply: FastifyReply,
  options: { clock: Clock; heartbeatMs?: number },
): SseStream {
  reply.hijack();
  const res = reply.raw;
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) res.setHeader(name, value);
  }
  const headers: OutgoingHttpHeaders = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  };
  res.writeHead(200, headers);
  res.write(': open\n\n');

  const server = reply.server.server;
  let done = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const heartbeat = setInterval(() => {
    if (!done) res.write(': ping\n\n');
  }, options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const stream: SseStream = {
    send(event, data) {
      if (!done) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (done) return;
      finish();
      res.end();
    },
    closed,
  };

  function finish(): void {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    openStreams.get(server)?.delete(stream);
    resolveClosed();
  }

  res.on('close', finish);
  let set = openStreams.get(server);
  if (!set) {
    set = new Set();
    openStreams.set(server, set);
  }
  set.add(stream);
  return stream;
}

/** Ends all open SSE streams of a server. Returns how many were open. */
export function closeAllSse(server: Server): number {
  const set = openStreams.get(server);
  if (!set) return 0;
  const streams = [...set];
  for (const stream of streams) stream.close();
  return streams.length;
}
```

- [ ] **Step 7: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/api`
Expected: PASS, `Test Files  3 passed (3)`, `Tests  18 passed (18)`.

- [ ] **Step 8: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 9: The app (host scopes, hooks, health) and the auth routes

Spec 2 (one process, two hostnames), 4 (`HYDRA_TRUSTED_PROXIES`), 6.4 (cookie, CSRF), 6.8 (dashboard headers), 12.1 (auth routes, health), 12.2, 14 (health); index 5.9 (`AppDeps`, `buildApp`, scopes, CSRF hook), 5.12 (`createTestApp`, `loginAs`); spec 15.2 (login, logout, CSRF).

**Files:**
- Create: `packages/server/src/static/headers.ts`, `packages/server/src/api/health.ts`, `packages/server/src/api/auth.ts`, `packages/server/src/app.ts`
- Create: `packages/server/test/helpers/app.ts`
- Modify: `packages/server/test/helpers/seed.ts` (add `loginAs`)
- Test: `packages/server/test/integration/app.test.ts`, `packages/server/test/integration/auth.test.ts`, `packages/server/test/integration/csrf.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 8; `Config`, `Logger`, `Subkeys`, `PasswordHasher`, `Db`, `EventBus`, `AuditWriter`, `deriveSubkeys`, `createLogger` (plan 02); `LoginRequestSchema`, `ChangePasswordRequestSchema`, `Me`, `ApiError` (`@hydra/shared`); `FakeClock`, `testConfig`, `createTestDb` (plan 02 helpers).
- Produces:
  - `interface AppDeps { config; clock; logger; db; bus; subkeys; audit; hasher; auth; users; access; tokens; webRoot: string | null }` and `buildApp(deps): Promise<FastifyInstance>` (index 5.9; `webRoot` is index issue 1); `BODY_LIMIT` (1 MiB).
  - `registerHealthRoutes(app, deps)`, `registerAuthRoutes(scope, deps)`, `toMe(user): Me`, `dashboardHeaders(config): Record<string, string>`.
  - `createTestApp(overrides?)` (index 5.12), `apiRequest(app, request)`, `errorOf(response)`, `PUBLIC_HOST`, `PUBLIC_ORIGIN`, `LIVE_HOST`, `TEST_START`; `loginAs(app, email, password): Promise<string>` (index 5.12).
  - Later tasks add one line each to `buildApp` (Tasks 10 to 13 and 15); plans 04 to 06 add theirs (index 5.9).

- [ ] **Step 1: Write the test helper `app.ts`**

`createTestApp` builds the real services on a real SQLite database in a temporary folder, with a `FakeClock` and the real `PasswordHasher`. `apiRequest` sends a request on the public host that passes the CSRF check, as the dashboard sends it.

`packages/server/test/helpers/app.ts`:

```ts
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ApiError } from '@hydra/shared';
import { AccessService } from '../../src/access/index.js';
import { buildApp, type AppDeps } from '../../src/app.js';
import { AuditWriter } from '../../src/audit/index.js';
import { AuthService } from '../../src/auth/index.js';
import { PasswordHasher, deriveSubkeys } from '../../src/crypto/index.js';
import { EventBus } from '../../src/events/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { TokensService } from '../../src/tokens/index.js';
import { UsersService } from '../../src/users/index.js';
import { FakeClock } from './clock.js';
import { testConfig } from './config.js';
import { createTestDb } from './db.js';

export const TEST_START = Date.UTC(2026, 9, 10, 12, 0, 0);
/** testConfig(): public URL http://hydra.localhost, live URL http://live.hydra.localhost. */
export const PUBLIC_HOST = 'hydra.localhost';
export const PUBLIC_ORIGIN = 'http://hydra.localhost';
export const LIVE_HOST = 'live.hydra.localhost';

/** Real SQLite in a temporary folder, a FakeClock, and the real services (index section 5.12). */
export async function createTestApp(overrides: Partial<AppDeps> = {}): Promise<{
  app: FastifyInstance;
  deps: AppDeps;
  clock: FakeClock;
  close(): Promise<void>;
}> {
  const clock = overrides.clock instanceof FakeClock ? overrides.clock : new FakeClock(TEST_START);
  const config = overrides.config ?? testConfig();
  const testDb = createTestDb(clock);
  const db = overrides.db ?? testDb.db;
  const logger = overrides.logger ?? createLogger('fatal');
  const bus = overrides.bus ?? new EventBus(logger);
  const subkeys = overrides.subkeys ?? deriveSubkeys(config.secretKey);
  const audit = overrides.audit ?? new AuditWriter({ db, bus, clock });
  const hasher = overrides.hasher ?? new PasswordHasher(subkeys.passwordPepper);
  const access = overrides.access ?? new AccessService({ db, clock, audit, bus });
  const tokens = overrides.tokens ?? new TokensService({ db, clock, subkeys, access, audit, bus });
  const auth = overrides.auth ?? new AuthService({ db, clock, subkeys, hasher, audit, bus });
  const users =
    overrides.users ?? new UsersService({ db, clock, hasher, auth, tokens, audit, bus });
  const deps: AppDeps = {
    config,
    clock,
    logger,
    db,
    bus,
    subkeys,
    audit,
    hasher,
    auth,
    users,
    access,
    tokens,
    webRoot: overrides.webRoot ?? null,
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    clock,
    close: async () => {
      await app.close();
      testDb.close();
    },
  };
}

export interface ApiRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** The `cookie` header value, for example from `loginAs`. */
  cookie?: string;
  /** JSON body. Requests that are not GET/HEAD send `{}` if it is missing, as the dashboard does. */
  body?: unknown;
  /** Extra headers. They replace the defaults (host, origin, content-type). */
  headers?: Record<string, string>;
  remoteAddress?: string;
}

/** The `error` object of an error response (spec section 12.2). */
export function errorOf(response: LightMyRequestResponse): ApiError['error'] {
  return response.json<ApiError>().error;
}

/** An API request on the public host that passes the CSRF check, as the dashboard sends it. */
export function apiRequest(
  app: FastifyInstance,
  request: ApiRequest,
): Promise<LightMyRequestResponse> {
  const withBody = request.method !== 'GET' && request.method !== 'HEAD';
  const headers: Record<string, string> = { host: PUBLIC_HOST };
  if (request.cookie !== undefined) headers.cookie = request.cookie;
  if (withBody) {
    headers.origin = PUBLIC_ORIGIN;
    headers['content-type'] = 'application/json';
  }
  Object.assign(headers, request.headers);
  return app.inject({
    method: request.method,
    url: request.url,
    headers,
    ...(withBody ? { payload: JSON.stringify(request.body ?? {}) } : {}),
    ...(request.remoteAddress !== undefined ? { remoteAddress: request.remoteAddress } : {}),
  });
}
```

- [ ] **Step 2: Add `loginAs` to the seed helpers**

Replace the content of `packages/server/test/helpers/seed.ts` with the version below. It adds the imports of `FastifyInstance`, `SESSION_COOKIE`, and `apiRequest`, and the function `loginAs`; the rest is unchanged from Task 3.

`packages/server/test/helpers/seed.ts`:

```ts
import { eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GlobalRole, SessionState, UserStatus } from '@hydra/shared';
import {
  SESSION_COOKIE,
  toAuthedUser,
  type AuthedUser,
  type PasswordHashing,
} from '../../src/auth/index.js';
import type { Config } from '../../src/config/index.js';
import { newSid, newUlid } from '../../src/crypto/index.js';
import type { Db } from '../../src/db/index.js';
import { sessions, users, type SessionRow } from '../../src/db/schema.js';
import type { Clock } from '../../src/lib/clock.js';
import { apiRequest } from './app.js';

/** 28 characters, not in the common password list. */
export const DEFAULT_PASSWORD = 'correct horse battery staple';

/** Fast stand-in for PasswordHasher in unit tests. Never use it outside tests. */
export const plainHasher: PasswordHashing = {
  hash: (password) => Promise.resolve(`plain:${password}`),
  verify: (phc, password) => Promise.resolve(phc === `plain:${password}`),
  verifyDummy: () => Promise.resolve(false as const),
  needsRehash: (phc) => !phc.startsWith('plain:'),
};

let userCounter = 0;

export async function seedUser(
  deps: { db: Db; clock: Clock; hasher: Pick<PasswordHashing, 'hash'> },
  input: {
    email?: string;
    password?: string;
    role?: GlobalRole;
    status?: UserStatus;
    displayName?: string;
  } = {},
): Promise<{ user: AuthedUser; password: string }> {
  userCounter += 1;
  const password = input.password ?? DEFAULT_PASSWORD;
  const now = deps.clock.now();
  const row = {
    id: newUlid(deps.clock),
    email: (input.email ?? `user${userCounter}@example.com`).trim().toLowerCase(),
    displayName: input.displayName ?? `User ${userCounter}`,
    passwordHash: await deps.hasher.hash(password),
    role: input.role ?? 'member',
    status: input.status ?? 'active',
    mustChangePassword: false,
    failedLogins: 0,
    lockedAt: null,
    lastLoginAt: null,
    passwordChangedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof users.$inferInsert;
  deps.db.insert(users).values(row).run();
  return { user: toAuthedUser(row), password };
}

let loginCounter = 0;

/**
 * Logs in through the API and returns the `cookie` header value. Each call uses its own
 * client address (TEST-NET-2), so the login limit per IP does not affect tests that log in often.
 */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  loginCounter += 1;
  const response = await apiRequest(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { email, password },
    remoteAddress: `198.51.100.${(loginCounter % 250) + 1}`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`loginAs(${email}) failed: ${response.statusCode} ${response.body}`);
  }
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`loginAs(${email}): no ${SESSION_COOKIE} cookie`);
  return `${SESSION_COOKIE}=${cookie.value}`;
}

const DESIRED_FOR_STATE: Record<SessionState, SessionRow['desiredState']> = {
  stopped: 'stopped',
  starting: 'running',
  running: 'running',
  stopping: 'stopped',
  error: 'stopped',
  deleting: 'deleted',
  deleted: 'deleted',
};

const HOLDS_PORT: ReadonlySet<SessionState> = new Set(['starting', 'running', 'stopping']);

/** Inserts a session row directly (plan 04 adds the session service). */
export function seedSession(
  deps: { db: Db; clock: Clock; config: Config },
  input: { ownerId: string; name?: string; state?: SessionState },
): SessionRow {
  const state = input.state ?? 'stopped';
  const now = deps.clock.now();
  let mediaPort: number | null = null;
  if (HOLDS_PORT.has(state)) {
    const used = new Set(
      deps.db
        .select({ port: sessions.mediaPort })
        .from(sessions)
        .where(isNotNull(sessions.mediaPort))
        .all()
        .map((row) => row.port),
    );
    const { first, last } = deps.config.mediaPortRange;
    for (let port = first; port <= last && mediaPort === null; port += 1) {
      if (!used.has(port)) mediaPort = port;
    }
  }
  const settings = {
    allowlist: ['example.com'],
    timezone: deps.config.defaultTimezone,
    language: deps.config.defaultLanguage,
    screen: '1920x1080' as const,
  };
  const id = newSid();
  deps.db
    .insert(sessions)
    .values({
      id,
      name: input.name ?? 'Test session',
      ownerId: input.ownerId,
      desiredState: DESIRED_FOR_STATE[state],
      state,
      errorReason: state === 'error' ? 'CrashLoopBackOff: test' : null,
      mediaPort,
      ...settings,
      appliedSettings: settings,
      startedAt: HOLDS_PORT.has(state) ? now : null,
      readyAt: state === 'running' ? now : null,
      createdAt: now,
      updatedAt: now,
      deletedAt: state === 'deleted' ? now : null,
    })
    .run();
  const row = deps.db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) throw new Error('seedSession: the row was not inserted');
  return row;
}
```

- [ ] **Step 3: Write the failing integration tests**

`packages/server/test/integration/app.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf, LIVE_HOST, PUBLIC_HOST } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { createTestDb } from '../helpers/db.js';
import { seedUser } from '../helpers/seed.js';

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://live.hydra.localhost; " +
  "img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

describe('app', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  describe('health', () => {
    it('answers /healthz and /readyz on any host', async () => {
      for (const host of [PUBLIC_HOST, LIVE_HOST, '10.42.0.17:8080']) {
        const health = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host } });
        expect(health.statusCode).toBe(200);
        expect(health.json<unknown>()).toEqual({ status: 'ok' });
        const ready = await t.app.inject({ method: 'GET', url: '/readyz', headers: { host } });
        expect(ready.statusCode).toBe(200);
        expect(ready.json<unknown>()).toEqual({ status: 'ok', checks: { db: true } });
      }
    });

    it('reports not ready when the database does not answer', async () => {
      const broken = createTestDb();
      const app = await createTestApp({ db: broken.db });
      broken.sqlite.close();
      const ready = await app.app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json<unknown>()).toEqual({ status: 'unavailable', checks: { db: false } });
      await app.close();
      broken.close();
    });
  });

  describe('hosts', () => {
    it('serves the API only on the public host', async () => {
      const onPublic = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
      expect(onPublic.statusCode).toBe(401);
      for (const host of [LIVE_HOST, 'evil.example', 'hydra.localhost:8080']) {
        const response = await t.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { host },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json<unknown>()).toEqual({
          error: { code: 'not_found', message: 'Not found.' },
        });
      }
    });

    it('returns not_found for an unknown API path', async () => {
      const response = await apiRequest(t.app, { method: 'GET', url: '/api/nothing-here' });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    });
  });

  describe('headers', () => {
    it('sets the dashboard headers of spec section 6.8 on API responses', async () => {
      const response = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('errors', () => {
    it('answers a zod failure with validation_failed and fields', async () => {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'a@b.c' },
      });
      expect(response.statusCode).toBe(400);
      const error = errorOf(response);
      expect(error.code).toBe('validation_failed');
      expect(error.message).toBe('The request is not valid.');
      expect(Object.keys(error.fields ?? {})).toEqual(['password']);
    });

    it('answers 413 for a body over 1 MiB', async () => {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: 'a@b.c', password: 'x'.repeat(1_048_576) },
      });
      expect(response.statusCode).toBe(413);
      expect(errorOf(response).code).toBe('validation_failed');
    });

    it('answers a malformed URL in the API error format', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/api/%zz',
        headers: { host: PUBLIC_HOST },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('validation_failed');
    });
  });

  describe('client address', () => {
    it('trusts X-Forwarded-For only from HYDRA_TRUSTED_PROXIES', async () => {
      const { user, password } = await seedUser(t.deps);
      const login = (remoteAddress: string) =>
        apiRequest(t.app, {
          method: 'POST',
          url: '/api/auth/login',
          body: { email: user.email, password },
          headers: { 'x-forwarded-for': '203.0.113.50' },
          remoteAddress,
        });
      expect((await login('10.42.3.4')).statusCode).toBe(200);
      expect((await login('192.0.2.1')).statusCode).toBe(200);
      const ips = t.deps.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'auth.login')
        .map((row) => row.data.ip);
      expect(ips).toEqual(['203.0.113.50', '192.0.2.1']);
    });

    it('trusts no proxy when the list is empty', async () => {
      const strict = await createTestApp({ config: testConfig({ trustedProxies: [] }) });
      const { user, password } = await seedUser(strict.deps);
      await apiRequest(strict.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: { email: user.email, password },
        headers: { 'x-forwarded-for': '203.0.113.50' },
        remoteAddress: '10.42.3.4',
      });
      const row = strict.deps.db
        .select()
        .from(auditEvents)
        .all()
        .find((event) => event.kind === 'auth.login');
      expect(row?.data.ip).toBe('10.42.3.4');
      await strict.close();
    });
  });
});
```

`packages/server/test/integration/auth.test.ts`:

```ts
import { type Me } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOGIN_SESSION_IDLE_MS, SESSION_COOKIE } from '../../src/auth/index.js';
import { loginSessions } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

describe('auth routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it('logs in, sets the __Host- cookie, and returns Me', async () => {
    const { user, password } = await seedUser(t.deps, {
      email: 'alice@example.com',
      displayName: 'Alice',
    });
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: 'ALICE@example.com', password },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toEqual({
      id: user.id,
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'member',
      mustChangePassword: false,
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^__Host-hydra_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    const value = setCookie.split(';')[0]?.split('=')[1] ?? '';
    const stored = t.deps.db.select().from(loginSessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHmac.toString('base64url')).not.toBe(value);
  });

  it('answers 401 invalid_credentials for a wrong password', async () => {
    const { user } = await seedUser(t.deps);
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: user.email, password: 'not the password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<unknown>()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('GET /api/auth/me needs a login session', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json<Me>().id).toBe(user.id);
    const anonymous = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(errorOf(anonymous).code).toBe('unauthenticated');
    const forged = await apiRequest(t.app, {
      method: 'GET',
      url: '/api/auth/me',
      cookie: `${SESSION_COOKIE}=forged`,
    });
    expect(forged.statusCode).toBe(401);
  });

  it('logs out: 204, clears the cookie, deletes the row, publishes login.ended', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    const ended: HydraEvent[] = [];
    t.deps.bus.subscribe('login.ended', (event) => ended.push(event));
    const response = await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toBe(
      '__Host-hydra_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
    expect(t.deps.db.select().from(loginSessions).all()).toHaveLength(0);
    expect(ended).toHaveLength(1);
    const after = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(after.statusCode).toBe(401);
  });

  it('gives a new cookie value at each login and ends the login session of the old cookie', async () => {
    const { user, password } = await seedUser(t.deps);
    const first = await loginAs(t.app, user.email, password);
    const again = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      cookie: first,
      body: { email: user.email, password },
    });
    const second = `${SESSION_COOKIE}=${again.cookies[0]?.value ?? ''}`;
    expect(second).not.toBe(first);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: first })).statusCode,
    ).toBe(401);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: second })).statusCode,
    ).toBe(200);
  });

  it('ends a login session after 12 h idle', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    t.clock.advance(LOGIN_SESSION_IDLE_MS - 60_000);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(200);
    t.clock.advance(LOGIN_SESSION_IDLE_MS);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(401);
  });

  it('a password change ends the other login sessions of the user, not the current one', async () => {
    const { user, password } = await seedUser(t.deps);
    const current = await loginAs(t.app, user.email, password);
    const other = await loginAs(t.app, user.email, password);
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/password',
      cookie: current,
      body: { current: password, new: 'a different long passphrase' },
    });
    expect(response.statusCode).toBe(204);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: current })).statusCode,
    ).toBe(200);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: other })).statusCode,
    ).toBe(401);
    await loginAs(t.app, user.email, 'a different long passphrase');
  });

  it('rejects a new password that breaks the rules', async () => {
    const { user, password } = await seedUser(t.deps);
    const cookie = await loginAs(t.app, user.email, password);
    for (const next of ['short', 'Password1234', user.email]) {
      const response = await apiRequest(t.app, {
        method: 'POST',
        url: '/api/auth/password',
        cookie,
        body: { current: password, new: next },
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('password_rejected');
    }
  });
});
```

`packages/server/test/integration/csrf.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRequest, createTestApp, errorOf, PUBLIC_HOST, PUBLIC_ORIGIN } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

describe('CSRF check (spec section 6.4)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let cookie: string;

  beforeEach(async () => {
    t = await createTestApp();
    const { user, password } = await seedUser(t.deps);
    cookie = await loginAs(t.app, user.email, password);
  });

  afterEach(async () => {
    await t.close();
  });

  const logout = (headers: Record<string, string>, payload?: string, url = '/api/auth/logout') =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { host: PUBLIC_HOST, cookie, ...headers },
      payload,
    });

  async function expectCsrfFailed(response: Awaited<ReturnType<typeof logout>>): Promise<void> {
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('csrf_failed');
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.statusCode).toBe(200);
  }

  it('accepts the dashboard request: public Origin, JSON type, JSON body', async () => {
    const response = await logout(
      { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
      '{}',
    );
    expect(response.statusCode).toBe(204);
  });

  it('rejects a missing Origin', async () => {
    await expectCsrfFailed(await logout({ 'content-type': 'application/json' }, '{}'));
  });

  it('rejects another Origin, also the live origin', async () => {
    await expectCsrfFailed(
      await logout({ origin: 'https://evil.example', 'content-type': 'application/json' }, '{}'),
    );
    await expectCsrfFailed(
      await logout(
        { origin: 'http://live.hydra.localhost', 'content-type': 'application/json' },
        '{}',
      ),
    );
  });

  it('rejects a body that is not JSON by its Content-Type', async () => {
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'text/plain' }, '{}'),
    );
    await expectCsrfFailed(
      await logout(
        { origin: PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        'a=b',
      ),
    );
    await expectCsrfFailed(await logout({ origin: PUBLIC_ORIGIN }));
  });

  it('rejects a missing or broken JSON body', async () => {
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'application/json' }),
    );
    await expectCsrfFailed(
      await logout({ origin: PUBLIC_ORIGIN, 'content-type': 'application/json' }, '{oops'),
    );
  });

  it('cannot be skipped with a percent-encoded path', async () => {
    await expectCsrfFailed(
      await logout({ 'content-type': 'application/json' }, '{}', '/%61pi/auth/logout'),
    );
  });

  it('protects the login route too', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: PUBLIC_HOST, 'content-type': 'text/plain' },
      payload: '{"email":"a@b.c","password":"x"}',
    });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('csrf_failed');
  });

  it('does not apply to GET and HEAD', async () => {
    const get = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { host: PUBLIC_HOST, cookie },
    });
    expect(get.statusCode).toBe(200);
    const head = await t.app.inject({
      method: 'HEAD',
      url: '/api/auth/me',
      headers: { host: PUBLIC_HOST, cookie },
    });
    expect(head.statusCode).toBe(200);
  });
});
```

- [ ] **Step 4: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/app.test.ts test/integration/auth.test.ts test/integration/csrf.test.ts`
Expected: FAIL, 3 failed suites with `Error: Cannot find module '../../src/app.js' imported from …/test/helpers/app.ts`.

- [ ] **Step 5: Write the dashboard headers**

`packages/server/src/static/headers.ts`:

```ts
import type { Config } from '../config/index.js';

/** Spec section 6.8, dashboard origin. Set on every response of the public host. */
export function dashboardHeaders(config: Config): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `frame-src ${config.liveUrl.origin}`,
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; '),
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}
```

- [ ] **Step 6: Write the health routes**

`/healthz` answers while the process runs; `/readyz` checks that the database answers (plan 04 adds the Kubernetes check, spec 14). Both are on the root instance, so they have no host constraint (index 5.9).

`packages/server/src/api/health.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/index.js';

function dbAnswers(db: Db): boolean {
  try {
    return db.get<{ ok: number }>(sql`select 1 as ok`)?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Spec section 14. No host constraint: kubelet probes use the pod IP. Plan 04 adds the
 * Kubernetes API check to /readyz.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: Pick<AppDeps, 'db'>): void {
  app.get('/healthz', { logLevel: 'warn' }, () => ({ status: 'ok' }));

  app.get('/readyz', { logLevel: 'warn' }, (_request, reply) => {
    const checks = { db: dbAnswers(deps.db) };
    const ready = Object.values(checks).every(Boolean);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable', checks });
  });
}
```

- [ ] **Step 7: Write the auth routes**

`packages/server/src/api/auth.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { ChangePasswordRequestSchema, LoginRequestSchema, type Me } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { clearedSessionCookie, sessionCookie, type AuthedUser } from '../auth/index.js';
import { requireLogin } from './context.js';

export function toMe(user: AuthedUser): Me {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export function registerAuthRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.post('/api/auth/login', async (request, reply) => {
    const input = LoginRequestSchema.parse(request.body);
    const previous = request.login;
    const { cookieValue, context } = await deps.auth.login(input.email, input.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? '',
    });
    // The browser replaces its cookie, so the login session of the old cookie ends now.
    if (previous) deps.auth.logout(previous);
    return reply.header('set-cookie', sessionCookie(cookieValue)).send(toMe(context.user));
  });

  scope.post('/api/auth/logout', (request, reply) => {
    deps.auth.logout(requireLogin(request));
    return reply.code(204).header('set-cookie', clearedSessionCookie()).send();
  });

  scope.get('/api/auth/me', (request) => toMe(requireLogin(request).user));

  scope.post('/api/auth/password', async (request, reply) => {
    const context = requireLogin(request);
    const input = ChangePasswordRequestSchema.parse(request.body);
    await deps.auth.changePassword(context, input.current, input.new);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 8: Write `buildApp`**

Notes for the reader of the code:
- `trustProxy` gets the CIDR list of `HYDRA_TRUSTED_PROXIES`, so `request.ip` is the client address behind Traefik and the peer address otherwise.
- The public scope adds the host constraint `config.publicUrl.host` to each of its routes with an `onRoute` hook. Its `onRequest` hook sets the dashboard headers on every response of the public host; for `/api/*` routes it runs the CSRF check and resolves the login session cookie into `request.login`. The hook tests `request.routeOptions.url`, not `request.url`.
- The live scope adds the host constraint `config.liveUrl.host`; plan 06 registers its routes there.
- The root not-found handler answers every request that matches no route: unknown paths and all other hosts.
- The scope plugins use the `done` callback, because they do not await anything; later plans add synchronous `registerX(scope, deps)` calls (index 5.11).

`packages/server/src/app.ts`:

```ts
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AccessService } from './access/index.js';
import { registerAuthRoutes } from './api/auth.js';
import { errorHandler, frameworkErrorHandler, notFoundHandler } from './api/errors.js';
import { registerHealthRoutes } from './api/health.js';
import { closeAllSse } from './api/sse.js';
import type { AuditWriter } from './audit/index.js';
import { SESSION_COOKIE, checkCsrf, parseCookies, type AuthService } from './auth/index.js';
import type { Config } from './config/index.js';
import type { PasswordHasher, Subkeys } from './crypto/index.js';
import type { Db } from './db/index.js';
import type { EventBus } from './events/index.js';
import type { Clock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { dashboardHeaders } from './static/headers.js';
import type { TokensService } from './tokens/index.js';
import type { UsersService } from './users/index.js';

/** 1 MiB, the body limit of spec section 8.2. Dashboard bodies are much smaller. */
export const BODY_LIMIT = 1_048_576;

export interface AppDeps {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  hasher: PasswordHasher;
  auth: AuthService;
  users: UsersService;
  access: AccessService;
  tokens: TokensService;
  /** Folder of the @hydra/web build, or null to serve no dashboard (development, tests). */
  webRoot: string | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  // Widen the pino type, so the instance is a plain FastifyInstance for all plans.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustedProxies,
    bodyLimit: BODY_LIMIT,
    frameworkErrors: frameworkErrorHandler,
  });
  app.decorateRequest('login', null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  // app.close() waits for open connections; SSE streams never end by themselves.
  app.addHook('preClose', (done) => {
    closeAllSse(app.server);
    done();
  });

  registerHealthRoutes(app, deps);

  // Public host: dashboard, API, and (plan 05) the MCP endpoint.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.publicUrl.host };
    });
    const headers = dashboardHeaders(config);
    scope.addHook('onRequest', (request, reply, next) => {
      reply.headers(headers);
      // Use the route pattern: the raw URL can be percent-encoded (`/%61pi/...`).
      if (request.routeOptions.url?.startsWith('/api/')) {
        checkCsrf(request, config.publicUrl.origin);
        request.login = deps.auth.resolve(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      }
      next();
    });
    registerAuthRoutes(scope, deps);
    // Plans 04 and 05 add their route registrations here.
    done();
  });

  // Live host: plan 06 registers the live routes in this scope.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.liveUrl.host };
    });
    done();
  });

  return app;
}
```

- [ ] **Step 9: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/app.test.ts test/integration/auth.test.ts test/integration/csrf.test.ts`
Expected: PASS, `Test Files  3 passed (3)`, `Tests  26 passed (26)`.

- [ ] **Step 10: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 10: Admin user routes

Spec 6.3 (admin actions), 6.4 (lock, unlock), 12.1 (`/api/users*`); spec 15.2 (rate limits, lockout responses, rights change).

**Files:**
- Create: `packages/server/src/api/users.ts`
- Modify: `packages/server/src/app.ts` (register the routes)
- Test: `packages/server/test/integration/users.test.ts`, `packages/server/test/integration/login-limits.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (Task 8); `UsersService` (Task 7); `CreateUserRequestSchema`, `UpdateUserRequestSchema`, `CreateUserResponse`, `ResetPasswordResponse`, `UserSummary`, `Me` (`@hydra/shared`); Task 9 helpers. The disable test sets up the member and the token with `t.deps.access` and `t.deps.tokens`, because their routes come in Tasks 11 and 12.
- Produces: `registerUserRoutes(scope, deps)`: `GET /api/users` → `UserSummary[]`; `POST /api/users` → 201 `CreateUserResponse`; `PATCH /api/users/:id` → `UserSummary`; `POST /api/users/:id/reset-password` → `ResetPasswordResponse`; `POST /api/users/:id/unlock` → `UserSummary`.

- [ ] **Step 1: Write the failing tests**

`packages/server/test/integration/users.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import {
  type CreateUserResponse,
  type Me,
  type ResetPasswordResponse,
  type UserSummary,
} from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { agentTokens, users } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

describe('admin user routes (spec section 6.3)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: AuthedUser;
  let adminCookie: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const seeded = await seedUser(t.deps, { email: 'admin@example.com', role: 'admin' });
    admin = seeded.user;
    adminCookie = await loginAs(t.app, admin.email, seeded.password);
    events = [];
    for (const type of ['rights.changed', 'login.ended', 'token.revoked'] as const) {
      t.deps.bus.subscribe(type, (event) => events.push(event));
    }
  });

  afterEach(async () => {
    await t.close();
  });

  it('is forbidden for members and needs a login', async () => {
    const member = await seedUser(t.deps);
    const cookie = await loginAs(t.app, member.user.email, member.password);
    const forbidden = await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie });
    expect(forbidden.statusCode).toBe(403);
    expect(errorOf(forbidden).code).toBe('forbidden');
    const anonymous = await apiRequest(t.app, { method: 'GET', url: '/api/users' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('creates a user with a one-time password shown one time', async () => {
    const created = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'bob@example.com', displayName: 'Bob', role: 'member' },
    });
    expect(created.statusCode).toBe(201);
    const { user, oneTimePassword } = created.json<CreateUserResponse>();
    expect(user).toMatchObject({
      email: 'bob@example.com',
      role: 'member',
      status: 'active',
      locked: false,
    });
    expect(oneTimePassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const list = await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie: adminCookie });
    expect(list.body).not.toContain(oneTimePassword);
    const cookie = await loginAs(t.app, 'bob@example.com', oneTimePassword);
    const me = await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie });
    expect(me.json<Me>().mustChangePassword).toBe(true);
    const duplicate = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'BOB@example.com', displayName: 'Bob 2', role: 'member' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate).code).toBe('conflict');
  });

  it('rejects a body that does not match the schema', async () => {
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/users',
      cookie: adminCookie,
      body: { email: 'not-an-email', displayName: '', role: 'root' },
    });
    expect(response.statusCode).toBe(400);
    expect(Object.keys(errorOf(response).fields ?? {}).sort()).toEqual([
      'displayName',
      'email',
      'role',
    ]);
  });

  it('changes the role and publishes rights.changed', async () => {
    const { user } = await seedUser(t.deps);
    const response = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      cookie: adminCookie,
      body: { role: 'admin', displayName: 'Promoted' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown>()).toMatchObject({ role: 'admin', displayName: 'Promoted' });
    expect(events).toEqual([{ type: 'rights.changed', userId: user.id }]);
  });

  it('disables a user: login sessions end, tokens are revoked, rights.changed; enable keeps tokens revoked', async () => {
    const member = await seedUser(t.deps);
    const owner = await seedUser(t.deps);
    const session = seedSession(t.deps, { ownerId: owner.user.id });
    // The member and token routes come in later tasks, so the setup uses the services.
    t.deps.access.addMember({ user: owner.user, loginSessionId: 'setup' }, session.id, {
      email: member.user.email,
      role: 'operator',
    });
    const memberCookie = await loginAs(t.app, member.user.email, member.password);
    const { token } = t.deps.tokens.create(
      { user: member.user, loginSessionId: 'setup' },
      session.id,
      {
        name: 'agent',
        expiresInDays: 7,
      },
    );
    events.length = 0;
    const disabled = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${member.user.id}`,
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    expect(disabled.json<UserSummary>().status).toBe('disabled');
    expect(events.map((event) => event.type)).toEqual([
      'login.ended',
      'token.revoked',
      'rights.changed',
    ]);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie: memberCookie }))
        .statusCode,
    ).toBe(401);
    const login = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email: member.user.email, password: member.password },
    });
    expect(login.statusCode).toBe(401);
    const revoked = () =>
      t.deps.db.select().from(agentTokens).where(eq(agentTokens.id, token.id)).get()?.revokedAt;
    expect(revoked()).not.toBeNull();
    await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${member.user.id}`,
      cookie: adminCookie,
      body: { status: 'active' },
    });
    expect(revoked()).not.toBeNull();
    await loginAs(t.app, member.user.email, member.password);
  });

  it('does not let an admin change the own role or status', async () => {
    const response = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('resets a password: all login sessions end, the lock ends, a new one-time password works', async () => {
    const member = await seedUser(t.deps);
    const first = await loginAs(t.app, member.user.email, member.password);
    const second = await loginAs(t.app, member.user.email, member.password);
    t.deps.db
      .update(users)
      .set({ lockedAt: t.clock.now(), failedLogins: 100 })
      .where(eq(users.id, member.user.id))
      .run();
    const response = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/users/${member.user.id}/reset-password`,
      cookie: adminCookie,
    });
    expect(response.statusCode).toBe(200);
    const { oneTimePassword } = response.json<ResetPasswordResponse>();
    for (const cookie of [first, second]) {
      expect(
        (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
      ).toBe(401);
    }
    const cookie = await loginAs(t.app, member.user.email, oneTimePassword);
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).json<Me>()
        .mustChangePassword,
    ).toBe(true);
  });

  it('answers 404 for an unknown user', async () => {
    for (const request of [
      { method: 'PATCH' as const, url: '/api/users/nope', body: { role: 'admin' } },
      { method: 'POST' as const, url: '/api/users/nope/reset-password' },
      { method: 'POST' as const, url: '/api/users/nope/unlock' },
    ]) {
      const response = await apiRequest(t.app, { ...request, cookie: adminCookie });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    }
  });
});
```

`login-limits.test.ts` covers the login limit per IP, the pair throttle with `Retry-After`, and the lockout responses of spec 15.2. Its timeout is 15 s, because it runs many real Argon2 verifies.

`packages/server/test/integration/login-limits.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { type UserSummary } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedUser } from '../helpers/seed.js';

// Many real Argon2 verifies: a longer timeout for slow CI runners.
describe('brute-force protection (spec section 6.4)', { timeout: 15_000 }, () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  const login = (email: string, password: string, remoteAddress = '203.0.113.20') =>
    apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { email, password },
      remoteAddress,
    });

  it('permits 10 login attempts per minute for each IP, then 429', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await login(`nobody${i}@example.com`, 'whatever password')).statusCode).toBe(401);
    }
    const limited = await login('nobody10@example.com', 'whatever password');
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('other@example.com', 'whatever password', '203.0.113.21')).statusCode).toBe(
      401,
    );
    t.clock.advance(60_000);
    expect((await login('nobody11@example.com', 'whatever password')).statusCode).toBe(401);
  });

  it('throttles a pair after 5 failures: 429 with Retry-After, doubling, other IPs unaffected', async () => {
    const { user, password } = await seedUser(t.deps);
    for (let i = 0; i < 5; i += 1)
      expect((await login(user.email, 'wrong password!!')).statusCode).toBe(401);
    const throttled = await login(user.email, password);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers['retry-after']).toBe('900');
    expect((await login(user.email, password, '198.51.100.200')).statusCode).toBe(200);
    t.clock.advance(15 * 60_000);
    expect((await login(user.email, 'wrong password!!')).statusCode).toBe(401);
    expect((await login(user.email, password)).headers['retry-after']).toBe('1800');
  });

  it('throttles an email that does not exist in the same way', async () => {
    for (let i = 0; i < 5; i += 1)
      expect((await login('ghost@example.com', 'wrong password!!')).statusCode).toBe(401);
    expect((await login('ghost@example.com', 'wrong password!!')).statusCode).toBe(429);
  });

  it('gives the same status and body for a locked account, an unknown email, and a wrong password', async () => {
    const locked = await seedUser(t.deps, { email: 'locked@example.com' });
    t.deps.db
      .update(users)
      .set({ lockedAt: t.clock.now(), failedLogins: 100 })
      .where(eq(users.id, locked.user.id))
      .run();
    const valid = await seedUser(t.deps, { email: 'valid@example.com' });
    const responses = [
      await login(locked.user.email, locked.password, '192.0.2.1'),
      await login('unknown@example.com', 'some password!!', '192.0.2.2'),
      await login(valid.user.email, 'wrong password!!', '192.0.2.3'),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(responses[0]?.body);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(responses[0]?.json<unknown>()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    });
  });

  it('locks after 100 failures in a row; an admin unlock ends the lock', async () => {
    const { user, password } = await seedUser(t.deps, { email: 'target@example.com' });
    t.deps.db.update(users).set({ failedLogins: 99 }).where(eq(users.id, user.id)).run();
    expect((await login(user.email, 'wrong password!!', '192.0.2.10')).statusCode).toBe(401);
    expect((await login(user.email, password, '192.0.2.11')).statusCode).toBe(401);
    const admin = await seedUser(t.deps, { role: 'admin' });
    const adminCookie = await loginAs(t.app, admin.user.email, admin.password);
    const listed = await apiRequest(t.app, {
      method: 'GET',
      url: '/api/users',
      cookie: adminCookie,
    });
    expect(listed.json<UserSummary[]>().find((row) => row.id === user.id)?.locked).toBe(true);
    const unlocked = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/users/${user.id}/unlock`,
      cookie: adminCookie,
    });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json<UserSummary>().locked).toBe(false);
    expect((await login(user.email, password, '192.0.2.12')).statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/users.test.ts test/integration/login-limits.test.ts`
Expected: FAIL, `Tests  8 failed | 5 passed (13)`; the failures show the 404 of the missing routes, for example `AssertionError: expected 404 to be 403`.

- [ ] **Step 3: Write the routes**

The handlers without `await` are synchronous functions: Fastify sends their return value (Verified facts), and the lint rule `require-await` stays quiet.

`packages/server/src/api/users.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { CreateUserRequestSchema, UpdateUserRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requireAdmin } from './context.js';

interface UserParams {
  Params: { id: string };
}

export function registerUserRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get('/api/users', (request) => {
    requireAdmin(request);
    return deps.users.list();
  });

  scope.post('/api/users', async (request, reply) => {
    const context = requireAdmin(request);
    const input = CreateUserRequestSchema.parse(request.body);
    return reply.code(201).send(await deps.users.create(context, input));
  });

  scope.patch<UserParams>('/api/users/:id', (request) => {
    const context = requireAdmin(request);
    const input = UpdateUserRequestSchema.parse(request.body);
    return deps.users.update(context, request.params.id, input);
  });

  scope.post<UserParams>('/api/users/:id/reset-password', (request) => {
    const context = requireAdmin(request);
    return deps.users.resetPassword(context, request.params.id);
  });

  scope.post<UserParams>('/api/users/:id/unlock', (request) => {
    const context = requireAdmin(request);
    return deps.users.unlock(context, request.params.id);
  });
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add this import directly after the line `import { closeAllSse } from './api/sse.js';`:

```ts
import { registerUserRoutes } from './api/users.js';
```

and add this line directly after `    registerAuthRoutes(scope, deps);`:

```ts
    registerUserRoutes(scope, deps);
```

- [ ] **Step 5: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/users.test.ts test/integration/login-limits.test.ts`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  13 passed (13)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 11: Member routes (sharing)

Spec 6.5 (members, owner rules, rights change, admin audit), 12.1 (`/api/sessions/:sid/members*`); spec 15.2 (sharing, the 404 rule).

**Files:**
- Create: `packages/server/src/api/members.ts`
- Modify: `packages/server/src/app.ts` (register the routes)
- Test: `packages/server/test/integration/members.test.ts`

**Interfaces:**
- Consumes: `requireLogin`, `requestInfo` (Task 8); `AccessService` (Task 5); `AddMemberRequestSchema`, `UpdateMemberRequestSchema`, `Member` (`@hydra/shared`); `seedSession` (Task 3), Task 9 helpers.
- Produces: `registerMemberRoutes(scope, deps)`: `GET /api/sessions/:sid/members` (`session.read`) → `MembersResponse`; `POST …/members` (`session.share`) → 201 `Member`; `PATCH …/members/:userId` → `Member`; `DELETE …/members/:userId` → 204.

- [ ] **Step 1: Write the failing test**

`packages/server/test/integration/members.test.ts`:

```ts
import { type Member } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { auditEvents } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

describe('sharing and the 404 rule (spec section 6.5)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let owner: AuthedUser;
  let member: AuthedUser;
  let ownerCookie: string;
  let memberCookie: string;
  let strangerCookie: string;
  let adminCookie: string;
  let sid: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const o = await seedUser(t.deps, { email: 'owner@example.com', displayName: 'Owner' });
    const m = await seedUser(t.deps, { email: 'member@example.com', displayName: 'Member' });
    const s = await seedUser(t.deps, { email: 'stranger@example.com' });
    const a = await seedUser(t.deps, { email: 'admin@example.com', role: 'admin' });
    owner = o.user;
    member = m.user;
    ownerCookie = await loginAs(t.app, o.user.email, o.password);
    memberCookie = await loginAs(t.app, m.user.email, m.password);
    strangerCookie = await loginAs(t.app, s.user.email, s.password);
    adminCookie = await loginAs(t.app, a.user.email, a.password);
    sid = seedSession(t.deps, { ownerId: owner.id, state: 'running' }).id;
    events = [];
    t.deps.bus.subscribe('rights.changed', (event) => events.push(event));
  });

  afterEach(async () => {
    await t.close();
  });

  const add = (cookie: string, email: string, role: 'viewer' | 'operator') =>
    apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/members`,
      cookie,
      body: { email, role },
    });

  it('the owner adds, changes, and removes a member; each change publishes rights.changed', async () => {
    const added = await add(ownerCookie, 'MEMBER@example.com', 'viewer');
    expect(added.statusCode).toBe(201);
    expect(added.json<unknown>()).toEqual({
      userId: member.id,
      email: 'member@example.com',
      displayName: 'Member',
      role: 'viewer',
    });
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: memberCookie,
    });
    expect(list.json<unknown>()).toEqual({
      owner: { userId: owner.id, email: 'owner@example.com', displayName: 'Owner', role: 'owner' },
      members: [
        { userId: member.id, email: 'member@example.com', displayName: 'Member', role: 'viewer' },
      ],
    });
    const changed = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/sessions/${sid}/members/${member.id}`,
      cookie: ownerCookie,
      body: { role: 'operator' },
    });
    expect(changed.json<Member>().role).toBe('operator');
    const removed = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/members/${member.id}`,
      cookie: ownerCookie,
    });
    expect(removed.statusCode).toBe(204);
    expect(events).toEqual([
      { type: 'rights.changed', userId: member.id },
      { type: 'rights.changed', userId: member.id },
      { type: 'rights.changed', userId: member.id },
    ]);
    const after = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: memberCookie,
    });
    expect(after.statusCode).toBe(404);
  });

  it('the owner cannot be removed or changed', async () => {
    const patch = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/sessions/${sid}/members/${owner.id}`,
      cookie: ownerCookie,
      body: { role: 'viewer' },
    });
    expect(patch.statusCode).toBe(409);
    const remove = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/members/${owner.id}`,
      cookie: ownerCookie,
    });
    expect(remove.statusCode).toBe(409);
    expect((await add(ownerCookie, owner.email, 'viewer')).statusCode).toBe(409);
  });

  it('rejects an unknown email and a second add', async () => {
    expect((await add(ownerCookie, 'ghost@example.com', 'viewer')).statusCode).toBe(404);
    expect((await add(ownerCookie, member.email, 'viewer')).statusCode).toBe(201);
    expect((await add(ownerCookie, member.email, 'operator')).statusCode).toBe(409);
  });

  it('an operator can see the members but cannot share: 403', async () => {
    await add(ownerCookie, member.email, 'operator');
    const response = await add(memberCookie, 'stranger@example.com', 'viewer');
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('a user without access gets 404 on the member routes, never 403', async () => {
    const routes = [
      { method: 'GET' as const, url: `/api/sessions/${sid}/members` },
      {
        method: 'POST' as const,
        url: `/api/sessions/${sid}/members`,
        body: { email: 'x@example.com', role: 'viewer' },
      },
      {
        method: 'PATCH' as const,
        url: `/api/sessions/${sid}/members/${member.id}`,
        body: { role: 'viewer' },
      },
      { method: 'DELETE' as const, url: `/api/sessions/${sid}/members/${member.id}` },
    ];
    for (const route of routes) {
      const response = await apiRequest(t.app, { ...route, cookie: strangerCookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'not_found', message: 'Session not found.' },
      });
    }
  });

  it('a deleted session is not found, also for the owner', async () => {
    const deleted = seedSession(t.deps, { ownerId: owner.id, state: 'deleted' });
    const response = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${deleted.id}/members`,
      cookie: ownerCookie,
    });
    expect(response.statusCode).toBe(404);
  });

  it('an admin can share any session, and the audit log records it; reads of members are exempt', async () => {
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/members`,
      cookie: adminCookie,
    });
    expect(list.statusCode).toBe(200);
    const kinds = () =>
      t.deps.db
        .select()
        .from(auditEvents)
        .all()
        .filter((row) => row.kind === 'admin.session_access');
    expect(kinds()).toHaveLength(0);
    expect((await add(adminCookie, member.email, 'viewer')).statusCode).toBe(201);
    expect(kinds()).toHaveLength(1);
    expect(kinds()[0]?.data).toMatchObject({
      action: 'session.share',
      method: 'POST',
      path: '/api/sessions/:sid/members',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/members.test.ts`
Expected: FAIL, `Tests  6 failed | 1 passed (7)`, for example `AssertionError: expected 404 to be 201`.

- [ ] **Step 3: Write the routes**

Each route checks the access before it parses the body, so a user without access gets 404, never 400.

`packages/server/src/api/members.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { AddMemberRequestSchema, UpdateMemberRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requestInfo, requireLogin } from './context.js';

interface SessionParams {
  Params: { sid: string };
}
interface MemberParams {
  Params: { sid: string; userId: string };
}

// Access is checked before the body, so a user without access gets 404, never 400.
export function registerMemberRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/members', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'session.read', requestInfo(request));
    return deps.access.members(request.params.sid);
  });

  scope.post<SessionParams>('/api/sessions/:sid/members', (request, reply) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'session.share', requestInfo(request));
    const input = AddMemberRequestSchema.parse(request.body);
    return reply.code(201).send(deps.access.addMember(context, request.params.sid, input));
  });

  scope.patch<MemberParams>('/api/sessions/:sid/members/:userId', (request) => {
    const context = requireLogin(request);
    const { sid, userId } = request.params;
    deps.access.requireSession(context, sid, 'session.share', requestInfo(request));
    const input = UpdateMemberRequestSchema.parse(request.body);
    return deps.access.updateMember(context, sid, userId, input.role);
  });

  scope.delete<MemberParams>('/api/sessions/:sid/members/:userId', (request, reply) => {
    const context = requireLogin(request);
    const { sid, userId } = request.params;
    deps.access.requireSession(context, sid, 'session.share', requestInfo(request));
    deps.access.removeMember(context, sid, userId);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add this import directly after the line `import { registerHealthRoutes } from './api/health.js';`:

```ts
import { registerMemberRoutes } from './api/members.js';
```

and add this line directly after `    registerUserRoutes(scope, deps);`:

```ts
    registerMemberRoutes(scope, deps);
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/members.test.ts`
Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 12: Token routes

Spec 6.6, 12.1 (`/api/sessions/:sid/tokens*`); spec 15.2 (token create and revoke).

**Files:**
- Create: `packages/server/src/api/tokens.ts`
- Modify: `packages/server/src/app.ts` (register the routes)
- Test: `packages/server/test/integration/tokens.test.ts`

**Interfaces:**
- Consumes: `requireLogin`, `requestInfo` (Task 8); `TokensService` (Task 6); `CreateTokenRequestSchema` (`expiresInDays` defaults to 30; names are 1 to 64 characters of `[A-Za-z0-9_-]`, plan 02), `CreateTokenResponse` (`@hydra/shared`); Task 9 helpers.
- Produces: `registerTokenRoutes(scope, deps)`: `GET /api/sessions/:sid/tokens` (`token.create`) → `Token[]`; `POST …/tokens` (`token.create`) → 201 `CreateTokenResponse`; `DELETE …/tokens/:tokenId` (`token.revoke_own`, plus `token.revoke_any` for a token of another user) → 204.

- [ ] **Step 1: Write the failing test**

`packages/server/test/integration/tokens.test.ts`:

```ts
import { type CreateTokenResponse } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { hmac } from '../../src/crypto/index.js';
import { agentTokens } from '../../src/db/schema.js';
import type { HydraEvent } from '../../src/events/index.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

const DAY = 24 * 60 * 60 * 1000;

describe('agent token routes (spec section 6.6)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let operator: AuthedUser;
  let ownerCookie: string;
  let operatorCookie: string;
  let otherOperatorCookie: string;
  let viewerCookie: string;
  let sid: string;
  let events: HydraEvent[];

  beforeEach(async () => {
    t = await createTestApp();
    const owner = await seedUser(t.deps);
    const op = await seedUser(t.deps, { displayName: 'Operator' });
    const op2 = await seedUser(t.deps);
    const viewer = await seedUser(t.deps);
    operator = op.user;
    sid = seedSession(t.deps, { ownerId: owner.user.id, state: 'running' }).id;
    ownerCookie = await loginAs(t.app, owner.user.email, owner.password);
    for (const [user, role] of [
      [op.user, 'operator'],
      [op2.user, 'operator'],
      [viewer.user, 'viewer'],
    ] as const) {
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${sid}/members`,
        cookie: ownerCookie,
        body: { email: user.email, role },
      });
    }
    operatorCookie = await loginAs(t.app, op.user.email, op.password);
    otherOperatorCookie = await loginAs(t.app, op2.user.email, op2.password);
    viewerCookie = await loginAs(t.app, viewer.user.email, viewer.password);
    events = [];
    t.deps.bus.subscribe('token.revoked', (event) => events.push(event));
  });

  afterEach(async () => {
    await t.close();
  });

  const create = (cookie: string, body: unknown = { name: 'claude', expiresInDays: 30 }) =>
    apiRequest(t.app, { method: 'POST', url: `/api/sessions/${sid}/tokens`, cookie, body });

  it('creates a token: the secret one time, the HMAC in the DB, 30 days', async () => {
    const response = await create(operatorCookie);
    expect(response.statusCode).toBe(201);
    const { token, secret } = response.json<CreateTokenResponse>();
    expect(secret).toMatch(/^hyd_[0-9A-Za-z]+$/);
    expect(token).toMatchObject({
      name: 'claude',
      prefix: `${String(secret).slice(0, 12)}…`,
      createdBy: { id: operator.id, displayName: 'Operator' },
      createdAt: t.clock.now(),
      expiresAt: t.clock.now() + 30 * DAY,
      lastUsedAt: null,
      revokedAt: null,
    });
    const row = t.deps.db.select().from(agentTokens).get();
    expect(row?.tokenHmac.equals(hmac(t.deps.subkeys.agentToken, secret))).toBe(true);
    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/tokens`,
      cookie: ownerCookie,
    });
    expect(list.json<unknown>()).toEqual([token]);
    expect(list.body).not.toContain(secret);
    expect(t.deps.tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.1')?.tokenId).toBe(token.id);
  });

  it('accepts only the expiry values 1, 7, 30, and 90 days', async () => {
    const bad = await create(operatorCookie, { name: 'x', expiresInDays: 3 });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).fields).toHaveProperty('expiresInDays');
    const week = await create(operatorCookie, { name: 'x', expiresInDays: 7 });
    expect(week.json<CreateTokenResponse>().token.expiresAt).toBe(t.clock.now() + 7 * DAY);
  });

  it('a viewer gets 403 for the token routes', async () => {
    expect(
      (
        await apiRequest(t.app, {
          method: 'GET',
          url: `/api/sessions/${sid}/tokens`,
          cookie: viewerCookie,
        })
      ).statusCode,
    ).toBe(403);
    expect((await create(viewerCookie)).statusCode).toBe(403);
  });

  it('revokes an own token: 204, token.revoked event, the token stops working', async () => {
    const { token, secret } = (await create(operatorCookie)).json<CreateTokenResponse>();
    const response = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(response.statusCode).toBe(204);
    expect(events).toEqual([{ type: 'token.revoked', tokenId: token.id, sessionId: sid }]);
    expect(t.deps.tokens.resolve(`Bearer ${secret}`, sid, '192.0.2.1')).toBeNull();
    const again = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(again.statusCode).toBe(204);
    expect(events).toHaveLength(1);
  });

  it('an operator cannot revoke the token of another user; the owner can', async () => {
    const { token } = (await create(otherOperatorCookie)).json<CreateTokenResponse>();
    const denied = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: operatorCookie,
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: ownerCookie,
    });
    expect(allowed.statusCode).toBe(204);
  });

  it('answers 404 for a token of another session', async () => {
    const owner2 = await seedUser(t.deps);
    const other = seedSession(t.deps, { ownerId: owner2.user.id });
    const cookie = await loginAs(t.app, owner2.user.email, owner2.password);
    const { token } = (
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${other.id}/tokens`,
        cookie,
        body: { name: 'x', expiresInDays: 1 },
      })
    ).json<CreateTokenResponse>();
    const response = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/tokens/${token.id}`,
      cookie: ownerCookie,
    });
    expect(response.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/tokens.test.ts`
Expected: FAIL, `Tests  6 failed (6)`, for example `AssertionError: expected 404 to be 201`.

- [ ] **Step 3: Write the routes**

`packages/server/src/api/tokens.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { CreateTokenRequestSchema } from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requestInfo, requireLogin } from './context.js';

interface SessionParams {
  Params: { sid: string };
}
interface TokenParams {
  Params: { sid: string; tokenId: string };
}

export function registerTokenRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/tokens', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'token.create', requestInfo(request));
    return deps.tokens.list(request.params.sid);
  });

  scope.post<SessionParams>('/api/sessions/:sid/tokens', (request, reply) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'token.create', requestInfo(request));
    const input = CreateTokenRequestSchema.parse(request.body);
    return reply.code(201).send(deps.tokens.create(context, request.params.sid, input));
  });

  scope.delete<TokenParams>('/api/sessions/:sid/tokens/:tokenId', (request, reply) => {
    const context = requireLogin(request);
    const { sid, tokenId } = request.params;
    const view = deps.access.requireSession(context, sid, 'token.revoke_own', requestInfo(request));
    deps.tokens.revokeInSession(context, view, tokenId);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add this import directly after the line `import { closeAllSse } from './api/sse.js';`:

```ts
import { registerTokenRoutes } from './api/tokens.js';
```

and add this line directly after `    registerMemberRoutes(scope, deps);`:

```ts
    registerTokenRoutes(scope, deps);
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/tokens.test.ts`
Expected: PASS, `Tests  6 passed (6)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 13: Audit routes and the audit SSE stream

Spec 10.3 (session SSE stream, heartbeat), 12.1 (`GET /api/sessions/:sid/audit` with filters and `limit` up to 200, `GET /api/sessions/:sid/events`); spec 15.2 (a viewer gets 403 on `GET …/audit`). Plans 05 and 06 test the closing of MCP streams and live grants.

**Files:**
- Create: `packages/server/src/api/audit.ts`
- Modify: `packages/server/src/app.ts` (register the routes)
- Test: `packages/server/test/integration/audit.test.ts`

**Interfaces:**
- Consumes: `requireLogin`, `requestInfo`, `openSse` (Task 8); `AccessService.requireSession`, `AccessService.can` (Task 5); `toAuditEvent` (plan 02, `src/audit/index.ts`); `auditEvents`, `users`, `agentTokens`; `AUDIT_KINDS`, `AUDIT_STATUSES`, `AUDIT_PAGE_DEFAULT_LIMIT`, `AUDIT_PAGE_MAX_LIMIT`, `AuditPage` (`@hydra/shared`); the bus events `audit`, `rights.changed`, `login.ended`, `session.state`.
- Produces: `registerAuditRoutes(scope, deps)`; `listAuditEvents(db, sessionId, query): AuditPage`; `AuditQueryParamsSchema` and `AuditQueryParams`.

- [ ] **Step 1: Write the failing test**

`packages/server/test/integration/audit.test.ts`:

```ts
import type { Readable } from 'node:stream';
import { type AuditPage, type CreateTokenResponse } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../src/auth/index.js';
import { apiRequest, createTestApp, errorOf, PUBLIC_HOST } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

/** Collects an SSE body; `waitFor` resolves when the text contains a string, `ended` when it ends. */
function collect(stream: Readable): {
  text(): string;
  waitFor(part: string): Promise<void>;
  ended: Promise<void>;
} {
  let received = '';
  const waiters: Array<{ part: string; resolve: () => void }> = [];
  stream.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
    for (const waiter of waiters.filter((item) => received.includes(item.part))) waiter.resolve();
  });
  const ended = new Promise<void>((resolve) => stream.on('end', resolve));
  return {
    text: () => received,
    waitFor: (part) =>
      received.includes(part)
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ part, resolve })),
    ended,
  };
}

describe('audit routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let owner: AuthedUser;
  let operator: AuthedUser;
  let ownerCookie: string;
  let operatorCookie: string;
  let viewerCookie: string;
  let sid: string;
  let otherSid: string;

  beforeEach(async () => {
    t = await createTestApp();
    const o = await seedUser(t.deps);
    const op = await seedUser(t.deps, { displayName: 'Operator' });
    const v = await seedUser(t.deps);
    owner = o.user;
    operator = op.user;
    sid = seedSession(t.deps, { ownerId: owner.id, state: 'running' }).id;
    otherSid = seedSession(t.deps, { ownerId: owner.id }).id;
    ownerCookie = await loginAs(t.app, o.user.email, o.password);
    for (const [email, role] of [
      [op.user.email, 'operator'],
      [v.user.email, 'viewer'],
    ] as const) {
      await apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${sid}/members`,
        cookie: ownerCookie,
        body: { email, role },
      });
    }
    operatorCookie = await loginAs(t.app, op.user.email, op.password);
    viewerCookie = await loginAs(t.app, v.user.email, v.password);
  });

  afterEach(async () => {
    await t.close();
  });

  const audit = (cookie: string, query = '') =>
    apiRequest(t.app, { method: 'GET', url: `/api/sessions/${sid}/audit${query}`, cookie });

  it('a viewer gets 403 on GET audit (spec section 15.2)', async () => {
    const response = await audit(viewerCookie);
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe('forbidden');
  });

  it('lists the events of the session newest first, with actor names', async () => {
    const response = await audit(operatorCookie);
    expect(response.statusCode).toBe(200);
    const page = response.json<AuditPage>();
    expect(page.nextBefore).toBeNull();
    expect(page.events.map((event) => event.kind)).toEqual(['session.shared', 'session.shared']);
    const [newest, older] = page.events;
    expect(newest).toMatchObject({
      actorType: 'user',
      actorId: owner.id,
      actorName: owner.displayName,
      sessionId: sid,
    });
    expect(newest?.id).toBeGreaterThan(older?.id ?? Number.POSITIVE_INFINITY);
  });

  it('filters by kind, tool, status, and token', async () => {
    const created = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/tokens`,
      cookie: operatorCookie,
      body: { name: 'claude', expiresInDays: 7 },
    });
    const tokenId = created.json<CreateTokenResponse>().token.id;
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: sid,
      status: 'ok',
      data: { tool: 'browser_click' },
    });
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: sid,
      status: 'error',
      data: { tool: 'browser_type' },
    });
    t.deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: tokenId,
      sessionId: otherSid,
      status: 'ok',
      data: { tool: 'browser_click' },
    });
    const kinds = (await audit(operatorCookie, '?kind=mcp.tool_call')).json<AuditPage>().events;
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ actorType: 'token', actorName: 'claude', status: 'error' });
    expect(
      (await audit(operatorCookie, '?tool=browser_click')).json<AuditPage>().events,
    ).toHaveLength(1);
    expect((await audit(operatorCookie, '?status=error')).json<AuditPage>().events).toHaveLength(1);
    const byToken = (await audit(operatorCookie, `?tokenId=${tokenId}`)).json<AuditPage>().events;
    expect(byToken.map((event) => event.kind)).toEqual([
      'mcp.tool_call',
      'mcp.tool_call',
      'token.created',
    ]);
  });

  it('pages with before and limit, at most 200', async () => {
    for (let i = 0; i < 5; i += 1) {
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { i },
      });
    }
    const first = (await audit(operatorCookie, '?limit=3')).json<AuditPage>();
    expect(first.events).toHaveLength(3);
    expect(first.nextBefore).toBe(first.events[2]?.id);
    const second = (
      await audit(operatorCookie, `?limit=3&before=${first.nextBefore}`)
    ).json<AuditPage>();
    expect(second.events).toHaveLength(3);
    expect(second.events[0]?.id).toBeLessThan(first.nextBefore ?? 0);
    const last = (
      await audit(operatorCookie, `?limit=3&before=${second.nextBefore}`)
    ).json<AuditPage>();
    expect(last.events).toHaveLength(1);
    expect(last.nextBefore).toBeNull();
    for (const query of ['?limit=201', '?limit=0', '?limit=abc', '?before=-1', '?kind=nope']) {
      const bad = await audit(operatorCookie, query);
      expect(bad.statusCode, query).toBe(400);
      expect(errorOf(bad).code).toBe('validation_failed');
    }
    expect((await audit(operatorCookie, '?limit=200')).statusCode).toBe(200);
  });

  describe('GET /api/sessions/:sid/events (SSE)', () => {
    const open = (cookie: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/events`,
        headers: { host: PUBLIC_HOST, cookie },
        payloadAsStream: true,
      });

    it('streams the audit events of this session only', async () => {
      const response = await open(operatorCookie);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      const body = collect(response.stream());
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: otherSid,
        data: { which: 'other' },
      });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { which: 'this' },
      });
      await body.waitFor('"which":"this"');
      expect(body.text()).toContain('event: audit\ndata: {');
      expect(body.text()).not.toContain('"which":"other"');
    });

    it('a viewer gets 403', async () => {
      const response = await t.app.inject({
        method: 'GET',
        url: `/api/sessions/${sid}/events`,
        headers: { host: PUBLIC_HOST, cookie: viewerCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it('closes when the user loses audit.read', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      const downgrade = await apiRequest(t.app, {
        method: 'PATCH',
        url: `/api/sessions/${sid}/members/${operator.id}`,
        cookie: ownerCookie,
        body: { role: 'viewer' },
      });
      expect(downgrade.statusCode).toBe(200);
      await body.ended;
    });

    it('stays open when the user keeps audit.read', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      t.deps.bus.publish({ type: 'rights.changed', userId: operator.id });
      t.deps.audit.write({
        kind: 'mcp.connect',
        actorType: 'system',
        actorId: null,
        sessionId: sid,
        data: { still: 'open' },
      });
      await body.waitFor('"still":"open"');
    });

    it('closes when the login session ends', async () => {
      const body = collect((await open(operatorCookie)).stream());
      await body.waitFor(': open');
      await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie: operatorCookie });
      await body.ended;
    });
  });
});
```

- [ ] **Step 2: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/audit.test.ts`
Expected: FAIL, `Tests  9 failed (9)`: the requests get the 404 of the missing routes (for example `AssertionError: expected 404 to be 403`), and the three SSE tests that wait for `: open` fail after the 5 s test timeout.

- [ ] **Step 3: Write the routes**

Notes for the reader of the code:
- The list is newest first; `before` is an event id, and `nextBefore` is set only if an older event exists (the query reads `limit + 1` rows).
- The `tokenId` filter finds the events of the token as actor (`mcp.*`) and the events about the token (`token.created`, `token.revoked`, which carry `data.tokenId`).
- The SSE stream sends each `audit` bus event of this session. It closes when the user loses `audit.read` (`rights.changed` of this user, or `session.state` of this session followed by a failed `AccessService.can`) and when its login session ends (`login.ended`).

`packages/server/src/api/audit.ts`:

```ts
import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUDIT_KINDS,
  AUDIT_PAGE_DEFAULT_LIMIT,
  AUDIT_PAGE_MAX_LIMIT,
  AUDIT_STATUSES,
  type AuditPage,
} from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { toAuditEvent } from '../audit/index.js';
import type { Db } from '../db/index.js';
import { agentTokens, auditEvents, users } from '../db/schema.js';
import { requestInfo, requireLogin } from './context.js';
import { openSse } from './sse.js';

/** The querystring has only strings, so the numbers are coerced. Limit 1..200, default 50. */
export const AuditQueryParamsSchema = z.object({
  kind: z.enum(AUDIT_KINDS).optional(),
  tool: z.string().min(1).max(200).optional(),
  status: z.enum(AUDIT_STATUSES).optional(),
  tokenId: z.string().min(1).max(64).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX_LIMIT).default(AUDIT_PAGE_DEFAULT_LIMIT),
});
export type AuditQueryParams = z.infer<typeof AuditQueryParamsSchema>;

interface SessionParams {
  Params: { sid: string };
}

/** Newest first. `nextBefore` is the id to pass as `before` for the next page, or null. */
export function listAuditEvents(db: Db, sessionId: string, query: AuditQueryParams): AuditPage {
  const conditions: SQL[] = [eq(auditEvents.sessionId, sessionId)];
  if (query.kind) conditions.push(eq(auditEvents.kind, query.kind));
  if (query.status) conditions.push(eq(auditEvents.status, query.status));
  if (query.tool) conditions.push(sql`json_extract(${auditEvents.data}, '$.tool') = ${query.tool}`);
  if (query.tokenId) {
    const byToken = or(
      and(eq(auditEvents.actorType, 'token'), eq(auditEvents.actorId, query.tokenId)),
      sql`json_extract(${auditEvents.data}, '$.tokenId') = ${query.tokenId}`,
    );
    if (byToken) conditions.push(byToken);
  }
  if (query.before !== undefined) conditions.push(lt(auditEvents.id, query.before));
  const rows = db
    .select({ event: auditEvents, userName: users.displayName, tokenName: agentTokens.name })
    .from(auditEvents)
    .leftJoin(users, and(eq(auditEvents.actorType, 'user'), eq(users.id, auditEvents.actorId)))
    .leftJoin(
      agentTokens,
      and(eq(auditEvents.actorType, 'token'), eq(agentTokens.id, auditEvents.actorId)),
    )
    .where(and(...conditions))
    .orderBy(desc(auditEvents.id))
    .limit(query.limit + 1)
    .all();
  const page = rows.slice(0, query.limit);
  // The actor name rule of AuditWriter: user display name, token name, or null.
  const events = page.map(({ event, userName, tokenName }) =>
    toAuditEvent(
      event,
      event.actorType === 'user' ? userName : event.actorType === 'token' ? tokenName : null,
    ),
  );
  const last = page.at(-1);
  return { events, nextBefore: rows.length > query.limit && last ? last.event.id : null };
}

export function registerAuditRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/audit', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'audit.read', requestInfo(request));
    return listAuditEvents(
      deps.db,
      request.params.sid,
      AuditQueryParamsSchema.parse(request.query),
    );
  });

  // SSE of the audit events of one session. Ends when the user loses audit.read or the login ends.
  scope.get<SessionParams>('/api/sessions/:sid/events', (request, reply) => {
    const context = requireLogin(request);
    const { sid } = request.params;
    deps.access.requireSession(context, sid, 'audit.read', requestInfo(request));
    const stream = openSse(reply, { clock: deps.clock });
    const stillAllowed = () => deps.access.can(context.user.id, sid, 'audit.read');
    const unsubscribe = [
      deps.bus.subscribe('audit', ({ event }) => {
        if (event.sessionId === sid) stream.send('audit', event);
      }),
      deps.bus.subscribe('rights.changed', ({ userId }) => {
        if (userId === context.user.id && !stillAllowed()) stream.close();
      }),
      deps.bus.subscribe('login.ended', ({ loginSessionIds }) => {
        if (loginSessionIds.includes(context.loginSessionId)) stream.close();
      }),
      deps.bus.subscribe('session.state', ({ sessionId }) => {
        if (sessionId === sid && !stillAllowed()) stream.close();
      }),
    ];
    void stream.closed.then(() => {
      for (const off of unsubscribe) off();
    });
  });
}
```

- [ ] **Step 4: Register the routes**

In `packages/server/src/app.ts`, add this import directly after the line `import type { AccessService } from './access/index.js';`:

```ts
import { registerAuditRoutes } from './api/audit.js';
```

and add this line directly after `    registerTokenRoutes(scope, deps);`:

```ts
    registerAuditRoutes(scope, deps);
```

- [ ] **Step 5: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/audit.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 6: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 14: Rules over all routes (login, `must_change_password`, the 404 rule)

Spec 6.3 (`must_change_password`: only `GET /api/auth/me`, `POST /api/auth/password`, `POST /api/auth/logout`), 6.5 (404 rule), 12.2; spec 15.2 (`must_change_password`, the 404 rule).

**Files:**
- Test: `packages/server/test/integration/route-rules.test.ts`

**Interfaces:**
- Consumes: all routes of Tasks 9 to 13; `ApiRequest`, `apiRequest`, `errorOf`, `createTestApp`, `loginAs`, `seedUser`, `seedSession`.
- Produces: the route lists `loginRoutes(sid, userId)` and `sessionRoutes(sid, userId)` in the test. Plans 04 to 06 add their routes there (index issue 8).

This task adds a test only. The rules are already in the code (`requireLogin` of Task 8, `requireSession` of Task 5); the test pins them for every route, so a later route that forgets them fails here.

- [ ] **Step 1: Write the test**

`packages/server/test/integration/route-rules.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf, type ApiRequest } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

type Route = Omit<ApiRequest, 'cookie'>;

/** Every route of plan 03 that needs a login. Plans 04 to 06 add their routes to this list. */
function loginRoutes(sid: string, userId: string): Route[] {
  return [
    { method: 'GET', url: '/api/users' },
    {
      method: 'POST',
      url: '/api/users',
      body: { email: 'new@example.com', displayName: 'New', role: 'member' },
    },
    { method: 'PATCH', url: `/api/users/${userId}`, body: { displayName: 'X' } },
    { method: 'POST', url: `/api/users/${userId}/reset-password` },
    { method: 'POST', url: `/api/users/${userId}/unlock` },
    ...sessionRoutes(sid, userId),
  ];
}

function sessionRoutes(sid: string, userId: string): Route[] {
  return [
    { method: 'GET', url: `/api/sessions/${sid}/members` },
    {
      method: 'POST',
      url: `/api/sessions/${sid}/members`,
      body: { email: 'x@example.com', role: 'viewer' },
    },
    { method: 'PATCH', url: `/api/sessions/${sid}/members/${userId}`, body: { role: 'viewer' } },
    { method: 'DELETE', url: `/api/sessions/${sid}/members/${userId}` },
    { method: 'GET', url: `/api/sessions/${sid}/tokens` },
    { method: 'POST', url: `/api/sessions/${sid}/tokens`, body: { name: 'x', expiresInDays: 1 } },
    { method: 'DELETE', url: `/api/sessions/${sid}/tokens/some-token` },
    { method: 'GET', url: `/api/sessions/${sid}/audit` },
    { method: 'GET', url: `/api/sessions/${sid}/events` },
  ];
}

describe('rules over all routes', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let sid: string;
  let ownerId: string;

  beforeEach(async () => {
    t = await createTestApp();
    const owner = await seedUser(t.deps);
    ownerId = owner.user.id;
    sid = seedSession(t.deps, { ownerId, state: 'running' }).id;
  });

  afterEach(async () => {
    await t.close();
  });

  it('every route except login needs a login session: 401 unauthenticated', async () => {
    for (const route of [
      ...loginRoutes(sid, ownerId),
      { method: 'GET' as const, url: '/api/auth/me' },
    ]) {
      const response = await apiRequest(t.app, route);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(errorOf(response).code).toBe('unauthenticated');
    }
  });

  it('must_change_password: only me, password, and logout work; all others are 403 (spec section 6.3)', async () => {
    const admin = await seedUser(t.deps, { role: 'admin' });
    t.deps.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, admin.user.id))
      .run();
    const cookie = await loginAs(t.app, admin.user.email, admin.password);
    for (const route of loginRoutes(sid, ownerId)) {
      const response = await apiRequest(t.app, { ...route, cookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(errorOf(response).code).toBe('password_change_required');
    }
    expect(
      (await apiRequest(t.app, { method: 'GET', url: '/api/auth/me', cookie })).statusCode,
    ).toBe(200);
    const changed = await apiRequest(t.app, {
      method: 'POST',
      url: '/api/auth/password',
      cookie,
      body: { current: admin.password, new: 'my own new passphrase' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await apiRequest(t.app, { method: 'GET', url: '/api/users', cookie })).statusCode).toBe(
      200,
    );
    expect(
      (await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie })).statusCode,
    ).toBe(204);
  });

  it('logout works while must_change_password is true', async () => {
    const member = await seedUser(t.deps);
    t.deps.db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, member.user.id))
      .run();
    const cookie = await loginAs(t.app, member.user.email, member.password);
    expect(
      (await apiRequest(t.app, { method: 'POST', url: '/api/auth/logout', cookie })).statusCode,
    ).toBe(204);
  });

  it('a user without session.read gets the same 404 as for a missing session (spec section 6.5)', async () => {
    const stranger = await seedUser(t.deps);
    const cookie = await loginAs(t.app, stranger.user.email, stranger.password);
    for (const route of sessionRoutes(sid, ownerId)) {
      const response = await apiRequest(t.app, { ...route, cookie });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      expect(response.json<unknown>()).toEqual({
        error: { code: 'not_found', message: 'Session not found.' },
      });
      const missing = await apiRequest(t.app, {
        ...route,
        url: route.url.replace(sid, 'nosuchsession'),
        cookie,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toBe(response.body);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/route-rules.test.ts`
Expected: PASS, `Tests  4 passed (4)`. If a route fails, the message names it (`GET /api/…`): that route must call `requireLogin` or `requireAdmin` first, and `requireSession` before it reads the body. Fix the route, not the test.

- [ ] **Step 3: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 15: Serve the dashboard build

Spec 3.1 (`static/`), 6.8 (dashboard headers); index 2.3 (`@fastify/static` is permitted with a reason), 5.9.

**Files:**
- Modify: `packages/server/package.json` (dependency `@fastify/static`)
- Create: `packages/server/src/static/index.ts`
- Modify: `packages/server/src/app.ts` (register the dashboard)
- Test: `packages/server/test/integration/static.test.ts`

**Interfaces:**
- Consumes: `HydraError`; `AppDeps.webRoot` (Task 9); the public scope of `buildApp` (host constraint and dashboard headers).
- Produces: `registerStatic(scope: FastifyInstance, options: { root: string }): void`.

**Why `@fastify/static`:** serving files is security-relevant code: path traversal checks, `ETag`/`Last-Modified` with 304 answers, `HEAD`, `Range`, and MIME types. The official plugin does all of it, streams the files, and uses `fastify-plugin`, so its routes get the host constraint of the public scope. Own code would repeat this work with more risk.

- [ ] **Step 1: Add the plugin**

Run: `pnpm --filter @hydra/server add @fastify/static@10.1.5`
Expected: the output lists `+ @fastify/static 10.1.5`, and `packages/server/package.json` has `"@fastify/static": "10.1.5"` under `dependencies`.

- [ ] **Step 2: Write the failing test**

`packages/server/test/integration/static.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorOf, LIVE_HOST, PUBLIC_HOST } from '../helpers/app.js';

const INDEX = '<!doctype html><title>Hydra</title>';
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://live.hydra.localhost; " +
  "img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

describe('dashboard build (spec section 6.8)', () => {
  let webRoot: string;
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(() => {
    webRoot = mkdtempSync(join(tmpdir(), 'hydra-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), INDEX);
    writeFileSync(join(webRoot, 'assets', 'index-4f2a9c.js'), 'console.log("hydra");');
    writeFileSync(join(webRoot, '.env'), 'SECRET=1');
  });

  afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

  afterEach(async () => {
    await t.close();
  });

  const get = (url: string, host = PUBLIC_HOST, method: 'GET' | 'HEAD' = 'GET') =>
    t.app.inject({ method, url, headers: { host } });

  it('serves index.html at / and for app routes, with the dashboard headers and no-cache', async () => {
    t = await createTestApp({ webRoot });
    for (const url of ['/', '/sessions/abcdefghijkl/live', '/admin/users?tab=1']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.body).toBe(INDEX);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('serves hashed assets with a long cache, HEAD, and 304', async () => {
    t = await createTestApp({ webRoot });
    const response = await get('/assets/index-4f2a9c.js');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/assets/index-4f2a9c.js', PUBLIC_HOST, 'HEAD')).statusCode).toBe(200);
    const cached = await t.app.inject({
      method: 'GET',
      url: '/assets/index-4f2a9c.js',
      headers: { host: PUBLIC_HOST, 'if-none-match': String(response.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers['content-security-policy']).toBe(CSP);
  });

  it('answers 404 JSON for missing files, unknown API paths, dot files, and path traversal', async () => {
    t = await createTestApp({ webRoot });
    for (const url of [
      '/assets/missing.js',
      '/api/unknown',
      '/.env',
      '/../package.json',
      '/%2e%2e/package.json',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    }
  });

  it('serves nothing on other hosts', async () => {
    t = await createTestApp({ webRoot });
    for (const host of [LIVE_HOST, 'evil.example']) {
      expect((await get('/', host)).statusCode).toBe(404);
      expect((await get('/assets/index-4f2a9c.js', host)).statusCode).toBe(404);
    }
  });

  it('serves no dashboard without a build folder', async () => {
    t = await createTestApp({ webRoot: null });
    expect((await get('/')).statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run the test to verify that it fails**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/static.test.ts`
Expected: FAIL, `Tests  2 failed | 3 passed (5)`, with `AssertionError: /: expected 404 to be 200`.

- [ ] **Step 4: Write `registerStatic`**

`wildcard: false` registers one route for each file of the build at start (the image never changes the build). Other `GET` paths get `index.html` (the dashboard uses client routes such as `/sessions/:sid/live`), except unknown `/api` paths and paths with a file extension, which get 404 `not_found`. Hashed files under `assets/` get a long cache; all other files get `no-cache`.

`packages/server/src/static/index.ts`:

```ts
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { HydraError } from '../lib/errors.js';

/** Vite puts hashed file names under assets/, so these files can be cached for a long time. */
function cacheControl(path: string): string {
  return /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * Serves the @hydra/web build from `root` on the public host scope (the scope adds the host
 * constraint and the headers of spec section 6.8). @fastify/static does the file handling:
 * path traversal checks, ETag and Last-Modified, 304, HEAD, Range, and MIME types.
 * Other GET paths that are not files get index.html (single-page app). Unknown /api paths and
 * paths with a file extension get 404.
 */
export function registerStatic(scope: FastifyInstance, options: { root: string }): void {
  void scope.register(fastifyStatic, {
    root: options.root,
    wildcard: false,
    index: false,
    serveDotFiles: false,
    setHeaders: (reply, path) => {
      reply.header('cache-control', cacheControl(path));
    },
  });

  scope.get('/*', (request, reply) => {
    const path = request.url.split('?')[0] ?? '/';
    if (path === '/api' || path.startsWith('/api/') || /\.[A-Za-z0-9]+$/.test(path)) {
      throw new HydraError('not_found', 'Not found.');
    }
    return reply.sendFile('index.html');
  });
}
```

- [ ] **Step 5: Register the dashboard**

In `packages/server/src/app.ts`, add this import directly after the line `import { dashboardHeaders } from './static/headers.js';`:

```ts
import { registerStatic } from './static/index.js';
```

and add this line directly after `    registerAuditRoutes(scope, deps);`:

```ts
    if (deps.webRoot !== null) registerStatic(scope, { root: deps.webRoot });
```

After Tasks 9 to 15, `packages/server/src/app.ts` is exactly:

```ts
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AccessService } from './access/index.js';
import { registerAuditRoutes } from './api/audit.js';
import { registerAuthRoutes } from './api/auth.js';
import { errorHandler, frameworkErrorHandler, notFoundHandler } from './api/errors.js';
import { registerHealthRoutes } from './api/health.js';
import { registerMemberRoutes } from './api/members.js';
import { closeAllSse } from './api/sse.js';
import { registerTokenRoutes } from './api/tokens.js';
import { registerUserRoutes } from './api/users.js';
import type { AuditWriter } from './audit/index.js';
import { SESSION_COOKIE, checkCsrf, parseCookies, type AuthService } from './auth/index.js';
import type { Config } from './config/index.js';
import type { PasswordHasher, Subkeys } from './crypto/index.js';
import type { Db } from './db/index.js';
import type { EventBus } from './events/index.js';
import type { Clock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { dashboardHeaders } from './static/headers.js';
import { registerStatic } from './static/index.js';
import type { TokensService } from './tokens/index.js';
import type { UsersService } from './users/index.js';

/** 1 MiB, the body limit of spec section 8.2. Dashboard bodies are much smaller. */
export const BODY_LIMIT = 1_048_576;

export interface AppDeps {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  hasher: PasswordHasher;
  auth: AuthService;
  users: UsersService;
  access: AccessService;
  tokens: TokensService;
  /** Folder of the @hydra/web build, or null to serve no dashboard (development, tests). */
  webRoot: string | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  // Widen the pino type, so the instance is a plain FastifyInstance for all plans.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustedProxies,
    bodyLimit: BODY_LIMIT,
    frameworkErrors: frameworkErrorHandler,
  });
  app.decorateRequest('login', null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  // app.close() waits for open connections; SSE streams never end by themselves.
  app.addHook('preClose', (done) => {
    closeAllSse(app.server);
    done();
  });

  registerHealthRoutes(app, deps);

  // Public host: dashboard, API, and (plan 05) the MCP endpoint.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.publicUrl.host };
    });
    const headers = dashboardHeaders(config);
    scope.addHook('onRequest', (request, reply, next) => {
      reply.headers(headers);
      // Use the route pattern: the raw URL can be percent-encoded (`/%61pi/...`).
      if (request.routeOptions.url?.startsWith('/api/')) {
        checkCsrf(request, config.publicUrl.origin);
        request.login = deps.auth.resolve(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      }
      next();
    });
    registerAuthRoutes(scope, deps);
    registerUserRoutes(scope, deps);
    registerMemberRoutes(scope, deps);
    registerTokenRoutes(scope, deps);
    registerAuditRoutes(scope, deps);
    if (deps.webRoot !== null) registerStatic(scope, { root: deps.webRoot });
    // Plans 04 and 05 add their route registrations here.
    done();
  });

  // Live host: plan 06 registers the live routes in this scope.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.liveUrl.host };
    });
    done();
  });

  return app;
}
```

- [ ] **Step 6: Run the test to verify that it passes**

Run: `pnpm --filter @hydra/server exec vitest run test/integration/static.test.ts`
Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 7: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 16: `main.ts` (composition, daily jobs, SIGTERM)

Spec 3.1 (`main.ts`), 13.3 (daily jobs), 14 (SIGTERM, health); index 5.9 (`main.ts`).

**Files:**
- Create: `packages/server/src/main.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `createLogger`, `systemClock`, `openDb` (async), `EventBus`, `deriveSubkeys`, `AuditWriter`, `runAuditRetention`, `PasswordHasher` (plan 02); the services of Tasks 3 to 7; `buildApp` (Task 9).
- Produces: the gateway entry point (`node dist/main.js`, development: `tsx watch --conditions=@hydra/source src/main.ts`). Plans 04 to 06 add the reconciler, the connection checks, and their deps here (index 5.9).

`main.ts` has no unit test: plan 04 adds a Kubernetes check at start, so a test that starts the process would break. Step 3 is a smoke run with exact expectations.

- [ ] **Step 1: Write `main.ts`**

Notes for the reader of the code:
- A `ConfigError` prints `hydra: <message>` (the message names the variable) and exits with code 1 (spec 4).
- `openDb` makes a backup and runs the migrations (plan 02); if a migration fails, the promise rejects and the process stops before it listens (spec 11.8).
- The daily jobs run once at start and then every 24 h (`unref()` timer): audit retention with `HYDRA_AUDIT_RETENTION_DAYS`, and `AuthService.cleanupExpired()` (spec 13.3).
- SIGTERM (and SIGINT): `app.close()` stops new connections, the `preClose` hook ends the SSE streams, open requests get 10 s, then `closeAllConnections()` ends them; then the database closes (spec 14).

`packages/server/src/main.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessService } from './access/index.js';
import { buildApp } from './app.js';
import { AuditWriter, runAuditRetention } from './audit/index.js';
import { AuthService } from './auth/index.js';
import { ConfigError, loadConfig, type Config } from './config/index.js';
import { PasswordHasher, deriveSubkeys } from './crypto/index.js';
import { openDb } from './db/index.js';
import { EventBus } from './events/index.js';
import { systemClock } from './lib/clock.js';
import { createLogger, type Logger } from './lib/logger.js';
import { TokensService } from './tokens/index.js';
import { UsersService } from './users/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spec section 14: open streams and WebSockets get 10 s after SIGTERM, then they are closed. */
const SHUTDOWN_GRACE_MS = 10_000;

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`hydra: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** The dashboard build is `public/` in the server package root, next to `src/` and `dist/`. */
function findWebRoot(logger: Logger): string | null {
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  if (existsSync(join(root, 'index.html'))) return root;
  logger.warn({ root }, 'no dashboard build found, the gateway serves only the API');
  return null;
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  const clock = systemClock;
  const database = await openDb({ dataDir: config.dataDir, logger, clock });
  const db = database.db;
  const bus = new EventBus(logger);
  const subkeys = deriveSubkeys(config.secretKey);
  const audit = new AuditWriter({ db, bus, clock });
  const hasher = new PasswordHasher(subkeys.passwordPepper);
  const access = new AccessService({ db, clock, audit, bus });
  const tokens = new TokensService({ db, clock, subkeys, access, audit, bus });
  const auth = new AuthService({ db, clock, subkeys, hasher, audit, bus });
  const users = new UsersService({ db, clock, hasher, auth, tokens, audit, bus });
  const app = await buildApp({
    config,
    clock,
    logger,
    db,
    bus,
    subkeys,
    audit,
    hasher,
    auth,
    users,
    access,
    tokens,
    webRoot: findWebRoot(logger),
  });

  // Spec section 13.3: every day, audit retention and the cleanup of expired login sessions and live grants.
  const runDailyJobs = (): void => {
    try {
      const deleted = runAuditRetention({ db, clock }, config.auditRetentionDays);
      logger.info({ deleted }, 'audit retention done');
    } catch (err) {
      logger.error({ err }, 'audit retention failed');
    }
    try {
      logger.info(auth.cleanupExpired(), 'expired login sessions and live grants removed');
    } catch (err) {
      logger.error({ err }, 'cleanup of expired login sessions failed');
    }
  };
  runDailyJobs();
  const daily = setInterval(runDailyJobs, DAY_MS);
  daily.unref();

  await app.listen({ port: config.port, host: '0.0.0.0' });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(daily);
    // app.close() stops new requests and waits for open ones; after 10 s it closes them.
    const force = setTimeout(() => {
      logger.warn('closing the open connections');
      app.server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    try {
      await app.close();
    } finally {
      clearTimeout(force);
      database.close();
      logger.info('stopped');
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @hydra/server run typecheck`
Expected: exit code 0.

- [ ] **Step 3: Smoke run**

Run (bash or zsh, from the repository root):

```bash
cd packages/server
export HYDRA_DATA_DIR="$(mktemp -d)"
export HYDRA_SECRET_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
export HYDRA_PUBLIC_URL=http://hydra.localhost HYDRA_LIVE_URL=http://live.hydra.localhost HYDRA_PUBLIC_IP=127.0.0.1
export HYDRA_SESSION_IMAGE="localhost:5000/hydra-session:dev@sha256:$(printf 'a%.0s' $(seq 64))"
export HYDRA_MCP_IMAGE="localhost:5000/hydra-mcp:dev@sha256:$(printf 'b%.0s' $(seq 64))"
export PORT="$(node -e "const s=require('node:net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")"
node --import tsx --conditions=@hydra/source src/main.ts > "$HYDRA_DATA_DIR/gateway.log" 2>&1 &
GATEWAY=$!
sleep 4
curl -s -w ' %{http_code}\n' "http://127.0.0.1:$PORT/healthz"
curl -s -w ' %{http_code}\n' "http://127.0.0.1:$PORT/readyz"
curl -s -w ' %{http_code}\n' "http://127.0.0.1:$PORT/api/auth/me"
curl -s -H 'Host: hydra.localhost' -w ' %{http_code}\n' "http://127.0.0.1:$PORT/api/auth/me"
kill -TERM "$GATEWAY"; wait "$GATEWAY"; echo "exit code $?"
grep -o '"msg":"[^"]*"' "$HYDRA_DATA_DIR/gateway.log"
cd ../..
```

Expected: the four answers, then `exit code 0`, then log messages that include these lines in this order (Fastify prints one `Server listening` line for each address):

```
{"status":"ok"} 200
{"status":"ok","checks":{"db":true}} 200
{"error":{"code":"not_found","message":"Not found."}} 404
{"error":{"code":"unauthenticated","message":"Log in first."}} 401
exit code 0
"msg":"no dashboard build found, the gateway serves only the API"
"msg":"audit retention done"
"msg":"expired login sessions and live grants removed"
"msg":"Server listening at http://127.0.0.1:<PORT>"
"msg":"shutting down"
"msg":"stopped"
```

The third request has no `Host: hydra.localhost`, so it gets the 404 of other hosts. The health checks write no request logs (`logLevel: 'warn'`).

- [ ] **Step 4: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.

---

### Task 17: The `hydra` CLI

Spec 3.1 (`hydra keygen`, `hydra user create`, `hydra user reset-password`, `hydra db backup`), 5.1 (backups), 6.1 (`hydra keygen`), 6.3 (first admin: the command asks for the password and does not show it).

**Files:**
- Create: `packages/server/src/cli/prompt.ts`, `packages/server/src/cli/commands.ts`, `packages/server/src/cli/main.ts`
- Modify: `packages/server/package.json` (`bin`, the `hydra` script)
- Test: `packages/server/src/cli/prompt.test.ts`, `packages/server/src/cli/commands.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `generateRootKey`, `deriveSubkeys`, `PasswordHasher`, `openDb` (async), `openSqlite`, `DB_FILE`, `backupDb`, `EventBus`, `AuditWriter`, `createLogger`, `systemClock`, `HydraError` (plan 02); `AccessService`, `TokensService`, `AuthService`, `UsersService.createWithPassword`, `UsersService.setPassword` (Tasks 3 to 7).
- Produces: `runCli(argv: string[], io: CliIo): Promise<number>` (exit code 0 done, 1 failed, 2 usage), `CliIo`, `USAGE`; `createSecretReader(input?, output?)`, `PromptCancelledError`, `SecretInput`; the `hydra` bin.

- [ ] **Step 1: Write the failing tests**

`packages/server/src/cli/prompt.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PromptCancelledError, createSecretReader, type SecretInput } from './prompt.js';

function tty(): { input: SecretInput & PassThrough; setRawMode: ReturnType<typeof vi.fn> } {
  const setRawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
  return { input, setRawMode };
}

function capture(): { output: PassThrough; text(): string } {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { output, text: () => text };
}

describe('createSecretReader on a TTY', () => {
  it('reads without echo, handles backspace, and restores the mode', async () => {
    const { input, setRawMode } = tty();
    const out = capture();
    const read = createSecretReader(input, out.output);
    const answer = read('Password: ');
    input.write('abc\u007fd\r');
    expect(await answer).toBe('abd');
    expect(out.text()).toBe('Password: \n');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('rejects on Ctrl-C', async () => {
    const { input } = tty();
    const read = createSecretReader(input, capture().output);
    const answer = read('Password: ');
    input.write('ab\u0003');
    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
  });
});

describe('createSecretReader without a TTY', () => {
  it('reads one line for each call', async () => {
    const input = new PassThrough();
    const out = capture();
    const read = createSecretReader(input, out.output);
    input.write('first secret\nsecond secret\n');
    expect(await read('Password: ')).toBe('first secret');
    expect(await read('Repeat: ')).toBe('second secret');
    expect(out.text()).toBe('Password: \nRepeat: \n');
  });

  it('rejects when the input ends', async () => {
    const input = new PassThrough();
    const read = createSecretReader(input, capture().output);
    input.end();
    await expect(read('Password: ')).rejects.toBeInstanceOf(PromptCancelledError);
  });
});
```

`packages/server/src/cli/commands.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher, deriveSubkeys } from '../crypto/index.js';
import { openDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import { runCli, type CliIo } from './commands.js';

const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

function env(dataDir: string): Record<string, string> {
  return {
    HYDRA_DATA_DIR: dataDir,
    HYDRA_SECRET_KEY: SECRET_KEY,
    HYDRA_PUBLIC_URL: 'http://hydra.localhost',
    HYDRA_LIVE_URL: 'http://live.hydra.localhost',
    HYDRA_PUBLIC_IP: '127.0.0.1',
    HYDRA_SESSION_IMAGE: `localhost:5000/hydra-session:test@sha256:${'a'.repeat(64)}`,
    HYDRA_MCP_IMAGE: `localhost:5000/hydra-mcp:test@sha256:${'b'.repeat(64)}`,
  };
}

function io(environment: Record<string, string | undefined>, secrets: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIo = {
    env: environment,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readSecret: () => {
      const next = secrets.shift();
      return next === undefined
        ? Promise.reject(new Error('no more secrets'))
        : Promise.resolve(next);
    },
  };
  return { cli, out: () => out.join(''), err: () => err.join('') };
}

describe('hydra CLI', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hydra-cli-'));
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  async function userRow(email: string) {
    const db = await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock });
    try {
      return db.db.select().from(users).where(eq(users.email, email)).get();
    } finally {
      db.close();
    }
  }

  it('keygen prints a new 32-byte key in base64', async () => {
    const run = io({});
    expect(await runCli(['keygen'], run.cli)).toBe(0);
    expect(Buffer.from(run.out().trim(), 'base64')).toHaveLength(32);
  });

  it('prints the usage for an unknown command, a missing --email, or an unknown option', async () => {
    for (const argv of [
      [],
      ['nope'],
      ['user', 'create'],
      ['user', 'create', '--email', 'a@b.co', '--root'],
    ]) {
      const run = io(env(dataDir));
      expect(await runCli(argv, run.cli), argv.join(' ')).toBe(2);
      expect(run.err()).toContain('Usage:');
    }
  });

  it('user create --admin asks the password two times and creates an admin', async () => {
    const run = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(
      await runCli(['user', 'create', '--admin', '--email', 'Root@Example.com'], run.cli),
    ).toBe(0);
    expect(run.out()).toMatch(/^Created admin root@example\.com \(.+\)\.\n$/);
    const row = await userRow('root@example.com');
    expect(row).toMatchObject({
      role: 'admin',
      displayName: 'Root',
      mustChangePassword: false,
      status: 'active',
    });
    const hasher = new PasswordHasher(
      deriveSubkeys(Buffer.from(SECRET_KEY, 'base64')).passwordPepper,
    );
    expect(await hasher.verify(row?.passwordHash ?? '', 'a long admin passphrase')).toBe(true);
  });

  it('user create fails for different passwords, a weak password, and an existing email', async () => {
    const differ = io(env(dataDir), ['a long admin passphrase', 'another passphrase!!']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], differ.cli)).toBe(1);
    expect(differ.err()).toBe('hydra: The passwords are not the same.\n');
    const weak = io(env(dataDir), ['Password1234', 'Password1234']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], weak.cli)).toBe(1);
    expect(weak.err()).toContain('too common');
    const first = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(
      await runCli(['user', 'create', '--email', 'a@example.com', '--name', 'Ann'], first.cli),
    ).toBe(0);
    expect((await userRow('a@example.com'))?.role).toBe('member');
    const again = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], again.cli)).toBe(1);
    expect(again.err()).toContain('exists');
  });

  it('user reset-password sets a typed password and ends the lock', async () => {
    const create = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    await runCli(['user', 'create', '--email', 'ops@example.com'], create.cli);
    const db = await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock });
    db.db
      .update(users)
      .set({ lockedAt: Date.now(), failedLogins: 100 })
      .where(eq(users.email, 'ops@example.com'))
      .run();
    db.close();
    const run = io(env(dataDir), ['the new passphrase!', 'the new passphrase!']);
    expect(await runCli(['user', 'reset-password', '--email', 'ops@example.com'], run.cli)).toBe(0);
    expect(await userRow('ops@example.com')).toMatchObject({
      lockedAt: null,
      failedLogins: 0,
      mustChangePassword: false,
    });
    const missing = io(env(dataDir), ['the new passphrase!', 'the new passphrase!']);
    expect(
      await runCli(['user', 'reset-password', '--email', 'ghost@example.com'], missing.cli),
    ).toBe(1);
  });

  it('db backup writes a backup file and prints its path', async () => {
    const none = io(env(dataDir));
    expect(await runCli(['db', 'backup'], none.cli)).toBe(1);
    expect(none.err()).toContain('No database');
    (await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock })).close();
    const before = existsSync(join(dataDir, 'backups'))
      ? readdirSync(join(dataDir, 'backups')).length
      : 0;
    const run = io(env(dataDir));
    expect(await runCli(['db', 'backup'], run.cli)).toBe(0);
    const path = run.out().trim();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(before + 1);
  });

  it('names the variable when the configuration is not valid', async () => {
    const run = io({ ...env(dataDir), HYDRA_SECRET_KEY: undefined }, [
      'a long admin passphrase',
      'a long admin passphrase',
    ]);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], run.cli)).toBe(1);
    expect(run.err()).toContain('HYDRA_SECRET_KEY');
  });
});
```

- [ ] **Step 2: Run the tests to verify that they fail**

Run: `pnpm --filter @hydra/server exec vitest run src/cli`
Expected: FAIL, 2 failed suites with `Error: Cannot find module './prompt.js'` and `Error: Cannot find module './commands.js'`.

- [ ] **Step 3: Write the password prompt**

On a TTY, the prompt switches stdin to raw mode, so the typed characters are not shown (spec 6.3); it handles Enter, Backspace, Ctrl-C, and Ctrl-D, and restores the mode. Without a TTY (`kubectl exec` without `-it`, or a pipe), it reads one line for each question. The prompt goes to stderr, so stdout has only the result.

`packages/server/src/cli/prompt.ts`:

```ts
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** stdin as the prompt sees it: a TTY can switch to raw mode, so the typed text is not shown. */
export type SecretInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PromptCancelledError';
  }
}

const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

function readTtySecret(prompt: string, input: SecretInput, output: Writable): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(prompt);
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = (error: Error | null): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (ENTER.has(char)) return finish(null);
        if (char === CTRL_C) return finish(new PromptCancelledError());
        if (char === CTRL_D) {
          return finish(value === '' ? new PromptCancelledError() : null);
        }
        if (BACKSPACE.has(char)) value = [...value].slice(0, -1).join('');
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Returns a function that asks for a secret. On a TTY the typed characters are not shown (raw
 * mode). Without a TTY (for example `printf 'pw\npw\n' | hydra user create …`) it reads one line
 * for each call.
 */
export function createSecretReader(
  input: SecretInput = process.stdin,
  output: Writable = process.stderr,
): (prompt: string) => Promise<string> {
  if (input.isTTY && input.setRawMode) return (prompt) => readTtySecret(prompt, input, output);
  const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
  return async (prompt) => {
    output.write(prompt);
    const next = await lines.next();
    output.write('\n');
    if (next.done === true) throw new PromptCancelledError();
    return String(next.value);
  };
}
```

- [ ] **Step 4: Write the commands**

`node:util` `parseArgs` (strict) parses the options. `user create` and `user reset-password` open the database with `openDb` (backup and migrations, as at gateway start), so they also work before the first gateway start. `db backup` uses `openSqlite` and `backupDb`, without migrations (plan 02, index issue 3). The CLI runs in the gateway pod next to the gateway (SQLite WAL, `busy_timeout`); its bus events stay in the CLI process, and the gateway's connection checks (plans 05 and 06) close what the CLI ended.

`packages/server/src/cli/commands.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import { AuthService } from '../auth/index.js';
import { ConfigError, loadConfig } from '../config/index.js';
import { PasswordHasher, deriveSubkeys, generateRootKey } from '../crypto/index.js';
import { DB_FILE, backupDb, openDb, openSqlite } from '../db/index.js';
import { EventBus } from '../events/index.js';
import { systemClock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { TokensService } from '../tokens/index.js';
import { UsersService } from '../users/index.js';
import { PromptCancelledError } from './prompt.js';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  readSecret(prompt: string): Promise<string>;
}

export const USAGE = `Usage:
  hydra keygen
  hydra user create --email <email> [--admin] [--name <display name>]
  hydra user reset-password --email <email>
  hydra db backup
`;

class UsageError extends Error {}

/** Runs one CLI command. Returns the exit code: 0 done, 1 failed, 2 usage error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (group === 'keygen' && command === undefined) {
      io.stdout(`${generateRootKey()}\n`);
      return 0;
    }
    if (group === 'user' && command === 'create') return await userCreate(rest, io);
    if (group === 'user' && command === 'reset-password') return await userResetPassword(rest, io);
    if (group === 'db' && command === 'backup') return await dbBackup(rest, io);
    throw new UsageError(
      argv.length === 0 ? 'No command given.' : `Unknown command: ${argv.join(' ')}`,
    );
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr(`hydra: ${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    if (
      error instanceof HydraError ||
      error instanceof ConfigError ||
      error instanceof PromptCancelledError
    ) {
      io.stderr(`hydra: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')
  );
}

async function askNewPassword(io: CliIo): Promise<string> {
  const password = await io.readSecret('Password: ');
  const repeated = await io.readSecret('Repeat the password: ');
  if (password !== repeated) {
    throw new HydraError('password_rejected', 'The passwords are not the same.');
  }
  return password;
}

/** Opens the database (backup and migrations, as at gateway start) and builds the user services. */
async function withUsers<T>(
  env: CliIo['env'],
  run: (users: UsersService) => Promise<T>,
): Promise<T> {
  const config = loadConfig(env);
  const logger = createLogger('error');
  const clock = systemClock;
  const database = await openDb({ dataDir: config.dataDir, logger, clock });
  try {
    const db = database.db;
    const bus = new EventBus(logger);
    const subkeys = deriveSubkeys(config.secretKey);
    const audit = new AuditWriter({ db, bus, clock });
    const hasher = new PasswordHasher(subkeys.passwordPepper);
    const access = new AccessService({ db, clock, audit, bus });
    const tokens = new TokensService({ db, clock, subkeys, access, audit, bus });
    const auth = new AuthService({ db, clock, subkeys, hasher, audit, bus });
    return await run(new UsersService({ db, clock, hasher, auth, tokens, audit, bus }));
  } finally {
    database.close();
  }
}

async function userCreate(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      admin: { type: 'boolean', default: false },
      name: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.email === undefined) throw new UsageError('--email is necessary.');
  const email = values.email;
  const password = await askNewPassword(io);
  const user = await withUsers(io.env, (users) =>
    users.createWithPassword({
      email,
      displayName: values.name ?? email.split('@')[0] ?? email,
      role: values.admin ? 'admin' : 'member',
      password,
    }),
  );
  io.stdout(`Created ${user.role} ${user.email} (${user.id}).\n`);
  return 0;
}

async function userResetPassword(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.email === undefined) throw new UsageError('--email is necessary.');
  const email = values.email;
  const password = await askNewPassword(io);
  const user = await withUsers(io.env, (users) => users.setPassword(email, password));
  io.stdout(`New password set for ${user.email}. Its login sessions ended and its lock ended.\n`);
  return 0;
}

/**
 * Backup without migrations (`openSqlite`, not `openDb`), so a backup never changes the schema next
 * to the running gateway. Safe while the gateway runs (SQLite online backup API, WAL mode).
 */
async function dbBackup(args: string[], io: CliIo): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  const config = loadConfig(io.env);
  const file = join(config.dataDir, DB_FILE);
  // openSqlite creates a missing file, so check first.
  if (!existsSync(file)) throw new HydraError('not_found', `No database at ${file}.`);
  const sqlite = openSqlite(config.dataDir);
  try {
    io.stdout(`${await backupDb(sqlite, config.dataDir, systemClock)}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}
```

- [ ] **Step 5: Write the entry point**

`packages/server/src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { runCli } from './commands.js';
import { createSecretReader } from './prompt.js';

let readSecret: ((prompt: string) => Promise<string>) | undefined;

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  // Created on first use, so `hydra keygen` does not read stdin.
  readSecret: (prompt) => (readSecret ??= createSecretReader())(prompt),
});
process.exit(code);
```

- [ ] **Step 6: Run the tests to verify that they pass**

Run: `pnpm --filter @hydra/server exec vitest run src/cli`
Expected: PASS, `Test Files  2 passed (2)`, `Tests  11 passed (11)`.

- [ ] **Step 7: Add the bin and the script**

In `packages/server/package.json`, add the `bin` field after the `exports` field:

```json
  "bin": {
    "hydra": "./dist/cli/main.js"
  },
```

and add this entry to `scripts` (development use: `pnpm --filter @hydra/server run hydra keygen`):

```json
    "hydra": "tsx --conditions=@hydra/source src/cli/main.ts",
```

- [ ] **Step 8: Smoke run**

Run (bash or zsh, from the repository root):

```bash
cd packages/server
export HYDRA_DATA_DIR="$(mktemp -d)"
export HYDRA_SECRET_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
export HYDRA_PUBLIC_URL=http://hydra.localhost HYDRA_LIVE_URL=http://live.hydra.localhost HYDRA_PUBLIC_IP=127.0.0.1
export HYDRA_SESSION_IMAGE="localhost:5000/hydra-session:dev@sha256:$(printf 'a%.0s' $(seq 64))"
export HYDRA_MCP_IMAGE="localhost:5000/hydra-mcp:dev@sha256:$(printf 'b%.0s' $(seq 64))"
hydra() { node --import tsx --conditions=@hydra/source src/cli/main.ts "$@"; }
hydra keygen; echo "exit $?"
printf 'a long admin passphrase\na long admin passphrase\n' | hydra user create --admin --email admin@example.com; echo "exit $?"
printf 'one passphrase here\nanother passphrase!\n' | hydra user reset-password --email admin@example.com; echo "exit $?"
hydra db backup; echo "exit $?"
hydra bogus; echo "exit $?"
unset -f hydra
cd ../..
```

Expected (the key, the ULID, and the backup name differ):

```
<44 base64 characters>
exit 0
Password: 
Repeat the password: 
Created admin admin@example.com (<ULID>).
exit 0
Password: 
Repeat the password: 
hydra: The passwords are not the same.
exit 1
<HYDRA_DATA_DIR>/backups/hydra-<timestamp>.db
exit 0
hydra: Unknown command: bogus
Usage:
  hydra keygen
  hydra user create --email <email> [--admin] [--name <display name>]
  hydra user reset-password --email <email>
  hydra db backup
exit 2
```

- [ ] **Step 9: Check the built bin**

Run: `pnpm --filter "@hydra/server..." run build && head -1 packages/server/dist/cli/main.js`
Expected: the build succeeds and prints `#!/usr/bin/env node`.

- [ ] **Step 10: Checkpoint**
  Run: `pnpm lint && pnpm typecheck && pnpm --filter @hydra/server test`
  Expected: all pass.
  Do not commit (AGENTS.md rule 1). Report the changed and the new files to the controller.
