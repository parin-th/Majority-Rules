import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {zipFunctions} from '@netlify/zip-it-and-ship-it';

const root = new URL('../', import.meta.url);
const output = new URL('artifacts/functions/', root);
await mkdir(output, {recursive:true});
const functions = await zipFunctions(
  fileURLToPath(new URL('netlify/functions/', root)),
  fileURLToPath(output),
  {config:{'*':{nodeBundler:'esbuild', nodeVersion:'22'}}, archiveFormat:'zip', basePath:fileURLToPath(root)}
);
if (functions.length !== 1 || functions[0].name !== 'game' || functions[0].runtimeAPIVersion !== 2) {
  throw new Error('Expected exactly one standard v2 Netlify Function named game.');
}
await writeFile(new URL('verification.json', output), JSON.stringify(functions.map(({name,runtime,runtimeAPIVersion,nodeVersion})=>({name,runtime,runtimeAPIVersion,nodeVersion})),null,2)+'\n');
console.log('Packaged game.zip with the official Netlify function bundler (API version 2).');
