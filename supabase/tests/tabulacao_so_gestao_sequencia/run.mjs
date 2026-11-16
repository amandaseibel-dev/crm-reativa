// Harness da sequência de 20261106140000 (trava SÓ GESTÃO no banco).
//
// Roda, nesta ordem, num Postgres descartável (PGDATABASE deve ser um banco vazio):
//   1. ambiente + barreira de produção (como o job da CI)
//   2. DEPENDÊNCIA AUSENTE (ordem inválida): sem a linha RETORNO_FINANCEIRO, a migração
//      recusa e NADA muda. Isto NÃO prova que 20261106120000 foi aplicada inteira.
//   3. ORDEM CORRETA: com a linha, a migração aplica e o md5 do corpo final é o medido
//   4. NORMALIZAÇÃO nos três campos (status_atual, status_jornada, status_acionamento):
//      variante restrita é recusada (42501) para operador; gestão e código comum passam.
//
// psql não é exigido: cada arquivo é executado pelo cliente `pg`, com `\i` resolvido
// e as demais meta-linhas (\set, \connect) descartadas.
// Uso: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE node run.mjs   (a partir da raiz do repo)

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRACAO = "supabase/aguardando_aprovacao/20261106140000_tabulacao_so_gestao_no_banco.sql.pendente";
const TDIR = "supabase/tests/tabulacao_termo_fisico_gestao";
const MD5_PRE = "ae0382adc0eaf11fbe68d9ed0fc4a9b4";
const MD5_FINAL = "d4a7f02cbcb0657defe69b9598e1e157";
const PAPEL_TESTE = "teste_app_sequencia";

const CAMPOS = ["status_atual", "status_jornada", "status_acionamento"];
const RESTRITOS = [
  "CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "JURIDICO", "ANTECIPACAO_SEMESTRE",
  "ALEGA_FIES_CONFIRMADO", "ALEGA_CREDIES_CONFIRMADO", "ALEGA_FINANCIAMENTO_CONFIRMADO",
  "RETORNO_FINANCEIRO",
];
const OPERADOR = "operador.teste@exemplo.local";
const GESTAO = "amanda.seibel@aelbra.com.br";
const ALUNO = "a0000000-0000-0000-0000-000000000042";

function sqlDe(relativo) {
  const texto = readFileSync(resolve(RAIZ, relativo), "utf8");
  return texto
    .split("\n")
    .map((linha) => {
      const m = linha.match(/^\\i\s+(\S+)\s*$/);
      if (m) return sqlDe(m[1]);
      if (linha.startsWith("\\")) return ""; // \set, \connect: não existem sem psql
      return linha;
    })
    .join("\n");
}

function conexao(usuario, senha) {
  return new Client({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: usuario || process.env.PGUSER,
    password: senha || process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  });
}

const falhas = [];
const ok = (msg) => console.log(`PASS  ${msg}`);
const falha = (msg) => {
  falhas.push(msg);
  console.log(`FAIL  ${msg}`);
};
function afirma(cond, msg) {
  cond ? ok(msg) : falha(msg);
}

async function fotografia(c) {
  const md5 = await c.query(
    "select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_encerramento_so_gestao'",
  );
  const tab = await c.query("select count(*)::int as n, coalesce(md5(string_agg(codigo||rotulo||ordem||somente_gestao, '|' order by codigo)),'') as m from public.tabulacoes");
  const trg = await c.query("select coalesce(string_agg(tgname, ',' order by tgname),'') as t from pg_trigger where not tgisinternal and tgrelid='public.alunos'::regclass");
  const alu = await c.query("select md5(string_agg(id||status_atual||status_jornada||status_acionamento, '|' order by id)) as m from public.alunos");
  return JSON.stringify([md5.rows[0].m, tab.rows[0], trg.rows[0].t, alu.rows[0].m]);
}

async function main() {
  const c = conexao();
  await c.connect();

  // 1. ambiente e barreira, como o job da CI
  await c.query(sqlDe(`${TDIR}/01_ambiente.sql`));
  await c.query(sqlDe(`${TDIR}/00_barreira_producao.sql`));
  const pre = await c.query("select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_encerramento_so_gestao'");
  afirma(pre.rows[0].m === MD5_PRE, `pré-estado de _encerramento_so_gestao = âncora de produção (${MD5_PRE})`);

  // 2. ORDEM INVÁLIDA: sem RETORNO_FINANCEIRO no catálogo, a migração recusa e nada muda
  await c.query("delete from public.tabulacoes where codigo = 'RETORNO_FINANCEIRO'");
  const antes = await fotografia(c);
  let erroInvalida = null;
  try {
    await c.query(sqlDe(MIGRACAO));
  } catch (e) {
    erroInvalida = e;
  }
  await c.query("rollback").catch(() => {});
  afirma(erroInvalida !== null, "ordem inválida: migração recusada sem RETORNO_FINANCEIRO");
  afirma(erroInvalida && /RETORNO_FINANCEIRO/.test(erroInvalida.message), "dependência ausente: a mensagem nomeia RETORNO_FINANCEIRO");
  afirma((await fotografia(c)) === antes, "ordem inválida: nenhuma alteração no banco (função, catálogo, gatilhos, alunos)");

  // 3. ORDEM CORRETA: com a linha da tabulação, aplica e o corpo final é o medido
  await c.query(`insert into public.tabulacoes (codigo, rotulo, ativa, ordem, grupo, retorno_modo, proxima_acao, somente_gestao)
                 values ('RETORNO_FINANCEIRO','Retorno do financeiro',true,340,'FINANCEIRO','NENHUM','CONTATAR',true)`);
  let erroCorreta = null;
  try {
    await c.query(sqlDe(MIGRACAO));
  } catch (e) {
    erroCorreta = e;
  }
  if (erroCorreta) await c.query("rollback").catch(() => {});
  afirma(erroCorreta === null, `dependência presente: migração aplicada sem erro${erroCorreta ? ` (erro: ${erroCorreta.message})` : ""}`);
  const depois = await c.query("select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_encerramento_so_gestao'");
  afirma(depois.rows[0].m === MD5_FINAL, `md5(prosrc) final = ${MD5_FINAL} (medido: ${depois.rows[0].m})`);
  await c.end();

  // 4. NORMALIZAÇÃO nos três campos, como papel de aplicação (não é dono: o gatilho decide)
  const admin = conexao();
  await admin.connect();
  await admin.query(`do $r$ begin
      if not exists (select 1 from pg_roles where rolname='${PAPEL_TESTE}') then
        create role ${PAPEL_TESTE} login;
      end if;
    end $r$`);
  await admin.query(`alter role ${PAPEL_TESTE} login password '${PAPEL_TESTE}'`);
  await admin.query(`grant authenticated to ${PAPEL_TESTE}`);
  await admin.end();

  const app = conexao(PAPEL_TESTE, PAPEL_TESTE);
  await app.connect();
  const claims = (email) => app.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email, role: "authenticated" })]);
  const variantes = (base) => [
    base, ` ${base}`, `\t${base}\n`, `\r${base}`, `${base}​`, `​${base}`,
    `﻿${base}`, ` ${base}`, base.toLowerCase(),
  ];

  await claims(OPERADOR);
  let recusadas = 0;
  let tentativas = 0;
  const naoRecusadas = [];
  for (const campo of CAMPOS) {
    for (const base of RESTRITOS) {
      for (const v of new Set(variantes(base))) {
        tentativas++;
        try {
          await app.query("begin");
          await app.query(`update public.alunos set ${campo} = $1 where id = $2`, [v, ALUNO]);
          naoRecusadas.push(`${campo}=${JSON.stringify(v)}`);
          await app.query("rollback");
        } catch (e) {
          await app.query("rollback").catch(() => {});
          if (e.code === "42501" && /(decis.o da gest.o|restrita . gest.o)/.test(e.message)) recusadas++;
          else naoRecusadas.push(`${campo}=${JSON.stringify(v)} (erro ${e.code}: ${e.message})`);
        }
      }
    }
  }
  afirma(naoRecusadas.length === 0 && recusadas === tentativas,
    `normalização: operador recusado em ${recusadas}/${tentativas} variantes restritas (42501) nos três campos${naoRecusadas.length ? ` — passaram: ${naoRecusadas.slice(0, 5).join(" ; ")}` : ""}`);

  let comumOk = 0;
  for (const campo of CAMPOS) {
    await app.query("begin");
    const r = await app.query(`update public.alunos set ${campo} = 'CONTATAR' where id = $1`, [ALUNO]);
    await app.query("rollback");
    if (r.rowCount === 1) comumOk++;
  }
  afirma(comumOk === CAMPOS.length, "normalização: código comum (CONTATAR) passa nos três campos");

  await claims(GESTAO);
  let gestaoOk = 0;
  for (const campo of CAMPOS) {
    await app.query("begin");
    const r = await app.query(`update public.alunos set ${campo} = 'CANCELAMENTO_COBRANCA' where id = $1`, [ALUNO]);
    await app.query("rollback");
    if (r.rowCount === 1) gestaoOk++;
  }
  afirma(gestaoOk === CAMPOS.length, "normalização: gestão passa com código restrito nos três campos");

  await app.end();

  console.log(falhas.length === 0 ? "\nTODOS OS CASOS PASSARAM" : `\n${falhas.length} FALHA(S)`);
  process.exit(falhas.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO FATAL:", e.message);
  process.exit(2);
});
