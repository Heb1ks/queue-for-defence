import test from 'node:test';
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workRoot = join(root, 'work', 'build-tests');
const publicSettings = { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_example' };

async function withBuild(settings, extraEnv, callback) {
  await mkdir(workRoot, { recursive: true });
  const folder = await mkdtemp(join(workRoot, 'case-'));
  try {
    for (const item of ['scripts', 'src', 'vendor']) await mkdir(join(folder, item));
    await copyFile(join(root, 'scripts', 'build.mjs'), join(folder, 'scripts', 'build.mjs'));
    await writeFile(join(folder, 'package.json'), '{"type":"module"}');
    await writeFile(join(folder, 'config.js'), `export default ${JSON.stringify(settings)};`);
    await writeFile(join(folder, 'index.html'), '<script type="module" src="./src/app.js"></script>');
    await writeFile(join(folder, 'styles.css'), ':root{color:green}');
    await writeFile(join(folder, 'src', 'app.js'), 'export const app = true;');
    await writeFile(join(folder, 'vendor', 'library.js'), '// fixture');
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
      cwd: folder, encoding: 'utf8', env: { ...process.env, SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ...extraEnv },
    });
    await callback({ folder, result });
  } finally {
    // Generated scratch directories must remain under this workspace before recursive cleanup.
    if (!resolve(folder).startsWith(resolve(workRoot) + sep)) throw new Error('Unsafe test cleanup path');
    await rm(folder, { recursive: true, force: true });
  }
}

test('Pages build preserves project-relative assets and emits only allowed public config fields', async () => {
  await withBuild({ ...publicSettings, appName: 'Порядок', groupCode: 'SE-2421', timezone: 'Asia/Qyzylorda',
    unrelatedPrivateValue: 'DO_NOT_PUBLISH_THIS' }, {}, async ({ folder, result }) => {
    assert.equal(result.status, 0, result.stderr);
    const configSource = await readFile(join(folder, 'dist', 'config.js'), 'utf8');
    assert.doesNotMatch(configSource, /DO_NOT_PUBLISH|unrelatedPrivateValue/);
    const published = (await import(pathToFileURL(join(folder, 'dist', 'config.js')))).default;
    assert.equal(published.supabasePublishableKey, publicSettings.supabasePublishableKey);
    assert.deepEqual(Object.keys(published).sort(), ['appName', 'groupCode', 'supabasePublishableKey', 'supabaseUrl', 'timezone']);
    assert.match(await readFile(join(folder, 'dist', 'index.html'), 'utf8'), /src="\.\/src\/app\.js"/);
    await access(join(folder, 'dist', 'src', 'app.js'));
    await access(join(folder, 'dist', 'vendor', 'library.js'));
    await access(join(folder, 'dist', '.nojekyll'));
  });
});

test('manual config secret keys and legacy service_role keys fail before files are published', async () => {
  const serviceRole = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`;
  for (const key of ['sb_secret_example', serviceRole]) {
    await withBuild({ ...publicSettings, supabasePublishableKey: key }, {}, async ({ folder, result }) => {
      assert.notEqual(result.status, 0);
      await assert.rejects(access(join(folder, 'dist', 'config.js')));
    });
  }
});

test('environment overrides are validated and legacy public anon keys remain supported', async () => {
  await withBuild(publicSettings, { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_example' }, async ({ result }) => {
    assert.notEqual(result.status, 0);
  });
  const anonKey = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.signature`;
  await withBuild(publicSettings, { SUPABASE_PUBLISHABLE_KEY: anonKey }, async ({ folder, result }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readFile(join(folder, 'dist', 'config.js'), 'utf8')).includes(anonKey));
  });
});

test('fully unconfigured demo builds, while a partial live configuration fails', async () => {
  await withBuild({}, {}, async ({ result }) => assert.equal(result.status, 0, result.stderr));
  await withBuild({ supabaseUrl: publicSettings.supabaseUrl }, {}, async ({ result }) => assert.notEqual(result.status, 0));
});
