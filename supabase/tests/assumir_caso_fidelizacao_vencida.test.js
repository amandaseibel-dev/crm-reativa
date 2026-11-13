// ASSUMIR CASO COM FIDELIZACAO VENCIDA -- teste de comportamento.
//
// Roda a MIGRATION PENDENTE
// (supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente)
// num PostgreSQL real (PGlite), sobre as mesmas fixtures de producao usadas por
// assumir_caso_livre_teto_e_tres_carteiras.test.js, com o md5 do prosrc conferido.
// A migration NAO foi aplicada em banco nenhum.

globalThis.process.env.TZ = "UTC";

import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const FIXTURE = ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.sql");
const MD5_BASE = JSON.parse(ler("supabase/tests/fixtures/fidelizacao_por_dono_prod_20260930.md5.json"));
const COMPLEMENTO = ler("supabase/tests/fixtures/assumir_caso_livre_prod_20261020.sql");
const MD5_COMPL = JSON.parse(ler("supabase/tests/fixtures/assumir_caso_livre_prod_20261020.md5.json"));
const FIXTURE3 = ler("supabase/tests/fixtures/assumir_caso_fidelizacao_vencida_prod_20261113.sql");
const MD5_FIX3 = JSON.parse(ler("supabase/tests/fixtures/assumir_caso_fidelizacao_vencida_prod_20261113.md5.json"));
const ROLLBACK = ler("supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.rollback.sql");
const MIGRATION = ler("supabase/aguardando_aprovacao/20261113120000_assumir_caso_fidelizacao_vencida.sql.pendente");

const LUANA = "cobranca05@aelbra.com.br";
const MAURICIO = "cobranca06@aelbra.com.br";
const OLGA = "cobranca03@aelbra.com.br";

const ext = { unaccent, pg_trgm, uuid_ossp };
const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CPF = (n) => String(30000000000 + n);

const hoje = new Date();
const diasAtras = (n) => new Date(hoje.getTime() - n * 86400000).toISOString().slice(0, 10);

const como = (db, email) =>
  db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);

// A RPC recebe o id do ALUNO. O helper recebe o id do caso (como os testes ja usam)
// e resolve o aluno a partir dele.
const tomar = async (db, casoId, motivo = "Cliente pediu atendimento") => {
  const a = await q1(db, "select aluno_id from public.casos where id=$1", [casoId]);
  return q1(db, "select * from public.assumir_caso_fidelizacao_vencida($1,$2)", [a.aluno_id, motivo]);
};

async function construir() {
  const db = new PGlite({ extensions: ext });
  await db.exec(FIXTURE);
  await db.exec(COMPLEMENTO);
  await db.exec(FIXTURE3);

  const rows = await qn(db,
    `select n.nspname||'.'||p.proname nome, md5(p.prosrc) md5
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','internal')`);
  const noBanco = Object.fromEntries(rows.map((r) => [r.nome, r.md5]));
  for (const [nome, md5] of Object.entries({ ...MD5_BASE, ...MD5_COMPL, ...MD5_FIX3 })) {
    if (noBanco[nome] !== md5) throw new Error(`fixture diverge de producao: ${nome}`);
  }

  await db.exec(`
    insert into public.usuarios (nome, email, perfil, ativo, operador_nome, recebe_novos_casos) values
      ('LUANA',    '${LUANA}',    'operador', true,  'LUANA',    true),
      ('MAURICIO', '${MAURICIO}', 'operador', true,  'MAURICIO', true),
      ('OLGA',     '${OLGA}',     'operador', false, 'OLGA',     false);
    insert into public.calibragem_parametros (chave, valor) values ('limite_carteira', '700'::jsonb)
      on conflict (chave) do update set valor = excluded.valor;
  `);
  return db;
}

async function cenario(db, n, o = {}) {
  const {
    dono = MAURICIO, saldo = 500, statusAtual = null, statusAcion = null,
    giroAte = null, dua = diasAtras(20),
  } = o;
  const cpf = CPF(n);
  await db.query(
    `insert into public.alunos (id, cpf, nome, matricula, responsavel_atual_email, responsavel_atual_nome, responsavel_atual_em)
     values ($1,$2,$3,$4,$5,'DONO', now() - interval '5 days')`,
    [U(n), cpf, `Aluno Sintetico ${n}`, `M${n}`, dono]);
  if (saldo > 0) {
    await db.query(
      `insert into public.acordos_titulos (aluno_id, cpf, documento, vencimento,
          valor_original, saldo_corrigido, situacao, status)
       values ($1,$2,$3,'2026-03-10',$4,$4,'ABERTO','em_aberto')`,
      [U(n), cpf, `DOC${n}`, saldo]);
  }
  const caso = await q1(db,
    `insert into public.casos (aluno_id, cpf, cpf_limpo, nome, operador_email, operador_nome, status_atual,
        status_acionamento, data_ultimo_acionamento, giro_fidelizacao_ate, ultima_tabulacao_em, caso_codigo)
     values ($1,$2,$2,$3,$4,'DONO',$5,$6,$7,$8,'2026-08-01T10:00:00',$9) returning id`,
    [U(n), cpf, `Aluno Sintetico ${n}`, dono, statusAtual, statusAcion, dua, giroAte, n]);
  return caso.id;
}

let SEM;
let COM;

beforeAll(async () => {
  const b1 = await construir();
  SEM = await b1.dumpDataDir();
  await b1.close();

  const b2 = await construir();
  await b2.exec(MIGRATION);
  COM = await b2.dumpDataDir();
  await b2.close();
});

const abrirCom = () => new PGlite({ loadDataDir: COM, extensions: ext });

describe("operador assume caso com fidelização vencida", () => {
  it("assume caso do colega com 20 dias sem acionamento, sem destinatário escolhido", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 1, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(true);

    const c = await q1(db, "select operador_email, data_ultimo_acionamento from public.casos where id=$1", [caso]);
    expect(c.operador_email).toBe(LUANA);
    // a data do ultimo acionamento NAO pode ser apagada pela troca
    expect(c.data_ultimo_acionamento).not.toBeNull();

    const h = await q1(db,
      `select acao, operador_anterior_email, operador_email, observacao from public.historico_operadores_alunos
        where acao='ASSUMIR_FIDELIZACAO_VENCIDA'`);
    expect(h.operador_anterior_email).toBe(MAURICIO);
    expect(h.operador_email).toBe(LUANA);
    expect(h.observacao).toContain("Motivo: Cliente pediu atendimento");
    expect(h.observacao).toContain(`Autor: ${LUANA}`);
    await db.close();
  });

  it("recusa caso ainda dentro dos 10 dias (acionamento de ontem)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 2, { dono: MAURICIO, dua: diasAtras(1) });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("dentro do prazo de 10 dias");
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(MAURICIO);
    await db.close();
  });

  it("recusa caso protegido (acordo/negociação em andamento)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 3, { dono: MAURICIO, statusAcion: "ACORDO FECHADO" });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao elegivel");
    await db.close();
  });

  it("recusa caso com giro de carteira vigente", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 4, { dono: MAURICIO, giroAte: diasAtras(-30) });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("giro");
    await db.close();
  });

  it("recusa caso sem dono (esse é o fluxo de assumir livre)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 5, { dono: null });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("Assumir atendimento");
    await db.close();
  });

  it("recusa dono que já é o próprio operador", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 6, { dono: LUANA });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("recusa dono inativo (carteira da Olga), que tem fluxo próprio", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 7, { dono: OLGA });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("Assumir atendimento");
    await db.close();
  });

  it("recusa quando a carteira já está no teto vigente", async () => {
    const db = await abrirCom();
    await db.exec(`update public.calibragem_parametros set valor='2'::jsonb where chave='limite_carteira'`);
    await cenario(db, 8, { dono: LUANA });
    await cenario(db, 9, { dono: LUANA });
    const caso = await cenario(db, 10, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("teto");
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(MAURICIO);
    await db.close();
  });

  it("exige motivo", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 11, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso, "   ");
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("motivo");
    await db.close();
  });

  it("recusa segunda tomada do mesmo caso (já é de LUANA agora)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 12, { dono: MAURICIO });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    await como(db, MAURICIO);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    await db.close();
  });

  it("recusa caso com encerramento sem saldo congelado (sem resolver)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 13, { dono: MAURICIO });
    await db.query(
      `insert into public.caso_encerramento_sem_saldo (escopo, caso_id, classificacao, estado_anterior, justificativa, origem)
       values ('CASO', $1, 'MANTIDO_PELA_GESTAO', '{}'::jsonb, 'teste', 'GESTAO')`, [caso]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("congelado");
    await db.close();
  });

  it("recusa caso sem saldo em aberto", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 14, { dono: MAURICIO, saldo: 0 });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("recusa responsável trocado nas últimas 24h (hold do cron)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 15, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_em = now() - interval '2 hours' where id=$1", [U(15)]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("24h");
    await db.close();
  });

  it("aceita caso que nunca foi acionado (mesma regra da liberação automática)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 16, { dono: MAURICIO, dua: null });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    await db.close();
  });

  it("auditoria: a troca de responsável do aluno vai para aluno_movimentacoes com autor", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 17, { dono: MAURICIO });
    await como(db, LUANA);
    expect((await tomar(db, caso, "Assumir por fidelizacao vencida")).sucesso).toBe(true);
    const m = await q1(db,
      "select tipo, operador_anterior_email, operador_novo_email, registrado_por_email from public.aluno_movimentacoes where aluno_id=$1 order by registrado_em desc limit 1",
      [U(17)]);
    expect(m.tipo).toBe("ASSUMIR_FIDELIZACAO_VENCIDA");
    expect(m.operador_anterior_email).toBe(MAURICIO);
    expect(m.operador_novo_email).toBe(LUANA);
    expect(m.registrado_por_email).toBe(LUANA);
    // o acionamento do aluno nao pode ser apagado pela troca
    const a = await q1(db, "select data_ultimo_acionamento from public.alunos where id=$1", [U(17)]);
    expect(a.data_ultimo_acionamento).toBeNull();
    await db.close();
  });

  it("permissões: só authenticated executa; anon e public não", async () => {
    const db = await abrirCom();
    const p = await q1(db, `select has_function_privilege('anon','public.assumir_caso_fidelizacao_vencida(uuid,text)','execute') a,
                                   has_function_privilege('authenticated','public.assumir_caso_fidelizacao_vencida(uuid,text)','execute') u`);
    expect(p.a).toBe(false);
    expect(p.u).toBe(true);
    await db.close();
  });

  it("recusa quando um acionamento válido foi gravado só no ALUNO (caminho que não toca o caso)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 18, { dono: MAURICIO });
    await db.query("update public.alunos set data_ultimo_acionamento = current_date where id=$1", [U(18)]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("dentro do prazo");
    await db.close();
  });

  it("recusa quando o responsável do aluno diverge do dono do caso (ambiguidade)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 19, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_email=$2 where id=$1", [U(19), OLGA]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("divergente");
    await db.close();
  });

  it("rollback remove a RPC e preserva a auditoria já gravada", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 20, { dono: MAURICIO });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    await db.exec(ROLLBACK);
    const existe = await q1(db, "select count(*)::int n from pg_proc where proname='assumir_caso_fidelizacao_vencida'");
    expect(existe.n).toBe(0);
    const aud = await q1(db, "select count(*)::int n from public.historico_operadores_alunos where acao='ASSUMIR_FIDELIZACAO_VENCIDA'");
    expect(aud.n).toBe(1);
    await db.close();
  });
});
