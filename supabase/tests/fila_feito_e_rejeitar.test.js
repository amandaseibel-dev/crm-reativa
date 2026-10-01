// FILA MANUAL: FEITO E REJEITAR -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) aplicando o ARQUIVO da migration.
//
// O QUE ESTE TESTE PROVA
//   * FEITO e REJEITAR encerram a pendencia e registram quem, quando, categoria
//     e observacao;
//   * REJEITAR EXIGE motivo, e "outro" (nos dois lados) exige observacao --
//     senao fecha a linha sem deixar como relê-la depois;
//   * nenhuma das duas toca pagamento, parcela, acordo ou baixa: REJEITAR e
//     decisao de revisao, nao estorno;
//   * o historico anterior e preservado no retorno e na auditoria;
//   * a coerencia mora na TABELA: FEITO sem conclusao e REJEITADO sem motivo
//     sao recusados mesmo por escrita direta, fora das RPCs;
//   * linha ja decidida nao e decidida de novo (SEM_PENDENCIA_ABERTA);
//   * pagamento ja BAIXADO nao entra em nenhuma das duas.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(AQUI, "..", "migrations", "20260923020000_fila_feito_e_rejeitar.sql"), "utf8");

const BANCADA = `
  -- o papel de producao nao existe no PGlite; a migration da grant a ele
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated; end if; end $$;
  create schema if not exists auth;
  create or replace function auth.jwt() returns jsonb language sql stable
    as $$ select '{"email":"amanda.seibel@aelbra.com.br"}'::jsonb $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
  create or replace function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select coalesce(current_setting('teste.gestao', true), 'on') = 'on' $$;

  create table public.pagamentos (
    id uuid primary key default gen_random_uuid(),
    valor_pago numeric, status_conciliacao text, conciliacao_motivo text
  );
  create table public.fila_pagamento_sem_vinculo (
    id bigserial primary key,
    pagamento_id uuid not null references public.pagamentos(id) on delete cascade,
    boleto text, motivo text, observacao text, status_conciliacao text,
    decisao text, decidido_por text, decidido_em timestamptz,
    detectado_em timestamptz not null default now(),
    quantidade_tentativas integer not null default 1,
    primeira_tentativa_em timestamptz default now(),
    constraint fila_pag_sem_vinculo_unico unique (pagamento_id),
    constraint fila_pagamento_sem_vinculo_decisao_check check (
      decisao is null or decisao = any (array['VINCULADO','DESCARTADO',
        'AGUARDANDO_TERCEIRO','RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO']))
  );
  create table public.auditoria (
    id uuid primary key default gen_random_uuid(), usuario text, acao text,
    tabela_afetada text, registro_id uuid, detalhes jsonb,
    created_at timestamp default now()
  );
`;

let db;
const um = async (sql, p) => (await db.query(sql, p)).rows[0];

async function pendente(status = "AGUARDANDO_ACORDO") {
  const p = await um("insert into public.pagamentos (valor_pago, status_conciliacao) values (500,$1) returning id", [status]);
  await db.query("insert into public.fila_pagamento_sem_vinculo (pagamento_id, boleto, motivo) values ($1,'50712345001','sem estrutura')", [p.id]);
  return p.id;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(MIGRATION);
});

describe("FEITO", () => {
  it("A. encerra a pendencia e registra quem, quando, conclusao e observacao", async () => {
    const id = await pendente();
    const r = await um("select public.conciliacao_feito($1,'ENTRADA_DE_ACORDO','conferido no extrato') j", [id]);
    expect(r.j.ok).toBe(true);
    expect(r.j.decisao).toBe("FEITO");

    const l = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [id]);
    expect(l.decisao).toBe("FEITO");
    expect(l.conclusao).toBe("ENTRADA_DE_ACORDO");
    expect(l.motivo_rejeicao).toBeNull();
    expect(l.decidido_por).toBe("amanda.seibel@aelbra.com.br");
    expect(l.decidido_em).not.toBeNull();
    expect(l.observacao).toMatch(/ENTRADA_DE_ACORDO/);
    expect(l.observacao).toMatch(/conferido no extrato/);
  });

  it("B. observacao e opcional nas conclusoes normais", async () => {
    const id = await pendente();
    const r = await um("select public.conciliacao_feito($1,'JA_TRATADO',null) j", [id]);
    expect(r.j.ok).toBe(true);
  });

  it('C. "outro motivo confirmado" exige observacao', async () => {
    const id = await pendente();
    await expect(db.query("select public.conciliacao_feito($1,'OUTRO_CONFIRMADO',null)", [id]))
      .rejects.toThrow(/exige observacao/i);
  });

  it("D. conclusao fora do catalogo e recusada", async () => {
    const id = await pendente();
    await expect(db.query("select public.conciliacao_feito($1,'INVENTADO','x')", [id]))
      .rejects.toThrow();
  });

  it("E. o historico anterior vai para o retorno e para a auditoria", async () => {
    const id = await pendente();
    const r = await um("select public.conciliacao_feito($1,'SEM_IMPACTO_FINANCEIRO','ok') j", [id]);
    expect(r.j.estado_anterior.fila.motivo).toBe("sem estrutura");
    expect(r.j.estado_anterior.fila.decisao).toBeNull();

    const a = await um("select * from public.auditoria where registro_id=$1", [id]);
    expect(a.acao).toBe("CONCILIACAO_FEITO_PELA_GESTAO");
    expect(a.detalhes.sem_efeito_financeiro).toBe(true);
    expect(a.detalhes.estado_anterior.fila.motivo).toBe("sem estrutura");
  });
});

describe("REJEITAR", () => {
  it("F. exige motivo -- rejeitar em branco e recusado", async () => {
    const id = await pendente();
    await expect(db.query("select public.conciliacao_rejeitar($1,'   ','x')", [id]))
      .rejects.toThrow(/exige motivo/i);
  });

  it("G. registra motivo, quem e quando, e encerra a pendencia", async () => {
    const id = await pendente();
    const r = await um("select public.conciliacao_rejeitar($1,'VALOR_INCOMPATIVEL','pagou 500, parcela 900') j", [id]);
    expect(r.j.ok).toBe(true);
    expect(r.j.decisao).toBe("REJEITADO");

    const l = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [id]);
    expect(l.decisao).toBe("REJEITADO");
    expect(l.motivo_rejeicao).toBe("VALOR_INCOMPATIVEL");
    expect(l.conclusao).toBeNull();
    expect(l.decidido_por).toBe("amanda.seibel@aelbra.com.br");
  });

  it("H. NAO apaga nada e NAO desfaz o pagamento", async () => {
    const id = await pendente();
    const antes = await um("select * from public.pagamentos where id=$1", [id]);
    await db.query("select public.conciliacao_rejeitar($1,'DOCUMENTO_INCOMPATIVEL','x')", [id]);

    const dep = await um("select * from public.pagamentos where id=$1", [id]);
    expect(dep).toEqual(antes);                       // pagamento intacto, campo a campo
    const n = await um("select count(*)::int c from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [id]);
    expect(n.c).toBe(1);                              // a linha continua la
    const a = await um("select detalhes from public.auditoria where registro_id=$1", [id]);
    expect(a.detalhes.pagamento_preservado).toBe(true);
    expect(a.detalhes.sem_efeito_financeiro).toBe(true);
  });

  it('I. motivo "outro" exige observacao', async () => {
    const id = await pendente();
    await expect(db.query("select public.conciliacao_rejeitar($1,'OUTRO',null)", [id]))
      .rejects.toThrow(/exige observacao/i);
  });
});

describe("travas comuns", () => {
  it("J. a coerencia mora na TABELA, nao so na RPC", async () => {
    const id = await pendente();
    // escrita direta, por fora das RPCs
    await expect(db.query("update public.fila_pagamento_sem_vinculo set decisao='FEITO' where pagamento_id=$1", [id]))
      .rejects.toThrow();
    await expect(db.query("update public.fila_pagamento_sem_vinculo set decisao='REJEITADO' where pagamento_id=$1", [id]))
      .rejects.toThrow();
    // e nao se pode carimbar categoria sem a decisao correspondente
    await expect(db.query("update public.fila_pagamento_sem_vinculo set conclusao='JA_TRATADO' where pagamento_id=$1", [id]))
      .rejects.toThrow();
  });

  it("K. linha ja decidida nao e decidida de novo", async () => {
    const id = await pendente();
    await db.query("select public.conciliacao_feito($1,'JA_TRATADO',null)", [id]);
    const r = await um("select public.conciliacao_rejeitar($1,'OUTRO','tentando de novo') j", [id]);
    expect(r.j.ok).toBe(false);
    expect(r.j.motivo).toBe("SEM_PENDENCIA_ABERTA");

    const l = await um("select decisao, conclusao, motivo_rejeicao from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [id]);
    expect(l.decisao).toBe("FEITO");            // a primeira decisao manda
    expect(l.motivo_rejeicao).toBeNull();
  });

  it("L. pagamento ja BAIXADO nao entra em nenhuma das duas", async () => {
    const id = await pendente("BAIXADO");
    const f = await um("select public.conciliacao_feito($1,'JA_TRATADO',null) j", [id]);
    const j = await um("select public.conciliacao_rejeitar($1,'OUTRO','x') j", [id]);
    expect(f.j.motivo).toBe("JA_BAIXADO");
    expect(j.j.motivo).toBe("JA_BAIXADO");
  });

  it("M. sem ser gestao, nenhuma das duas roda", async () => {
    const id = await pendente();
    await db.exec("set teste.gestao = 'off'");
    await expect(db.query("select public.conciliacao_feito($1,'JA_TRATADO',null)", [id]))
      .rejects.toThrow(/decisao da gestao/i);
    await expect(db.query("select public.conciliacao_rejeitar($1,'OUTRO','x')", [id]))
      .rejects.toThrow(/decisao da gestao/i);
  });

  it("N. os valores antigos de decisao continuam aceitos", async () => {
    const id = await pendente();
    await db.query("update public.fila_pagamento_sem_vinculo set decisao='ENCERRADO_GESTAO' where pagamento_id=$1", [id]);
    const l = await um("select decisao from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [id]);
    expect(l.decisao).toBe("ENCERRADO_GESTAO");
  });
});
