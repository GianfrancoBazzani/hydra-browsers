import { randomBytes } from 'node:crypto';
import { expect, test as setup } from '@playwright/test';
import { deleteLeftoverSessions, HydraApi } from '../src/api.js';
import { checkCluster, createAdminWithCli } from '../src/cluster.js';
import { E2E } from '../src/env.js';
import { ensureAuthDir, STATE_FILES, writeRunState, type RunUser } from '../src/run-state.js';

/** 24 characters: inside the 12 to 128 rule, not a common password, not the email (spec section 6.3). */
function newPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function readyzStatus(): Promise<number> {
  try {
    return (await fetch(`${E2E.publicUrl}/readyz`)).status;
  } catch {
    return 0;
  }
}

/** An admin creates a member, who logs in with the one-time password and sets a new password. */
async function createMember(
  admin: HydraApi,
  role: 'viewer' | 'outsider',
  runId: string,
): Promise<RunUser> {
  const email = `e2e-${role}-${runId}@hydra.test`;
  const displayName = `E2E ${role}`;
  const created = await admin.createMember(email, displayName);
  const api = await HydraApi.login(email, created.oneTimePassword);
  try {
    expect((await api.me()).mustChangePassword).toBe(true);
    const password = newPassword();
    await api.changePassword(created.oneTimePassword, password);
    expect((await api.me()).mustChangePassword).toBe(false);
    await api.saveState(STATE_FILES[role]);
    return { id: created.user.id, email, password, displayName };
  } finally {
    await api.dispose();
  }
}

setup('cluster, first admin from the CLI, and test users', async () => {
  setup.setTimeout(20 * 60_000);
  ensureAuthDir();
  await checkCluster();
  // Through Traefik: the route works, and the gateway reaches its DB and the Kubernetes API.
  await expect.poll(readyzStatus, { timeout: 120_000, intervals: [2_000] }).toBe(200);

  const runId = Date.now().toString(36);
  // Main flow step 1 (spec section 15.3): create an admin with the CLI, then log in.
  const adminEmail = `e2e-admin-${runId}@hydra.test`;
  const adminPassword = newPassword();
  await createAdminWithCli(adminEmail, adminPassword);
  const admin = await HydraApi.login(adminEmail, adminPassword);
  try {
    const me = await admin.me();
    expect(me).toMatchObject({ email: adminEmail, role: 'admin', mustChangePassword: false });
    await admin.saveState(STATE_FILES.admin);

    // Free the capacity: earlier runs can leave sessions behind.
    await deleteLeftoverSessions(admin);

    const viewer = await createMember(admin, 'viewer', runId);
    const outsider = await createMember(admin, 'outsider', runId);
    writeRunState({
      runId,
      admin: { id: me.id, email: adminEmail, password: adminPassword, displayName: me.displayName },
      viewer,
      outsider,
    });
  } finally {
    await admin.dispose();
  }
});
