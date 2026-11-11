(() => {
'use strict';
const $ = id => document.getElementById(id);
const days = typeof almanaque !== 'undefined' && Array.isArray(almanaque) ? almanaque : [];
const countFmt = new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0});
const baseData = {atualizado_em:null,fonte:'Aguardando fonte oficial',resultado:{},rankings:{},destaques:null,receptivo:{}};
const D = window.tvDestaques;
const options = {snapshot_url:'',fila_url:'',intervalo_dados_segundos:30,intervalo_fila_segundos:5};
let config={...options}, data={...baseData},frames=[],frame=0,lastDay='',transitionToken=0;
const money=n=>D.dinheiro(n,(data&&data.resultado&&data.resultado.precisao)||'inteiro');
const count=n=>typeof n==='number' && Number.isFinite(n) && n>=0?countFmt.format(n):'—';
const nameOf=o=>typeof o==='string'?o.trim().slice(0,56):o&&typeof o==='object'?String(o.apelido||o.nome||'').trim().slice(0,56):'';
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const validDate=x=>{if(!x)return null; const d=new Date(x);return !isNaN(d.getTime())?d:null;};
const tzDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const titleCase=s=>s?s[0].toLocaleUpperCase('pt-BR')+s.slice(1):'';
function currentAlmanac(){
 if(!days.length)return null;
 const today=new Date(`${tzDay(new Date())}T12:00:00-03:00`);
 const start=new Date('2026-10-30T12:00:00-03:00');
 const delta=Math.round((today-start)/86400000);
 return days[((delta%days.length)+days.length)%days.length];
}
function updateTime(){
 const now=new Date();$('todayDate').textContent=titleCase(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(now));
 $('clock').textContent=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}).format(now);
 const nowDay=tzDay(now);if(nowDay!==lastDay){lastDay=nowDay;buildFrames();}
 const month=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',month:'long',year:'numeric'}).format(now);
 $('rankMonth').textContent=titleCase(month);
}
function getWeather(code){if(code===0)return ['Ensolarado','☀'];if(code===1)return ['Predomínio de sol','☀'];if(code===2)return ['Parcialmente nublado','⛅'];if(code===3)return ['Nublado','☁'];if([45,48].includes(code))return ['Neblina','☁'];if([51,53,55,56,57].includes(code))return ['Garoa','☁'];if([61,63,65,66,67,80,81,82].includes(code))return ['Chuva','☂'];if([95,96,99].includes(code))return ['Tempestade','⚡'];return ['Tempo não informado','☁'];}
async function updateWeather(){
 try{const r=await fetch('https://api.open-meteo.com/v1/forecast?latitude=-29.92&longitude=-51.18&current=temperature_2m,weather_code&timezone=America%2FSao_Paulo',{cache:'no-store'});
  if(!r.ok)throw Error('falha na previsão');const x=await r.json();if(!Number.isFinite(x?.current?.temperature_2m))throw Error('sem dados');
  const [cond,icon]=getWeather(x.current.weather_code);$('temperature').textContent=`${Math.round(x.current.temperature_2m)}°C`;$('weatherLabel').textContent=`Canoas/RS · ${cond}`;$('weatherIcon').textContent=icon;
 }catch(e){$('temperature').textContent='--°C';$('weatherLabel').textContent='Canoas/RS';$('weatherIcon').textContent='☁';}
}
function isToday(){const t=validDate(data.atualizado_em);return t&&tzDay(t)===tzDay(new Date());}
function renderResults(){
 const r=data.resultado||{};
 $('honorariosHoje').textContent=money(isToday()?r.honorarios_hoje:null);
 $('recuperadoHoje').textContent=money(isToday()?r.recuperado_hoje:null);
 $('pagamentosHoje').textContent=count(isToday()?r.pagamentos_confirmados_hoje:null);
 $('acordosHoje').textContent=count(isToday()?r.acordos_fechados_hoje:null);
 $('honorariosMes').textContent=money(r.honorarios_mes);
 // Projeção vem do snapshot, sempre inteira: sem ',00' inventado.
 $('projecaoHonorarios').textContent=D.dinheiro(r.projecao_honorarios_mes,'inteiro')+(r.projecao_parcial===true&&typeof r.projecao_honorarios_mes==='number'?' · parcial':'');
 $('recuperadoMes').textContent=money(r.recuperado_mes);
 // Meta é metas_projecao.meta_honorario. A projeção NÃO entra aqui.
 const percent=D.percentualMeta(r.honorarios_mes,r.meta_honorarios_mes);
 $('metaPct').textContent=D.percentual(percent);
 $('metaValor').textContent=typeof r.meta_honorarios_mes==='number'?`da meta de ${money(r.meta_honorarios_mes)}`:'meta do mês não informada';
 $('monthFill').style.width=`${Math.min(100,Math.max(0,percent||0)).toFixed(1)}%`;
 const ritmo=D.ritmo(r.honorarios_mes,r.meta_honorarios_mes,r.dias_uteis_ate_hoje,r.dias_uteis_mes);
 const pace=$('ritmoMes'),mark=$('paceMark');
 if(!ritmo){pace.dataset.situacao='';pace.textContent='Ritmo: aguardando meta e dias úteis';mark.hidden=true;}
 else{
  pace.dataset.situacao=ritmo.situacao;
  const dias=`${ritmo.diasAteHoje}/${ritmo.diasMes} dias úteis`;
  pace.textContent=ritmo.situacao==='no_ritmo'?`No ritmo da meta · ${dias}`
   :`${ritmo.situacao==='acima'?'▲':'▼'} ${money(Math.abs(ritmo.diferenca))} ${ritmo.situacao==='acima'?'acima':'abaixo'} do ritmo · esperado ${money(ritmo.esperado)} em ${dias}`;
  mark.hidden=false;mark.style.left=`${Math.min(100,100*ritmo.diasAteHoje/ritmo.diasMes).toFixed(1)}%`;
 }
 const d=validDate(data.atualizado_em);
 $('statusDados').textContent=d?`Última leitura: ${new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d)}`:'Aguardando fonte oficial';
}
// Fotos: URL assinada do bucket privado, válida por 5 min, renovada a cada leitura
// da tv-dados (60 s). A imagem já carregada fica guardada pela identidade do
// arquivo (a URL sem o token), para não piscar a cada troca de token e seguir na
// tela depois que o token vence. Se a cópia guardada falhar, tenta a URL nova;
// só cai nas iniciais quando não há foto ou as duas falham.
const fotoCache=new Map();
const chaveFoto=url=>url.split('?')[0];
// Pré-carrega as fotos assim que a leitura chega: o card que entra depois já
// encontra a imagem pronta (foto grande não mostra iniciais enquanto baixa).
function preCarregarFotos(dz){
 if(!dz)return;
 for(const k of ['podio_mes',...D.RANKINGS.map(r=>r.chave)]){
  for(const p of (Array.isArray(dz[k])?dz[k]:[])){
   const url=D.fotoSegura(p&&p.foto);if(!url||fotoCache.has(chaveFoto(url)))continue;
   const img=new Image();img.referrerPolicy='no-referrer';img.onload=()=>fotoCache.set(chaveFoto(url),url);img.src=url;
  }
 }
}
function avatar(pessoa,tamanho){
 const el=document.createElement('div');el.className=`avatar ${tamanho||''}`;
 const ini=document.createElement('span');ini.textContent=D.iniciais(pessoa&&pessoa.nome);el.append(ini);
 const url=D.fotoSegura(pessoa&&pessoa.foto);
 if(url){
  const k=chaveFoto(url);const guardada=fotoCache.get(k);
  const img=new Image();img.alt='';img.decoding='async';img.referrerPolicy='no-referrer';
  img.onload=()=>{fotoCache.set(k,img.src);el.classList.add('com-foto');};
  img.onerror=()=>{
   if(img.src!==url){fotoCache.delete(k);img.src=url;return;}
   fotoCache.delete(k);img.remove();el.classList.remove('com-foto');
  };
  img.src=guardada||url;el.append(img);
  if(guardada&&img.complete&&img.naturalWidth)el.classList.add('com-foto');
 }
 return el;
}
function textoMes(){return titleCase(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',month:'long',year:'numeric'}).format(new Date()));}
// Painel da direita: pódio fixo do mês — 1º ouro, 2º prata, 3º bronze — com
// nome e foto, SEM valor (a TV não expõe o resultado individual do operador).
const MEDALHAS=['ouro','prata','bronze'];
function destaqueCard(pessoa,i){
 const card=document.createElement('div');card.className=`leader-card medal-${MEDALHAS[i]}`;
 const copy=document.createElement('div');copy.className='leader-copy';
 const tag=document.createElement('span');tag.className='leader-tag';tag.textContent=`${i+1}º LUGAR`;
 const nm=document.createElement('span');nm.className='leader-name';nm.textContent=D.nomeCurto(pessoa.nome);
 copy.append(tag,nm);card.append(avatar(pessoa,i===0?'avatar-xl':'avatar-lg'),copy);return card;
}
function renderRanks(){
 const dz=data.destaques||null;
 const podio=D.ranking(dz&&dz.podio_mes);
 const host=$('rankItems');
 if(!podio||!podio.length){
  const v=document.createElement('p');v.className='board-empty';
  v.textContent=podio?'Ainda não há resultado registrado neste mês.':'Dado indisponível no momento.';
  host.replaceChildren(v);return;}
 host.replaceChildren(...podio.map((p,i)=>destaqueCard(p,i)));
}
// Card central de ranking: nome, foto, posição, resultado e período, ou o aviso
// de dado indisponível. Nunca completa a lista com nomes inventados.
function renderBoard(def){
 const board=$('rankBoard');board.replaceChildren();
 const dz=data.destaques||null;
 const lista=D.ranking(dz&&dz[def.chave]);
 const periodo=def.periodo==='hoje'?`Hoje · ${new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit'}).format(new Date())}`:textoMes();
 const head=document.createElement('div');head.className='board-head';
 const h=document.createElement('h1');h.textContent=def.titulo;const per=document.createElement('span');per.className='board-period';per.textContent=periodo;
 const crit=document.createElement('p');crit.className='board-criterio';crit.textContent=def.criterio;
 head.append(h,per);board.append(head,crit);
 if(lista===null||(def.periodo==='hoje'&&!isToday()&&dz&&dz.fonte!=='tv_painel_operadores')){
  const v=document.createElement('p');v.className='board-empty';v.textContent='Dado indisponível no momento. O ranking aparece assim que o CRM enviar a informação.';board.append(v);return;}
 if(!lista.length){const v=document.createElement('p');v.className='board-empty';v.textContent=def.periodo==='hoje'?'Ainda não há resultado registrado hoje.':'Ainda não há resultado registrado neste mês.';board.append(v);return;}
 const ol=document.createElement('ol');ol.className='board-list';
 for(const item of lista){
  const li=document.createElement('li');li.className=`board-row pos-${item.posicao}`;
  const medal=document.createElement('span');medal.className='rank-medal';medal.textContent=`${item.posicao}º`;
  const who=document.createElement('div');who.className='board-who';
  // Só posição, foto e nome: resultado individual não aparece na TV.
  const nome=document.createElement('strong');nome.textContent=D.nomeCurto(item.nome);
  who.append(nome);
  li.append(medal,avatar(item,'avatar-md'),who);ol.append(li);
 }
 board.append(ol);
}
// Card "Honorários em destaque": o LÍDER em honorários pagos ACUMULADOS no mês
// (1º do pódio, podio_mes[0]), com foto e nome — sem valor individual. É outro
// critério que o "Top honorários do mês" (maior honorário em um único pagamento).
const CRITERIO_LIDER='Líder em honorários pagos acumulados no mês';
function renderLider(){
 const board=$('rankBoard');board.replaceChildren();
 const dz=data.destaques||null;
 const podio=D.ranking(dz&&dz.podio_mes);
 const head=document.createElement('div');head.className='board-head';
 const h=document.createElement('h1');h.textContent='Honorários em destaque';
 const per=document.createElement('span');per.className='board-period';per.textContent=textoMes();
 const crit=document.createElement('p');crit.className='board-criterio';crit.textContent=CRITERIO_LIDER;
 head.append(h,per);board.append(head,crit);
 if(!podio||!podio.length){
  const v=document.createElement('p');v.className='board-empty';
  v.textContent=podio?'Ainda não há resultado registrado neste mês.':'Dado indisponível no momento. O destaque aparece assim que o CRM enviar a informação.';
  board.append(v);return;}
 const lider=podio[0];
 const spot=document.createElement('div');spot.className='lider-spotlight';
 const copy=document.createElement('div');copy.className='lider-copy';
 const tag=document.createElement('span');tag.className='leader-tag';tag.textContent='1º LUGAR · DESTAQUE DO MÊS';
 const nm=document.createElement('strong');nm.className='lider-nome';nm.textContent=D.nomeCurto(lider.nome);
 copy.append(tag,nm);spot.append(avatar(lider,'avatar-xl'),copy);board.append(spot);
}
function renderQueue(){
 const q=data.receptivo||{};const stamped=validDate(q.atualizado_em);const fresh=!!stamped;
 const names=fresh&&Array.isArray(q.proximos)?q.proximos.slice(0,4).map(nameOf):[];
 const host=$('queueItems');host.replaceChildren();
 for(let i=0;i<4;i++){
  const el=document.createElement('div');el.className=`queue-entry ${i===0?'next':''}`;
  if(i===0){const next=document.createElement('span');next.className='next-pill';next.textContent='PRÓXIMO';el.append(next);}
  const nr=document.createElement('b');nr.className='queue-number';nr.textContent=String(i+1);
  const who=document.createElement('strong');who.textContent=names[i]||'—';el.append(nr,who);host.append(el);
 }
 $('operatorsOnline').textContent=fresh?count(q.online):'—';
 $('queueStatus').textContent=!stamped?'Aguardando conexão com a fila oficial':fresh?'Fila do receptivo · online e disponíveis':'Fila desatualizada · aguardando nova leitura';
}
function makeFrames(){
 const today=currentAlmanac();
 const core=[{kind:'honorarios'},{kind:'resultados'},...D.RANKINGS.map(def=>({kind:'ranking',def}))];
 const training=(today?.slides||[]).map(item=>({kind:'treino',item,theme:today.theme}));
 return [...core,...training];
}
function buildFrames(){frames=makeFrames();frame=0;renderFrame();}
function viewFor(f){
 const r=data.resultado||{};const pm=D.percentualMeta(r.honorarios_mes,r.meta_honorarios_mes);const result={kicker:'RESULTADOS REATIVA',title:'Honorários em destaque',body:'A base da nossa recuperação é a geração de honorários.',quote:pm===null?'Acompanhamento atualizado do resultado da operação.':`A ReATIVA atingiu ${D.percentual(pm)} da meta de honorários do mês.`,footerTitle:'HONORÁRIOS PAGOS NO MÊS · REATIVA',footer:money(r.honorarios_mes)};
 if(f.kind==='honorarios')return result;
 if(f.kind==='resultados')return {kicker:'RESULTADOS REATIVA',title:'Recuperação em foco',body:'Pagamento confirmado, negociação bem conduzida e resultado sustentável.',quote:'Recuperado pela ReATIVA no mês: '+money(r.recuperado_mes),footerTitle:'PAGAMENTOS CONFIRMADOS HOJE · REATIVA',footer:count(isToday()?r.pagamentos_confirmados_hoje:null)};
 if(f.kind==='ranking')return {kicker:'RECONHECIMENTO REATIVA',title:f.def.titulo,body:'',quote:'',footerTitle:f.def.periodo==='hoje'?'PERÍODO: HOJE':'PERÍODO: MÊS ATUAL',footer:'Classificação do CRM ReATIVA. Resultados individuais não são exibidos.'};
 const s=f.item||{};
 return {kicker:s.kicker||'NEGOCIAÇÃO EM FOCO',title:s.title||'Negociação',body:s.body||'',quote:s.quote||'',footerTitle:'FOCO PRÁTICO',footer:s.footer||''};
}
function setMainText(f){
 const x=viewFor(f);$('contentCategory').textContent=x.kicker.toLocaleUpperCase('pt-BR');
 const board=f.kind==='ranking'||f.kind==='honorarios';$('centerStage').classList.toggle('is-board',board);$('rankBoard').hidden=!board;
 if(f.kind==='honorarios')renderLider();else if(f.kind==='ranking')renderBoard(f.def);
 const theme=f.theme||currentAlmanac()?.theme||'Negociação em foco';$('themeChip').replaceChildren();
 const t=document.createTextNode('TEMA DO DIA ');const bold=document.createElement('b');bold.textContent=theme.toLocaleUpperCase('pt-BR');$('themeChip').append(t,bold);
 const h=$('contentTitle');h.replaceChildren();
 // Last meaningful phrase in cyan, avoiding HTML injection.
 const words=x.title.split(' ');const cut=Math.max(1,Math.floor(words.length/2));h.append(document.createTextNode(words.slice(0,cut).join(' ')+' '));const em=document.createElement('em');em.textContent=words.slice(cut).join(' ')||'';h.append(em);
 $('contentBody').textContent=x.body;
 const q=$('quotePanel');q.hidden=!x.quote;
 $('contentQuote').textContent=x.quote;
 $('contentFooterTitle').textContent=x.footerTitle;
 $('contentFooter').textContent=x.footer;
}
// Slide que depende dos dados (honorários, resultados, rankings): redesenha a
// cada leitura. Sem isso, o slide aberto antes da 1ª leitura ficava com "—" até
// a rotação voltar a ele. Slides de treino não dependem de dado e não piscam.
const FRAMES_COM_DADOS=['honorarios','resultados','ranking'];
function refreshFrameData(){
 const f=frames.length&&frames[frame];
 if(f&&FRAMES_COM_DADOS.includes(f.kind))setMainText(f);
}
function renderFrame(){
 if(!frames.length)return;
 const panel=document.querySelector('.main-panel');const token=++transitionToken;panel.classList.add('swap');
 window.setTimeout(()=>{if(token!==transitionToken)return;setMainText(frames[frame]);panel.classList.remove('swap');},180);
}
async function getJSON(url){
 const externo=/^https?:/i.test(url);const headers=externo&&window.tvAuth?await window.tvAuth.headers():{};
 const r=await fetch(url+(url.includes('?')?'&':'?')+'t='+Date.now(),{cache:'no-store',headers});
 if(externo&&(r.status===401||r.status===403)&&window.tvAuth)window.tvAuth.negado(r.status);
 if(!r.ok)throw Error('HTTP '+r.status);return r.json();}
// Pódio (líder em honorários pagos no mês): redesenha só quando o snapshot ou os valores mudam —
// a foto vem por URL assinada que muda a cada leitura, e não deve piscar a imagem a cada minuto.
let podiumStamp=null;
function refreshPodium(){
 // assinatura: nomes + quais têm foto (não a URL, que muda a cada leitura)
 const stamp=JSON.stringify([data.atualizado_em||null,(data.destaques&&Array.isArray(data.destaques.podio_mes)?data.destaques.podio_mes:[]).map(x=>x&&[x.nome,!!D.fotoSegura(x.foto)])]);
 if(stamp===podiumStamp)return;
 podiumStamp=stamp;
 renderRanks();
}
// Fila do receptivo: redesenha só quando o conteúdo muda, sem ciclo próprio de 5 s.
let queueSignature=null;
function refreshQueue(){
 const q=data.receptivo||{};
 const sig=JSON.stringify([q.online??null,Array.isArray(q.proximos)?q.proximos.slice(0,4):[]]);
 if(sig===queueSignature)return;
 queueSignature=sig;
 renderQueue();
}
// Sinal realtime da projeção (tabela tv_sinal, publicada no Realtime). Quando o snapshot é gerado
// com sucesso, o telão recebe UM evento e faz UMA leitura. Se o Realtime falhar, a leitura periódica
// do snapshot continua valendo, porque o pódio só redesenha quando atualizado_em muda.
let queueTimer=null;
function scheduleQueueRefresh(){
 clearTimeout(queueTimer);
 queueTimer=setTimeout(()=>{queueTimer=null;readSnapshot();},1500);
}
async function subscribeProjectionSignal(){
 if(!window.supabase||!window.tvAuth||!config.supabase_url||!config.supabase_key)return;
 const sb=window.supabase.createClient(config.supabase_url,config.supabase_key,{auth:{persistSession:false,autoRefreshToken:false}});
 const authorize=async()=>{const h=await window.tvAuth.headers();const token=String(h?.Authorization||'').replace(/^Bearer\s+/i,'');if(token)sb.realtime.setAuth(token);};
 await authorize();
 sb.channel('tv-sinal-projecao').on('postgres_changes',{event:'*',schema:'public',table:'tv_sinal'},()=>{readSnapshot();}).subscribe();
 // Sinal da fila (public.fila_sinal, incrementado a cada atendimento registrado). Vários atendimentos
 // seguidos viram UMA leitura: o debounce espera 1,5 s de silêncio antes de ler o snapshot.
 sb.channel('tv-sinal-fila').on('postgres_changes',{event:'*',schema:'public',table:'fila_sinal'},scheduleQueueRefresh).subscribe();
 // Token de sessão expira; renova a autorização do canal a cada 5 minutos.
 setInterval(()=>{authorize().catch(()=>{});},5*60*1000);
}
async function readSnapshot(){
 try{const fresh=await getJSON(config.snapshot_url||'./dados-tv.json');if(!isObject(fresh)||!isObject(fresh.resultado))throw Error('dados inválidos');
  data={...data,...fresh,resultado:{...data.resultado,...fresh.resultado},rankings:{...data.rankings,...fresh.rankings},destaques:isObject(fresh.destaques)?fresh.destaques:null,receptivo:{...data.receptivo,...fresh.receptivo}};
  preCarregarFotos(data.destaques);renderResults();refreshPodium();refreshQueue();refreshFrameData();
 }catch(e){if(!data.atualizado_em)$('statusDados').textContent='Fonte oficial indisponível';}
}
async function readQueue(){
 if(!config.fila_url)return;
 try{const fresh=await getJSON(config.fila_url);const q=isObject(fresh.receptivo)?fresh.receptivo:fresh;if(!isObject(q)||!Array.isArray(q.proximos))throw Error('fila inválida');data.receptivo={...data.receptivo,...q};renderQueue();}
 catch(e){$('queueStatus').textContent='Fila indisponível';}
}
async function start(){
 try{const r=await getJSON('./config.json');if(isObject(r))config={...config,...r};}catch(e){}
 renderResults();renderRanks();renderQueue();updateTime();updateWeather();
 if(window.tvAuth)await window.tvAuth.ready();
 await readSnapshot();await readQueue();
 subscribeProjectionSignal().catch(()=>{});
 setInterval(updateTime,1000);setInterval(updateWeather,30*60*1000);
 setInterval(readSnapshot,Math.max(10,Number(config.intervalo_dados_segundos)||30)*1000);
 setInterval(()=>{if(!frames.length)return;frame=(frame+1)%frames.length;renderFrame();},25000);
}
$('fullscreenButton').addEventListener('click',()=>{const doc=document.documentElement;if(document.fullscreenElement){document.exitFullscreen?.();return;}doc.requestFullscreen?.().catch(()=>{});});
document.addEventListener('keydown',e=>{if(!frames.length)return;if(e.key==='ArrowRight'){frame=(frame+1)%frames.length;renderFrame();}if(e.key==='ArrowLeft'){frame=(frame+frames.length-1)%frames.length;renderFrame();}if(e.key.toLowerCase()==='f')$('fullscreenButton').click();});
start();
})();
