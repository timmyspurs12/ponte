// Explicit Linux x64 fallback only. Standard Playwright is the default everywhere.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
export async function prepareBrowser() {
  if(process.platform !== 'linux' || process.arch !== 'x64') throw new Error('PONTE_BROWSER_FALLBACK is only supported on Linux x64. Use npm run test:install on Windows/macOS.');
  const {default:chromium}=await import('@sparticuz/chromium');
  const directory=path.resolve('.cache/chromium-libs');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'libs.tar'),zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));
  execFileSync('tar',['xf',path.join(directory,'libs.tar'),'-C',directory]);
  return {executablePath:await chromium.executablePath(),libraryPath:path.join(directory,'lib')};
}
