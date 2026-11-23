import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bundle from '../desktop/vpn-bundle.cjs';
import access from '../desktop/access-check.cjs';
import record from '../desktop/access-config.cjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
const password = process.env.API_SWITCHBOARD_BUNDLE_PASSWORD;
try {
  if (!source || !password) throw new Error();
  if (!(await access.createPasswordCheck(record)(password)).ok) throw new Error();
  const broker = path.join(root, 'artifacts/broker/Switchboard.Vpn.exe');
  const env = { ...process.env };
  delete env.API_SWITCHBOARD_BUNDLE_PASSWORD;
  execFileSync(broker, ['--validate-data', path.resolve(source)], { env, windowsHide: true, stdio: 'ignore', timeout: 20000 });
  const output = path.join(root, 'artifacts/distribution/bootstrap.enc');
  const result = await bundle.packBundle({ source, output, password });
  console.log('Encrypted VPN distribution created (' + result.files + ' allowed files).');
} catch {
  console.error('Could not build the VPN resource. Check the source directory, broker and supplied password.');
  process.exitCode = 1;
}
