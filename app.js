/* Resenhudo V1 — a súmula oficial da pelada */
(function(){
'use strict';
const CFG=window.RESENHUDO_CONFIG||{};
const $=(s,el=document)=>el.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad2=n=>String(n).padStart(2,'0');
const today=()=>new Date().toLocaleDateString('sv-SE');
const fmtDate=d=>{if(!d||typeof d!=='string')return'';const[y,m,dd]=d.split('-');return dd&&m?dd+'/'+m:'';};
const fmtDateLong=d=>{if(!d||typeof d!=='string')return'';const[y,m,dd]=d.split('-');return dd&&m&&y?dd+'/'+m+'/'+y:'';};
const isUuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hasScore=r=>r&&Number.isFinite(r.score_a)&&Number.isFinite(r.score_b);

/* ---------- Armazenamento local (por pelada) ---------- */
const LS={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}},del(k){try{localStorage.removeItem(k);}catch(e){}}};
const CODE=(new URLSearchParams(location.search).get('p')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);
const K=k=>'resenhudo:'+CODE+':'+k;

const VIEWS=['rodada','ranking','galera'];
const S={
  state:null,loaded:false,notFound:false,err:null,
  me:null,pin:null,browse:false,
  view:'rodada',photos:{},busy:false,arm:null,
  tie:null,tiePick:{},selRound:null,editing:false,draftPhoto:null,joining:false,created:null
};
if(CODE){const m=LS.get(K('me'),null);S.me=isUuid(m)?m:null;S.pin=LS.get(K('pin'),null);}
let needsRender=false,armTimer=null;

/* ---------- API ---------- */
const MSG={
  pelada_nao_encontrada:'Pelada não encontrada. Confira o link.',
  rodada_fechada:'Essa rodada já foi encerrada.',
  rodada_aberta:'Já existe uma rodada aberta.',
  palpites_encerrados:'Os palpites fecharam quando o placar foi lançado.',
  alvo_invalido:'Esse jogador não está marcado em "Quem jogou".',
  jogador_invalido:'Não encontrei esse jogador nesta pelada.',
  elenco_cheio:'O elenco chegou ao limite de 60 jogadores.',
  desculpas_demais:'Essa rodada já tem desculpas demais (20).',
  pin_invalido:'PIN errado.',
  pin_invalido_formato:'O PIN precisa ter de 4 a 8 números.',
  bloqueado:'Muitas tentativas de PIN. Tente de novo em 15 minutos.',
  poucos_jogadores:'Marque pelo menos dois jogadores em "Quem jogou".',
  sem_votos:'Ainda falta pelo menos um voto para Craque e um para Bagre.',
  placar_incompleto:'Preencha os dois lados do placar, ou deixe os dois em branco.',
  nome_invalido:'Dê um nome para a pelada.',
  rede:'Sem conexão com o servidor. Confira sua internet e tente de novo.'
};
class ApiErr extends Error{constructor(code,data){super(code);this.code=code;this.data=data;}}
function msgOf(e){const c=e&&e.code;return MSG[c]||(c&&/violates check constraint/.test(c)?'Algum campo está fora do formato. Confira e tente de novo.':'Algo deu errado. Tente de novo.');}
async function rpc(fn,args){
  if(!CFG.url||!CFG.key)throw new ApiErr('config');
  let res;
  try{res=await fetch(CFG.url+'/rest/v1/rpc/'+fn,{method:'POST',headers:{'Content-Type':'application/json',apikey:CFG.key},body:JSON.stringify(args||{})});}
  catch(e){throw new ApiErr('rede');}
  let j=null;try{j=await res.json();}catch(e){}
  if(!res.ok)throw new ApiErr((j&&j.message)||('http_'+res.status),j);
  if(j&&j.error)throw new ApiErr(j.error,j);
  return j;
}

/* ---------- Carregamento ---------- */
async function load(){
  if(!CODE)return;
  try{
    const st=await rpc('get_state',{p_code:CODE,p_me:S.me});
    S.state=st;S.loaded=true;S.notFound=false;S.err=null;
    if(S.me&&!st.players.some(p=>p.id===S.me)){S.me=null;LS.del(K('me'));}
    await loadPhotos();
  }catch(e){
    if(e.code==='pelada_nao_encontrada'){S.notFound=true;S.loaded=true;}
    else{S.err=msgOf(e);if(!S.state)S.loaded=true;}
  }
  render();
}
async function loadPhotos(){
  const ps=S.state?S.state.players:[];
  ps.forEach(p=>{if(!p.has_photo)delete S.photos[p.id];});
  const need=ps.filter(p=>p.has_photo&&(!S.photos[p.id]||S.photos[p.id].u!==p.updated_at));
  for(let i=0;i<need.length;i+=20){
    const chunk=need.slice(i,i+20);
    try{const m=await rpc('get_photos',{p_code:CODE,p_ids:chunk.map(p=>p.id)});chunk.forEach(p=>{if(m&&m[p.id])S.photos[p.id]={u:p.updated_at,d:m[p.id]};});}catch(e){}
  }
}
async function act(fn,args,okMsg){
  if(S.busy)return null;S.busy=true;
  try{const r=await rpc(fn,args);await load();if(okMsg)toast(okMsg);return r||{};}
  catch(e){toast(msgOf(e));if(e.code==='pin_invalido'||e.code==='bloqueado'){if(S.pin){S.pin=null;LS.del(K('pin'));render();}}return null;}
  finally{S.busy=false;}
}
function adminArgs(){return{p_code:CODE,p_pin:S.pin};}

/* ---------- Dados derivados ---------- */
function players(){return S.state?S.state.players.map(p=>Object.assign({},p,{photo:S.photos[p.id]?S.photos[p.id].d:null})):[];}
function pmap(){const m={};players().forEach(p=>m[p.id]=p);return m;}
function P(id){return id?pmap()[id]:null;}
function rounds(){return S.state?S.state.rounds:[];}
function roundNo(r){return rounds().findIndex(x=>x.id===r.id)+1;}
function openRound(){return rounds().find(r=>r.status==='open')||null;}
function closedRounds(){return rounds().filter(r=>r.status==='closed');}
function display(p){return p?(p.nick||p.name||'Sem nome'):'Ex-jogador';}
function initials(p){const s=String((p&&(p.nick||p.name))||'?').trim().split(/\s+/);return((s[0]||'?')[0]+(s[1]?s[1][0]:'')).toUpperCase();}
function excuseOf(r){return(r&&r.excuse_id&&(r.excuses||[]).find(e=>e.id===r.excuse_id))||null;}
function guessOf(r,pid){return(r.guesses||[]).find(g=>g.player_id===pid)||null;}
function stats(){
  const st={};players().forEach(p=>st[p.id]={jogos:0,craque:0,bagre:0,desculpa:0,dina:0});
  closedRounds().forEach(r=>{(r.present||[]).forEach(id=>{if(st[id])st[id].jogos++;});
    if(st[r.craque_id])st[r.craque_id].craque++;if(st[r.bagre_id])st[r.bagre_id].bagre++;if(st[r.mae_dina_id])st[r.mae_dina_id].dina++;
    const e=excuseOf(r);if(e&&st[e.player_id])st[e.player_id].desculpa++;});
  return st;
}
function countUntil(r,kind){const key=kind+'_id';let n=0;for(const x of closedRounds()){if(x[key]&&x[key]===r[key])n++;if(x.id===r.id)break;}return n;}
function titleOf(s){
  if(!s)return null;
  if(s.craque>=3&&s.craque>s.bagre)return['Dono da bola','c'];
  if(s.bagre>=3&&s.bagre>=s.craque)return['Bagre de estimação','b'];
  if(s.dina>=3)return['Vidente oficial','c'];
  if(s.craque>0&&s.craque===s.bagre)return['Médico e monstro','c'];
  if(s.desculpa>=2)return['Assessoria de imprensa','b'];
  if(s.jogos>=4&&!s.craque&&!s.bagre)return['Figurante de luxo','c'];
  if(s.craque>s.bagre)return['Em alta','c'];
  if(s.bagre>s.craque)return['Na mira da resenha','b'];
  return null;
}
function shareUrl(){return location.origin+location.pathname+'?p='+CODE;}

/* ---------- Render ---------- */
const safePhoto=p=>(p&&typeof p.photo==='string'&&/^data:image\/(png|jpe?g|webp);base64,/.test(p.photo))?p.photo:null;
function avatarHTML(p,size){
  p=p||{id:'?',name:'?'};const s='width:'+size+'px;height:'+size+'px';const ph=safePhoto(p);
  if(ph)return'<img class="av" src="'+esc(ph)+'" alt="" style="'+s+'">';
  return'<span class="av av-ini" aria-hidden="true" style="'+s+';font-size:'+Math.round(size*.42)+'px">'+esc(initials(p))+'</span>';
}
function armBtn(key,label,armedLabel,cls){
  const a=S.arm===key;
  return'<button type="button" class="btn small '+(a?'armed':(cls||'ghost'))+'" data-act="arm" data-key="'+esc(key)+'">'+(a?armedLabel:label)+'</button>';
}
function secH(idx,title,aside,tag){tag=tag||'h3';return'<div class="sec-h">'+(idx?'<span class="idx">'+idx+'</span>':'')+'<'+tag+'>'+title+'</'+tag+'>'+(aside?'<span class="aside">'+aside+'</span>':'')+'</div>';}
function isTyping(){const ae=document.activeElement;return!!(ae&&ae.matches&&ae.matches('input[type=text],input[type=number],input[type=date],input[type=password],input[inputmode]'));}
function render(force){
  if(!force&&isTyping()){needsRender=true;return;}
  needsRender=false;
  const app=$('#app');
  if(!CODE){app.innerHTML=landing();return;}
  if(!S.loaded){app.innerHTML='<div class="loading">Carregando a súmula…</div>';return;}
  if(S.notFound){app.innerHTML=header(false)+'<div class="empty"><h2>Pelada não encontrada</h2><p>Confira se o link está completo, ou peça um novo ao organizador.</p><a class="btn" href="'+esc(location.pathname)+'">Criar uma pelada</a></div>';return;}
  if(!S.state){app.innerHTML=header(false)+'<p class="alert" role="alert">'+esc(S.err||MSG.rede)+'</p><button type="button" class="btn primary" data-act="retry">Tentar de novo</button>';return;}
  const err=S.err?'<p class="alert" role="alert">'+esc(S.err)+'</p>':'';
  if(S.created)return void(app.innerHTML=header(false)+viewCreated());
  if(!S.me&&!S.browse){app.innerHTML=header(false)+err+viewWho();return;}
  let v='';
  if(S.view==='ranking')v=viewRanking();else if(S.view==='galera')v=viewGalera();else v=viewRodada();
  app.innerHTML=header(true)+err+'<main class="stack" style="margin-top:16px">'+v+'</main>';
  if(S.view==='rodada')fillCards();
}
document.addEventListener('focusout',()=>setTimeout(()=>{if(needsRender&&!isTyping())render();},0));

function header(withTabs){
  const me=P(S.me);
  const right=me?'<span class="save" style="text-transform:none">'+avatarHTML(me,22)+'</span>':(S.pin?'<span class="save local">Organizador</span>':'');
  let h='<header class="top"><div class="brand"><div class="logo">Resenhu<span>do</span></div><div class="meta">Súmula oficial · '+esc(S.state&&S.state.group?S.state.group.name:'da sua pelada')+'</div></div>'+right+'</header>';
  if(withTabs)h+='<nav class="tabs" aria-label="Seções">'+[['rodada','Rodada'],['ranking','Ranking'],['galera','Galera']].map(([k,l])=>'<a href="#'+k+'"'+(S.view===k?' aria-current="page"':'')+'>'+l+'</a>').join('')+'</nav>';
  return h;
}
function landing(){
  return'<header class="top"><div class="brand"><div class="logo">Resenhu<span>do</span></div><div class="meta">Súmula oficial da pelada</div></div></header>'+
  '<section class="hero"><div class="kicker">Placar oficial da pelada</div><h1>O jogo acabou. A resenha, não.</h1><p>Crie a sua pelada, mande o link no grupo do WhatsApp e a galera vota no Craque, no Bagre e na Desculpa da Rodada. No fim, sai a súmula e as figurinhas.</p></section>'+
  '<form class="stack sec" data-form="create" style="margin-top:24px"><label class="f" for="c-name">Nome da pelada<input type="text" id="c-name" name="name" placeholder="Ex.: Pelada de Quinta" maxlength="40" required></label>'+
  '<label class="f" for="c-pin">PIN do organizador (4 a 8 números)<input type="password" id="c-pin" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" autocomplete="new-password" required></label>'+
  '<p class="note">O PIN é só seu. Com ele você abre e encerra rodadas. Guarde bem: não dá para recuperar.</p>'+
  '<button class="btn primary block" type="submit">Criar pelada</button></form>';
}
function viewCreated(){
  const url=shareUrl();
  return'<section class="hero"><div class="kicker">Pelada criada</div><h1>Agora é só chamar a galera.</h1><p>Mande este link no grupo do WhatsApp. Quem abrir escolhe o próprio nome ou se cadastra.</p></section>'+
  '<div class="stack"><div class="linkbox">'+esc(url)+'</div><div class="row wrap"><button type="button" class="btn" data-act="copyLink">Copiar link</button><a class="btn primary" href="'+esc(waLink())+'" target="_blank" rel="noopener">Mandar no WhatsApp</a></div>'+
  '<p class="banner">Você entrou como organizador neste aparelho. Agora cadastre-se como jogador também.</p>'+
  '<button type="button" class="btn primary block" data-act="createdDone">Continuar</button></div>';
}
function waLink(){return'https://wa.me/?text='+encodeURIComponent('Resenhudo da '+((S.state&&S.state.group&&S.state.group.name)||'pelada')+': entra aí, escolhe teu nome e vota no Craque e no Bagre da rodada 👉 '+shareUrl());}

function viewWho(){
  const ps=players();
  let h='<section class="hero" style="padding-top:20px"><div class="kicker">Bem-vindo à súmula</div><h1>Quem é você?</h1><p>Toque no seu nome. Este aparelho vai lembrar de você.</p></section>';
  if(ps.length)h+='<div class="who-grid">'+ps.map(p=>'<button type="button" class="who-btn" data-act="iam" data-id="'+esc(p.id)+'">'+avatarHTML(p,40)+'<span>'+esc(display(p))+(p.nick?'<br><small class="note">'+esc(p.name)+'</small>':'')+'</span></button>').join('')+'</div>';
  h+='<section class="sec" style="margin-top:20px">'+secH('',ps.length?'Não estou na lista':'Seja o primeiro','','h2')+joinForm()+'</section>';
  h+='<div class="row" style="justify-content:center;margin-top:8px"><button type="button" class="btn ghost small" data-act="browse">Só quero olhar</button></div>';
  return h;
}
function joinForm(){
  return'<form class="stack" data-form="join" style="gap:12px"><div class="row wrap"><label class="f" for="j-name">Nome<input type="text" id="j-name" name="name" maxlength="30" placeholder="Beto" required></label><label class="f" for="j-nick">Apelido<input type="text" id="j-nick" name="nick" maxlength="30" placeholder="Pé de Alface"></label></div>'+
  '<div class="row wrap"><span class="btn filebtn small"><input type="file" id="j-photo" accept="image/*" aria-label="Sua foto">'+(S.draftPhoto?'Trocar foto':'Escolher foto')+'</span>'+(S.draftPhoto?'<img class="av" src="'+esc(S.draftPhoto)+'" alt="Prévia da foto" style="width:40px;height:40px">':'')+'<button class="btn primary" type="submit" style="margin-left:auto">Entrar na pelada</button></div>'+
  '<p class="note">A foto aparece nas figurinhas e na súmula. Só quem tem o link da pelada vê.</p></form>';
}

/* --- Rodada --- */
function viewRodada(){
  const r=openRound();
  if(r)return viewOpenRound(r);
  const sel=S.selRound&&rounds().find(x=>x.id===S.selRound&&x.status==='closed');
  const last=sel||closedRounds().slice(-1)[0];
  let h='';
  if(S.pin)h+='<div class="admin stack" style="gap:10px"><span class="tag">Organizador</span><button type="button" class="btn primary block" data-act="openRound">Abrir nova rodada</button></div>';
  if(last)h+=viewResult(last);
  else h+='<div class="empty"><h2>Nenhuma rodada ainda</h2><p>'+(S.pin?'Abra a primeira rodada no dia do jogo. A galera marca presença, crava o placar e vota pelo link.':'Assim que o organizador abrir a rodada, ela aparece aqui.')+'</p></div>';
  return h;
}
function viewOpenRound(r){
  const pm=pmap();const present=(r.present||[]).filter(id=>pm[id]);const me=pm[S.me];
  const iPlayed=me&&present.includes(me.id);const scored=hasScore(r);const pp=present.map(id=>pm[id]);
  let h='<div class="res-h"><h2>Rodada '+pad2(roundNo(r))+'</h2><span class="meta">'+fmtDate(r.date)+(scored?' · '+r.score_a+' × '+r.score_b:'')+'</span></div>';
  if(!me)h+='<p class="banner">Você está só olhando. <button type="button" class="btn small" data-act="choose">Escolher quem eu sou</button></p>';
  if(me)h+='<button type="button" class="toggle" data-act="played" aria-pressed="'+iPlayed+'"><span><b>Eu joguei</b><br><span class="note">'+present.length+' marcado'+(present.length===1?'':'s')+' até agora</span></span><span class="sw" aria-hidden="true"></span></button>';
  // Palpite
  h+='<section class="sec">'+secH('01','Palpite',scored?'Encerrado':'Antes do jogo');
  if(!scored&&me){const g=guessOf(r,me.id);
    h+='<form data-form="guess" class="score"><label class="f" for="g-a">Coletes<input type="number" id="g-a" name="a" min="0" max="99" inputmode="numeric" value="'+(g?g.a:'')+'" required></label><span class="x">×</span><label class="f" for="g-b" style="text-align:right">Sem colete<input type="number" id="g-b" name="b" min="0" max="99" inputmode="numeric" value="'+(g?g.b:'')+'" required></label><button class="btn small" type="submit" style="grid-column:1/-1;justify-self:end">'+(g?'Mudar palpite':'Cravar palpite')+'</button></form>';
  }
  const gs=(r.guesses||[]).filter(g=>pm[g.player_id]);
  h+=gs.length?'<div class="guess-list">'+gs.map(g=>'<span>'+esc(display(pm[g.player_id]))+' <b>'+g.a+'×'+g.b+'</b></span>').join('')+'</div>':'<p class="note">'+(scored?'Ninguém cravou palpite.':'Ninguém cravou ainda.')+'</p>';
  h+='</section>';
  // Votos
  h+=voteBlock(r,pp,'craque','02','Craque','var(--craque)',me);
  h+=voteBlock(r,pp,'bagre','03','Bagre','var(--bagre)',me);
  h+=excuseBlock(r,pp,me);
  if(S.pin)h+=adminPanel(r);
  return h;
}
function voteBlock(r,pp,kind,idx,label,color,me){
  const n=(r.voters&&r.voters[kind]||[]).length;const mine=r.my_votes&&r.my_votes[kind];
  let h='<section class="sec">'+secH(idx,label+' da rodada',n+' voto'+(n===1?'':'s'));
  if(!pp.length)return h+'<p class="note">A votação abre quando a galera marcar "Eu joguei".</p></section>';
  if(idx==='02')h+='<p class="note" style="margin:-4px 0 10px">Voto secreto. O resultado só aparece quando o organizador encerrar.</p>';
  pp.forEach(p=>{const on=mine===p.id;
    h+='<button type="button" class="pick" style="--pick:'+color+'" data-act="vote" data-kind="'+kind+'" data-id="'+esc(p.id)+'" aria-pressed="'+on+'"'+(me?'':' disabled')+'>'+avatarHTML(p,36)+'<span class="nm">'+esc(display(p))+(p.nick?'<small>'+esc(p.name)+'</small>':'')+'</span>'+(on?'<span class="mark">Seu voto</span>':'')+'</button>';});
  return h+'</section>';
}
function excuseBlock(r,pp,me){
  const pm=pmap();const ex=(r.excuses||[]).filter(e=>pm[e.player_id]);const mine=r.my_votes&&r.my_votes.desculpa;const n=(r.voters&&r.voters.desculpa||[]).length;
  let h='<section class="sec">'+secH('04','Desculpa da rodada',ex.length?n+' voto'+(n===1?'':'s'):'Opcional');
  h+='<p class="note" style="margin:-4px 0 10px">Cadastre a desculpa que você deu (ou ouviu) e vote na melhor. O Bagre tem direito de resposta.</p>';
  ex.forEach(e=>{const on=mine===e.id;
    h+='<div class="row" style="gap:6px;align-items:stretch"><button type="button" class="pick" style="--pick:var(--colete)" data-act="voteExcuse" data-id="'+esc(e.id)+'" aria-pressed="'+on+'"'+(me?'':' disabled')+'>'+avatarHTML(pm[e.player_id],32)+'<span class="nm"><span class="quote">“'+esc(e.text)+'”</span><small>'+esc(display(pm[e.player_id]))+'</small></span>'+(on?'<span class="mark">Seu voto</span>':'')+'</button>'+
      (S.pin?'<span style="display:flex;align-items:center;margin-bottom:6px">'+armBtn('delx:'+e.id,'✕','Apagar?')+'</span>':'')+'</div>';});
  if(me){
    const opts=[me].concat(pp.filter(p=>p.id!==me.id));
    h+='<form class="stack" data-form="excuse" style="margin-top:8px;gap:10px"><div class="row wrap" style="align-items:flex-end"><label class="f" for="x-who" style="flex:none;width:150px">Quem disse<select id="x-who" name="pid">'+
      opts.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.id===me.id?display(p)+' (eu)':display(p))+'</option>').join('')+'</select></label>'+
      '<label class="f" for="x-text" style="min-width:180px">Desculpa<input type="text" id="x-text" name="text" maxlength="120" placeholder="A bola tava murcha" required></label></div>'+
      '<button class="btn small" type="submit" style="align-self:flex-end">Adicionar desculpa</button></form>';
  }
  return h+'</section>';
}
function adminPanel(r){
  const ps=players();const pm=pmap();const present=new Set((r.present||[]).filter(id=>pm[id]));
  const pending=k=>{const v=new Set(r.voters&&r.voters[k]||[]);return[...present].filter(id=>!v.has(id)).map(id=>display(pm[id]));};
  const pc=pending('craque'),pb=pending('bagre');
  let h='<section class="admin stack" style="gap:14px"><span class="tag">Painel do organizador</span>';
  h+='<form data-form="score" class="stack" style="gap:10px"><div class="score"><label class="f" for="s-a">Coletes<input type="number" id="s-a" name="a" min="0" max="99" inputmode="numeric" value="'+(hasScore(r)?r.score_a:'')+'" placeholder="–"></label><span class="x">×</span><label class="f" for="s-b" style="text-align:right">Sem colete<input type="number" id="s-b" name="b" min="0" max="99" inputmode="numeric" value="'+(hasScore(r)?r.score_b:'')+'" placeholder="–"></label></div>'+
    '<div class="row" style="align-items:flex-end"><label class="f" for="s-date" style="max-width:180px">Data<input type="date" id="s-date" name="date" value="'+esc(r.date||'')+'"></label><button class="btn small" type="submit" style="margin-left:auto">Salvar placar</button></div>'+
    '<p class="note">Ao lançar o placar, os palpites fecham.</p></form>';
  h+='<div>'+secH('','Quem jogou',present.size+' de '+ps.length)+'<div class="chips">'+ps.map(p=>'<button type="button" class="chip" data-act="adminPresent" data-id="'+esc(p.id)+'" aria-pressed="'+present.has(p.id)+'">'+avatarHTML(p,28)+esc(display(p))+'</button>').join('')+'</div></div>';
  if(present.size){
    h+='<p class="pending">Falta votar no Craque: <b>'+(pc.length?esc(pc.join(', ')):'ninguém')+'</b><br>Falta votar no Bagre: <b>'+(pb.length?esc(pb.join(', ')):'ninguém')+'</b></p>';
    const miss=[...new Set(pc.concat(pb))];
    if(miss.length)h+='<a class="btn small" style="align-self:flex-start" target="_blank" rel="noopener" href="https://wa.me/?text='+encodeURIComponent('Falta o voto de '+miss.join(', ')+' no Resenhudo 👉 '+shareUrl())+'">Cobrar no WhatsApp</a>';
  }
  if(S.tie&&S.tie.round===r.id){
    const lbl={craque:'no Craque',bagre:'no Bagre',desculpa:'na Desculpa'}[S.tie.kind];
    h+='<div class="alert" role="alert">Empate '+lbl+'. Quem leva o voto de minerva?<div class="tie">'+S.tie.ids.map(id=>{
      const name=S.tie.kind==='desculpa'?'“'+(((r.excuses||[]).find(e=>e.id===id)||{}).text||'')+'”':display(pm[id]);
      return'<button type="button" class="btn small" data-act="tiePick" data-id="'+esc(id)+'">'+esc(name)+'</button>';}).join('')+'</div></div>';
  }
  h+='<button type="button" class="btn primary block" data-act="closeRound">Encerrar e gerar a súmula</button>';
  h+='<div class="row" style="justify-content:center">'+armBtn('discard:'+r.id,'Descartar rodada','Toque de novo para descartar')+'</div>';
  return h+'</section>';
}
function viewResult(r){
  const pm=pmap();const c=pm[r.craque_id],b=pm[r.bagre_id],dn=pm[r.mae_dina_id];
  const sc=hasScore(r)?' · '+r.score_a+' × '+r.score_b:'';
  const sh=what=>'<button type="button" class="btn small" data-act="share" data-what="'+what+'">Compartilhar</button>';
  let h='<section class="stack sec"><div class="res-h"><h2>Rodada '+pad2(roundNo(r))+'</h2><span class="meta">'+fmtDate(r.date)+sc+'</span></div>';
  if(dn){const g=guessOf(r,dn.id);h+='<p class="dina">Mãe Diná da rodada: '+esc(display(dn))+(g?' · cravou '+g.a+'×'+g.b:'')+'</p>';}
  h+='<div class="row between"><span class="lbl">Súmula da rodada</span>'+sh('card')+'</div>';
  h+='<div class="shot card"><img id="img-card" alt="Súmula da rodada '+roundNo(r)+': Craque '+esc(display(c))+', Bagre '+esc(display(b))+'"></div>';
  h+='<div class="stickers"><figure><div class="row between"><span class="lbl">Craque</span>'+sh('craque')+'</div><img id="img-craque" alt="Figurinha do Craque '+esc(display(c))+'"></figure>'+
     '<figure><div class="row between"><span class="lbl">Bagre</span>'+sh('bagre')+'</div><img id="img-bagre" alt="Figurinha do Bagre '+esc(display(b))+'"></figure></div>';
  const ex=excuseOf(r);
  if(ex)h+='<div class="row between"><span class="lbl">Nota oficial · Desculpa</span>'+sh('desculpa')+'</div><div class="shot sq"><img id="img-desculpa" alt="Desculpa da rodada: '+esc(ex.text)+' ('+esc(display(pm[ex.player_id]))+')"></div>';
  h+='<p class="note">No celular, "Compartilhar" abre o WhatsApp direto. Para virar figurinha, envie a imagem e use o criador de figurinhas do WhatsApp.</p>';
  if(S.pin)h+='<div class="row" style="justify-content:center">'+(openRound()?'':'<button type="button" class="btn ghost small" data-act="reopen" data-id="'+esc(r.id)+'">Reabrir esta rodada</button>')+'</div>';
  return h+'</section>';
}

/* --- Ranking --- */
function viewRanking(){
  const ps=players();const st=stats();const cr=closedRounds();const pm=pmap();
  if(!cr.length)return'<div class="empty"><h2>Ranking vazio</h2><p>O ranking da temporada aparece depois da primeira rodada encerrada.</p></div>';
  const by=k=>ps.filter(p=>st[p.id][k]>0).sort((a,b)=>st[b.id][k]-st[a.id][k]||st[a.id].jogos-st[b.id].jogos)[0];
  const rei=by('craque'),bm=by('bagre');
  const tile=(p,label,col,n)=>'<div class="tile" style="--c:'+col+'"><span class="k">'+label+'</span>'+(p?avatarHTML(p,56)+'<span class="who">'+esc(display(p))+'</span><span class="n">'+n+'</span>':'<span class="who">—</span>')+'</div>';
  let h='<div class="tiles">'+tile(rei,'Rei da pelada','var(--craque)',rei?st[rei.id].craque+'× Craque':'')+tile(bm,'Bagre-mor','var(--bagre)',bm?st[bm.id].bagre+'× Bagre':'')+'</div>';
  const rows=ps.slice().sort((a,b)=>st[b.id].craque-st[a.id].craque||st[a.id].bagre-st[b.id].bagre||st[b.id].jogos-st[a.id].jogos);
  h+='<section class="sec">'+secH('','Temporada',cr.length+' rodada'+(cr.length===1?'':'s'),'h2')+'<div class="tbl-wrap"><table><thead><tr><th class="l">#</th><th class="l">Jogador</th><th title="Jogos">J</th><th title="Vezes Craque">C</th><th title="Vezes Bagre">B</th><th title="Vezes Mãe Diná">MD</th></tr></thead><tbody>'+
    rows.map((p,i)=>{const s=st[p.id];const t=titleOf(s);return'<tr><td class="pos" style="text-align:left">'+pad2(i+1)+'</td><td class="pl"><div class="row">'+avatarHTML(p,30)+'<div><div>'+esc(display(p))+'</div>'+(t?'<span class="title-chip '+t[1]+'" style="margin-top:3px">'+t[0]+'</span>':'')+'</div></div></td><td>'+s.jogos+'</td><td><span class="c">'+s.craque+'</span></td><td><span class="b">'+s.bagre+'</span></td><td>'+s.dina+'</td></tr>';}).join('')+
    '</tbody></table></div><p class="note" style="margin-top:8px">J jogos · C Craque · B Bagre · MD Mãe Diná (melhor palpite)</p></section>';
  const mus=cr.filter(r=>excuseOf(r)).reverse();
  if(mus.length)h+='<section class="sec">'+secH('','Museu das desculpas',mus.length+' no acervo','h2')+mus.map(r=>{const e=excuseOf(r);return'<div class="museu"><q>'+esc(e.text)+'</q><div class="who">'+esc(display(pm[e.player_id]))+' · Rodada '+pad2(roundNo(r))+' · '+fmtDate(r.date)+'</div></div>';}).join('')+'</section>';
  h+='<section class="sec">'+secH('','Histórico','','h2')+cr.slice().reverse().map(r=>{
    const sc=hasScore(r)?' · '+r.score_a+'×'+r.score_b:'';
    return'<div class="hist"><div class="info"><b>Rodada '+pad2(roundNo(r))+'</b> <span class="lbl">'+fmtDate(r.date)+sc+'</span><div>Craque: '+esc(display(pm[r.craque_id]))+' · Bagre: '+esc(display(pm[r.bagre_id]))+'</div></div><button type="button" class="btn small" data-act="viewRound" data-id="'+esc(r.id)+'">Ver</button>'+(S.pin?armBtn('delr:'+r.id,'Apagar','Confirmar'):'')+'</div>';
  }).join('')+'</section>';
  return h;
}

/* --- Galera --- */
function viewGalera(){
  const ps=players();const st=stats();const me=P(S.me);
  let h='';
  if(me){
    h+='<section class="sec">'+secH('','Meu perfil','','h2');
    if(S.editing){
      h+='<form class="stack" data-form="profile" style="gap:12px"><div class="row wrap"><label class="f" for="e-name">Nome<input type="text" id="e-name" name="name" maxlength="30" value="'+esc(me.name)+'" required></label><label class="f" for="e-nick">Apelido<input type="text" id="e-nick" name="nick" maxlength="30" value="'+esc(me.nick||'')+'"></label></div>'+
        '<div class="row wrap"><span class="btn filebtn small"><input type="file" id="e-photo" accept="image/*" aria-label="Trocar minha foto">Trocar foto</span>'+(S.draftPhoto?'<img class="av" src="'+esc(S.draftPhoto)+'" alt="Prévia" style="width:40px;height:40px">':avatarHTML(me,40))+'<button class="btn primary small" type="submit" style="margin-left:auto">Salvar</button><button type="button" class="btn ghost small" data-act="cancelEdit">Cancelar</button></div></form>';
    }else{
      h+='<div class="prow">'+avatarHTML(me,56)+'<div class="info"><div class="nick">'+esc(display(me))+'</div>'+(me.nick?'<div class="real">'+esc(me.name)+'</div>':'')+'</div><div class="acts"><button type="button" class="btn small" data-act="editMe">Editar</button><button type="button" class="btn small ghost" data-act="notMe">Não sou eu</button></div></div>';
    }
    h+='</section>';
  }else{
    h+='<p class="banner">Você está só olhando. <button type="button" class="btn small" data-act="choose">Escolher quem eu sou</button></p>';
  }
  h+='<section class="sec">'+secH('','Chamar a galera','','h2')+'<div class="stack" style="gap:10px"><div class="linkbox">'+esc(shareUrl())+'</div><div class="row wrap"><button type="button" class="btn small" data-act="copyLink">Copiar link</button><a class="btn small primary" href="'+esc(waLink())+'" target="_blank" rel="noopener">Mandar no WhatsApp</a></div><p class="note">Pelada fechada: só quem tem este link vê.</p></div></section>';
  h+='<section class="sec">'+secH('','Elenco',ps.length+' jogador'+(ps.length===1?'':'es'),'h2');
  ps.forEach(p=>{const s=st[p.id]||{jogos:0,craque:0,bagre:0,dina:0};const t=titleOf(s);
    h+='<div class="prow">'+avatarHTML(p,48)+'<div class="info"><div class="nick">'+esc(display(p))+'</div>'+(p.nick?'<div class="real">'+esc(p.name)+'</div>':'')+'<div class="stat">'+s.jogos+' J · '+s.craque+' C · '+s.bagre+' B · '+s.dina+' MD</div>'+(t?'<span class="title-chip '+t[1]+'">'+t[0]+'</span>':'')+'</div>'+(S.pin&&p.id!==S.me?'<div class="acts">'+armBtn('delp:'+p.id,'Remover','Confirmar')+'</div>':'')+'</div>';});
  h+='</section>';
  h+='<section class="sec">'+secH('','Organizador','','h2');
  if(S.pin){
    h+='<form class="stack" data-form="rename" style="gap:10px"><div class="row" style="align-items:flex-end"><label class="f" for="g-rename">Nome da pelada<input type="text" id="g-rename" name="name" value="'+esc(S.state.group.name||'')+'" maxlength="40" required></label><button class="btn small" type="submit" style="margin-bottom:3px">Salvar</button></div></form>'+
      '<div class="row" style="margin-top:10px"><button type="button" class="btn ghost small" data-act="logoutAdmin">Sair do modo organizador neste aparelho</button></div>';
  }else{
    h+='<form class="row" data-form="admin" style="align-items:flex-end"><label class="f" for="a-pin">PIN do organizador<input type="password" id="a-pin" name="pin" inputmode="numeric" maxlength="8" autocomplete="current-password" required></label><button class="btn small" type="submit" style="margin-bottom:3px">Entrar</button></form>';
  }
  return h+'</section>';
}

/* ---------- Ações ---------- */
function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{t.hidden=true;},3500);}
function go(v){if(location.hash!=='#'+v)location.hash=v;else{S.view=v;render(true);}}
window.addEventListener('hashchange',()=>{const h=location.hash.slice(1);S.view=VIEWS.includes(h)?h:'rodada';S.arm=null;S.editing=false;S.draftPhoto=null;render(true);window.scrollTo(0,0);});
function setMe(id){S.me=id;S.browse=false;if(id)LS.set(K('me'),id);else LS.del(K('me'));}

document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b||b.disabled)return;
  const a=b.dataset.act,id=b.dataset.id;
  if(a==='arm'){
    const key=b.dataset.key;
    if(S.arm===key){S.arm=null;clearTimeout(armTimer);doArmed(key);}
    else{S.arm=key;clearTimeout(armTimer);armTimer=setTimeout(()=>{S.arm=null;render(true);},4000);}
    render(true);return;
  }
  if(a==='retry'){S.loaded=false;render(true);load();return;}
  if(a==='iam'){setMe(id);render(true);load();window.scrollTo(0,0);return;}
  if(a==='browse'){S.browse=true;render(true);return;}
  if(a==='choose'||a==='notMe'){setMe(null);S.browse=false;S.editing=false;render(true);window.scrollTo(0,0);return;}
  if(a==='createdDone'){S.created=null;render(true);return;}
  if(a==='copyLink'){try{await navigator.clipboard.writeText(shareUrl());toast('Link copiado.');}catch(err){toast('Não consegui copiar. Selecione o link e copie.');}return;}
  if(a==='played'){const r=openRound();if(!r||!S.me)return;const on=b.getAttribute('aria-pressed')!=='true';await act('set_attendance',{p_code:CODE,p_round:r.id,p_player:S.me,p_present:on},on?'Presença confirmada.':'Presença desmarcada.');return;}
  if(a==='adminPresent'){const r=openRound();if(!r)return;const on=b.getAttribute('aria-pressed')!=='true';await act('set_attendance',{p_code:CODE,p_round:r.id,p_player:id,p_present:on});return;}
  if(a==='vote'){const r=openRound();if(!r||!S.me)return;await act('cast_vote',{p_code:CODE,p_round:r.id,p_voter:S.me,p_kind:b.dataset.kind,p_target:id},'Voto registrado.');return;}
  if(a==='voteExcuse'){const r=openRound();if(!r||!S.me)return;await act('cast_vote',{p_code:CODE,p_round:r.id,p_voter:S.me,p_kind:'desculpa',p_target:id},'Voto registrado.');return;}
  if(a==='openRound'){const res=await act('admin_open_round',Object.assign(adminArgs(),{p_date:today()}),'Rodada aberta. Mande o link no grupo.');if(res)window.scrollTo(0,0);return;}
  if(a==='closeRound'){closeRound();return;}
  if(a==='tiePick'){if(!S.tie)return;S.tiePick[S.tie.kind]=id;closeRound();return;}
  if(a==='reopen'){await act('admin_reopen_round',Object.assign(adminArgs(),{p_round:id}),'Rodada reaberta.');window.scrollTo(0,0);return;}
  if(a==='viewRound'){S.selRound=id;go('rodada');return;}
  if(a==='editMe'){S.editing=true;S.draftPhoto=null;render(true);return;}
  if(a==='cancelEdit'){S.editing=false;S.draftPhoto=null;render(true);return;}
  if(a==='logoutAdmin'){S.pin=null;LS.del(K('pin'));render(true);toast('Modo organizador desligado neste aparelho.');return;}
  if(a==='share'){shareImg(b.dataset.what);return;}
});
async function closeRound(){
  const r=openRound();if(!r)return;
  if(S.tie&&S.tie.round!==r.id){S.tie=null;S.tiePick={};}
  if(S.busy)return;S.busy=true;
  try{
    await rpc('admin_close_round',Object.assign(adminArgs(),{p_round:r.id,p_craque:S.tiePick.craque||null,p_bagre:S.tiePick.bagre||null,p_excuse:S.tiePick.desculpa||null}));
    S.tie=null;S.tiePick={};S.selRound=r.id;await load();window.scrollTo(0,0);toast('Rodada encerrada. Súmula e figurinhas prontas.');
  }catch(e){
    if(e.code==='empate'&&e.data){S.tie={round:r.id,kind:e.data.kind,ids:e.data.ids};render(true);const al=$('.admin .alert');if(al)al.scrollIntoView({block:'center'});}
    else{toast(msgOf(e));if(e.code==='pin_invalido'||e.code==='bloqueado'){S.pin=null;LS.del(K('pin'));render(true);}}
  }finally{S.busy=false;}
}
async function doArmed(key){
  const i=key.indexOf(':');const k=key.slice(0,i),id=key.slice(i+1);
  if(k==='discard'||k==='delr'){if(S.selRound===id)S.selRound=null;S.tie=null;S.tiePick={};await act('admin_delete_round',Object.assign(adminArgs(),{p_round:id}),'Rodada apagada.');}
  else if(k==='delp'){await act('admin_remove_player',Object.assign(adminArgs(),{p_player:id}),'Jogador removido.');}
  else if(k==='delx'){await act('admin_delete_excuse',Object.assign(adminArgs(),{p_excuse:id}),'Desculpa apagada.');}
}
document.addEventListener('change',async e=>{
  const t=e.target;
  if((t.id==='j-photo'||t.id==='e-photo')&&t.files&&t.files[0]){
    try{S.draftPhoto=await fileToPhoto(t.files[0]);}catch(err){toast('Não consegui ler essa imagem. Tente outra foto.');}
    keepFields(()=>render(true));
  }
});
function keepFields(fn){const vals={};document.querySelectorAll('#app input[type=text]').forEach(i=>{vals[i.id]=i.value;});fn();for(const id in vals){const el=document.getElementById(id);if(el)el.value=vals[id];}}
document.addEventListener('submit',async e=>{
  const f=e.target.closest('form[data-form]');if(!f)return;e.preventDefault();
  const fd=new FormData(f);const kind=f.dataset.form;const val=k=>String(fd.get(k)||'').trim();
  if(kind==='create'){
    const name=val('name').slice(0,40),pin=val('pin');
    if(!name)return;if(!/^[0-9]{4,8}$/.test(pin)){toast(MSG.pin_invalido_formato);return;}
    try{const r=await rpc('create_group',{p_name:name,p_pin:pin});
      try{localStorage.setItem('resenhudo:'+r.code+':pin',JSON.stringify(pin));localStorage.setItem('resenhudo:'+r.code+':created','true');}catch(err){}
      location.href=location.pathname+'?p='+r.code;
    }catch(err){toast(msgOf(err));}
    return;
  }
  if(kind==='join'){
    const name=val('name').slice(0,30);if(!name)return;
    if(S.busy)return;S.busy=true;
    try{const r=await rpc('join_group',{p_code:CODE,p_name:name,p_nick:val('nick').slice(0,30),p_photo:S.draftPhoto||null});setMe(r.id);S.draftPhoto=null;await load();toast('Bem-vindo à súmula, '+name+'.');window.scrollTo(0,0);}
    catch(err){toast(msgOf(err));}finally{S.busy=false;}
    return;
  }
  if(kind==='profile'){
    const name=val('name').slice(0,30);if(!name||!S.me)return;
    const res=await act('update_player',{p_code:CODE,p_player:S.me,p_name:name,p_nick:val('nick').slice(0,30),p_photo:S.draftPhoto,p_set_photo:!!S.draftPhoto},'Perfil atualizado.');
    if(res){S.editing=false;S.draftPhoto=null;render(true);}
    return;
  }
  if(kind==='guess'){
    const r=openRound();if(!r||!S.me)return;const a=parseInt(val('a'),10),b=parseInt(val('b'),10);
    if(!(a>=0&&a<=99&&b>=0&&b<=99)){toast('O placar vai de 0 a 99.');return;}
    document.activeElement&&document.activeElement.blur();
    await act('set_guess',{p_code:CODE,p_round:r.id,p_player:S.me,p_a:a,p_b:b},'Palpite cravado: '+a+'×'+b+'.');return;
  }
  if(kind==='excuse'){
    const r=openRound();const text=val('text').replace(/\s+/g,' ').slice(0,120);const pid=val('pid');if(!r||!text||!pid)return;
    document.activeElement&&document.activeElement.blur();
    await act('add_excuse',{p_code:CODE,p_round:r.id,p_author:pid,p_text:text},'Desculpa registrada.');return;
  }
  if(kind==='score'){
    const r=openRound();if(!r)return;const sa=val('a'),sb=val('b');
    const a=sa===''?null:parseInt(sa,10),b=sb===''?null:parseInt(sb,10);
    if((a===null)!==(b===null)){toast(MSG.placar_incompleto);return;}
    if(a!==null&&!(a>=0&&a<=99&&b>=0&&b<=99)){toast('O placar vai de 0 a 99.');return;}
    const d=val('date');
    document.activeElement&&document.activeElement.blur();
    await act('admin_update_round',Object.assign(adminArgs(),{p_round:r.id,p_date:/^\d{4}-\d{2}-\d{2}$/.test(d)?d:null,p_score_a:a,p_score_b:b}),'Placar salvo.');return;
  }
  if(kind==='rename'){const name=val('name').slice(0,40);if(!name)return;document.activeElement&&document.activeElement.blur();await act('admin_rename',Object.assign(adminArgs(),{p_name:name}),'Nome salvo.');return;}
  if(kind==='admin'){
    const pin=val('pin');
    try{await rpc('admin_check',{p_code:CODE,p_pin:pin});S.pin=pin;LS.set(K('pin'),pin);document.activeElement&&document.activeElement.blur();render(true);toast('Modo organizador ligado.');}
    catch(err){toast(msgOf(err));}
    return;
  }
});

/* ---------- Imagens ---------- */
const INK='#0c1310',CHALK='#ecebe4',MUTED='#98a299',ORANGE='#ff6b1a',BRASS='#d9b45a',STEEL='#8fb1c2';
const F={
  disp:(w,s)=>w+' '+s+'px "Big Shoulders Display", "Arial Narrow", Impact, sans-serif',
  mono:(w,s)=>w+' '+s+'px "IBM Plex Mono", Menlo, Consolas, monospace',
  body:(w,s)=>w+' '+s+'px Archivo, system-ui, sans-serif',
  serif:s=>'italic 400 '+s+'px "Instrument Serif", Georgia, serif'
};
function mk(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
function loadImg(src){return new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src;});}
function drawCover(x,img,dx,dy,dw,dh){const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;const s=Math.max(dw/iw,dh/ih);const w=dw/s,h=dh/s;x.drawImage(img,(iw-w)/2,(ih-h)/2,w,h,dx,dy,dw,dh);}
async function fileToPhoto(file){
  if(file.size>25*1024*1024)throw new Error('big');
  const url=URL.createObjectURL(file);
  try{const img=await loadImg(url);const c=mk(360,360);drawCover(c.getContext('2d'),img,0,0,360,360);return c.toDataURL('image/jpeg',.82);}
  finally{URL.revokeObjectURL(url);}
}
async function fontsReady(){
  try{await Promise.race([Promise.all([F.disp(900,40),F.disp(800,40),F.disp(700,40),F.mono(500,20),F.mono(600,20),F.body(500,20),F.serif(40)].map(f=>document.fonts.load(f))),new Promise(r=>setTimeout(r,2500))]);}catch(e){}
}
async function photoCanvas(p){
  const ph=safePhoto(p);
  if(ph){try{return await loadImg(ph);}catch(e){}}
  const c=mk(360,360);const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,0,360);g.addColorStop(0,'#3a463f');g.addColorStop(1,'#141c17');x.fillStyle=g;x.fillRect(0,0,360,360);
  x.fillStyle='rgba(236,235,228,.9)';x.font=F.disp(900,190);x.textAlign='center';x.textBaseline='middle';x.fillText(initials(p),180,196);
  return c;
}
function hexRgb(h){const n=parseInt(h.slice(1),16);return[(n>>16)&255,(n>>8)&255,n&255];}
function duo(src,w,h,dark,light){
  const c=mk(w,h);const x=c.getContext('2d');drawCover(x,src,0,0,w,h);
  try{const d=x.getImageData(0,0,w,h),a=d.data,D=hexRgb(dark),L=hexRgb(light);
    for(let i=0;i<a.length;i+=4){let y=(a[i]*.299+a[i+1]*.587+a[i+2]*.114)/255;y=Math.min(1,Math.max(0,(y-.5)*1.3+.53));
      a[i]=D[0]+(L[0]-D[0])*y;a[i+1]=D[1]+(L[1]-D[1])*y;a[i+2]=D[2]+(L[2]-D[2])*y;}
    x.putImageData(d,0,0);}catch(e){}
  return c;
}
function fit(x,text,maxW,size,fontFn){let s=size;do{x.font=fontFn(s);if(x.measureText(text).width<=maxW)break;s-=2;}while(s>12);return s;}
function rrect(x,X,Y,W,H,R){x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+H,R);x.arcTo(X+W,Y+H,X,Y+H,R);x.arcTo(X,Y+H,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();}
function wrapLines(x,text,maxW){const words=String(text).split(/\s+/);const lines=[];let cur='';for(const w of words){const t=cur?cur+' '+w:w;if(!cur||x.measureText(t).width<=maxW)cur=t;else{lines.push(cur);cur=w;}}if(cur)lines.push(cur);return lines;}
function stamp(x,cx,cy,word,small,color,rot,scale){
  x.save();x.translate(cx,cy);x.rotate(rot);x.scale(scale,scale);x.globalAlpha=.94;
  x.font=F.disp(900,96);const tw=Math.max(x.measureText(word).width,200);const W=tw+56,H=150;
  x.strokeStyle=color;x.lineWidth=7;x.strokeRect(-W/2,-H/2,W,H);x.lineWidth=2.5;x.strokeRect(-W/2+10,-H/2+10,W-20,H-20);
  x.fillStyle=color;x.textAlign='center';x.textBaseline='alphabetic';x.fillText(word,0,24);
  x.font=F.mono(600,17);x.fillText(small,0,52);x.restore();
}
async function sticker(p,kind,n){
  const c=mk(512,512);const x=c.getContext('2d');const isC=kind==='craque';const col=isC?BRASS:STEEL;
  x.save();x.shadowColor='rgba(0,0,0,.35)';x.shadowBlur=14;x.shadowOffsetY=5;rrect(x,12,12,488,488,52);x.fillStyle='#fff';x.fill();x.restore();
  const ph=duo(await photoCanvas(p),464,464,'#0c1310',isC?'#f6e7bf':'#d9e8ef');
  x.save();rrect(x,24,24,464,464,42);x.clip();x.drawImage(ph,24,24);
  const g=x.createLinearGradient(0,250,0,488);g.addColorStop(0,'rgba(12,19,16,0)');g.addColorStop(1,'rgba(12,19,16,.96)');x.fillStyle=g;x.fillRect(24,250,464,240);
  x.fillStyle=col;x.fillRect(24,24,464,10);x.fillRect(24,34,124,46);x.fillStyle=INK;x.font=F.mono(600,24);x.textAlign='center';x.textBaseline='middle';x.fillText('Nº '+pad2(n),86,58);
  x.restore();
  stamp(x,330,178,isC?'CRAQUE':'BAGRE','HOMOLOGADO PELA GALERA',isC?BRASS:ORANGE,isC?-.12:.14,.9);
  x.textAlign='left';x.textBaseline='alphabetic';
  x.fillStyle=col;x.font=F.mono(600,19);x.fillText(isC?'CRAQUE DA RODADA':'BAGRE DA RODADA',52,386);
  x.fillStyle=CHALK;const nm=display(p).toUpperCase();fit(x,nm,408,70,s=>F.disp(900,s));x.fillText(nm,50,464);
  return c;
}
async function resultCard(r){
  const W=1080,H=1350;const c=mk(W,H);const x=c.getContext('2d');const pm=pmap();
  x.fillStyle=INK;x.fillRect(0,0,W,H);
  for(let i=0;i<W;i+=135){if((i/135)%2){x.fillStyle='rgba(236,235,228,.022)';x.fillRect(i,0,135,H);}}
  x.textBaseline='alphabetic';x.textAlign='left';
  x.fillStyle=CHALK;x.font=F.disp(900,72);x.fillText('RESENHU',64,118);const wR=x.measureText('RESENHU').width;x.fillStyle=ORANGE;x.fillText('DO',64+wR,118);
  x.textAlign='right';x.fillStyle=MUTED;x.font=F.mono(500,22);x.fillText('SÚMULA Nº '+pad2(roundNo(r)),W-64,86);x.fillText(fmtDateLong(r.date),W-64,118);
  x.fillStyle='rgba(236,235,228,.18)';x.fillRect(64,146,W-128,2);
  x.textAlign='left';x.fillStyle=CHALK;const gn=((S.state&&S.state.group&&S.state.group.name)||'').toUpperCase();fit(x,gn,W-128,40,s=>F.disp(800,s));x.fillText(gn,64,204);
  let top=244;
  if(hasScore(r)){
    x.fillStyle=MUTED;x.font=F.mono(500,20);x.textAlign='left';x.fillText('COLETES',64,268);x.textAlign='right';x.fillText('SEM COLETE',W-64,268);
    x.fillStyle=CHALK;x.font=F.disp(900,150);x.textAlign='left';x.fillText(String(r.score_a),60,400);x.textAlign='right';x.fillText(String(r.score_b),W-60,400);
    x.textAlign='center';x.fillStyle=MUTED;x.font=F.disp(700,60);x.fillText('×',W/2,380);top=436;
  }
  const ph=hasScore(r)?560:700;const pw=468;
  const panel=async(px,kind)=>{
    const isC=kind==='craque';const col=isC?BRASS:STEEL;const id=isC?r.craque_id:r.bagre_id;const p=pm[id]||{id:'x',name:'?'};
    const img=duo(await photoCanvas(p),pw,ph,'#0c1310',isC?'#f6e7bf':'#d9e8ef');x.drawImage(img,px,top);
    const g=x.createLinearGradient(0,top+ph*.45,0,top+ph);g.addColorStop(0,'rgba(12,19,16,0)');g.addColorStop(1,'rgba(12,19,16,.97)');x.fillStyle=g;x.fillRect(px,top+ph*.45,pw,ph*.55+1);
    x.fillStyle=col;x.fillRect(px,top,pw,8);
    stamp(x,px+pw-128,top+96,isC?'CRAQUE':'BAGRE','HOMOLOGADO',isC?BRASS:ORANGE,isC?-.1:.12,.62);
    x.textAlign='left';x.fillStyle=col;x.font=F.mono(600,20);x.fillText(isC?'CRAQUE DA RODADA':'BAGRE DA RODADA',px+28,top+ph-118);
    x.fillStyle=CHALK;const nm=display(pm[id]).toUpperCase();fit(x,nm,pw-56,68,s=>F.disp(900,s));x.fillText(nm,px+26,top+ph-58);
    x.fillStyle=MUTED;x.font=F.body(500,24);x.fillText(p.nick&&p.name?p.name:'',px+28,top+ph-24);
    const votes=(r.tally&&r.tally[kind]&&r.tally[kind][id])||0;const n=countUntil(r,kind);
    x.fillStyle=MUTED;x.font=F.mono(500,19);x.fillText(votes+' VOTO'+(votes===1?'':'S')+'  ·  '+n+'º '+(isC?'TÍTULO':'BAGRE')+' NA TEMPORADA',px+2,top+ph+38);
  };
  await panel(56,'craque');await panel(W-56-pw,'bagre');
  const by=top+ph+70;
  x.fillStyle='rgba(236,235,228,.18)';x.fillRect(64,by,W-128,2);
  const ex=excuseOf(r);x.textAlign='left';
  if(ex){
    x.fillStyle=ORANGE;x.font=F.mono(600,19);x.fillText('DESCULPA DA RODADA',64,by+44);
    x.fillStyle=CHALK;const q='“'+ex.text+'”';let s=46;let lines;
    for(;s>=26;s-=2){x.font=F.serif(s);lines=wrapLines(x,q,W-128);if(lines.length<=2)break;}
    if(lines.length>2){lines=lines.slice(0,2);lines[1]=lines[1].replace(/\s*\S*$/,'')+'…”';}
    lines.forEach((l,i)=>x.fillText(l,64,by+96+i*s*1.05));
    x.fillStyle=MUTED;x.font=F.mono(500,18);x.fillText('— '+display(pm[ex.player_id]).toUpperCase(),64,by+96+lines.length*s*1.05+10);
  }else{x.fillStyle=MUTED;x.font=F.mono(500,20);x.fillText('O BAGRE TEM DIREITO DE RESPOSTA NO GRUPO.',64,by+50);}
  const dn=pm[r.mae_dina_id];
  if(dn){const gq=guessOf(r,dn.id);x.textAlign='left';x.fillStyle=ORANGE;x.font=F.mono(600,17);x.fillText('MÃE DINÁ: '+display(dn).toUpperCase()+(gq?' · '+gq.a+'×'+gq.b:''),64,H-40);}
  x.textAlign='right';x.fillStyle='rgba(152,162,153,.7)';x.font=F.mono(400,16);x.fillText('RESENHUDO · PLACAR OFICIAL',W-64,H-40);
  return c;
}
async function quoteCard(r,e){
  const W=1080,H=1080;const c=mk(W,H);const x=c.getContext('2d');const pm=pmap();
  x.fillStyle='#efede4';x.fillRect(0,0,W,H);x.textBaseline='alphabetic';x.textAlign='left';
  x.fillStyle=INK;x.font=F.disp(900,64);x.fillText('NOTA OFICIAL',72,128);
  x.textAlign='right';x.fillStyle='#5d655f';
  const gm=((S.state&&S.state.group&&S.state.group.name)||'').toUpperCase();fit(x,gm,440,20,s=>F.mono(500,s));x.fillText(gm,W-72,96);x.font=F.mono(500,20);x.fillText('RODADA '+pad2(roundNo(r))+' · '+fmtDateLong(r.date),W-72,126);
  x.fillStyle=INK;x.fillRect(72,156,W-144,4);x.fillRect(72,166,W-144,1);
  const maxW=W-144;let s=104,lines=[];const q='“'+e.text+'”';
  for(;s>=44;s-=4){x.font=F.serif(s);lines=wrapLines(x,q,maxW);if(lines.length*s*1.02<=520&&lines.every(l=>x.measureText(l).width<=maxW))break;}
  x.textAlign='left';x.fillStyle=INK;const lh=s*1.02;let y=250+Math.max(0,(520-lines.length*lh)/2)+s*.78;
  lines.forEach(l=>{x.fillText(l,72,y);y+=lh;});
  const v=e.votes||0;
  stamp(x,W-230,H-250,'DESCULPA','DA RODADA · '+v+' VOTO'+(v===1?'':'S'),ORANGE,-.14,.82);
  x.fillStyle=INK;x.fillRect(72,H-196,W-144,1);
  const p=pm[e.player_id]||{id:'z',name:'?'};
  const img=duo(await photoCanvas(p),120,120,'#0c1310','#efede4');x.drawImage(img,72,H-170);
  x.fillStyle=INK;const nm=display(pm[e.player_id]).toUpperCase();fit(x,nm,520,56,s=>F.disp(900,s));x.fillText(nm,214,H-110);
  x.fillStyle='#5d655f';x.font=F.mono(500,19);x.fillText((p.nick&&p.name?p.name.toUpperCase()+' · ':'')+'EM DECLARAÇÃO PÓS-JOGO',216,H-72);
  return c;
}
let cache={key:null,job:null};
function cardKey(r){const pm=pmap();const ids=[r.craque_id,r.bagre_id,r.mae_dina_id,(excuseOf(r)||{}).player_id];
  return JSON.stringify([r,S.state&&S.state.group&&S.state.group.name,roundNo(r),countUntil(r,'craque'),countUntil(r,'bagre'),ids.map(id=>{const p=pm[id]||{};return[display(pm[id]),p.name,p.updated_at,(p.photo||'').length];})]);}
async function buildCards(r){
  await fontsReady();const pm=pmap();
  const pc=pm[r.craque_id]||{id:'x',name:'?'},pb=pm[r.bagre_id]||{id:'y',name:'?'};
  const sc=await sticker(pc,'craque',countUntil(r,'craque'));const sb=await sticker(pb,'bagre',countUntil(r,'bagre'));
  const card=await resultCard(r);const ex=excuseOf(r);const dc=ex?await quoteCard(r,ex):null;
  return{card,craque:sc,bagre:sb,desculpa:dc,urls:{card:card.toDataURL('image/png'),craque:sc.toDataURL('image/png'),bagre:sb.toDataURL('image/png'),desculpa:dc?dc.toDataURL('image/png'):null},round:r,names:{craque:display(pm[r.craque_id]),bagre:display(pm[r.bagre_id]),desculpa:ex?display(pm[ex.player_id]):''}};
}
function currentResult(){if(openRound())return null;const sel=S.selRound&&rounds().find(x=>x.id===S.selRound&&x.status==='closed');return sel||closedRounds().slice(-1)[0]||null;}
async function fillCards(){
  if(!$('#img-card'))return;const r=currentResult();if(!r)return;
  const key=cardKey(r);if(cache.key!==key)cache={key,job:buildCards(r)};
  try{const res=await cache.job;if(cache.key!==key)return;
    const set=(sel,u)=>{const el=$(sel);if(el&&u&&el.getAttribute('src')!==u)el.src=u;};
    set('#img-card',res.urls.card);set('#img-craque',res.urls.craque);set('#img-bagre',res.urls.bagre);set('#img-desculpa',res.urls.desculpa);
  }catch(e){toast('Não consegui gerar as imagens desta rodada.');}
}
function slug(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'jogador';}
async function shareImg(what){
  if(!cache.job)return;
  try{
    const res=await cache.job;const cv=res[what];if(!cv)return;
    const blob=await new Promise((ok,ko)=>cv.toBlob(b=>b?ok(b):ko(new Error('blob')),'image/png'));
    const n=pad2(roundNo(res.round));
    const fname=what==='card'?'resenhudo-sumula-rodada-'+n+'.png':'resenhudo-'+what+'-'+slug(res.names[what])+'-rodada-'+n+'.png';
    const file=new File([blob],fname,{type:'image/png'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file]});return;}catch(err){if(err&&err.name==='AbortError')return;}
    }
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=fname;document.body.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},2000);
  }catch(e){toast('Não consegui compartilhar. Segure o dedo na imagem para salvar.');}
}

/* ---------- Início ---------- */
function start(){
  const h=location.hash.slice(1);if(VIEWS.includes(h))S.view=h;
  if(!CODE){render(true);return;}
  if(LS.get(K('created'),false)){S.created=true;LS.del(K('created'));}
  render(true);load();
  setInterval(()=>{if(document.visibilityState==='visible'&&!isTyping()&&!S.busy)load();},12000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!S.busy)load();});
}
start();
})();
