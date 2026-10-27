import { showBootstrapFailure } from '@board-platform/client/lib/bootstrapFailure.js';
import { installCrashReporting } from '@board-platform/client/lib/crashReporter.js';
import { installStaleChunkRecovery } from '@board-platform/client/lib/staleChunkRecovery.js';
import './globals.css';

installCrashReporting();
installStaleChunkRecovery();
void import('./main')
  .then(({ startApp }) => startApp())
  .catch(showBootstrapFailure);
