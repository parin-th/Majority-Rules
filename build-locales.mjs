import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const source=await read('./decks.json');
const english=await read('./locales/ui-en.json');
const errors=await read('./locales/errors.json');
const catalog={en:{ui:english}};
const placeholders=value=>[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
for(const lang of ['es','fr']){
  const ui=await read(`./locales/ui-${lang}.json`);
  assert.deepEqual(Object.keys(ui).sort(),Object.keys(english).sort(),`${lang}: all UI keys required`);
  for(const key of Object.keys(english))assert.deepEqual(placeholders(ui[key]),placeholders(english[key]),`${lang}/${key}: preserve placeholders`);
  const decks=await read(`./locales/decks.${lang}.json`);
  assert.equal(decks.length,source.length);
  const localized={ui,decks:{},questions:{},errors:{}};
  for(const deck of source){
    const translated=decks.find(d=>d.id===deck.id);assert.ok(translated,`${lang}: missing deck ${deck.id}`);
    assert.equal(translated.questions.length,deck.questions.length);
    localized.decks[deck.id]={title:translated.title,description:translated.description};
    for(const question of deck.questions){
      const q=translated.questions.find(q=>q.id===question.id);assert.ok(q,`${lang}: missing question ${question.id}`);
      assert.ok(q.prompt.length>=15&&q.prompt.length<=120,`${lang}/${q.id}: prompt length`);
      assert.ok([q.a,q.b].every(v=>v.length>=2&&v.length<=40),`${lang}/${q.id}: choice length`);
      assert.notEqual(q.a.toLocaleLowerCase(),q.b.toLocaleLowerCase());
      localized.questions[question.prompt]={prompt:q.prompt,a:q.a,b:q.b,sourceA:question.a,sourceB:question.b};
    }
  }
  for(const [message,translations] of Object.entries(errors)){assert.ok(translations[lang],`Missing ${lang} error translation`);localized.errors[message]=translations[lang];}
  catalog[lang]=localized;
}
const moduleText=(await readFile(new URL('./i18n.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
const client=await readFile(new URL('./client.mjs',import.meta.url),'utf8');
assert.ok(client.includes('/* @i18n-module */')&&client.includes('/* @i18n-data */'));
const bundle=client.replace('/* @i18n-module */',moduleText).replace('/* @i18n-data */',()=>`const LOCALIZATION = ${JSON.stringify(catalog)};`);
await writeFile(new URL('./public/app.js',import.meta.url),bundle,'utf8');
console.log('Built English, Spanish and French: '+Object.keys(english).length+' UI messages and 100 questions per language.');
