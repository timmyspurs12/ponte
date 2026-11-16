// Registry-only Chromium fallback for restricted development environments.
import chromium from '@sparticuz/chromium';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
fs.mkdirSync('.cache/chromium-libs',{recursive:true});
fs.writeFileSync('.cache/chromium-libs/libs.tar',zlib.brotliDecompressSync(fs.readFileSync('node_modules/@sparticuz/chromium/bin/al2023.tar.br')));
execFileSync('tar',['xf','.cache/chromium-libs/libs.tar','-C','.cache/chromium-libs']);
console.log('Chromium prepared:',await chromium.executablePath());
