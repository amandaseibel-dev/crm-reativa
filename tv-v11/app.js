(() => {
'use strict';
const $ = id => document.getElementById(id);
const days = typeof almanaque !== 'undefined' && Array.isArray(almanaque) ? almanaque : [];
const brl = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const countFmt = new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0});
const baseData = {atualizado_em:null,fonte:'Aguardando fonte oficial',resultado:{},rankings:{},receptivo:{}};
const options = {snapshot_url:'',fila_url:'',intervalo_dados_segundos:30,intervalo_fila_segundos:5};
let config={...options}, data={...baseData},frames=[],frame=0,lastDay='',transitionToken=0;
const money=n=>typeof n==='number' && Number.isFinite(n) && n>=0?brl.format(n):'—';
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
 $('projecaoHonorarios').textContent=money(r.projecao_honorarios_mes)+(r.projecao_parcial===true&&typeof r.projecao_honorarios_mes==='number'?' · parcial':'');
 $('recuperadoMes').textContent=money(r.recuperado_mes);
 const percent=typeof r.honorarios_mes==='number'&&typeof r.projecao_honorarios_mes==='number'&&r.projecao_honorarios_mes>0?100*r.honorarios_mes/r.projecao_honorarios_mes:0;
 $('monthFill').style.width=`${Math.min(100,Math.max(0,percent)).toFixed(1)}%`;
 const d=validDate(data.atualizado_em);
 $('statusDados').textContent=d?`Última leitura: ${new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d)}`:'Aguardando fonte oficial';
}
function renderRanks(kind='honorarios'){
 const labels={honorarios:'TOP HONORÁRIOS',valor_recuperado:'TOP VALOR RECUPERADO',pagamentos:'TOP PAGAMENTOS',acordos:'TOP ACORDOS'};
 $('rankCategory').textContent=labels[kind]||'RESULTADOS DO MÊS';
 const ranks=Array.isArray(data.rankings?.[kind])?data.rankings[kind]:[];
 const host=$('rankItems');host.replaceChildren();
 for(let i=0;i<3;i++){
  const el=document.createElement('div');el.className=`rank-entry ${['rank-one','rank-two','rank-three'][i]}`;
  const medal=document.createElement('span');medal.className='rank-medal';medal.textContent=`${i+1}º`;
  const who=document.createElement('span');who.className='operator-name';who.textContent=nameOf(ranks[i])||'Aguardando classificação';
  el.append(medal,who);host.append(el);
 }
}
function renderQueue(){
 const q=data.receptivo||{};const stamped=validDate(q.atualizado_em);const fresh=stamped&&Date.now()-stamped.getTime()>=0&&Date.now()-stamped.getTime()<90000;
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
 const core=[{kind:'honorarios',rank:'honorarios'},{kind:'resultados',rank:'honorarios'},{kind:'ranking',rank:'honorarios'},{kind:'ranking',rank:'valor_recuperado'},{kind:'ranking',rank:'pagamentos'},{kind:'ranking',rank:'acordos'}];
 const training=(today?.slides||[]).map(item=>({kind:'treino',rank:'honorarios',item,theme:today.theme}));
 return [...core,...training];
}
function buildFrames(){frames=makeFrames();frame=0;renderFrame();}
function viewFor(f){
 const r=data.resultado||{};const result={kicker:'RESULTADOS REATIVA',title:'Honorários em destaque',body:'A base da nossa recuperação é a geração de honorários.',quote:'Acompanhamento atualizado do resultado da operação.',footerTitle:'HONORÁRIOS NO MÊS',footer:money(r.honorarios_mes)};
 if(f.kind==='honorarios')return result;
 if(f.kind==='resultados')return {kicker:'RESULTADOS DA OPERAÇÃO',title:'Recuperação em foco',body:'Pagamento confirmado, negociação bem conduzida e resultado sustentável.',quote:'Recuperado no mês: '+money(r.recuperado_mes),footerTitle:'PAGAMENTOS CONFIRMADOS HOJE',footer:count(isToday()?r.pagamentos_confirmados_hoje:null)};
 if(f.kind==='ranking'){
  const names={honorarios:'Honorários',valor_recuperado:'Valor recuperado',pagamentos:'Pagamentos',acordos:'Acordos'};
  return {kicker:'RECONHECIMENTO REATIVA',title:`Top ${names[f.rank]||'do mês'}`,body:'Os três primeiros colocados em destaque. Sem valores individuais.',quote:'Reconhecimento por desempenho, consistência e qualidade operacional.',footerTitle:'CATEGORIA DO MÊS',footer:names[f.rank]||''};
 }
 const s=f.item||{};
 return {kicker:s.kicker||'NEGOCIAÇÃO EM FOCO',title:s.title||'Negociação',body:s.body||'',quote:s.quote||'',footerTitle:'FOCO PRÁTICO',footer:s.footer||''};
}
function setMainText(f){
 const x=viewFor(f);$('contentCategory').textContent=x.kicker.toLocaleUpperCase('pt-BR');
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
 renderRanks(f.rank);
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
async function readSnapshot(){
 try{const fresh=await getJSON(config.snapshot_url||'./dados-tv.json');if(!isObject(fresh)||!isObject(fresh.resultado))throw Error('dados inválidos');
  data={...data,...fresh,resultado:{...data.resultado,...fresh.resultado},rankings:{...data.rankings,...fresh.rankings},receptivo:{...data.receptivo,...fresh.receptivo}};
  renderResults();renderQueue();if(frames.length)renderFrame();
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
 setInterval(updateTime,1000);setInterval(updateWeather,30*60*1000);
 setInterval(readSnapshot,Math.max(10,Number(config.intervalo_dados_segundos)||30)*1000);
 setInterval(readQueue,Math.max(3,Number(config.intervalo_fila_segundos)||5)*1000);
 setInterval(renderQueue,5000);
 setInterval(()=>{if(!frames.length)return;frame=(frame+1)%frames.length;renderFrame();},25000);
}
$('fullscreenButton').addEventListener('click',()=>{const doc=document.documentElement;if(document.fullscreenElement){document.exitFullscreen?.();return;}doc.requestFullscreen?.().catch(()=>{});});
document.addEventListener('keydown',e=>{if(!frames.length)return;if(e.key==='ArrowRight'){frame=(frame+1)%frames.length;renderFrame();}if(e.key==='ArrowLeft'){frame=(frame+frames.length-1)%frames.length;renderFrame();}if(e.key.toLowerCase()==='f')$('fullscreenButton').click();});
start();
})();
