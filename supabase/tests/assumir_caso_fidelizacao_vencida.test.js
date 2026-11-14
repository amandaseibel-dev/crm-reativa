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
const GESTAO = "amanda.seibel@aelbra.com.br";

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
      ('OLGA',     '${OLGA}',     'operador', false, 'OLGA',     false),
      ('AMANDA GESTORA', '${GESTAO}', 'gerencia', true, null, false);
    update public.usuarios set pode_alterar_responsavel = true where lower(email) = '${GESTAO}';
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
     values ($1,$2,$3,$4,$5,'DONO', now() - interval '30 days')`,
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

let COM;

beforeAll(async () => {
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
    expect(r.mensagem).toContain("nao esta disponivel");
    expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(MAURICIO);
    await db.close();
  });

  it("recusa caso protegido (acordo/negociação em andamento)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 3, { dono: MAURICIO, statusAcion: "ACORDO FECHADO" });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao esta disponivel");
    await db.close();
  });

  it("recusa caso com giro de carteira vigente", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 4, { dono: MAURICIO, giroAte: diasAtras(-30) });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao esta disponivel");
    await db.close();
  });

  it("recusa caso sem dono (esse é o fluxo de assumir livre)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 5, { dono: null });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao esta disponivel");
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
    expect(r.mensagem).toContain("nao esta disponivel");
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
    expect(r.mensagem).toContain("nao esta disponivel");
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
    expect(r.mensagem).toContain("nao esta disponivel");
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
    expect(r.mensagem).toContain("nao esta disponivel");
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
      "select tipo, operador_anterior_email, operador_novo_email, registrado_por_email from public.aluno_movimentacoes where aluno_id=$1 and tipo='ASSUMIR_FIDELIZACAO_VENCIDA'",
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
    expect(r.mensagem).toContain("nao esta disponivel");
    await db.close();
  });

  it("recusa quando o responsável do aluno diverge do dono do caso (ambiguidade)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 19, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_email=$2 where id=$1", [U(19), OLGA]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("nao esta disponivel");
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

  it("fronteira: no 10º dia ainda protegido; no 11º dia assumível", async () => {
    const db = await abrirCom();
    const dia10 = await cenario(db, 30, { dono: MAURICIO, dua: null });
    await db.query("update public.casos set data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date - 10 where id=$1", [dia10]);
    await como(db, LUANA);
    expect((await tomar(db, dia10)).sucesso).toBe(false);
    await db.query("update public.casos set data_ultimo_acionamento = (now() at time zone 'America/Sao_Paulo')::date - 11 where id=$1", [dia10]);
    expect((await tomar(db, dia10)).sucesso).toBe(true);
    await db.close();
  });

  it("preserva o acionamento do aluno na troca de dono (gatilho instalado)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 31, { dono: MAURICIO, dua: null });
    await db.query("update public.alunos set data_ultimo_acionamento = current_date - 15, status_acionamento = 'ACIONADO' where id=$1", [U(31)]);
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    const a = await q1(db, "select data_ultimo_acionamento, status_acionamento from public.alunos where id=$1", [U(31)]);
    expect(a.data_ultimo_acionamento).not.toBeNull();
    expect(a.status_acionamento).toBe("ACIONADO");
    await db.close();
  });

  it("R2: responsável que recebeu o caso há 3 dias não perde o caso", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 40, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_em = now() - interval '3 days' where id=$1", [U(40)]);
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("R2: responsável há 11 dias perde o caso (regra de 10 dias)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 41, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_em = now() - interval '11 days' where id=$1", [U(41)]);
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    await db.close();
  });

  it("R2: sem repasse sucessivo: quem recebeu não é tirado por quem recebeu depois", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 42, { dono: MAURICIO });
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(true);
    await db.exec(`insert into public.usuarios (nome,email,perfil,ativo,operador_nome,recebe_novos_casos) values ('ANA','cobranca07@aelbra.com.br','operador',true,'ANA',true)`);
    await como(db, "cobranca07@aelbra.com.br");
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("R5: conta de gestão não usa esta ação", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 43, { dono: MAURICIO });
    await como(db, GESTAO);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(false);
    expect(r.mensagem).toContain("exclusiva de operadores");
    await db.close();
  });

  it("R5: operador ativo que não recebe novos casos não usa esta ação", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 44, { dono: MAURICIO });
    await db.exec(`update public.usuarios set recebe_novos_casos = false where lower(email) = '${LUANA}'`);
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("pré-condição P1: gatilho com corpo divergente faz a migration FALHAR", async () => {
    const db = await construir();
    await db.exec(`create or replace function public._acionamento_nao_volta_para_nulo() returns trigger language plpgsql as $f$ begin return new; end; $f$`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/divergente/);
    await db.close();
  });

  it("pré-condição P1: gatilho ausente faz a migration FALHAR", async () => {
    const db = await construir();
    await db.exec(`drop trigger trg_acionamento_nao_volta_para_nulo on public.alunos`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/ausente/);
    await db.close();
  });

  it("tabela de operações não é acessível pelo cliente", async () => {
    const db = await abrirCom();
    const p = await q1(db, "select has_table_privilege('authenticated','public.assumir_fidelizacao_operacoes','select') a");
    expect(p.a).toBe(false);
    await db.close();
  });

  describe("reversão por operação", () => {
    async function tomadaDeLuana(db, n) {
      const caso = await cenario(db, n, { dono: MAURICIO });
      await como(db, LUANA);
      const r = await tomar(db, caso);
      expect(r.sucesso).toBe(true);
      return { caso, op: r.operacao_id };
    }

    it("gestão reverte a operação sem conflito: caso volta ao anterior, histórico preservado", async () => {
      const db = await abrirCom();
      const { caso, op } = await tomadaDeLuana(db, 50);
      const antes = await q1(db, "select count(*)::int n from public.historico_operadores_alunos");
      await como(db, GESTAO);
      const r = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "Erro de atribuicao"]);
      expect(r.sucesso).toBe(true);
      expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(MAURICIO);
      const dep = await q1(db, "select count(*)::int n from public.historico_operadores_alunos");
      expect(dep.n).toBeGreaterThan(antes.n);
      const o = await q1(db, "select revertida_em is not null r from public.assumir_fidelizacao_operacoes where id=$1", [op]);
      expect(o.r).toBe(true);
      await db.close();
    });

    it("conflito: novo responsável movimentou o aluno depois da tomada → não reverte", async () => {
      const db = await abrirCom();
      const { caso, op } = await tomadaDeLuana(db, 51);
      await db.query(`insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,registrado_por_email,registrado_em)
                      values ($1,'FINALIZACAO_ATENDIMENTO','teste',$2, now() + interval '1 second')`, [U(51), LUANA]);
      await como(db, GESTAO);
      const r = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "x"]);
      expect(r.sucesso).toBe(false);
      expect(r.mensagem).toContain("Conflito");
      expect((await q1(db, "select operador_email e from public.casos where id=$1", [caso])).e).toBe(LUANA);
      await db.close();
    });

    it("conflito: o caso mudou de dono depois da tomada → não reverte", async () => {
      const db = await abrirCom();
      const { caso, op } = await tomadaDeLuana(db, 52);
      await db.query("update public.casos set operador_email=$2 where id=$1", [caso, OLGA]);
      await como(db, GESTAO);
      const r = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "x"]);
      expect(r.sucesso).toBe(false);
      expect(r.mensagem).toContain("mudou de responsavel");
      await db.close();
    });

    it("operador comum não reverte", async () => {
      const db = await abrirCom();
      const { op } = await tomadaDeLuana(db, 53);
      await como(db, MAURICIO);
      const r = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "x"]);
      expect(r.sucesso).toBe(false);
      await db.close();
    });

    it("a mesma operação não é revertida duas vezes", async () => {
      const db = await abrirCom();
      const { op } = await tomadaDeLuana(db, 54);
      await como(db, GESTAO);
      expect((await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "x"])).sucesso).toBe(true);
      const r2 = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [op, "x"]);
      expect(r2.sucesso).toBe(false);
      await db.close();
    });
  });

  it("recusa uniforme no teto: mesma mensagem de qualquer outra recusa", async () => {
    const db = await abrirCom();
    await db.exec(`update public.calibragem_parametros set valor='2'::jsonb where chave='limite_carteira'`);
    await cenario(db, 60, { dono: LUANA });
    await cenario(db, 61, { dono: LUANA });
    const teto = await cenario(db, 62, { dono: MAURICIO });
    const semDono = await cenario(db, 63, { dono: null });
    await como(db, LUANA);
    const a = await tomar(db, teto);
    const b = await tomar(db, semDono);
    expect(a.mensagem).toBe(b.mensagem);
    await db.close();
  });

  it("recusa responsável sem data da troca ou sem responsável (não dá para provar o prazo)", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 64, { dono: MAURICIO });
    await db.query("update public.alunos set responsavel_atual_em = null where id=$1", [U(64)]);
    await como(db, LUANA);
    expect((await tomar(db, caso)).sucesso).toBe(false);
    await db.close();
  });

  it("atendimento de OUTRO autor no mesmo dia depois da tomada impede a reversão", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 65, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    await db.query("update public.casos set data_ultimo_acionamento = current_date where id=$1", [caso]);
    await como(db, GESTAO);
    const rv = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [r.operacao_id, "x"]);
    expect(rv.sucesso).toBe(false);
    expect(rv.mensagem).toContain("Conflito");
    await db.close();
  });

  it("reversão restaura proxima ação e retorno do operador de origem", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 66, { dono: MAURICIO });
    await db.query("update public.alunos set proxima_acao='LIGAR CEDO', data_retorno = current_date + 5 where id=$1", [U(66)]);
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(true);
    await como(db, GESTAO);
    expect((await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [r.operacao_id, "x"])).sucesso).toBe(true);
    const a = await q1(db, "select proxima_acao, data_retorno::text d from public.alunos where id=$1", [U(66)]);
    expect(a.proxima_acao).toBe("LIGAR CEDO");
    await db.close();
  });

  it("reversão recusada se o responsável anterior foi desligado", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 67, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    await db.exec(`update public.usuarios set ativo=false where lower(email)='${MAURICIO}'`);
    await como(db, GESTAO);
    const rv = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [r.operacao_id, "x"]);
    expect(rv.sucesso).toBe(false);
    expect(rv.mensagem).toContain("nao pode receber");
    await db.close();
  });

  it("pré-condição P2 divergente: migration FALHA", async () => {
    const db = await construir();
    await db.exec(`create or replace function public.aluno_retorno_operador_vigente(p_aluno_id uuid) returns boolean language sql as $f$ select false $f$`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/P2 divergente/);
    await db.close();
  });

  it("pré-condição P2 ausente: migration FALHA", async () => {
    const db = await construir();
    await db.exec(`drop function public.aluno_retorno_operador_vigente(uuid)`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/P2 ausente/);
    await db.close();
  });

  it("backup por operação: guarda a linha do caso e do aluno ANTES da tomada e o estado pós-tomada", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 68, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    expect(r.sucesso).toBe(true);
    const o = await q1(db, "select snapshot_caso->>'operador_email' as cap, snapshot_aluno->>'responsavel_atual_email' as rap, estado_pos->>'caso_operador_email' as pos from public.assumir_fidelizacao_operacoes where id=$1", [r.operacao_id]);
    expect(o.cap).toBe(MAURICIO);
    expect(o.rap).toBe(MAURICIO);
    expect(o.pos).toBe(LUANA);
    await db.close();
  });

  it("reversão recusada quando o responsável anterior já está no teto", async () => {
    const db = await abrirCom();
    const caso = await cenario(db, 69, { dono: MAURICIO });
    await como(db, LUANA);
    const r = await tomar(db, caso);
    await db.exec(`update public.calibragem_parametros set valor='1'::jsonb where chave='limite_carteira'`);
    await cenario(db, 70, { dono: MAURICIO });
    await como(db, GESTAO);
    const rv = await q1(db, "select * from public.reverter_assumir_fidelizacao($1,$2)", [r.operacao_id, "x"]);
    expect(rv.sucesso).toBe(false);
    expect(rv.mensagem).toContain("limite de casos");
    await db.close();
  });
});
