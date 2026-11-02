import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = join(root, 'dist');
const defaults = (await import(new URL('../config.js', import.meta.url))).default || {};
// Always select and validate public settings, including values edited in config.js.
// Never copy the source file verbatim: unrelated values must not reach Pages.
const settings = {
  supabaseUrl: String(process.env.SUPABASE_URL || defaults.supabaseUrl || '').trim(),
  supabasePublishableKey: String(process.env.SUPABASE_PUBLISHABLE_KEY || defaults.supabasePublishableKey || '').trim(),
  groupCode: String(defaults.groupCode || 'SE-2421'),
  timezone: String(defaults.timezone || 'Asia/Qyzylorda'),
  appName: String(defaults.appName || 'Порядок'),
};
if (settings.supabaseUrl || settings.supabasePublishableKey) {
  const key = settings.supabasePublishableKey;
  if (key.startsWith('sb_secret_')) throw new Error('Use the publishable key, never a secret key.');
  if (key.startsWith('sb_publishable_') && key.length > 'sb_publishable_'.length) {
    // Public key format used by current Supabase projects.
  } else if (key.split('.').length === 3) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); }
    catch { throw new Error('Invalid legacy anon key.'); }
    if (claims.role !== 'anon') throw new Error('Only a public anon key may be included in the browser.');
  } else {
    throw new Error('Set a valid public SUPABASE_PUBLISHABLE_KEY.');
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(settings.supabaseUrl)) {
    throw new Error('SUPABASE_URL must be the HTTPS URL of your Supabase project.');
  }
}
const source = `// Public settings generated during the Pages build.\nexport default Object.freeze(${JSON.stringify(settings, null, 2)});\n`;
await mkdir(destination, { recursive: true });
for (const item of ['index.html', 'styles.css', 'src', 'vendor']) {
  await cp(join(root, item), join(destination, item), { recursive: true });
}
await writeFile(join(destination, 'config.js'), source);
await writeFile(join(destination, '.nojekyll'), '');
console.log('Static site ready in dist/.');
