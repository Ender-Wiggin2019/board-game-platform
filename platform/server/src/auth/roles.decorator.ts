import type { ERole } from '@board-platform/contracts/auth/roles';
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Restrict a controller/route to the listed roles (checked by RolesGuard). */
export const Roles = (...roles: ERole[]) => SetMetadata(ROLES_KEY, roles);
