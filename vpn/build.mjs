import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = process.argv.includes('--fixture');
const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.env.API_SWITCHBOARD_DOTNET || (process.env.USERPROFILE &&
  path.join(process.env.USERPROFILE, '.cache', 'campus-link-sdk', 'sdk', 'dotnet.exe'));
const dotnet = process.env.API_SWITCHBOARD_DOTNET || (sdk && existsSync(sdk) ? sdk : 'dotnet');
const args = ['Switchboard.Vpn.csproj', '-c', 'Release', '-r', 'win-x64',
  '-p:VpnFixtures=' + fixture, '-o', path.join(root, 'artifacts', fixture ? 'fixture' : 'broker')];
const result = spawnSync(dotnet, fixture ? ['build', ...args] : ['publish', ...args,
  '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:DebugType=None'],
{ cwd: root, stdio: 'inherit' });
if (result.error) console.error('Could not start the .NET 8 SDK:', result.error.message);
process.exitCode = result.status ?? 1;
