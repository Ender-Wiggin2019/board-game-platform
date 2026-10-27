import type { ECapability } from '@board-platform/contracts/auth/permissions';
import { SetMetadata } from '@nestjs/common';

export const CAPABILITIES_KEY = 'capabilities';

/** Restrict a controller/route to users whose role has all capabilities. */
export const Capabilities = (...capabilities: ECapability[]) =>
  SetMetadata(CAPABILITIES_KEY, capabilities);
