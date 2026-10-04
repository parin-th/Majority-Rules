import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const source=await readFile(new URL('../client.mjs',import.meta.url),'utf8');
const networkSource=source.slice(source.indexOf("const GAME_ENDPOINT="),source.indexOf('function saveAuth('));
const createRequest=fetch=>new Function('fetch','crypto',networkSource+';return request;')(fetch,webcrypto);

test('frontend calls the default function endpoint and retries the same mutation ID',async()=>{
  const calls=[];
  const request=createRequest(async(url,options)=>{
    calls.push({url,options});
    if(calls.length===1)throw new TypeError('Network error');
    return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});
  });
  assert.deepEqual(await request('action',{room:'ABC123',action:'vote',data:{choice:'a'}},'secret-token'),{ok:true});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'/.netlify/functions/game');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,'Bearer secret-token');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.body,calls[1].options.body);
  const first=JSON.parse(calls[0].options.body);
  assert.ok(first.requestId.length>=32);
  await request('action',{room:'ABC123',action:'vote',data:{choice:'a'}},'secret-token');
  assert.notEqual(JSON.parse(calls[2].options.body).requestId,first.requestId);
});

test('authorization errors are not retried',async()=>{
  let count=0;
  const request=createRequest(async()=>{count++;return new Response(JSON.stringify({error:'Seat expired'}),{status:401});});
  await assert.rejects(request('poll',{room:'ABC123'},'expired'),{status:401,message:'Seat expired'});
  assert.equal(count,1);
});

test('aborting a session cancels polling without a retry',async()=>{
  let count=0;
  const request=createRequest(async(url,{signal})=>{
    count++;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));
  });
  const controller=new AbortController();
  const pending=request('poll',{room:'ABC123'},'seat',controller.signal);
  controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(count,1);
});

test('room revisions prevent stale and unnecessary redraws',()=>{
  const body={dataset:{}};
  const fragment=source.slice(source.indexOf('function setState('),source.indexOf('function connect('));
  const make=new Function('document',`
    let renders=0,timers=0,clockOffset=0;
    let state={code:'ABC123',revision:4,phase:'lobby',history:[],settings:{theme:'winter'}};
    function render(){renders++;} function updateTimers(){timers++;}
    ${fragment}
    return {setState,get:()=>({state,renders,timers,clockOffset})};
  `);
  const client=make({body});
  const snapshot={code:'ABC123',revision:4,phase:'lobby',history:[],settings:{theme:'winter'},serverNow:Date.now()};
  client.setState(snapshot);
  assert.equal(client.get().renders,0);
  assert.equal(client.get().timers,1);
  client.setState({...snapshot,revision:3,settings:{theme:'standard'}});
  assert.equal(client.get().state.settings.theme,'winter');
  client.setState({...snapshot,revision:5});
  assert.equal(client.get().renders,1);
});
