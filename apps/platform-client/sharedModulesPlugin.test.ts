import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sharedModulesPlugin } from './sharedModulesPlugin.ts';

test('catalogs public JavaScript style exports without cataloging CSS or PWA internals', async () => {
  const plugin = sharedModulesPlugin();
  const load = plugin.load;
  assert.equal(typeof load, 'function');
  const source = await load?.('\0platform-shared-modules');
  assert.equal(typeof source, 'string');
  assert.match(source, /@board-platform\/client\/styles\/zIndex\.js/);
  assert.doesNotMatch(source, /@board-platform\/client\/styles\/globals\.css/);
  assert.doesNotMatch(source, /@board-platform\/client\/pwa\/registerPwa\.js/);
});
