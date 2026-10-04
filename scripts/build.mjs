import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import '../build-locales.mjs';

const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/', root), {recursive:true});
for (const name of ['index.html','style.css','favicon.svg']) {
  await cp(new URL('public/'+name, root), new URL('dist/'+name, root));
}
const compiled = await transform(await readFile(new URL('public/app.js', root), 'utf8'), {
  minify:true, target:['es2022'], format:'esm', legalComments:'none'
});
await writeFile(new URL('dist/app.js', root), compiled.code);
const source = await readFile(new URL('client.mjs', root), 'utf8');
if (!source.includes('/.netlify/functions/game') || source.includes('EventSource') || source.includes('/api/')) {
  throw new Error('The frontend must call the standard Netlify Function endpoint directly.');
}
await writeFile(new URL('dist/robots.txt', root), 'User-agent: *\nAllow: /\n');
console.log('Production frontend built into dist/; English, Spanish and French included.');
