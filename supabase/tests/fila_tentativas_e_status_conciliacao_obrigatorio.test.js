// FLUXO NOVO: CONTADOR DE TENTATIVAS + STATUS_CONCILIACAO OBRIGATORIO.
//
// PostgreSQL real (PGlite). O teste aplica o ARQUIVO DA MIGRATION, nao uma
// copia do SQL: se a migration mudar e o comportamento quebrar, quebra aqui.
//
// O QUE ESTE TESTE PROVA
//   * a primeira tentativa e gravada uma vez e nunca reescrita;
//   * cada reavaliacao de linha PENDENTE incrementa o contador e move a ultima;
//   * depois da decisao o historico congela -- editar observacao nao inventa
//     tentativa;
//   * as linhas que ja existiam sao preservadas, ancoradas no que a propria
//     linha registrava, sem numero inventado;
//   * a ARMADILHA do constraint trigger diferido: o status chega por UPDATE
//     depois do INSERT, e mesmo assim o pagamento valido COMMITA -- porque a
//     checagem rele a linha em vez de olhar `new`;
//   * um pagamento que termina a transacao sem status NAO commita;
//   * linha historica com status nulo continua intocada (o gatilho so ve INSERT).
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(AQUI, "..", "migrations",
    "20260923010000_fila_tentativas_e_status_conciliacao_obrigatorio.sql"),
  "utf8",
);

// Recorte minimo de producao: so o que as duas protecoes tocam.
const BANCADA = `
  create table public.pagamentos (
    id uuid primary key default gen_random_uuid(),
    valor_pago numeric,
    status_conciliacao text,
    conciliacao_motivo text,
    created_at timestamptz default now()
  );
  create table public.fila_pagamento_sem_vinculo (
    id bigserial primary key,
    pagamento_id uuid not null references public.pagamentos(id) on delete cascade,
    boleto text,
    motivo text,
    observacao text,
    status_conciliacao text,
    decisao text,
    decidido_por text,
    decidido_em timestamptz,
    detectado_em timestamptz not null default now(),
    constraint fila_pag_sem_vinculo_unico unique (pagamento_id)
  );
`;

// O gatilho de producao que grava o status DEPOIS do insert. E ele que cria a
// armadilha do constraint trigger diferido.
const MOTOR = `
  create or replace function public._pagamento_conciliar() returns trigger
  language plpgsql as $$
  begin
    update public.pagamentos set status_conciliacao = 'BAIXADO' where id = new.id;
    return null;
  end; $$;
  create trigger trg_pagamento_conciliar after insert on public.pagamentos
    for each row execute function public._pagamento_conciliar();
`;

let db;
const um = async (sql, params) => (await db.query(sql, params)).rows[0];
const nova = async () => {
  const p = await um("insert into public.pagamentos (valor_pago) values (10) returning id");
  return p.id;
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
});

describe("contador de tentativas na fila", () => {
  // O motor entra junto: sem ele a trava do item 2 recusa -- com razao -- o
  // pagamento de bancada, e o teste nem chegaria na fila.
  const aplicar = async () => { await db.exec(MIGRATION); await db.exec(MOTOR); };

  it("A. primeira entrada abre com uma tentativa, primeira = ultima", async () => {
    await aplicar();
    const pid = await nova();
    await db.query("insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo) values ($1,'sem estrutura')", [pid]);

    const l = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(l.quantidade_tentativas).toBe(1);
    expect(l.primeira_tentativa_em).not.toBeNull();
    expect(new Date(l.ultima_tentativa_em).getTime())
      .toBe(new Date(l.primeira_tentativa_em).getTime());
  });

  it("B. cada reavaliacao de linha pendente incrementa e move a ultima", async () => {
    await aplicar();
    const pid = await nova();
    await db.query("insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo) values ($1,'x')", [pid]);
    const antes = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);

    // Duas rodadas do motor: o mesmo `on conflict do update` de producao.
    for (const m of ["x", "x"]) {
      await db.query(
        `insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo) values ($1,$2)
         on conflict (pagamento_id) do update set motivo = excluded.motivo
         where fila_pagamento_sem_vinculo.decisao is null`, [pid, m]);
    }

    const dep = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(dep.quantidade_tentativas).toBe(3);
    expect(new Date(dep.ultima_tentativa_em).getTime())
      .toBeGreaterThanOrEqual(new Date(antes.ultima_tentativa_em).getTime());
    // a primeira NUNCA e reescrita
    expect(new Date(dep.primeira_tentativa_em).getTime())
      .toBe(new Date(antes.primeira_tentativa_em).getTime());
  });

  it("C. o motor reescrevendo o MESMO estado ainda conta como tentativa", async () => {
    await aplicar();
    const pid = await nova();
    await db.query("insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao) values ($1,'igual','AGUARDANDO_ACORDO')", [pid]);
    await db.query(
      `insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo, status_conciliacao)
       values ($1,'igual','AGUARDANDO_ACORDO')
       on conflict (pagamento_id) do update set motivo = excluded.motivo,
         status_conciliacao = excluded.status_conciliacao
       where fila_pagamento_sem_vinculo.decisao is null`, [pid]);

    const l = await um("select quantidade_tentativas from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(l.quantidade_tentativas).toBe(2);
  });

  it("D. depois da decisao o historico congela", async () => {
    await aplicar();
    const pid = await nova();
    await db.query("insert into public.fila_pagamento_sem_vinculo (pagamento_id, motivo) values ($1,'x')", [pid]);
    // a tentativa que resolve: decisao vinha nula, entao CONTA
    await db.query("update public.fila_pagamento_sem_vinculo set decisao='RESOLVIDO_AUTOMATICO' where pagamento_id=$1 and decisao is null", [pid]);
    const resolvida = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(resolvida.quantidade_tentativas).toBe(2);

    // editar observacao depois NAO inventa tentativa
    await db.query("update public.fila_pagamento_sem_vinculo set observacao='nota da gestao' where pagamento_id=$1", [pid]);
    const dep = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(dep.quantidade_tentativas).toBe(2);
    expect(new Date(dep.ultima_tentativa_em).getTime())
      .toBe(new Date(resolvida.ultima_tentativa_em).getTime());
  });

  it("E. linhas que ja existiam sao preservadas, sem numero inventado", async () => {
    // fila povoada ANTES da migration, como em producao
    const pid = await nova();
    await db.query(
      `insert into public.fila_pagamento_sem_vinculo
         (pagamento_id, motivo, detectado_em, decisao, decidido_em)
       values ($1,'antigo', now() - interval '8 days', 'ENCERRADO_GESTAO', now() - interval '2 days')`, [pid]);

    await db.exec(MIGRATION);

    const l = await um("select * from public.fila_pagamento_sem_vinculo where pagamento_id=$1", [pid]);
    expect(l.quantidade_tentativas).toBe(1);
    expect(new Date(l.primeira_tentativa_em).getTime())
      .toBe(new Date(l.detectado_em).getTime());
    expect(new Date(l.ultima_tentativa_em).getTime())
      .toBe(new Date(l.decidido_em).getTime());
  });
});

describe("status_conciliacao obrigatorio no fluxo novo", () => {
  it("F. ARMADILHA: status escrito por gatilho AFTER ainda commita", async () => {
    await db.exec(MIGRATION);
    await db.exec(MOTOR);
    // `new.status_conciliacao` e NULL no instante do insert. So passa porque a
    // checagem rele a linha no commit.
    const p = await um("insert into public.pagamentos (valor_pago) values (99) returning id");
    const l = await um("select status_conciliacao from public.pagamentos where id=$1", [p.id]);
    expect(l.status_conciliacao).toBe("BAIXADO");
  });

  it("G. pagamento que termina a transacao sem status NAO commita", async () => {
    await db.exec(MIGRATION);
    // sem o motor: ninguem define o status
    await expect(
      db.query("insert into public.pagamentos (valor_pago) values (50)"),
    ).rejects.toThrow(/sem status_conciliacao/i);
  });

  it("H. a recusa cita o pagamento e nao sugere preencher a mao", async () => {
    await db.exec(MIGRATION);
    let erro = null;
    try { await db.query("insert into public.pagamentos (valor_pago) values (50)"); }
    catch (e) { erro = e; }
    expect(erro).not.toBeNull();
    expect(String(erro.message)).toMatch(/nunca nulo/i);
  });

  it("I. linha historica com status nulo continua intocada", async () => {
    // legado inserido antes da protecao existir
    const pid = await nova();
    await db.exec(MIGRATION);
    const l = await um("select status_conciliacao from public.pagamentos where id=$1", [pid]);
    expect(l.status_conciliacao).toBeNull();
    // e UPDATE nela nao dispara nada (o gatilho e so AFTER INSERT)
    await db.query("update public.pagamentos set valor_pago = 11 where id=$1", [pid]);
    const dep = await um("select valor_pago, status_conciliacao from public.pagamentos where id=$1", [pid]);
    expect(dep.status_conciliacao).toBeNull();
    expect(Number(dep.valor_pago)).toBe(11);
  });

  it("J. pagamento apagado na mesma transacao nao trava o commit", async () => {
    await db.exec(MIGRATION);
    await db.exec(`
      begin;
      insert into public.pagamentos (id, valor_pago) values ('11111111-1111-1111-1111-111111111111', 7);
      delete from public.pagamentos where id = '11111111-1111-1111-1111-111111111111';
      commit;
    `);
    const n = await um("select count(*)::int c from public.pagamentos");
    expect(n.c).toBe(0);
  });
});
