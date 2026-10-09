// A migration 20261009210000 roda AQUI, num Postgres de verdade e descartavel,
// antes de chegar perto de producao.
//
// O que se prova: o caminho titulo -> fila -> recalculo existe e e BARATO no
// lugar quente. O gatilho e de INSTRUCAO, nao de linha: um borderô que grava
// 500 titulos de um aluno faz UMA linha de fila, nao 500 recalculos dentro da
// transacao da importacao. Era esse o risco de fazer o recalculo direto no
// gatilho, e e por isso que existe fila.
//
// O QUE E DUBLE, e por que: `recalcular_situacao_aluno` tem 13 mil caracteres e
// depende de uma dezena de tabelas (parcelas, acordos, casos, confirmacoes,
// calibragem_parametros...). Reproduzir a base inteira aqui provaria a funcao
// DELA, que ja esta em producao e nao e tocada por esta frente. O duble soma os
// titulos pela MESMA regra canonica (ABERTO/NEGOCIADO, status <> quitada,
// tipo_boleto <> 'Acordo') e escreve saldo_total/saldo_vencido -- o suficiente
// para provar a LIGACAO, que e o que esta frente constroi.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION =
  "supabase/aguardando_aprovacao/20261009210000_recalculo_de_saldo_por_titulo.sql";

let db;

beforeAll(async () => {
  db = new PGlite();

  // ambiente minimo: papeis e o `auth` que o Supabase da de graca
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;

    create schema if not exists auth;
    create or replace function auth.role() returns text language sql stable as
      $f$ select coalesce(current_setting('teste.papel', true), 'service_role') $f$;

    create table public.alunos (
      id uuid primary key,
      cpf text,
      saldo_total numeric,
      saldo_vencido numeric,
      situacao_operacional text
    );

    create table public.acordos_titulos (
      id uuid primary key default gen_random_uuid(),
      aluno_id uuid,
      documento text,
      situacao text,
      status text,
      tipo_boleto text,
      vencimento date,
      valor_original numeric,
      saldo_corrigido numeric,
      valor_em_aberto numeric,
      valor_cobranca_ajustado numeric
    );

    -- portao de autorizacao do dreno, ligavel pelo teste
    create or replace function public.usuario_e_gestao() returns boolean
      language sql stable as
      $f$ select coalesce(current_setting('teste.gestao', true)::boolean, true) $f$;

    -- DUBLE de recalcular_situacao_aluno (ver cabecalho): mesma regra canonica
    -- de soma, so o que esta frente precisa observar.
    create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null)
    returns jsonb language plpgsql as $f$
    declare v_tot numeric; v_venc numeric;
    begin
      select
        coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0),
        coalesce(sum(coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0))
                 filter (where t.vencimento < current_date),0)
        into v_tot, v_venc
        from public.acordos_titulos t
       where t.aluno_id = p_aluno_id
         and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
         and coalesce(lower(t.status),'') not in ('quitada')
         and coalesce(t.tipo_boleto,'') <> 'Acordo';
      update public.alunos set
        saldo_total = v_tot, saldo_vencido = v_venc,
        situacao_operacional = case when v_venc > 0 then 'COBRANCA_VENCIDA' else situacao_operacional end
       where id = p_aluno_id;
      return jsonb_build_object('saldo_total', v_tot);
    end $f$;
  `);

  // A MIGRATION DE VERDADE, inteira, do arquivo.
  await db.exec(ler(MIGRATION));
});

afterAll(async () => { await db?.close(); });

const umId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// A ORDEM IMPORTA, e descobri isso quebrando um teste: apagar titulo dispara o
// gatilho de DELETE e enfileira de novo. Limpar a fila primeiro deixava lixo
// para o teste seguinte -- e o resultado passava a depender da ordem dos testes.
// Titulo primeiro, fila depois.
async function limpar() {
  await db.exec(`
    delete from public.acordos_titulos;
    delete from public.recalculo_saldo_pendente;
    delete from public.alunos;
    select set_config('teste.gestao','true',false);
    select set_config('teste.papel','service_role',false);
  `);
}

async function criarAluno(n) {
  await db.query(`insert into public.alunos (id) values ($1)`, [umId(n)]);
  return umId(n);
}

async function uma(sql, params) {
  const r = await db.query(sql, params);
  return r.rows[0];
}

describe("a migration aplica num postgres de verdade", () => {
  it("cria a fila com RLS ligada e forcada, e sem grant a anon/authenticated", async () => {
    const t = await uma(`
      select c.relrowsecurity rls, c.relforcerowsecurity forcada,
             has_table_privilege('anon','public.recalculo_saldo_pendente','select') anon_le,
             has_table_privilege('authenticated','public.recalculo_saldo_pendente','select') auth_le
        from pg_class c where c.oid = 'public.recalculo_saldo_pendente'::regclass`);
    expect(t.rls).toBe(true);
    expect(t.forcada).toBe(true);
    expect(t.anon_le).toBe(false);
    expect(t.auth_le).toBe(false);
  });

  it("os tres gatilhos sao de INSTRUCAO, nao de linha", async () => {
    const r = await db.query(`
      select tgname, (tgtype & 1) = 0 as por_instrucao
        from pg_trigger
       where tgrelid = 'public.acordos_titulos'::regclass
         and tgname like 'trg_enfileirar_recalculo_titulo%'
       order by tgname`);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.every((x) => x.por_instrucao)).toBe(true);
  });
});

describe("o gatilho enfileira por ALUNO, nao por linha", () => {
  it("6 titulos do mesmo aluno numa instrucao = 1 linha de fila", async () => {
    await limpar();
    const a = await criarAluno(1);
    await db.query(`
      insert into public.acordos_titulos (aluno_id, documento, situacao, status, tipo_boleto, vencimento, valor_original)
      select $1, 'd'||g, 'ABERTO', 'em_aberto', 'Cursos de Graduação Presencial',
             current_date - 30, 100
        from generate_series(1,6) g`, [a]);

    const f = await uma(`select count(*)::int n from public.recalculo_saldo_pendente`);
    expect(f.n).toBe(1);
    const t = await uma(`select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(6); // os titulos nao sao duplicados nem perdidos
  });

  it("500 alunos numa instrucao = 500 linhas de fila, uma por aluno", async () => {
    await limpar();
    await db.exec(`
      insert into public.alunos (id)
      select ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid from generate_series(1,500) g;
      insert into public.acordos_titulos (aluno_id, documento, situacao, status, tipo_boleto, vencimento, valor_original)
      select ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid, 'd'||g||'-'||p,
             'ABERTO','em_aberto','Cursos de Graduação Presencial', current_date - 10, 50
        from generate_series(1,500) g, generate_series(1,2) p;`);
    const f = await uma(`select count(*)::int n from public.recalculo_saldo_pendente`);
    expect(f.n).toBe(500);
    const t = await uma(`select count(*)::int n from public.acordos_titulos`);
    expect(t.n).toBe(1000);
  });

  it("UPDATE e DELETE tambem enfileiram", async () => {
    await limpar();
    const a = await criarAluno(2);
    await db.query(`insert into public.acordos_titulos (aluno_id, documento, situacao, status, valor_original)
                    values ($1,'d1','ABERTO','em_aberto',10)`, [a]);
    await db.exec(`delete from public.recalculo_saldo_pendente`);

    await db.query(`update public.acordos_titulos set situacao='NEGOCIADO' where aluno_id=$1`, [a]);
    expect((await uma(`select count(*)::int n from public.recalculo_saldo_pendente`)).n).toBe(1);

    await db.exec(`delete from public.recalculo_saldo_pendente`);
    await db.query(`delete from public.acordos_titulos where aluno_id=$1`, [a]);
    expect((await uma(`select count(*)::int n from public.recalculo_saldo_pendente`)).n).toBe(1);
  });

  it("titulo sem aluno_id nao entra na fila", async () => {
    await limpar();
    await db.exec(`insert into public.acordos_titulos (documento, situacao, status, valor_original)
                   values ('sem-aluno','ABERTO','em_aberto',10)`);
    expect((await uma(`select count(*)::int n from public.recalculo_saldo_pendente`)).n).toBe(0);
  });
});

describe("o dreno recalcula e limpa a fila", () => {
  it("saldo nulo vira o valor dos titulos, e a fila esvazia", async () => {
    await limpar();
    const a = await criarAluno(3);
    await db.query(`
      insert into public.acordos_titulos (aluno_id, documento, situacao, status, tipo_boleto, vencimento, valor_original)
      values ($1,'d1','ABERTO','em_aberto','Cursos de Graduação Presencial', current_date - 30, 1740.84),
             ($1,'d2','ABERTO','em_aberto','Cursos de Graduação Presencial', current_date - 10, 1740.85)`, [a]);

    expect((await uma(`select saldo_total from public.alunos where id=$1`, [a])).saldo_total).toBeNull();

    const res = await uma(`select public.recalculo_saldo_pendente_processar(500,'teste') r`);
    expect(res.r.processados).toBe(1);
    expect(res.r.com_erro).toBe(0);
    expect(res.r.restantes).toBe(0);

    const al = await uma(`select saldo_total::text st, saldo_vencido::text sv, situacao_operacional so
                            from public.alunos where id=$1`, [a]);
    expect(al.st).toBe("3481.69");
    expect(al.sv).toBe("3481.69");
    expect(al.so).toBe("COBRANCA_VENCIDA");
  });

  it("nao mexe em titulo: mesma contagem e mesmo valor depois do dreno", async () => {
    await limpar();
    const a = await criarAluno(4);
    await db.query(`
      insert into public.acordos_titulos (aluno_id, documento, situacao, status, vencimento, valor_original)
      select $1, 'd'||g, 'ABERTO','em_aberto', current_date - 5, 11.11 from generate_series(1,3) g`, [a]);
    const antes = await uma(`select count(*)::int n, sum(valor_original)::text v from public.acordos_titulos`);
    await db.exec(`select public.recalculo_saldo_pendente_processar(500,'teste')`);
    const depois = await uma(`select count(*)::int n, sum(valor_original)::text v from public.acordos_titulos`);
    expect(depois).toEqual(antes);
  });

  it("segunda chamada nao tem o que fazer: idempotente", async () => {
    await limpar();
    const a = await criarAluno(5);
    await db.query(`insert into public.acordos_titulos (aluno_id, documento, situacao, status, vencimento, valor_original)
                    values ($1,'d1','ABERTO','em_aberto', current_date - 1, 500)`, [a]);
    await db.exec(`select public.recalculo_saldo_pendente_processar(500,'teste')`);
    const r2 = await uma(`select public.recalculo_saldo_pendente_processar(500,'teste') r`);
    expect(r2.r.processados).toBe(0);
    expect(r2.r.restantes).toBe(0);
  });

  it("titulo que a regra nao cobra nao inventa saldo (boleto do proprio acordo e quitada)", async () => {
    await limpar();
    const a = await criarAluno(6);
    await db.query(`
      insert into public.acordos_titulos (aluno_id, documento, situacao, status, tipo_boleto, vencimento, valor_original)
      values ($1,'acordo','ABERTO','em_aberto','Acordo', current_date - 30, 9999),
             ($1,'quit','ABERTO','quitada','Cursos de Graduação Presencial', current_date - 30, 8888)`, [a]);
    await db.exec(`select public.recalculo_saldo_pendente_processar(500,'teste')`);
    expect((await uma(`select saldo_total::text st from public.alunos where id=$1`, [a])).st).toBe("0");
  });

  it("quem falha FICA na fila, nao desaparece", async () => {
    await limpar();
    // aluno na fila que nao existe em `alunos`: o duble nao acha e o update nao
    // escreve, mas o importante e o contrato -- a linha nao e perdida por erro.
    await db.exec(`
      create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null)
      returns jsonb language plpgsql as $f$ begin raise exception 'falha proposital'; end $f$;`);
    const a = await criarAluno(7);
    // este e o ultimo teste do bloco: o duble fica quebrado de proposito
    await db.query(`insert into public.acordos_titulos (aluno_id, documento, situacao, status, valor_original)
                    values ($1,'d1','ABERTO','em_aberto',1)`, [a]);
    const r = await uma(`select public.recalculo_saldo_pendente_processar(500,'teste') r`);
    expect(r.r.processados).toBe(0);
    expect(r.r.com_erro).toBe(1);
    expect(r.r.restantes).toBe(1);
    expect((await uma(`select count(*)::int n from public.recalculo_saldo_pendente`)).n).toBe(1);
  });
});

describe("autorizacao do dreno", () => {
  it("recusa quem nao e gestao nem service_role", async () => {
    await limpar();
    await db.exec(`select set_config('teste.papel','authenticated',false);
                   select set_config('teste.gestao','false',false);`);
    await expect(db.exec(`select public.recalculo_saldo_pendente_processar(10,'teste')`))
      .rejects.toThrow(/Acesso negado/);
  });

  it("recusa limite fora da faixa", async () => {
    await limpar();
    await expect(db.exec(`select public.recalculo_saldo_pendente_processar(0,'teste')`))
      .rejects.toThrow(/Limite fora da faixa/);
    await expect(db.exec(`select public.recalculo_saldo_pendente_processar(99999,'teste')`))
      .rejects.toThrow(/Limite fora da faixa/);
  });

  it("anon nao executa o dreno", async () => {
    const r = await uma(`select has_function_privilege('anon',
      'public.recalculo_saldo_pendente_processar(int,text)','execute') pode`);
    expect(r.pode).toBe(false);
  });
});
