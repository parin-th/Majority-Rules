import { randomBytes, randomInt, createHash } from 'node:crypto';
import deckData from './decks.json' with { type: 'json' };
import { COLORS, THEMES } from './config.mjs';

export const DECKS = deckData;
export const MAX_DECKS = 50;
export class GameError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const need = (condition,message,status=400) => {if(!condition) throw new GameError(message,status);};
const tidy = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu,' ') : '';
const normalized = value => tidy(value).toLocaleLowerCase('en-US');
export const fingerprint = q => createHash('sha256').update(JSON.stringify([normalized(q.prompt),...[normalized(q.a),normalized(q.b)].sort()])).digest('hex');
export function validateQuestion(value) {
  need(value && typeof value === 'object','Please enter a question and two choices.');
  const q = {prompt:tidy(value.prompt),a:tidy(value.a),b:tidy(value.b)};
  need(q.prompt.length>=15 && q.prompt.length<=120,'The prompt must be 15–120 characters.');
  need([q.a,q.b].every(v=>v.length>=2&&v.length<=40),'Each choice must be 2–40 characters.');
  need(normalized(q.a)!==normalized(q.b),'The two choices must be different.');
  need(!/[\u0000-\u001f\u007f]/u.test(q.prompt+q.a+q.b),'Please use readable text.');
  return q;
}
export function exportDeck(questions){return 'MR1.'+Buffer.from(JSON.stringify(questions.map(q=>[q.prompt,q.a,q.b])),'utf8').toString('base64url');}
export function importDeck(value){
  need(typeof value==='string'&&value.trim().length<=80000,'That deck code is too large.');
  const code=value.trim();need(/^MR1\.[A-Za-z0-9_-]+$/u.test(code),'Use a valid MR1 deck code.');
  let rows;try{const bytes=Buffer.from(code.slice(4),'base64url');need(bytes.toString('base64url')===code.slice(4),'That deck code is malformed.');rows=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new GameError('That deck code is damaged or invalid.');}
  need(Array.isArray(rows)&&rows.length>=1&&rows.length<=100,'A deck code must contain 1–100 questions.');
  return rows.map(row=>{need(Array.isArray(row)&&row.length===3,'That deck contains an invalid question.');return validateQuestion({prompt:row[0],a:row[1],b:row[2]});});
}
need(DECKS.length>0&&DECKS.length<=MAX_DECKS,'The deck catalog must contain 1–50 decks.');
need(new Set(DECKS.map(d=>d.id)).size===DECKS.length,'Deck identifiers must be unique.');
for(const deck of DECKS){need(deck.questions.length>=20,'Each deck must contain at least 20 questions.');deck.questions.forEach(validateQuestion);}
const shuffle = list => {const result=[...list];for(let i=result.length-1;i>0;i--){const j=randomInt(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;};
export const scoreFor = streak => streak>=4?200:streak===3?150:streak===2?125:100;

export class GameEngine {
  constructor({now=()=>Date.now(),onChange=()=>{}}={}){this.rooms=new Map();this.now=now;this.onChange=onChange;}
  active(room){return [...room.players.values()].filter(p=>p.connected);}
  emit(room){room.updatedAt=this.now();room.revision++;this.onChange(room);}
  get(code){const room=this.rooms.get(tidy(code).toUpperCase());need(room,'Room not found. Check the six-character code.',404);return room;}
  player(room,token){const p=[...room.players.values()].find(p=>p.token===token);need(p,'Your seat has expired. Please join again.',401);return p;}
  host(room,p){need(room.hostId===p.id,'Only the host can do that.',403);}
  lobby(room){need(room.phase==='lobby','This is available in the lobby between games.',409);}
  create({nickname,color}){
    need(this.rooms.size<500,'The party server is full. Try again later.',503);
    let code;do{code=randomBytes(6).reduce((s,n)=>s+'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n%31],'');}while(this.rooms.has(code));
    const room={code,revision:0,createdAt:this.now(),updatedAt:this.now(),hostId:null,phase:'lobby',players:new Map(),settings:{theme:'standard',deck:'general',rounds:5},custom:[],rejected:new Set(),queue:[],ballot:null,history:[],round:null,roundIndex:0,questions:[],matchId:0};
    const p=this.addPlayer(room,{nickname,color});room.hostId=p.id;this.rooms.set(code,room);this.emit(room);return{room,p};
  }
  addPlayer(room,{nickname,color}){
    need(room.players.size<8,'This room already has eight players. The host can release offline seats.',409);
    const name=tidy(nickname);need(name.length>=1&&name.length<=20,'Use a nickname of 1–20 characters.');
    need(!/[\u0000-\u001f\u007f]/u.test(name),'Please use a readable nickname.');
    need(COLORS.some(c=>c.id===color),'Choose an avatar color.');
    need(![...room.players.values()].some(p=>p.color===color),'That color was just taken. Choose another.',409);
    const p={id:randomBytes(9).toString('hex'),token:randomBytes(32).toString('hex'),nickname:name,color,score:0,streak:0,bestStreak:0,connected:true,joinedAt:this.now(),lastSeen:this.now(),offlineAt:null};room.players.set(p.id,p);return p;
  }
  join(code,details){const room=this.get(code);need(['lobby','podium'].includes(room.phase),'This game has started. Join when the group returns to the lobby.',409);const p=this.addPlayer(room,details);this.evaluateBallot(room);this.emit(room);return{room,p};}
  connect(room,p){p.connected=true;p.lastSeen=this.now();p.offlineAt=null;if(!room.hostId||!room.players.get(room.hostId)?.connected)room.hostId=p.id;this.evaluateBallot(room);this.emit(room);}
  disconnect(room,p){if(!room.players.has(p.id)||!p.connected)return;p.connected=false;p.offlineAt=this.now();this.migrateHost(room);this.evaluateBallot(room);this.maybeReveal(room);this.emit(room);}
  migrateHost(room){if(!room.players.get(room.hostId)?.connected)room.hostId=this.active(room)[0]?.id??room.hostId;}
  leave(room,p){room.players.delete(p.id);if(room.hostId===p.id)room.hostId=null;this.migrateHost(room);this.evaluateBallot(room);this.maybeReveal(room);this.emit(room);}
  publicInfo(room){return{code:room.code,phase:room.phase,playerCount:room.players.size,takenColors:[...room.players.values()].map(p=>p.color),joinable:['lobby','podium'].includes(room.phase)&&room.players.size<8};}
  settings(room,p,changes){this.host(room,p);this.lobby(room);need(changes&&typeof changes==='object','Choose valid settings.');const next={...room.settings};if(changes.theme!==undefined){need(THEMES.some(t=>t.id===changes.theme),'Unknown theme.');next.theme=changes.theme;}if(changes.deck!==undefined){need(DECKS.some(d=>d.id===changes.deck),'Unknown deck.');next.deck=changes.deck;}if(changes.rounds!==undefined){need([3,5,10,15,20].includes(changes.rounds),'Choose 3, 5, 10, 15, or 20 rounds.');next.rounds=changes.rounds;}room.settings=next;this.emit(room);}
  known(room,key){return room.custom.some(q=>q.key===key)||room.ballot?.question.key===key||room.queue.some(q=>q.key===key);}
  submit(room,p,value){this.lobby(room);const q=validateQuestion(value);const key=fingerprint(q);need(!room.rejected.has(key),'That question was rejected and is locked for this room session.',409);need(!this.known(room,key),'That question is already in this room.',409);need(room.custom.length+room.queue.length+(room.ballot?1:0)<100,'This room can hold up to 100 custom questions.');room.queue.push({...q,key,id:randomBytes(8).toString('hex'),authorId:p.id,author:p.nickname});this.nextBallot(room);this.emit(room);}
  nextBallot(room){if(room.ballot||!room.queue.length)return;const question=room.queue.shift();room.ballot={id:randomBytes(8).toString('hex'),question,votes:{[question.authorId]:true},deadline:this.now()+20000};this.evaluateBallot(room);}
  evaluateBallot(room){
    const ballot=room.ballot;if(!ballot)return;if(this.now()>=ballot.deadline){this.finishBallot(room,false);return;}
    const active=this.active(room);const threshold=Math.ceil(active.length*2/3);const yes=active.filter(p=>ballot.votes[p.id]===true).length;const no=active.filter(p=>ballot.votes[p.id]===false).length;
    if(active.length&&yes>=threshold)this.finishBallot(room,true);
    else if((active.length&&active.length-no<threshold)||this.now()>=ballot.deadline)this.finishBallot(room,false);
  }
  finishBallot(room,approved){const b=room.ballot;if(!b)return;if(approved)room.custom.push(b.question);else room.rejected.add(b.question.key);room.history.unshift({id:b.id,prompt:b.question.prompt,approved});room.history=room.history.slice(0,8);room.ballot=null;this.nextBallot(room);}
  approve(room,p,{id,approve}){this.lobby(room);need(room.ballot?.id===id,'That ballot has finished.',409);if(this.now()>=room.ballot.deadline){this.finishBallot(room,false);this.emit(room);throw new GameError('That approval ballot has expired.',409);}need(typeof approve==='boolean','Choose approve or pass.');need(p.connected,'Reconnect before voting.');need(room.ballot.votes[p.id]===undefined,'Your approval vote is already locked.',409);room.ballot.votes[p.id]=approve;this.evaluateBallot(room);this.emit(room);}
  import(room,p,code){this.host(room,p);this.lobby(room);const questions=importDeck(code);const additions=[];const seen=new Set();let skipped=0;for(const q of questions){const key=fingerprint(q);if(room.rejected.has(key)||this.known(room,key)||seen.has(key)){skipped++;continue;}seen.add(key);additions.push({...q,key,id:randomBytes(8).toString('hex'),authorId:p.id,author:p.nickname});}need(room.custom.length+room.queue.length+(room.ballot?1:0)+additions.length<=100,'Import would exceed the 100 custom-question limit.');room.queue.push(...additions);this.nextBallot(room);this.emit(room);return{added:additions.length,skipped};}
  start(room,p){this.host(room,p);this.lobby(room);need(this.active(room).length>=2,'At least two connected players are needed to start.');need(!room.ballot&&!room.queue.length,'Finish the custom-question ballots before starting.');const deck=DECKS.find(d=>d.id===room.settings.deck);const seen=new Set();room.questions=[...shuffle(room.custom),...shuffle(deck.questions)].filter(q=>{const key=fingerprint(q);if(seen.has(key))return false;seen.add(key);return true;}).slice(0,room.settings.rounds);need(room.questions.length>=room.settings.rounds,'There are not enough distinct questions.');for(const player of room.players.values()){player.score=0;player.streak=0;player.bestStreak=0;}room.roundIndex=0;room.matchId++;this.startRound(room);this.emit(room);}
  startRound(room){room.roundIndex++;const index=room.roundIndex;const blitz=index%4===0;room.phase='voting';room.round={id:randomBytes(9).toString('hex'),question:room.questions[index-1],blitz,multiplier:index%5===0?2:1,duration:blitz?8000:20000,deadline:this.now()+(blitz?8000:20000),eligible:this.active(room).map(p=>p.id),votes:{},result:null};}
  vote(room,p,{id,choice}){need(room.phase==='voting'&&room.round?.id===id,'This round has already closed.',409);if(this.now()>=room.round.deadline){this.reveal(room);this.emit(room);throw new GameError('Time is up. Your vote did not arrive in time.',409);}need(room.round.eligible.includes(p.id)&&p.connected,'You can vote in the next round.',403);need(choice==='a'||choice==='b','Choose A or B.');need(!room.round.votes[p.id],'Your vote is already locked.',409);room.round.votes[p.id]=choice;this.maybeReveal(room);this.emit(room);}
  maybeReveal(room){if(room.phase!=='voting')return;const active=this.active(room).filter(p=>room.round.eligible.includes(p.id));if(active.length&&active.every(p=>room.round.votes[p.id]))this.reveal(room);}
  reveal(room){
    if(room.phase!=='voting')return;const round=room.round;
    const counts={a:0,b:0};Object.values(round.votes).forEach(v=>counts[v]++);const winner=counts.a===counts.b?null:counts.a>counts.b?'a':'b';const awards={};
    for(const p of room.players.values()){const win=winner&&round.votes[p.id]===winner;p.streak=win?p.streak+1:0;p.bestStreak=Math.max(p.bestStreak,p.streak);const points=win?scoreFor(p.streak)*round.multiplier:0;p.score+=points;awards[p.id]=points;}
    round.result={counts,winner,awards,total:counts.a+counts.b};room.phase='reveal';
  }
  next(room,p){this.host(room,p);need(room.phase==='reveal','Wait until the round is revealed.',409);if(room.roundIndex>=room.settings.rounds)room.phase='podium';else{need(this.active(room).length>=2,'Wait for at least two players to reconnect.');this.startRound(room);}this.emit(room);}
  replay(room,p){this.host(room,p);need(room.phase==='podium','Finish the game before playing again.',409);room.phase='lobby';room.round=null;room.roundIndex=0;room.questions=[];for(const player of room.players.values()){player.score=0;player.streak=0;player.bestStreak=0;}this.emit(room);}
  action(room,p,action,data={}){p.lastSeen=this.now();switch(action){case'settings':return this.settings(room,p,data);case'submit':return this.submit(room,p,data);case'approve':return this.approve(room,p,data);case'import':return this.import(room,p,data.code);case'export':return{code:exportDeck(room.custom)};case'start':return this.start(room,p);case'vote':return this.vote(room,p,data);case'next':return this.next(room,p);case'replay':return this.replay(room,p);case'leave':return this.leave(room,p);case'remove':{this.host(room,p);need(['lobby','podium'].includes(room.phase),'Release seats between games.');const target=room.players.get(data.id);need(target&&!target.connected,'Only offline seats can be released.');return this.leave(room,target);}default:throw new GameError('Unknown action.',404);}}
  snapshot(room,viewer){
    const active=this.active(room);const round=room.round;const revealed=room.phase==='reveal'||room.phase==='podium';const ballot=room.ballot;
    return {code:room.code,revision:room.revision,phase:room.phase,hostId:room.hostId,you:viewer.id,settings:room.settings,serverNow:this.now(),roundIndex:room.roundIndex,matchId:room.matchId,
      players:[...room.players.values()].map(p=>({id:p.id,nickname:p.nickname,color:p.color,score:p.score,streak:p.streak,bestStreak:p.bestStreak,connected:p.connected,hasVoted:!!round?.votes[p.id]})),
      custom:room.custom.map(({id,prompt,a,b,author})=>({id,prompt,a,b,author})),queuedCount:room.queue.length,history:room.history,
      ballot:ballot?{id:ballot.id,question:{prompt:ballot.question.prompt,a:ballot.question.a,b:ballot.question.b,author:ballot.question.author},deadline:ballot.deadline,required:Math.ceil(active.length*2/3),activeCount:active.length,yes:active.filter(p=>ballot.votes[p.id]===true).length,no:active.filter(p=>ballot.votes[p.id]===false).length,myVote:ballot.votes[viewer.id]??null}:null,
      round:round?{id:round.id,question:{prompt:round.question.prompt,a:round.question.a,b:round.question.b,custom:!!round.question.author},blitz:round.blitz,multiplier:round.multiplier,duration:round.duration,deadline:round.deadline,myVote:round.votes[viewer.id]??null,eligible:round.eligible.includes(viewer.id),votedCount:Object.keys(round.votes).length,activeCount:active.filter(p=>round.eligible.includes(p.id)).length,...(revealed?{votes:round.votes,result:round.result}:{})}:null};
  }
  tick(){for(const room of this.rooms.values()){let changed=false;if(room.phase==='voting'&&this.now()>=room.round.deadline){this.reveal(room);changed=true;}if(room.ballot&&this.now()>=room.ballot.deadline){this.evaluateBallot(room);changed=true;}if(changed)this.emit(room);if(!this.active(room).length&&this.now()-room.updatedAt>6*60*60*1000)this.rooms.delete(room.code);}}
}
