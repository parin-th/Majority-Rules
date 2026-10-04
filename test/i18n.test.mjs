import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SUPPORTED_LANGUAGES,chooseLanguage,translate,localizeQuestion,localizeDeck,translateError} from '../i18n.mjs';
import {GameEngine,DECKS} from '../engine.mjs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const catalog=JSON.parse(source.match(/^const LOCALIZATION = (.+);$/m)[1]);
const read=name=>JSON.parse(readFileSync(new URL('../locales/'+name,import.meta.url),'utf8'));
test('language selection honors explicit links, saved preference, browser language, and English fallback',()=>{
  assert.deepEqual(SUPPORTED_LANGUAGES,['en','es','fr']);
  assert.equal(chooseLanguage('fr','es',['en-US']),'fr');assert.equal(chooseLanguage(null,'es',['fr-FR']),'es');
  assert.equal(chooseLanguage(null,null,['pt-BR','es-MX']),'es');assert.equal(chooseLanguage('invalid',null,['fr-CA']),'fr');
  assert.equal(chooseLanguage('<script>',null,['de-DE']),'en');
});
test('all translated UI messages retain all placeholders and cover every static client key',()=>{
  const placeholders=value=>[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
  for(const lang of SUPPORTED_LANGUAGES){assert.equal(Object.keys(catalog[lang].ui).length,252);assert.deepEqual(Object.keys(catalog[lang].ui).sort(),Object.keys(catalog.en.ui).sort());for(const [key,value] of Object.entries(catalog.en.ui))assert.deepEqual(placeholders(catalog[lang].ui[key]),placeholders(value),lang+'/'+key);}
  const client=readFileSync(new URL('../client.mjs',import.meta.url),'utf8');
  for(const [,key] of client.matchAll(/\b[ht]\('([^']+)'\s*[,)]/g))assert.ok(Object.hasOwn(catalog.en.ui,key),'Missing UI key: '+key);
});
test('all 100 dilemmas and five deck names have Spanish and French translations with identical A/B order',()=>{
  for(const lang of ['es','fr']){const translated=read('decks.'+lang+'.json');assert.equal(Object.keys(catalog[lang].questions).length,100);for(const deck of DECKS){const localizedDeck=translated.find(d=>d.id===deck.id);assert.equal(localizeDeck(catalog,lang,deck).title,localizedDeck.title);for(const q of deck.questions){const expected=localizedDeck.questions.find(candidate=>candidate.id===q.id);const actual=localizeQuestion(catalog,lang,q);assert.equal(actual.prompt,expected.prompt);assert.equal(actual.a,expected.a);assert.equal(actual.b,expected.b);assert.equal(actual.id,q.id);assert.ok(actual.prompt.length>=15&&actual.prompt.length<=120);assert.ok([actual.a,actual.b].every(s=>s.length>=2&&s.length<=40));assert.notEqual(actual.prompt,q.prompt);}}}
});
test('custom questions and unrecognized future decks are never automatically translated',()=>{
  const builtin=DECKS[0].questions[0];const custom={...builtin,custom:true};assert.equal(localizeQuestion(catalog,'es',custom),custom);
  const unknown={prompt:'Una pregunta original de la sala',a:'Primera opción',b:'Deuxième choix'};assert.equal(localizeQuestion(catalog,'fr',unknown),unknown);
  const changed={...builtin,a:'A different custom choice'};assert.equal(localizeQuestion(catalog,'es',changed),changed);
  assert.equal(localizeQuestion(catalog,'en',builtin),builtin);assert.equal(localizeQuestion(catalog,'fr',null),null);
  const deck={id:'future-deck',title:'Future',description:'New content'};assert.deepEqual(localizeDeck(catalog,'es',deck),deck);
});
test('server validation messages and connection failures are translated',()=>{
  for(const lang of ['es','fr']){assert.equal(Object.keys(catalog[lang].errors).length,Object.keys(read('errors.json')).length);for(const [message,result] of Object.entries(catalog[lang].errors)){assert.ok(result);assert.notEqual(result,message);assert.equal(translateError(catalog,lang,message),result);}assert.equal(translateError(catalog,lang,'Failed to fetch'),translate(catalog,lang,'connectionError'));}
});
test('changing a player’s display language cannot mutate the question, vote, timer, score, or theme',()=>{
  const e=new GameEngine();const {room,p}=e.create({nickname:'Español',color:'lime'});const fr=e.join(room.code,{nickname:'Français',color:'violet'}).p;const en=e.join(room.code,{nickname:'English',color:'coral'}).p;
  e.start(room,p);const original=JSON.stringify(room.round.question),id=room.round.id,deadline=room.round.deadline;
  e.vote(room,p,{id,choice:'a'});const esView=e.snapshot(room,p);for(const language of ['es','fr','en']){const q=localizeQuestion(catalog,language,esView.round.question);assert.equal(q.custom,false);assert.equal(esView.round.myVote,'a');assert.equal(room.round.deadline,deadline);assert.equal(room.round.id,id);assert.equal(room.settings.theme,'standard');assert.equal(p.score,0);}
  e.vote(room,fr,{id,choice:'a'});e.vote(room,en,{id,choice:'b'});assert.equal(room.phase,'reveal');assert.equal(p.score,100);assert.equal(fr.score,100);assert.equal(en.score,0);assert.equal(JSON.stringify(room.round.question),original);
});
test('translated parameters keep accents and user strings as literal data',()=>{
  assert.equal(translate(catalog,'fr','champion',{name:'José <b>'}),catalog.fr.ui.champion.replace('{name}','José <b>'));
  assert.ok(translate(catalog,'es','roomFound',{count:3}).includes('3/8'));assert.equal(translate(catalog,'en','unregistered-key'),'unregistered-key');
});
