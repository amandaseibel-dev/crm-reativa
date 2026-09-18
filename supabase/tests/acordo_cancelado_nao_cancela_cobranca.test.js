// ACORDO CANCELADO NAO E COBRANCA CANCELADA -- COMPORTAMENTO, nao estrutura.
//
// Roda a migration REAL num PostgreSQL real (PGlite) e prova o que ela muda e
// -- principalmente -- o que ela NAO muda. As funcoes que a migration reescreve
// sao as de producao; `normalizar_status_acionamento` e o gatilho
// `casos_set_encerrado_operacional` sao copiados BYTE A BYTE de producao e
// conferidos por md5 antes de usar, porque a regra testada depende deles.
//
// `aluno_saldo_pendente_detalhe`, `saldo_titulos_aberto`,
// `retirar_zerados_reais_sem_saldo` e `recalcular_situacao_aluno` sao DUBLES:
// o que esta sob teste e a regra de bloqueio/reabertura, nao o calculo do
// saldo. O saldo de cada aluno e fixado pelo proprio teste, para cada cenario
// dizer em voz alta quanto aquele aluno deve.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const MIGRATION = ler("supabase/migrations/20260918000000_acordo_cancelado_nao_cancela_cobranca.sql");

// --- corpos EXATOS de producao (17/09/2026) ---------------------------------
const CORPO = {
  normalizar: "\n  SELECT trim(regexp_replace(\n    upper(unaccent(coalesce(p_status, ''))),\n    '[_\\-]+', ' ', 'g'\n  ));\n",
  set_encerrado: "\nBEGIN\n  IF TG_OP = 'UPDATE'\n     AND NEW.cpf_limpo         IS NOT DISTINCT FROM OLD.cpf_limpo\n     AND NEW.status_atual      IS NOT DISTINCT FROM OLD.status_atual\n     AND NEW.status_acionamento IS NOT DISTINCT FROM OLD.status_acionamento\n     AND NEW.status_financeiro IS NOT DISTINCT FROM OLD.status_financeiro\n     AND NEW.status_jornada    IS NOT DISTINCT FROM OLD.status_jornada THEN\n    -- nada relevante mudou: preserva valor atual\n    RETURN NEW;\n  END IF;\n\n  NEW.encerrado_operacional := public.caso_encerrado_operacional(\n    NEW.cpf_limpo, NEW.status_atual, NEW.status_acionamento,\n    NEW.status_financeiro, NEW.status_jornada);\n  RETURN NEW;\nEND;\n",
};
const MD5_CORPO = {
  normalizar: "111639f9c4227e11b2f31fc7204ed64d",
  set_encerrado: "6fd02f124e1b9e2ba8012c1b751406bb",
};

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function novoBanco() {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(`
    create extension if not exists unaccent;
    create role anon; create role authenticated;

    create table public.alunos (id uuid primary key, nome text, cpf text, matricula text,
      status_atual text, status_jornada text, status_acionamento text,
      responsavel_atual_email text, saldo_total numeric, situacao_operacional text);

    create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      cpf text, cpf_limpo text, nome text, operador_email text,
      status_atual text, status_acionamento text, status_financeiro text, status_jornada text,
      situacao_operacional text, nao_acionar boolean, encerrado_operacional boolean not null default false,
      caso_atualizado_por text, caso_atualizado_em timestamptz, quitado_em date, valor_quitado numeric,
      origem_quitacao text);

    create table public.aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
      descricao text, status_anterior text, status_novo text, registrado_por_nome text,
      registrado_por_email text, registrado_em timestamptz);

    create table public.log_quitacao_bloqueada (aluno_id uuid, origem text, saldo_pendente numeric, detalhe jsonb);

    -- lista de trabalho de 10/09 que a migration promove a tabela estavel
    create table public._cancelamento_cobranca_20260910 (cpf text, motivo text, aluno text);

    -- saldo por aluno: fixado por cada cenario
    create table public._saldo (aluno_id uuid primary key, total numeric not null);

    create function public.aluno_saldo_pendente_detalhe(p_aluno_id uuid, p_ignorar uuid default null)
      returns jsonb language sql stable as $$
      select jsonb_build_object('total', coalesce((select total from public._saldo where aluno_id = p_aluno_id), 0)) $$;
    create function public.saldo_titulos_aberto(p_cpf text) returns numeric language sql stable as $$
      select coalesce((select s.total from public._saldo s join public.alunos a on a.id = s.aluno_id
        where regexp_replace(coalesce(a.cpf,''),'\\D','','g') = regexp_replace(coalesce(p_cpf,''),'\\D','','g')), 0) $$;

    create sequence public.chamadas_recalc;
    create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null) returns jsonb
      language plpgsql as $$ begin perform nextval('public.chamadas_recalc'); return '{}'::jsonb; end $$;
    create sequence public.chamadas_retirar;
    create function public.retirar_zerados_reais_sem_saldo(p_aluno_id uuid default null, p_mat text default null)
      returns integer language plpgsql as $$ begin perform nextval('public.chamadas_retirar'); return 0; end $$;
  `);

  for (const [chave, esperado] of Object.entries(MD5_CORPO)) {
    if (md5(CORPO[chave]) !== esperado) {
      throw new Error(`corpo de producao alterado: ${chave} (${md5(CORPO[chave])})`);
    }
  }
  await db.query(`create function public.normalizar_status_acionamento(p_status text) returns text
    language sql immutable set search_path to 'public' as $b$${CORPO.normalizar}$b$`);

  // caso_encerrado_operacional precisa existir antes do gatilho: a migration a substitui.
  await db.exec(`create function public.caso_encerrado_operacional(p_cpf text, p_status_atual text,
    p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
    returns boolean language sql stable as $$ select false $$;`);
  await db.query(`create function public.casos_set_encerrado_operacional() returns trigger
    language plpgsql set search_path to 'public' as $b$${CORPO.set_encerrado}$b$`);
  await db.exec(`create trigger trg_casos_set_encerrado before insert or update on public.casos
    for each row execute function public.casos_set_encerrado_operacional();`);

  await db.exec(MIGRATION);
  return db;
}

// Cria aluno + caso com um estado de status, e fixa a divida do aluno.
async function cenario(db, n, campos = {}) {
  const aluno = U(n), caso = U(1000 + n);
  const cpf = String(10000000000 + n);
  await db.query(
    `insert into public.alunos (id, nome, cpf, status_atual, responsavel_atual_email, saldo_total)
     values ($1,$2,$3,$4,$5,$6)`,
    [aluno, `Aluno ${n}`, cpf, campos.status_aluno ?? "MENSAGEM_ENVIADA", campos.operador ?? null, campos.divida ?? 0]);
  await db.query(`insert into public._saldo (aluno_id, total) values ($1,$2)`, [aluno, campos.divida ?? 0]);
  await db.query(
    `insert into public.casos (id, aluno_id, cpf, cpf_limpo, nome, operador_email, status_atual,
       status_acionamento, status_financeiro, status_jornada, nao_acionar)
     values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [caso, aluno, cpf, `Aluno ${n}`, campos.operador ?? null, campos.status_caso ?? "Mensagem enviada",
     campos.acionamento ?? null, campos.financeiro ?? null, campos.jornada ?? null, campos.nao_acionar ?? false]);
  return { aluno, caso, cpf };
}

const encerrado = async (db, caso) =>
  (await db.query(`select encerrado_operacional from public.casos where id = $1`, [caso])).rows[0].encerrado_operacional;
const ativo = async (db, caso) => !(await encerrado(db, caso));

describe("acordo cancelado nao e cobranca cancelada", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("A. acordo cancelado com divida volta a ser elegivel", async () => {
    const { caso } = await cenario(db, 1, { acionamento: "CANCELADO", divida: 1500 });
    expect(await encerrado(db, caso)).toBe(false); // ja nem encerra mais
    const n = (await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n;
    // nada a reabrir porque nunca saiu: a prova e que ele esta ativo
    expect(await ativo(db, caso)).toBe(true);
    expect(n).toBe(0);
  });

  it("A2. caso JA encerrado por acordo cancelado e devolvido pelo reabridor", async () => {
    const { aluno, caso } = await cenario(db, 2, { acionamento: "CANCELADO", divida: 2500 });
    // força o estado herdado de producao: encerrado com o rotulo antigo
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    expect(await encerrado(db, caso)).toBe(true);

    const n = (await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n;
    expect(n).toBe(1);
    expect(await ativo(db, caso)).toBe(true);

    const mov = (await db.query(
      `select tipo, status_anterior, status_novo from public.aluno_movimentacoes where aluno_id = $1`, [aluno])).rows;
    expect(mov).toHaveLength(1);
    expect(mov[0].tipo).toBe("REABERTURA_DIVIDA_NOVA");
    expect(mov[0].status_anterior).toBe("Mensagem enviada"); // status ANTERIOR preservado
    expect(mov[0].status_novo).toBe("Em cobrança");
  });

  it("B. acordo quebrado com divida volta a ser elegivel", async () => {
    const { caso } = await cenario(db, 3, { status_caso: "Acordo quebrado", acionamento: "CANCELADO", divida: 800 });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(1);
    expect(await ativo(db, caso)).toBe(true);
  });

  it("C. CANCELADO so em status_acionamento nao encerra a cobranca", async () => {
    const r = await db.query(
      `select public.caso_encerrado_operacional('11122233344', 'Mensagem enviada', 'CANCELADO', null, null) e`);
    expect(r.rows[0].e).toBe(false);
  });

  it("C2. o evento de cancelamento de acordo grava ACORDO_CANCELADO, nao CANCELADO", async () => {
    const { aluno, caso } = await cenario(db, 4, { divida: 1200 });
    await db.query(`select public.liberar_caso_por_evento($1, 'CANCELADO')`, [aluno]);
    const c = (await db.query(
      `select status_acionamento, encerrado_operacional from public.casos where id = $1`, [caso])).rows[0];
    expect(c.status_acionamento).toBe("ACORDO_CANCELADO");
    expect(c.encerrado_operacional).toBe(false); // o caso continua na fila
  });

  it("D. Cobranca Cancelada continua bloqueada", async () => {
    const { caso } = await cenario(db, 5, { status_caso: "Cobrança Cancelada", acionamento: "CANCELADO", divida: 3000 });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
    expect(await encerrado(db, caso)).toBe(true);
  });

  it("E. JURIDICO continua bloqueado -- inclusive em status_acionamento", async () => {
    expect((await db.query(
      `select public.caso_encerrado_operacional('1','Mensagem enviada','JURIDICO',null,null) e`)).rows[0].e).toBe(true);
    expect((await db.query(
      `select public.caso_encerrado_operacional('1','JURIDICO',null,null,null) e`)).rows[0].e).toBe(true);

    const { caso } = await cenario(db, 6, { acionamento: "JURIDICO", divida: 5000 });
    expect(await encerrado(db, caso)).toBe(true);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
  });

  it("F. SUSPENSAO_COBRANCA continua bloqueada nos quatro campos", async () => {
    for (const campo of ["p_status_atual", "p_status_acionamento", "p_status_financeiro", "p_status_jornada"]) {
      const args = { p_status_atual: "null", p_status_acionamento: "null", p_status_financeiro: "null", p_status_jornada: "null" };
      args[campo] = `'SUSPENSAO_COBRANCA'`;
      const r = await db.query(`select public.caso_encerrado_operacional('1', ${args.p_status_atual},
        ${args.p_status_acionamento}, ${args.p_status_financeiro}, ${args.p_status_jornada}) e`);
      expect(r.rows[0].e, `SUSPENSAO_COBRANCA em ${campo} deveria bloquear`).toBe(true);
    }
  });

  it("G. nao_acionar = true continua bloqueado", async () => {
    const { caso } = await cenario(db, 7, { acionamento: "CANCELADO", divida: 4000, nao_acionar: true });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
    expect(await encerrado(db, caso)).toBe(true);
  });

  it("H. quem esta na lista de cancelamento de 10/09 continua fora", async () => {
    const { caso, cpf } = await cenario(db, 8, { acionamento: "CANCELADO", divida: 6000 });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    // a migration ja rodou; simula a decisao ja promovida para a casa estavel
    await db.query(`insert into public.cobranca_nao_reabrir (cpf, motivo, origem, registrado_por)
                    values ($1, 'cancelamento de cobranca', 'teste', 'teste')`, [cpf]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
    expect(await encerrado(db, caso)).toBe(true);
  });

  it("H2. a migration promove a lista de 10/09 para cobranca_nao_reabrir", async () => {
    const db2 = new PGlite({ extensions: { unaccent } });
    // recria o minimo e semeia a lista ANTES da migration
    await db2.exec(`create extension if not exists unaccent; create role anon; create role authenticated;`);
    await db2.exec(`create table public._cancelamento_cobranca_20260910 (cpf text, motivo text, aluno text);`);
    await db2.query(`insert into public._cancelamento_cobranca_20260910 (cpf, motivo) values
      ('123.456.789-01','acordo judicial'), ('98765432100', null), ('123.456.789-01','duplicado')`);
    await db2.exec(`
      create table public.alunos (id uuid primary key, cpf text, status_atual text, status_jornada text, status_acionamento text);
      create table public.casos (id uuid primary key, aluno_id uuid, cpf text, cpf_limpo text, status_atual text,
        status_acionamento text, status_financeiro text, status_jornada text, nao_acionar boolean,
        encerrado_operacional boolean default false, caso_atualizado_por text, caso_atualizado_em timestamptz,
        quitado_em date, valor_quitado numeric, origem_quitacao text);
      create table public.aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text, descricao text,
        status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text, registrado_em timestamptz);
      create table public.log_quitacao_bloqueada (aluno_id uuid, origem text, saldo_pendente numeric, detalhe jsonb);
      create function public.normalizar_status_acionamento(p text) returns text language sql immutable as $$ select upper(coalesce(p,'')) $$;
      create function public.saldo_titulos_aberto(p text) returns numeric language sql stable as $$ select 0::numeric $$;
      create function public.aluno_saldo_pendente_detalhe(a uuid, b uuid default null) returns jsonb language sql stable as $$ select '{"total":0}'::jsonb $$;
      create function public.recalcular_situacao_aluno(a uuid, b text default null) returns jsonb language sql as $$ select '{}'::jsonb $$;
      create function public.retirar_zerados_reais_sem_saldo(a uuid default null, b text default null) returns int language sql as $$ select 0 $$;
    `);
    await db2.exec(MIGRATION);
    const linhas = (await db2.query(`select cpf, motivo from public.cobranca_nao_reabrir order by cpf`)).rows;
    expect(linhas).toHaveLength(2);                       // deduplicado
    expect(linhas[0].cpf).toBe("12345678901");            // so digitos, 11 posicoes
    expect(linhas[1].cpf).toBe("98765432100");
    expect(linhas[1].motivo).toBe("cancelamento de cobranca"); // motivo vazio ganha padrao
  });

  it("I. aluno sem divida real nao reabre", async () => {
    const { caso } = await cenario(db, 9, { acionamento: "CANCELADO", divida: 0 });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
    expect(await encerrado(db, caso)).toBe(true);
  });

  it("J. aluno que ja tem outro caso ativo nao ganha caso duplicado", async () => {
    const { aluno, caso } = await cenario(db, 10, { acionamento: "CANCELADO", divida: 2000 });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    // segundo caso do mesmo aluno, este ativo
    await db.query(`insert into public.casos (id, aluno_id, cpf, cpf_limpo, status_atual, encerrado_operacional)
                    values ($1,$2,'X','X','Em cobrança', false)`, [U(2010), aluno]);
    expect((await db.query(`select public.casos_reabrir_com_divida() n`)).rows[0].n).toBe(0);
    expect(await encerrado(db, caso)).toBe(true);
    const ativos = (await db.query(
      `select count(*)::int c from public.casos where aluno_id = $1 and not encerrado_operacional`, [aluno])).rows[0].c;
    expect(ativos).toBe(1);
  });

  it("K. o reabridor nao toca em responsavel nem em operador", async () => {
    const { aluno, caso } = await cenario(db, 11, { acionamento: "CANCELADO", divida: 900, operador: "cobranca03@aelbra.com.br" });
    await db.query(`update public.casos set encerrado_operacional = true where id = $1`, [caso]);
    await db.query(`select public.casos_reabrir_com_divida()`);
    const c = (await db.query(`select operador_email from public.casos where id = $1`, [caso])).rows[0];
    const a = (await db.query(`select responsavel_atual_email from public.alunos where id = $1`, [aluno])).rows[0];
    expect(c.operador_email).toBe("cobranca03@aelbra.com.br");
    expect(a.responsavel_atual_email).toBe("cobranca03@aelbra.com.br");
  });

  it("L. quitado com saldo zero continua encerrado (regra de quitacao intacta)", async () => {
    const r = await db.query(`select public.caso_encerrado_operacional('99999999999','QUITADO',null,null,null) e`);
    expect(r.rows[0].e).toBe(true); // saldo_titulos_aberto = 0 para cpf sem aluno
  });
});
