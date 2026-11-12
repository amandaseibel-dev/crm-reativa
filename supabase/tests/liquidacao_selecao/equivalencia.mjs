// Equivalencia da SELECAO de candidatos da liquidacao: versao atual x versao com
// `ex` filtrado pelos boletos abertos ANTES do DISTINCT ON.
// Dados FICTICIOS, PGlite (Postgres embutido). Nao executa a funcao de producao,
// nao executa suspender/reavaliar, nao grava nada fora deste processo.
import { PGlite } from "@electric-sql/pglite";

const LIMITE_RSS_MB = 500;
const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const vigia = setInterval(() => {
  if (rssMb() > LIMITE_RSS_MB) { console.error(`INTERROMPIDO rss=${rssMb()}MB`); process.exit(2); }
}, 300);

let semente = 7;
const rnd = () => ((semente = (semente * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (l) => l[Math.floor(rnd() * l.length)];

const N_TIT = 1500;
const db = new PGlite();
await db.exec(`
  create table acordos_titulos (id bigint primary key, aluno_id text, documento text, vencimento date,
    created_at timestamptz, situacao text, status text, tipo_boleto text,
    valor_cobranca_ajustado numeric, saldo_corrigido numeric, valor_em_aberto numeric, valor_original numeric);
  create table prime_extrato (matricula text, boleto text, liquidado_em date, portador int,
    valor_bruto numeric, valor_pago numeric, coletado_em timestamptz, primary key (matricula, boleto));
  create index ix_prime_extrato_boleto_ltrim on prime_extrato (ltrim(boleto, '0'));
  create table prime_liquidacao_classificacao (titulo_id bigint, evidencia_chave text, origem_decisao text);
  create table prime_conferencia_decisao (titulo_id bigint primary key, decisao text, evidencia jsonb);
  create or replace function prime_liquidacao_chave(doc text, dt date, p int) returns text
    language sql immutable as $$ select coalesce(doc,'') || '|' || coalesce(dt::text,'') || '|' || coalesce(p::text,'') $$;
`);

const situacoes = ["ABERTO", "ABERTO", "ABERTO", "NEGOCIADO", "QUITADA", "CANCELADO"];
const tipos = ["Boleto", "Boleto", "Acordo", null];
const decisoes = ["PENDENTE", "REJEITADO", "VINCULADO", "CONFIRMADO", "ENCERRADO_ADMINISTRATIVO", "DEVOLVIDO"];
const base = Date.UTC(2026, 0, 1);
const dia = (d) => new Date(base + d * 86400000).toISOString().slice(0, 10);

const titulos = [];
for (let i = 1; i <= N_TIT; i++) {
  const doc = rnd() < 0.2 ? "0" + String(100000 + i) : String(100000 + i);
  const venc = Math.floor(rnd() * 300);
  titulos.push([
    i, "aluno-" + (i % 700), doc, dia(venc), new Date(base + Math.floor(rnd() * 250) * 86400000).toISOString(),
    pick(situacoes), pick(["em_aberto", "quitada", null]), pick(tipos),
    rnd() < 0.5 ? Math.round(rnd() * 900 * 100) / 100 : null, Math.round(rnd() * 900 * 100) / 100,
    rnd() < 0.5 ? Math.round(rnd() * 900 * 100) / 100 : null, Math.round(rnd() * 900 * 100) / 100,
  ]);
}
for (const t of titulos) {
  await db.query(`insert into acordos_titulos values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, t);
}

// Extrato: para ~45% dos titulos, uma liquidacao plausivel (portador 195, depois
// do vencimento+30, coleta depois da liquidacao) + coletas antigas/novas do mesmo
// boleto (DISTINCT ON precisa escolher a mais recente). Restante: ruido.
const extratoRows = [];
let mi = 0;
for (const t of titulos) {
  const boletoBruto = t[2].startsWith("0") ? t[2] : (rnd() < 0.5 ? "0" + t[2] : t[2]);
  const vencD = Math.round((Date.parse(t[3]) - base) / 86400000);
  if (rnd() < 0.45) {
    const liqD = vencD + 31 + Math.floor(rnd() * 60);
    const coletaAntigaD = liqD + 1 + Math.floor(rnd() * 5);
    const coletaNovaD = coletaAntigaD + 1 + Math.floor(rnd() * 20);
    extratoRows.push(["m" + mi++, boletoBruto, dia(liqD), 195, 100, 90, new Date(base + coletaAntigaD * 86400000).toISOString()]);
    if (rnd() < 0.5) {
      // coleta mais nova com outra data de liquidacao (ou nula): DISTINCT ON fica com esta
      const liq2 = rnd() < 0.5 ? null : dia(liqD + 1);
      extratoRows.push(["m" + mi++, boletoBruto, liq2, 195, 100, 0, new Date(base + coletaNovaD * 86400000).toISOString()]);
    }
  }
  if (rnd() < 0.3) {
    extratoRows.push(["m" + mi++, boletoBruto, dia(Math.floor(rnd() * 320)), pick([95, 160, 166]),
      Math.round(rnd() * 900 * 100) / 100, 0, new Date(base + Math.floor(rnd() * 300) * 86400000).toISOString()]);
  }
}
for (let i = 0; i < 2000; i++) {
  const t = pick(titulos);
  extratoRows.push(["m" + mi++, rnd() < 0.5 ? "0" + t[2] : t[2], rnd() < 0.8 ? dia(Math.floor(rnd() * 320)) : null,
    pick([195, 195, 95]), 50, 40, new Date(base + Math.floor(rnd() * 320) * 86400000).toISOString()]);
}
for (let i = 0; i < extratoRows.length; i += 400) {
  const lote = extratoRows.slice(i, i + 400);
  const vals = []; const params = [];
  lote.forEach((r, j) => { const b = j * 7; vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`); params.push(...r); });
  await db.query(`insert into prime_extrato values ${vals.join(",")} on conflict do nothing`, params);
}

// Decisoes humanas e classificacoes existentes (exercitam as exclusoes NOT EXISTS)
for (const t of titulos) {
  if (rnd() < 0.35) {
    const d = pick(decisoes);
    const evid = JSON.stringify({ liquidado_em: dia(Math.floor(rnd() * 320)) });
    await db.query(`insert into prime_conferencia_decisao values ($1,$2,$3::jsonb)`, [t[0], d, evid]);
  }
}
for (const t of titulos) {
  if (rnd() < 0.1) {
    await db.query(`insert into prime_liquidacao_classificacao values ($1,$2,$3)`,
      [t[0], "x", pick(["ROTINA", "CORTE", "MANUAL"])]);
  }
}

// Selecao ATUAL (copiada da funcao em producao, sem as tabelas temporarias)
const selecaoAtual = (limite) => `
  with cob as (
    select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date as imp, upper(coalesce(t.situacao,'')) as situacao,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from acordos_titulos t
     where coalesce(t.tipo_boleto,'') <> 'Acordo'
       and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
  ),
  ex as (
    select distinct on (ltrim(e.boleto,'0')) ltrim(e.boleto,'0') as boleto, e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago, e.coletado_em
      from prime_extrato e
     where e.liquidado_em is not null
     order by ltrim(e.boleto,'0'), e.coletado_em desc
  )
  select c.id as titulo_id, c.aluno_id, c.v, ex.liquidado_em, ex.portador, ex.valor_bruto, ex.valor_pago,
         prime_liquidacao_chave(c.documento, ex.liquidado_em, ex.portador) as chave
    from cob c join ex on ex.boleto = ltrim(coalesce(c.documento,''),'0')
   where ex.portador = 195
     and ex.liquidado_em > c.vencimento + 30
     and ex.liquidado_em >= c.imp
     and ex.liquidado_em <> c.imp
     and ex.liquidado_em <= ex.coletado_em::date
     and ex.liquidado_em <= current_date
     and not exists (select 1 from prime_liquidacao_classificacao k
                      where k.titulo_id = c.id and k.evidencia_chave = prime_liquidacao_chave(c.documento, ex.liquidado_em, ex.portador)
                        and k.origem_decisao in ('ROTINA','CORTE'))
     and not exists (select 1 from prime_conferencia_decisao d
                      where d.titulo_id = c.id
                        and (d.decisao = 'PENDENTE'
                             or (d.decisao = 'REJEITADO'
                                 and coalesce((d.evidencia->>'liquidado_em')::date) = ex.liquidado_em)))
   order by c.v desc, c.id
   limit greatest(coalesce(${limite}, 500), 1)`;

// Selecao NOVA: o mesmo, com `ex` restrito aos boletos dos titulos em cobranca ANTES do DISTINCT ON
const selecaoNova = (limite) => selecaoAtual(limite).replace(
  `from prime_extrato e
     where e.liquidado_em is not null
     order by`,
  `from prime_extrato e
     where e.liquidado_em is not null
       and ltrim(e.boleto,'0') in (select ltrim(coalesce(t.documento,''),'0') from acordos_titulos t
            where coalesce(t.tipo_boleto,'') <> 'Acordo'
              and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
              and coalesce(lower(t.status),'') <> 'quitada')
     order by`
);

const chaves = (r) => r.rows.map((x) => [x.titulo_id, x.aluno_id, String(x.v), String(x.liquidado_em), x.portador, String(x.valor_bruto), String(x.valor_pago), x.chave].join("|"));
const resultados = {};
for (const limite of [500, 50, 7]) {
  const a = await db.query(selecaoAtual(limite));
  const n = await db.query(selecaoNova(limite));
  const ca = chaves(a), cn = chaves(n);
  resultados[`limite_${limite}`] = {
    candidatosAtual: ca.length,
    candidatosNovo: cn.length,
    mesmaOrdemEConteudo: JSON.stringify(ca) === JSON.stringify(cn),
    idsIguais: JSON.stringify(a.rows.map((x) => x.titulo_id)) === JSON.stringify(n.rows.map((x) => x.titulo_id)),
    valoresIguais: JSON.stringify(a.rows.map((x) => String(x.v))) === JSON.stringify(n.rows.map((x) => String(x.v))),
  };
}

// Medida do conjunto de extrato lido: linhas que o DISTINCT ON enxerga em cada versao
const linhasAtual = (await db.query(`select count(*)::int n from prime_extrato where liquidado_em is not null`)).rows[0].n;
const linhasNovo = (await db.query(`select count(*)::int n from prime_extrato e where e.liquidado_em is not null and ltrim(e.boleto,'0') in (select ltrim(coalesce(t.documento,''),'0') from acordos_titulos t where coalesce(t.tipo_boleto,'') <> 'Acordo' and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO') and coalesce(lower(t.status),'') <> 'quitada')`)).rows[0].n;

console.log(JSON.stringify({ titulos: N_TIT, extratoLinhas: extratoRows.length, linhasExtratoLidasAtual: linhasAtual, linhasExtratoLidasNovo: linhasNovo, resultados, rssMb: rssMb() }, null, 2));
clearInterval(vigia);
await db.close();
