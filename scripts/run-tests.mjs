import { loadEnvFile } from 'node:process';
try { loadEnvFile('.env.local'); } catch {}
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prepareBrowser } from './prepare-browser.mjs';
const require=createRequire(import.meta.url);
const env={
 ...process.env,
 // This runner alone opts its disposable local browser suite into the guarded
 // synthetic evidence provider. The app remains disabled by default.
 PONTE_LOCAL_EVIDENCE_TEST_PROVIDER:'1',
 PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS:process.env.PONTE_LOCAL_EVIDENCE_TEST_REGISTRY_ADDRESS??'0x1111111111111111111111111111111111111111',
};
if(env.PONTE_BROWSER_FALLBACK==='1') {
 const browser=await prepareBrowser();
 env.PONTE_CHROMIUM_EXECUTABLE=browser.executablePath;
 env.LD_LIBRARY_PATH=[browser.libraryPath,env.LD_LIBRARY_PATH].filter(Boolean).join(':');
 console.log('Using explicit Linux fallback:',browser.executablePath);
}
// Spawn Node directly: no Unix shell syntax, .cmd lookup or Windows quoting dependency.
const result=spawnSync(process.execPath,[require.resolve('@playwright/test/cli'),'test',...process.argv.slice(2)],{stdio:'inherit',env});
if(result.error)throw result.error;
process.exit(result.status??1);
