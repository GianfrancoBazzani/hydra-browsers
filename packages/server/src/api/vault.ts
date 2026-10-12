// Vault routes (spec sections 6.9 and 12.1).
import type { FastifyInstance } from 'fastify';
import {
  CreateCredentialRequestSchema,
  RevealRequestSchema,
  UpdateCredentialRequestSchema,
} from '@hydra/shared';
import type { AppDeps } from '../app.js';
import { requestInfo, requireLogin } from './context.js';

interface SessionParams {
  Params: { sid: string };
}
interface CredentialParams {
  Params: { sid: string; credentialId: string };
}

export function registerVaultRoutes(scope: FastifyInstance, deps: AppDeps): void {
  scope.get<SessionParams>('/api/sessions/:sid/vault', (request) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'vault.read', requestInfo(request));
    return deps.vault.list(request.params.sid);
  });

  scope.post<SessionParams>('/api/sessions/:sid/vault', (request, reply) => {
    const context = requireLogin(request);
    deps.access.requireSession(context, request.params.sid, 'vault.manage', requestInfo(request));
    const input = CreateCredentialRequestSchema.parse(request.body);
    return reply.code(201).send(deps.vault.create(context, request.params.sid, input));
  });

  scope.patch<CredentialParams>('/api/sessions/:sid/vault/:credentialId', (request) => {
    const context = requireLogin(request);
    const { sid, credentialId } = request.params;
    deps.access.requireSession(context, sid, 'vault.manage', requestInfo(request));
    const input = UpdateCredentialRequestSchema.parse(request.body);
    return deps.vault.update(context, sid, credentialId, input);
  });

  scope.delete<CredentialParams>('/api/sessions/:sid/vault/:credentialId', (request, reply) => {
    const context = requireLogin(request);
    const { sid, credentialId } = request.params;
    deps.access.requireSession(context, sid, 'vault.manage', requestInfo(request));
    deps.vault.remove(context, sid, credentialId);
    return reply.code(204).send();
  });

  scope.post<CredentialParams>(
    '/api/sessions/:sid/vault/:credentialId/reveal',
    (request, reply) => {
      const context = requireLogin(request);
      const { sid, credentialId } = request.params;
      deps.access.requireSession(context, sid, 'vault.reveal', requestInfo(request));
      const { field } = RevealRequestSchema.parse(request.body);
      return reply
        .header('cache-control', 'no-store')
        .send(deps.vault.reveal(context, sid, credentialId, field));
    },
  );
}
