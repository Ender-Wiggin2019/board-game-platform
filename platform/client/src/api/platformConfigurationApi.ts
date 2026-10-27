import {
  DEFAULT_PLATFORM_CONFIGURATION,
  type PlatformPublicConfiguration,
  parsePlatformConfiguration,
} from '../providers/PlatformConfiguration.js';
import { httpClient } from './httpClient.js';

export async function loadPlatformConfiguration(): Promise<PlatformPublicConfiguration> {
  try {
    const response = await httpClient.get<unknown>('/platform/config', {
      showServerUpdateDialog: false,
    });
    return parsePlatformConfiguration(response.data);
  } catch {
    return DEFAULT_PLATFORM_CONFIGURATION;
  }
}
