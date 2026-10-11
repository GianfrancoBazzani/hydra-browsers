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
