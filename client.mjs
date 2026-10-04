// Source for public/app.js. Run node build-locales.mjs after changing translations or this file.
/* @i18n-module */
/* @i18n-data */
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let savedLanguage;try{savedLanguage=localStorage.getItem('majority-language');}catch{}
let language=chooseLanguage(new URLSearchParams(location.search).get('lang'),savedLanguage,navigator.languages||[navigator.language]);
const t=(key,values)=>translate(LOCALIZATION,language,key,values);
const h=(key,values)=>escape(t(key,values));
const errorText=error=>translateError(LOCALIZATION,language,typeof error==='string'?error:error?.message);
const translatedQuestion=q=>localizeQuestion(LOCALIZATION,language,q);
const translatedDeck=d=>localizeDeck(LOCALIZATION,language,d);
let config,state=null,auth=null,stream=null,connected=false,clockOffset=0,entryMode='create',entryColor='lime',entryName='',entryCode=new URLSearchParams(location.search).get('room')?.toUpperCase()||'',taken=[],entryError='',lookupTimer,lookupRevision=0,busy=false,currentModal=null;
if(entryCode)entryMode='join';
const app=$('#app');
const me=()=>state?.players.find(p=>p.id===state.you);
const host=()=>state?.hostId===state?.you;
const color=id=>config.colors.find(c=>c.id===id)||config.colors[0];
const active=()=>state.players.filter(p=>p.connected);
const languageOptions=()=>[['en','English'],['es','Español'],['fr','Français']].map(([id,label])=>`<option value="${id}" ${language===id?'selected':''}>${label}</option>`).join('');
function chrome(){
  document.documentElement.lang=language;document.title=t('pageTitle');
  $('meta[name="description"]').content=t('pageDescription');
  $('.wordmark').setAttribute('aria-label',t('homeLink'));$('.edition').textContent=t('edition');
  $('.header-right .small-pill').textContent=t('playersBadge');$('#rules-open').textContent=t('howToPlay');
  $('#language-label').textContent=t('language');$('#language-select').innerHTML=languageOptions();
  $('footer>span:first-child').textContent=t('footer');
  $('#footer-status').textContent=state?`${t(connected?'connected':'reconnecting')} · ${state.code}`:t('everyDevice');
}
function updateURL(room){const url=new URL(location.href);if(room)url.searchParams.set('room',room);else url.searchParams.delete('room');url.searchParams.set('lang',language);history.replaceState({},'',url.pathname+url.search);}
function changeLanguage(value){
  if(!SUPPORTED_LANGUAGES.includes(value)||value===language)return;
  const fields=[...document.querySelectorAll('#modal input:not([readonly]),#modal textarea:not([readonly])')].map(el=>({id:el.id,value:el.value}));
  const wasOpen=$('#modal').open,modalScroll=$('#modal').scrollTop;
  language=value;try{localStorage.setItem('majority-language',value);}catch{}
  updateURL(state?.code||entryCode);render();
  if(wasOpen&&currentModal){showModal(currentModal.kind,currentModal.data);for(const field of fields){const el=document.getElementById(field.id);if(el)el.value=field.value;}$('#modal').scrollTop=modalScroll;}
  $('#toasts').replaceChildren();
}
function avatar(p,extra=''){const c=color(p.color);return `<span class="avatar ${extra}" style="--avatar:${c.hex};--ink:${c.ink}" title="${escape(p.nickname)}" aria-label="${escape(p.nickname)}">${escape(Array.from(p.nickname)[0]?.toUpperCase()||'?')}</span>`;}
function toast(message){const node=document.createElement('div');node.className='toast';node.textContent=message;$('#toasts').append(node);setTimeout(()=>node.remove(),4500);}
const GAME_ENDPOINT='/.netlify/functions/game';
const pendingActions=new Set();
function requestId(){
  if(crypto.randomUUID)return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
}
async function request(op,data={},token,signal){
  // Reuse the same ID on a network retry so a vote, join or replay runs only once.
  const mutation=['create','join','action'].includes(op);
  const body=JSON.stringify({op,...data,...(mutation?{requestId:requestId()}: {})});
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8500);
    const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)controller.abort();
    try{
      const response=await fetch(GAME_ENDPOINT,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body,signal:controller.signal});
      const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result.error||'Could not connect. Try again.'),{status:response.status});
      return result;
    }catch(error){
      if(signal?.aborted||error.status||attempt)throw error;
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
  }
}
function saveAuth(value){auth=value;try{if(value)sessionStorage.setItem('majority-session',JSON.stringify(value));else sessionStorage.removeItem('majority-session');}catch{}}
function setState(next,forceRender=false){
  if(!next)return;
  if(state&&state.code===next.code&&next.revision<state.revision){if(forceRender)render();return;}
  const previous=state;clockOffset=next.serverNow-Date.now();state=next;document.body.dataset.theme=next.settings.theme;
  if(!forceRender&&previous?.code===next.code&&previous.revision===next.revision){updateTimers();return;}
  render();
  if(!previous||previous.phase!==next.phase){if($('#modal').open)$('#modal').close();window.scrollTo({top:0});}
  if(next.ballot&&next.ballot.id!==previous?.ballot?.id&&next.ballot.myVote===null){$('.ballot-card')?.scrollIntoView({block:'center'});toast(t('newBallot'));}
  if(previous&&previous.code===next.code){const known=new Set(previous.history.map(x=>x.id));next.history.filter(x=>!known.has(x.id)).slice(0,3).reverse().forEach(x=>toast(t(x.approved?'questionApproved':'questionRejected')));}
}
function connect(){
  stream?.close();const session=auth;if(!session)return;
  let closed=false,timer,controller,running=false;
  const poll=async()=>{
    if(closed||running||auth!==session)return;
    running=true;controller=new AbortController();
    try{
      const result=await request('poll',{room:session.room},session.token,controller.signal);
      if(closed||auth!==session)return;
      const wasConnected=connected;connected=true;setState(result.state,!wasConnected);
    }catch(error){
      if(closed||auth!==session)return;
      if(error.status===401||error.status===403)return resetSession('seatReleased');
      if(error.status===404)return resetSession('roomClosed');
      const wasConnected=connected;connected=false;if(state&&wasConnected)render();
      if(!state)app.innerHTML=`<section class="panel quiet-card"><h1>${h('reconnecting')}</h1><p>${h('offlineHint')}</p><button class="secondary" data-action="reset">${h('joinAgain')}</button></section>`;
    }finally{
      running=false;
      if(!closed&&auth===session)timer=setTimeout(poll,document.hidden?2500:state?.phase==='voting'||state?.ballot?800:1500);
    }
  };
  const resume=()=>{if(!document.hidden&&!running){clearTimeout(timer);void poll();}};
  document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);
  stream={close(){closed=true;clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);}};
  void poll();
}
function resetSession(messageKey){stream?.close();stream=null;saveAuth(null);state=null;connected=false;pendingActions.clear();taken=[];entryMode='create';entryColor='lime';entryName='';entryCode='';document.body.dataset.theme='standard';updateURL();if($('#modal').open)$('#modal').close();render();if(messageKey)toast(t(messageKey));}
async function action(name,data={}){
  if(!auth||pendingActions.has(name))return;
  const session=auth;pendingActions.add(name);disablePendingActions();
  try{const result=await request('action',{room:session.room,action:name,data},session.token);pendingActions.delete(name);if(auth===session&&result.state){const wasConnected=connected;connected=true;setState(result.state,!wasConnected||state?.revision===result.state.revision);}return result.result;}
  finally{pendingActions.delete(name);}
}
function disablePendingActions(){
  for(const name of pendingActions){const selector=name==='vote'?'[data-vote]':name==='approve'?'[data-approve]':`[data-action="${name}"]`;document.querySelectorAll(selector).forEach(button=>button.disabled=true);}
}
function render(){
  const focused=document.activeElement,focusId=focused?.id;
  const focusAttribute=focused?.getAttributeNames().find(name=>['data-theme-pick','data-rounds','data-action','data-vote','data-approve'].includes(name));
  const focusValue=focusAttribute?focused.getAttribute(focusAttribute):null;
  const expanded=!!app.querySelector('details.custom-list[open]');
  chrome();if(!config)return;if(state)renderRoom();else renderHome();
  if(expanded&&app.querySelector('details.custom-list'))app.querySelector('details.custom-list').open=true;
  const replacement=focusId?document.getElementById(focusId):focusAttribute?app.querySelector(`[${focusAttribute}="${CSS.escape(focusValue)}"]`):null;
  if(replacement&&!replacement.disabled&&replacement!==focused)replacement.focus({preventScroll:true});
  disablePendingActions();
}

function renderHome(){
  document.body.dataset.theme='standard';
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">${h('entryEyebrow')}</p><h1>${h('entryTitle')}<br>${h('entryTitle2')}</h1><p>${h('entrySubtitle')}</p></div><span class="season-tag"><span>✦</span> ${h('seasonal')}</span></div>
  <div class="entry-grid"><section class="panel"><div class="tabs" role="tablist" aria-label="${h('createOrJoin')}"><button role="tab" aria-selected="${entryMode==='create'}" class="${entryMode==='create'?'active':''}" data-mode="create">${h('hostGame')}</button><button role="tab" aria-selected="${entryMode==='join'}" class="${entryMode==='join'?'active':''}" data-mode="join">${h('joinRoom')}</button></div>
  <form id="entry-form">${entryError?`<div class="error-box" role="alert">${escape(errorText(entryError))}</div>`:''}
  <div class="field"><label for="nickname">${h('nicknameLabel')}</label><input id="nickname" name="nickname" autocomplete="nickname" placeholder="${h('nicknamePlaceholder')}" maxlength="20" required value="${escape(entryName)}"></div>
  ${entryMode==='join'?`<div class="field"><label for="room-code-input">${h('roomCode')}</label><input id="room-code-input" name="code" placeholder="${h('codeExample')}" autocomplete="off" spellcheck="false" autocapitalize="characters" maxlength="6" minlength="6" pattern="[A-Za-z0-9]{6}" required value="${escape(entryCode)}"><p class="hint" id="room-hint">${h('codeHint')}</p></div>`:''}
  <div class="field"><div class="label-row"><label>${h('pickColor')}</label><span class="color-name" id="color-name">${h('color.'+color(entryColor).id)}</span></div><div class="palette" role="group" aria-label="${h('avatarColor')}">${paletteHTML()}</div><p class="hint">${h(entryMode==='join'?'colorHintJoin':'colorHintHost')}</p></div>
  <button class="primary full" type="submit" ${busy?'disabled':''}>${h(busy?'joining':entryMode==='create'?'createRoom':'joinTheRoom')}</button><p class="entry-note">${h(entryMode==='create'?'hostHint':'joinHint')}</p></form></section>
  <aside class="panel rule-panel"><p class="eyebrow">${h('houseRules')}</p><h2>${h('majorityRules')}</h2><p>${h('noRightAnswers')}</p><div class="choice-demo" aria-hidden="true"><div class="mini-choice"><small>${h('choiceLabel',{choice:'A'})}</small>${h('demoA')}</div><div class="mini-choice"><small>${h('choiceLabel',{choice:'B'})}</small>${h('demoB')}</div></div>
  <ol class="rule-list">${[1,2,3].map(n=>`<li><span class="rule-num">0${n}</span><span><b>${h('rule'+n+'Title')}</b>${h('rule'+n)}</span></li>`).join('')}</ol><div class="streak-scale">${[100,125,150,200].map((n,i)=>`<div><b>${n}</b><span>${h('win'+(i+1))}</span></div>`).join('')}</div></aside></div>`;
  if(entryMode==='join'&&entryCode.length===6)lookupRoom();
}
function paletteHTML(){return config.colors.map(c=>`<button type="button" class="swatch ${entryColor===c.id?'selected':''}" style="--swatch:${c.hex};--ink:${c.ink}" data-color="${c.id}" aria-label="${h('color.'+c.id)}${taken.includes(c.id)?' — '+h('colorTaken'):''}" aria-pressed="${entryColor===c.id}" title="${h('color.'+c.id)}${taken.includes(c.id)?' · '+h('colorTaken'):''}" ${taken.includes(c.id)?'disabled':''}></button>`).join('');}
async function lookupRoom(){
  const revision=++lookupRevision;const code=entryCode.toUpperCase();if(code.length!==6){taken=[];refreshPalette();return;}
  try{const room=await request('lookup',{code});if(revision!==lookupRevision||state)return;taken=room.takenColors;if(taken.includes(entryColor))entryColor=config.colors.find(c=>!taken.includes(c.id))?.id||'';refreshPalette();if($('#room-hint'))$('#room-hint').textContent=room.joinable?t('roomFound',{count:room.playerCount}):t('roomUnavailable');}
  catch(error){if(revision!==lookupRevision||state)return;taken=[];refreshPalette();if($('#room-hint'))$('#room-hint').textContent=errorText(error);}
}
function refreshPalette(){if($('.palette'))$('.palette').innerHTML=paletteHTML();if($('#color-name'))$('#color-name').textContent=t('color.'+color(entryColor).id);}
function renderRoom(){const banner=connected?'':`<div class="connection-banner" role="status">${h('reconnectNotice')} <button class="text-button" data-action="reset">${h('joinAgain')}</button></div>`;app.innerHTML=banner+(state.phase==='lobby'?lobbyHTML():state.phase==='podium'?podiumHTML():gameHTML());updateTimers();}
function playerRow(p,{awards=false,rank=false}={}){
  const meta=awards?(p.streak?t('streak',{count:p.streak})+(p.streak>=4?' · '+t('max'):''):t('streakReset')):t(p.connected?'inRoom':'offlineSeat');
  return `<div class="player-row ${p.connected?'':'offline'}">${rank?`<span class="rank">${rank}</span>`:''}${avatar(p)}<div class="player-info"><div class="player-name">${escape(p.nickname)}${p.id===state.you?` <span class="muted">(${h('you')})</span>`:''}</div><div class="player-meta">${escape(meta)}</div></div>${awards?`<span class="point-award">+${state.round.result.awards[p.id]||0}</span>`:p.id===state.hostId?`<span class="badge pill-good">${h('host')}</span>`:!p.connected&&host()?`<button class="text-button" data-remove="${p.id}" aria-label="${h('releaseSeat',{name:p.nickname})}">×</button>`:''}</div>`;
}
function lobbyHTML(){
  const isHost=host(),hasBallot=!!state.ballot,deck=translatedDeck(config.decks.find(d=>d.id===state.settings.deck));
  return `<div class="page-heading"><div><p class="eyebrow">${h('lobby')}</p><h1>${h('lobbyTitle')}</h1><p>${h(isHost?'lobbyHost':'lobbyGuest')}</p></div><button class="text-button" data-action="leave-prompt">${h('leaveRoom')}</button></div>
  <div class="lobby-grid"><div class="stack">${hasBallot?ballotHTML():''}<section class="panel"><div class="panel-title"><h2>${h('makeItYours')}</h2><span class="badge">${h(isHost?'hostControls':'roomSettings')}</span></div>
  <div class="setting-section"><span class="field-label">${h('atmosphere')}</span><div class="themes" role="group" aria-label="${h('visualTheme')}">${config.themes.map(theme=>`<button class="theme-option ${state.settings.theme===theme.id?'selected':''}" data-theme-pick="${theme.id}" title="${h('theme.'+theme.id)}" aria-label="${h('theme.'+theme.id)}" aria-pressed="${state.settings.theme===theme.id}" ${!isHost||!connected?'disabled':''}><span class="theme-orb" style="--c1:${theme.colors[0]};--c2:${theme.colors[1]}"></span>${h('short.'+theme.id)}</button>`).join('')}</div><p class="hint">${h('themeHint')}</p></div>
  <div class="setting-section"><div class="field" style="margin-bottom:0"><label for="deck-select">${h('questionDeck')}</label><select id="deck-select" ${!isHost||!connected?'disabled':''}>${config.decks.map(d=>`<option value="${d.id}" ${d.id===state.settings.deck?'selected':''}>${h('deckOption',{title:translatedDeck(d).title,count:d.count})}</option>`).join('')}</select><p class="hint">${escape(deck.description)}</p></div></div>
  <div class="setting-section"><span class="field-label">${h('howManyRounds')}</span><div class="round-options" role="group" aria-label="${h('gameLength')}">${(config.roundOptions||[3,5,10,15,20]).map(n=>`<button class="${state.settings.rounds===n?'selected':''}" data-rounds="${n}" aria-pressed="${state.settings.rounds===n}" ${!isHost||!connected?'disabled':''}>${n}</button>`).join('')}</div><p class="hint">${h('pacingHint')}</p></div></section>
  <section class="panel"><div class="panel-title"><h2>${h('customTitle')}</h2><span class="approved-count">${h('approvedCount',{count:state.custom.length})}</span></div><div class="custom-header"><p>${h('customDescription')}</p></div><div class="button-row"><button class="secondary" data-action="custom" ${!connected?'disabled':''}>＋ ${h('addQuestion')}</button>${isHost?`<button class="secondary" data-action="import">${h('importDeck')}</button>`:''}<button class="secondary" data-action="export" ${!state.custom.length?'disabled':''}>${h('exportDeck')}</button></div>
  ${state.custom.length?`<details class="custom-list"><summary class="text-button">${h('viewApproved',{count:state.custom.length})}</summary>${state.custom.map(q=>`<div class="custom-item">${escape(q.prompt)}<small>A · ${escape(q.a)} &nbsp; / &nbsp; B · ${escape(q.b)}</small></div>`).join('')}</details>`:''}<div class="status-line"><span>${state.queuedCount?h('queued',{count:state.queuedCount}):h('customFirst')}</span></div><p class="hint">${h('customLanguage')}</p>${state.history[0]?`<div class="hint">${h('lastBallot',{result:t(state.history[0].approved?'approved':'rejected')})} · ${escape(state.history[0].prompt)}</div>`:''}</section></div>
  <aside class="stack"><section class="room-card"><p class="eyebrow">${h('roomCodeEyebrow')}</p><div class="room-code" aria-label="${h('roomCode')} ${state.code}">${state.code}</div><div class="share-row"><button data-action="copy-code">${h('copyCode')}</button><button data-action="share">${h('inviteFriends')}</button></div><p class="hint">${h('sameWifi')}</p></section>
  <section class="panel"><div class="panel-title"><h2>${h('theRoom')}</h2><span class="subtle">${h('seatCount',{active:active().length,count:state.players.length})}</span></div><div class="roster">${state.players.map(p=>playerRow(p)).join('')}${state.players.length<8?`<div class="empty-seat"><span>＋</span>${h('waitingOpinion')}</div>`:''}</div>
  <div class="start-area">${isHost?`<button class="primary full" data-action="start" ${!connected||active().length<2||hasBallot||state.queuedCount?'disabled':''}>${h('letsPlay',{count:state.settings.rounds})}</button><p class="hint">${h(active().length<2?'inviteOne':hasBallot||state.queuedCount?'finishBallots':'startHint')}</p>`:`<div class="inline-notice center" style="margin:0">${h('waitingHostStart')}</div>`}</div></section><div class="hint center">${h('deckSummary',{decks:config.decks.length,questions:config.decks.reduce((n,d)=>n+d.count,0)})}<br>${h('opinionatedGroup')}</div></aside></div>`;
}
function ballotHTML(){const b=state.ballot;return `<section class="panel ballot-card"><div class="panel-title"><h2>${h('roomDecides')}</h2><span class="badge" data-ballot-timer>${h('seconds',{count:20})}</span></div><p class="eyebrow">${h('questionBy',{name:b.question.author})}</p><h3>${escape(b.question.prompt)}</h3><div class="ballot-choices"><span><b>A</b> · ${escape(b.question.a)}</span><span><b>B</b> · ${escape(b.question.b)}</span></div><div class="ballot-progress"><div style="width:${b.required?Math.min(100,b.yes/b.required*100):0}%"></div></div><div class="vote-count"><b class="accent">${h('approvalProgress',{yes:b.yes,required:b.required})}</b> · ${h('activePlayers',{count:b.activeCount})}${b.no?' · '+h('passedCount',{count:b.no}):''}</div>${b.myVote===null?`<div class="button-row"><button class="primary" data-approve="yes" data-ballot="${b.id}" ${!connected?'disabled':''}>${h('approveQuestion')}</button><button class="secondary" data-approve="no" data-ballot="${b.id}" ${!connected?'disabled':''}>${h('pass')}</button></div>`:`<p class="hint">${h('ballotLocked',{vote:t(b.myVote?'voteApproved':'votePassed')})}</p>`}</section>`;}
function gameTop(){return `<div class="game-top"><span class="game-room">${h('roomLabel',{code:state.code})}</span><div class="progress-dots" aria-label="${h('roundOf',{round:state.roundIndex,total:state.settings.rounds})}">${Array.from({length:state.settings.rounds},(_,i)=>`<span class="${i+1<state.roundIndex?'done':i+1===state.roundIndex?'current':''}"></span>`).join('')}</div><button class="text-button" data-action="standings">${h('leaderboard')}</button></div>`;}
function gameHTML(){const r=state.round,q=translatedQuestion(r.question);return `${gameTop()}<div class="round-label"><span class="badge ${r.blitz||r.multiplier===2?'modifier':''}">${r.blitz?h('blitz'):h('roundOf',{round:state.roundIndex,total:state.settings.rounds})}${r.multiplier===2?' · '+h('doublePoints'):''}</span>${r.blitz?`<p class="eyebrow">${h('roundOf',{round:state.roundIndex,total:state.settings.rounds})}</p>`:''}${q.custom?`<p class="hint">${h('customRound')}</p>`:''}</div><h1 class="question">${escape(q.prompt)}</h1>${state.phase==='voting'?votingHTML():revealHTML()}`;}
function votingHTML(){const r=state.round,q=translatedQuestion(r.question);return `<div class="timer-row"><div class="timer-track" role="progressbar" aria-label="${h('timeRemaining')}" aria-valuemin="0" aria-valuemax="${r.duration/1000}"><div class="timer-fill" data-timer-fill></div></div><span class="timer-number" data-round-timer>${h('seconds',{count:r.duration/1000})}</span></div><div class="vote-grid">${['a','b'].map(choice=>`<button class="choice-button ${choice==='b'?'b':''} ${r.myVote?'locked':''} ${r.myVote===choice?'picked':r.myVote?'unselected':''}" data-vote="${choice}" data-round-id="${r.id}" ${r.myVote||!r.eligible||!connected?'disabled':''} aria-pressed="${r.myVote===choice}"><span class="letter">${choice.toUpperCase()}</span><strong>${escape(q[choice])}</strong><span class="locked-label">${r.myVote===choice?h('voteLocked'):r.myVote?'':h(r.eligible?'tapChoose':'watching')}</span></button>`).join('')}</div><div class="under-vote"><span>${h(r.myVote?'afterVote':'beforeVote')}</span><span>${h('voteProgress',{voted:state.players.filter(p=>p.connected&&p.hasVoted).length,active:r.activeCount})}</span></div><div class="tiny-players" aria-label="${h('votingProgress')}">${state.players.map(p=>avatar(p,p.hasVoted?'voted':'')).join('')}</div><div class="game-footer"><span>${h('yourScore')} <strong>${me()?.score||0}</strong></span><span>${me()?.streak?h('nextStreak',{count:me().streak,points:[100,125,150,200][Math.min(me().streak,3)]*r.multiplier}):h('startStreak')}</span></div>`;}
function revealHTML(){
  const r=state.round,q=translatedQuestion(r.question),result=r.result,winner=result.winner,win=winner&&r.myVote===winner;
  const a=result.total?Math.round(result.counts.a/result.total*100):50,b=result.total?100-a:50,percent=key=>result.total?Math.round(result.counts[key]/result.total*100):0;
  return `<div class="reveal-banner"><h2>${h(!result.total?'silentRoom':!winner?'tieTitle':win?'majorityTitle':r.myVote?'minorityTitle':'revealedTitle')}</h2><p>${!result.total?h('noVotesDescription'):!winner?h('tieDescription'):h('winnerDescription',{choice:winner.toUpperCase(),count:result.counts[winner],total:result.total})+(win?' · '+h('pointsForYou',{points:result.awards[state.you]}):'')}</p></div>
  <div class="split-bar" aria-label="${h('splitLabel',{a:percent('a'),b:percent('b')})}"><div style="--share:${a}%;flex-basis:${a}%">${a>5?percent('a')+'%':''}</div><div style="--share:${b}%;flex-basis:${b}%">${b>5?percent('b')+'%':''}</div></div>
  <div class="vote-grid">${['a','b'].map(choice=>`<section class="reveal-choice ${winner===choice?'winner':''}"><span class="choice-label">${h('choiceVotes',{choice:choice.toUpperCase(),count:result.counts[choice]})}${winner===choice?' · '+h('majorityBadge'):''}</span><h3>${escape(q[choice])}</h3><div class="reveal-players">${state.players.filter(p=>r.votes[p.id]===choice).map(p=>playerRow(p,{awards:true})).join('')||`<p class="hint">${h('noOne')}</p>`}</div></section>`).join('')}</div>
  ${state.players.some(p=>!r.votes[p.id])?`<p class="hint center">${h('noVote',{names:state.players.filter(p=>!r.votes[p.id]).map(p=>p.nickname).join(', ')})}</p>`:''}<div class="standings-strip">${ranked().slice(0,3).map(p=>`<div class="standing-chip"><span class="muted">#${rankOf(p)}</span><span>${escape(p.nickname)}</span><b>${p.score}</b></div>`).join('')}</div>
  <div class="game-footer"><span>${me()?.streak?'ϟ '+h('streak',{count:me().streak})+(me().streak>=4?' · '+h('maxBonus'):''):h('freshStart')}</span>${host()?`<button class="primary" data-action="next" ${!connected||active().length<2&&state.roundIndex<state.settings.rounds?'disabled':''}>${h(state.roundIndex===state.settings.rounds?'podiumButton':'nextRound')}</button>`:`<span class="muted">${h('waitingHost')}</span>`}</div>`;
}
function ranked(){return [...state.players].sort((a,b)=>b.score-a.score||a.nickname.localeCompare(b.nickname));}
function rankOf(p){return state.players.filter(other=>other.score>p.score).length+1;}
function podiumHTML(){const players=ranked(),winners=players.filter(p=>p.score===players[0].score),order=players.length>=3?[players[1],players[0],players[2]]:[players[1],players[0]];return `${gameTop()}<div class="page-heading center" style="display:block"><p class="eyebrow">${h('podiumEyebrow',{count:state.settings.rounds})}</p><h1>${winners.length>1?h('sharedCrown'):h('champion',{name:players[0].nickname})}</h1><p>${winners.length>1?h('tiedFirst',{names:new Intl.ListFormat(language,{style:'long',type:'conjunction'}).format(winners.map(p=>p.nickname))}):h('winnerCompliment')}</p></div><div class="podium">${order.filter(Boolean).map(p=>{const place=players.indexOf(p);return `<div class="podium-place ${place===0?'first':place===2?'third':''}"><span class="rank">${place===0?'♛ ':''}#${rankOf(p)}</span>${avatar(p,'large')}<span class="podium-name">${escape(p.nickname)}</span><div class="podium-block"><strong>${p.score}</strong><span>${h('points')}</span><span>${h('bestStreak',{count:p.bestStreak})}</span></div></div>`;}).join('')}</div><div class="score-list">${players.slice(3).map(p=>`<div class="player-row"><span class="rank">${rankOf(p)}</span>${avatar(p)}<div class="player-info"><div class="player-name">${escape(p.nickname)}</div><div class="player-meta">${h('bestStreak',{count:p.bestStreak})}</div></div><b>${p.score}</b></div>`).join('')}</div><div class="podium-actions">${host()?`<button class="primary full" data-action="replay">${h('playAgain')}</button><p class="hint">${h('replayHint')}</p>`:`<p class="hint">${h('replayGuest')}</p>`}<button class="text-button" data-action="leave-prompt" style="margin-top:15px">${h('leaveRoom')}</button></div>`;}
function updateTimers(){if(!state)return;const now=Date.now()+clockOffset;if(state.ballot&&$('[data-ballot-timer]'))$('[data-ballot-timer]').textContent=t('seconds',{count:Math.max(0,Math.ceil((state.ballot.deadline-now)/1000))});if(state.phase==='voting'&&$('[data-round-timer]')){const remaining=Math.max(0,state.round.deadline-now),seconds=Math.ceil(remaining/1000);$('[data-round-timer]').textContent=t('seconds',{count:seconds});$('[data-round-timer]').classList.toggle('urgent',seconds<=5);$('[data-timer-fill]').style.width=Math.min(100,remaining/state.round.duration*100)+'%';$('.timer-track').setAttribute('aria-valuenow',seconds);if(!remaining)document.querySelectorAll('[data-vote]').forEach(b=>b.disabled=true);}}
setInterval(updateTimers,100);
setInterval(()=>{if(config&&!state&&entryMode==='join'&&entryCode.length===6&&!busy)lookupRoom();},2000);
async function copy(text){try{await navigator.clipboard.writeText(text);toast(t('copied'));}catch{showModal('copy',{text});$('#copy-text').select();}}
function inviteURL(){return location.origin+'/?room='+state.code+'&lang='+language;}

function showModal(kind,data={}){
  currentModal={kind,data};let title,body;
  if(kind==='rules'){
    title='houseRules';body=`<div class="modal-copy"><p>${h('rulesIntro')}</p><h3>${h('rulesMajorityTitle')}</h3><p>${h('rulesMajority')}</p><table><thead><tr><th>${h('consecutiveWins')}</th><th>${h('points')}</th><th>${h('doubleRound')}</th></tr></thead><tbody>${[100,125,150,200].map((points,i)=>`<tr><td>${i===3?h('fourOrMore'):i+1}</td><td>${points}</td><td>${points*2}</td></tr>`).join('')}</tbody></table><h3>${h('clockTitle')}</h3><p>${h('clockRules')}</p><h3>${h('makeItYours')}</h3><p>${h('customRules')}</p><p>${h('deckRules')}</p><h3>${h('language')}</h3><p>${h('languageRules')}</p><p>${h('customLanguage')}</p><h3>${h('togetherTitle')}</h3><p>${h('connectionRules')}</p><p>${h('replayRules')}</p></div>`;
  }else if(kind==='copy'){
    title='copyShare';body=`<div class="field"><label for="copy-text">${h('selectToCopy')}</label><textarea id="copy-text" readonly>${escape(data.text)}</textarea></div><button class="primary full" data-action="select-copy">${h('selectText')}</button>`;
  }else if(kind==='share'){
    title='inviteTitle';body=`<div class="room-card"><p class="eyebrow">${h('roomCode')}</p><div class="room-code">${state.code}</div></div><div class="modal-copy"><p>${h('inviteInstructions')}</p></div><div class="field"><input id="invite-url" readonly value="${escape(inviteURL())}" aria-label="${h('invitationLink')}"></div><button class="primary full" data-action="copy-link">${h('copyLink')}</button><p class="hint">${h('networkHint')}</p>`;
  }else if(kind==='custom'){
    title='customModal';body=`<form id="custom-form"><div class="field"><label for="custom-prompt">${h('theQuestion')}</label><textarea id="custom-prompt" name="prompt" minlength="15" maxlength="120" required placeholder="${h('questionPlaceholder')}"></textarea><p class="hint">${h('promptLength')}</p></div><div class="choice-fields"><div class="field"><label for="custom-a">${h('choiceLabel',{choice:'A'})}</label><input id="custom-a" name="a" minlength="2" maxlength="40" required placeholder="${h('demoA')}"></div><div class="field"><label for="custom-b">${h('choiceLabel',{choice:'B'})}</label><input id="custom-b" name="b" minlength="2" maxlength="40" required placeholder="${h('demoB')}"></div></div><div class="inline-notice">${h('customFormHint')}<br>${h('customLanguage')}</div><div id="form-error" role="alert"></div><button class="primary full" type="submit">${h('submitQuestion')}</button></form>`;
  }else if(kind==='import'){
    title='importTitle';body=`<form id="import-form"><div class="field"><label for="import-code">${h('deckCode')}</label><textarea class="deck-code" id="import-code" name="code" required maxlength="80000" rows="5" placeholder="MR1.…"></textarea></div><div class="inline-notice">${h('importHint')}<br>${h('customLanguage')}</div><div id="form-error" role="alert"></div><button class="primary full" type="submit">${h('importQuestions')}</button></form>`;
  }else if(kind==='standings'){
    title='standingsTitle';body=`<div class="score-list">${ranked().map(p=>`<div class="player-row"><span class="rank">${rankOf(p)}</span>${avatar(p)}<div class="player-info"><div class="player-name">${escape(p.nickname)}${p.id===state.you?' ('+h('you')+')':''}</div><div class="player-meta">${h('standingsStreak',{count:p.streak,best:p.bestStreak})}</div></div><b class="accent">${p.score}</b></div>`).join('')}</div>`;
  }else if(kind==='export'){
    title='exportTitle';body=`<p class="modal-copy">${h('exportHint',{count:state.custom.length})}</p><div class="field"><label for="export-code">${h('yourDeckCode')}</label><textarea id="export-code" class="deck-code" readonly rows="5">${escape(data.code)}</textarea></div><button class="primary full" data-action="copy-export">${h('copyDeckCode')}</button>`;
  }else if(kind==='leave'){
    title='leaveTitle';body=`<p class="modal-copy">${h('leaveDescription')}${host()?' '+h('hostHandoff'):''}</p><div class="button-row"><button class="secondary" data-close>${h('stay')}</button><button class="danger" data-action="leave">${h('leaveRoom')}</button></div>`;
  }
  $('#modal-body').innerHTML=`<div class="modal-top"><h2 id="modal-title">${h(title)}</h2><button class="close" data-close aria-label="${h('closeDialog')}">×</button></div><label class="modal-language">${h('language')}<select data-language aria-label="${h('language')}">${languageOptions()}</select></label>${body}`;
  if(data.error&&$('#form-error'))$('#form-error').innerHTML=`<div class="error-box">${escape(errorText(data.error))}</div>`;
  if(!$('#modal').open)$('#modal').showModal();
}
document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button||button.disabled)return;
  try{
    if(button.id==='rules-open')return showModal('rules');
    if(button.hasAttribute('data-close'))return $('#modal').close();
    if(button.dataset.mode){entryMode=button.dataset.mode;taken=[];entryError='';render();return;}
    if(button.dataset.color){entryColor=button.dataset.color;refreshPalette();return;}
    if(button.dataset.themePick)return await action('settings',{theme:button.dataset.themePick});
    if(button.dataset.rounds)return await action('settings',{rounds:Number(button.dataset.rounds)});
    if(button.dataset.vote){button.disabled=true;return await action('vote',{id:button.dataset.roundId,choice:button.dataset.vote});}
    if(button.dataset.approve){button.disabled=true;return await action('approve',{id:button.dataset.ballot,approve:button.dataset.approve==='yes'});}
    if(button.dataset.remove)return await action('remove',{id:button.dataset.remove});
    switch(button.dataset.action){
      case'reset':resetSession();break;
      case'copy-code':await copy(state.code);break;
      case'share':case'custom':case'import':case'standings':showModal(button.dataset.action);break;
      case'copy-link':await copy(inviteURL());break;
      case'select-copy':$('#copy-text').select();break;
      case'export':showModal('export',await action('export'));break;
      case'copy-export':await copy($('#export-code').value);break;
      case'start':case'next':case'replay':button.disabled=true;await action(button.dataset.action);break;
      case'leave-prompt':showModal('leave');break;
      case'leave':stream?.close();try{await action('leave');$('#modal').close();resetSession();}catch(error){connect();throw error;}break;
      case'retry':location.reload();break;
    }
  }catch(error){toast(errorText(error));if(state)render();}
});
document.addEventListener('change',async e=>{
  if(e.target.matches('[data-language]'))return changeLanguage(e.target.value);
  if(e.target.id==='deck-select'){try{await action('settings',{deck:e.target.value});}catch(error){toast(errorText(error));render();}}
});
document.addEventListener('input',e=>{if(e.target.setCustomValidity)e.target.setCustomValidity('');if(e.target.id==='nickname')entryName=e.target.value;if(e.target.id==='room-code-input'){entryCode=e.target.value.toUpperCase();e.target.value=entryCode;clearTimeout(lookupTimer);lookupRevision++;lookupTimer=setTimeout(lookupRoom,200);}});
document.addEventListener('invalid',e=>{
  const messages={nickname:'Use a nickname of 1–20 characters.','room-code-input':'Room not found. Check the six-character code.','custom-prompt':'The prompt must be 15–120 characters.','custom-a':'Each choice must be 2–40 characters.','custom-b':'Each choice must be 2–40 characters.','import-code':'Use a valid MR1 deck code.'};
  if(messages[e.target.id])e.target.setCustomValidity(errorText(messages[e.target.id]));
},true);
document.addEventListener('submit',async e=>{
  if(e.target.id==='entry-form'){
    e.preventDefault();if(busy)return;busy=true;entryError='';entryName=$('#nickname').value;entryCode=$('#room-code-input')?.value.toUpperCase()||entryCode;render();
    try{const result=await request(entryMode,{nickname:entryName,color:entryColor,code:entryCode});saveAuth({room:result.room,token:result.token,playerId:result.playerId});updateURL(result.room);connected=true;setState(result.state);connect();}
    catch(error){entryError=error.message;render();}finally{busy=false;if(!state)render();}return;
  }
  if(!['custom-form','import-form'].includes(e.target.id))return;
  e.preventDefault();const form=e.target,submit=form.querySelector('button[type=submit]');if(submit.disabled)return;submit.disabled=true;
  const data=Object.fromEntries(new FormData(form));
  try{if(form.id==='custom-form'){await action('submit',data);$('#modal').close();toast(t('submitted'));}else{const result=await action('import',data);$('#modal').close();toast(t('importResult',{added:result.added,skipped:result.skipped}));}}
  catch(error){if(currentModal)currentModal.data.error=error.message;$('#form-error').innerHTML=`<div class="error-box">${escape(errorText(error))}</div>`;submit.disabled=false;}
});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const rect=$('#modal').getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)$('#modal').close();}});
async function init(){
  chrome();app.innerHTML=`<div class="loading" role="status">${h('loading')}</div>`;
  try{config=await request('config');try{const saved=JSON.parse(sessionStorage.getItem('majority-session'));if(saved&&typeof saved.room==='string'&&typeof saved.token==='string')auth=saved;}catch{}render();if(auth){app.innerHTML=`<div class="loading" role="status">${h('rejoining')}</div>`;connect();}}
  catch{app.innerHTML=`<section class="panel quiet-card"><h1>${h('offlineTitle')}</h1><p>${h('offlineHint')}</p><button class="primary" data-action="retry">${h('tryAgain')}</button></section>`;}
}
init();
