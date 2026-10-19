// FILA DE EXCECOES: pagamento identificado em parcela/acordo CANCELADO --
// COMPORTAMENTO da funcao, num PostgreSQL real (PGlite), com a migration REAL.
//
// A bancada reproduz os tres casos investigados em 19/10/2026 (71006, 52411, 71398)
// mais o 64194, com os MESMOS valores medidos em producao -- porque a classificacao
// depende de casamento de valor, e numero inventado nao pegaria a inversao de sinal
// do 71006 (onde a 2a parcela foi paga no boleto do acordo ja cancelado).
//
// `usuario_e_gestao` e DUBLE, controlado por GUC, para testar o portao nos dois lados.
//
// NENHUM DADO REAL: nomes e CPFs sao ficticios; so os valores e os numeros de acordo
// reproduzem a forma do caso.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const MIGRATION = ler("supabase/migrations/20261019180000_fila_pagamento_parcela_cancelada.sql");

const CPF_A = "11111111111";
const CPF_B = "22222222222";
const CPF_C = "33333333333";
const CPF_D = "44444444444";

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;

    create table public.alunos (id uuid primary key default gen_random_uuid(),
      nome text, cpf text, matricula text);
    create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      status text default 'ATIVO', valor_total numeric, numero_ulbra text,
      criado_em timestamptz default now(), atualizado_em timestamptz default now());
    create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
      numero int, valor numeric, status text default 'A_VENCER', boleto text);
    create table public.pagamentos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
      data_pagamento date, valor_pago numeric, matricula text, cpf text,
      titulo_numero text, numero_parcela_completo text);
    create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(),
      aluno_id text, data_pagamento date, valor_pago numeric, parcela_id uuid, acordo_id uuid);
    create table public.prime_contratos (registration text, cpf text);

    -- DUBLE do portao: liga e desliga por GUC.
    create function public.usuario_e_gestao() returns boolean language sql stable as
      $$ select coalesce(nullif(current_setting('teste.gestao', true), ''), 'f')::boolean $$;
  `);
  await db.exec(MIGRATION);
  return db;
}

async function bancada(db) {
  // --- Caso 71006: acordo cancelado + substituto ATIVO criado na janela ---------
  await db.exec(`
    insert into public.alunos (id, nome, cpf, matricula) values
      ('aaaaaaaa-0000-0000-0000-000000000001','ALUNO UM','${CPF_A}','5381');
    insert into public.prime_contratos values ('211004249','${CPF_A}');

    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
              'CANCELADO', 1562.76, '71006', '2026-09-04 11:40:00+00', '2026-09-10 14:36:36+00');
    insert into public.parcelas (id, acordo_id, numero, valor, status, boleto) values
      ('dddddddd-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001',0,781.38,'CANCELADA','50710060001'),
      ('dddddddd-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000001',1,781.38,'CANCELADA','50710060002');

    -- substituto: ATIVO, criado 21s depois do cancelamento, uma parcela VENCIDA do mesmo valor
    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001',
              'ATIVO', 781.38, null, '2026-09-10 14:36:57+00', '2026-09-10 14:36:57+00');
    insert into public.parcelas (acordo_id, numero, valor, status, boleto) values
      ('cccccccc-0000-0000-0000-00000000000f',1,781.38,'VENCIDA','99999990001');

    insert into public.pagamentos (id, aluno_id, data_pagamento, valor_pago, matricula, cpf, titulo_numero, numero_parcela_completo) values
      ('eeeeeeee-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','2026-09-08',781.38,'211004249','${CPF_A}','71006','50710060001'),
      ('eeeeeeee-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-10-07',781.38,'211004249','${CPF_A}','71006','50710060002');
    -- a baixa de 08/09 existe e esta SEM VINCULO (parcela_id nulo), como em producao
    insert into public.baixas_pagamento (aluno_id, data_pagamento, valor_pago, parcela_id)
      values ('aaaaaaaa-0000-0000-0000-000000000001','2026-09-08',781.38,null);
  `);

  // --- Caso 52411: pago integral, acordo CANCELADO, nada aberto, zero baixa -----
  await db.exec(`
    insert into public.alunos (id, nome, cpf, matricula) values
      ('aaaaaaaa-0000-0000-0000-000000000002','ALUNO DOIS','${CPF_B}','205');
    insert into public.prime_contratos values ('71014381','${CPF_B}');
    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002',
              'CANCELADO', 641.78, '52411', '2026-07-17 15:14:00+00', '2026-09-28 19:33:11+00');
    insert into public.parcelas (acordo_id, numero, valor, status, boleto) values
      ('cccccccc-0000-0000-0000-000000000002',0,328.88,'CANCELADA','50524110006'),
      ('cccccccc-0000-0000-0000-000000000002',1,320.89,'CANCELADA','50524110007');
    insert into public.pagamentos (aluno_id, data_pagamento, valor_pago, matricula, cpf, titulo_numero, numero_parcela_completo) values
      ('aaaaaaaa-0000-0000-0000-000000000002','2026-07-20',328.88,'71014381','${CPF_B}','52411','50524110006'),
      ('aaaaaaaa-0000-0000-0000-000000000002','2026-09-28',333.11,'71014381','${CPF_B}','52411','50524110007');
  `);

  // --- Caso 71398: credito no titulo vizinho; este foi cancelado, nada aberto ---
  await db.exec(`
    insert into public.alunos (id, nome, cpf, matricula) values
      ('aaaaaaaa-0000-0000-0000-000000000003','ALUNO TRES','${CPF_C}','573');
    insert into public.prime_contratos values ('2024009347','${CPF_C}');
    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000003',
              'CANCELADO', 42373.80, '71398', '2026-09-09 15:07:36+00', '2026-09-10 15:26:18+00');
    insert into public.parcelas (acordo_id, numero, valor, status, boleto) values
      ('cccccccc-0000-0000-0000-000000000003',1,42373.80,'CANCELADA','50713980001');
    insert into public.pagamentos (aluno_id, data_pagamento, valor_pago, matricula, cpf, titulo_numero, numero_parcela_completo) values
      ('aaaaaaaa-0000-0000-0000-000000000003','2026-09-09',42373.80,'2024009347','${CPF_C}','71398','50713980001');
  `);

  // --- Caso 64194: copia ATIVA com o MESMO numero_ulbra, 5 parcelas do valor pago
  await db.exec(`
    insert into public.alunos (id, nome, cpf, matricula) values
      ('aaaaaaaa-0000-0000-0000-000000000004','ALUNO QUATRO','${CPF_D}','900');
    insert into public.prime_contratos values ('232000377','${CPF_D}');
    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000004',
              'CANCELADO', 33806.40, '64194', '2026-07-01 10:00:00+00', '2026-09-23 10:00:00+00');
    insert into public.parcelas (acordo_id, numero, valor, status, boleto) values
      ('cccccccc-0000-0000-0000-000000000004',2,6761.27,'CANCELADA','50641940002');
    -- a copia ATIVA, mesmo numero_ulbra, com parcelas do valor exato pago
    insert into public.acordos (id, aluno_id, status, valor_total, numero_ulbra, criado_em, atualizado_em)
      values ('cccccccc-0000-0000-0000-00000000004f','aaaaaaaa-0000-0000-0000-000000000004',
              'ATIVO', 40567.67, '64194', '2026-07-01 10:00:00+00', '2026-07-01 10:00:00+00');
    insert into public.parcelas (acordo_id, numero, valor, status, boleto) values
      ('cccccccc-0000-0000-0000-00000000004f',2,6761.28,'VENCIDA','88888880002'),
      ('cccccccc-0000-0000-0000-00000000004f',3,6761.28,'VENCIDA','88888880003');
    insert into public.pagamentos (aluno_id, data_pagamento, valor_pago, matricula, cpf, titulo_numero, numero_parcela_completo) values
      ('aaaaaaaa-0000-0000-0000-000000000004','2026-07-14',6761.27,'232000377','${CPF_D}','64194','50641940002');
  `);
}

async function fila(db) {
  await db.exec(`set teste.gestao = 't'`);
  const r = await db.query(`select * from public.fila_pagamento_parcela_cancelada()`);
  return r.rows;
}
const por = (linhas, boleto) => linhas.find((l) => l.boleto_pago === boleto);

describe("fila de pagamento em parcela cancelada", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); await bancada(db); });

  it("o portão recusa quem não é gestão, com 42501", async () => {
    await db.exec(`set teste.gestao = 'f'`);
    await expect(db.query(`select * from public.fila_pagamento_parcela_cancelada()`))
      .rejects.toThrow(/somente a gestao/i);
  });

  it("não escreve nada: a função é STABLE e o Postgres recusaria DML", async () => {
    const vol = await db.query(
      `select p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='fila_pagamento_parcela_cancelada'`);
    expect(vol.rows[0].provolatile).toBe("s");
    const antes = await db.query(`select
      (select count(*) from public.parcelas where status='CANCELADA') c,
      (select count(*) from public.acordos where status='CANCELADO') a,
      (select count(*) from public.baixas_pagamento) b`);
    await fila(db);
    const depois = await db.query(`select
      (select count(*) from public.parcelas where status='CANCELADA') c,
      (select count(*) from public.acordos where status='CANCELADO') a,
      (select count(*) from public.baixas_pagamento) b`);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it("acha os seis pagamentos da bancada e nenhum a mais", async () => {
    const linhas = await fila(db);
    expect(linhas).toHaveLength(6);
    expect(linhas.map((l) => l.boleto_pago).sort()).toEqual([
      "50524110006", "50524110007", "50641940002",
      "50710060001", "50710060002", "50713980001",
    ]);
    // nenhuma linha da copia ATIVA ou do substituto entra: a parcela deles esta aberta
    // e o acordo esta ATIVO
    expect(linhas.some((l) => ["99999990001", "88888880002"].includes(l.boleto_pago))).toBe(false);
  });

  it("71006: a 2ª parcela é COMPROVADO e a 1ª é só vínculo (já tem baixa)", async () => {
    const linhas = await fila(db);
    const segunda = por(linhas, "50710060002");
    expect(segunda).toMatchObject({
      classificacao: "COMPROVADO", grupo: "T2", escopo: "PARCELA_CANCELADA",
      tem_baixa_equivalente: false, substituto_na_janela: 1,
      parcelas_abertas_mesmo_valor: 1, identidade_comprovada: true,
      pagou_antes_de_cancelar: false,
    });
    expect(Number(segunda.saldo_acordo_aberto)).toBeCloseTo(781.38, 2);

    const primeira = por(linhas, "50710060001");
    expect(primeira).toMatchObject({
      classificacao: "SO_VINCULO_BAIXA", tem_baixa_equivalente: true,
      baixa_sem_vinculo: true, pagou_antes_de_cancelar: true,
    });
  });

  it("52411: as duas parcelas são T1 / só vínculo, sem baixa nenhuma", async () => {
    const linhas = await fila(db);
    for (const b of ["50524110006", "50524110007"]) {
      expect(por(linhas, b)).toMatchObject({
        classificacao: "SO_VINCULO_BAIXA", grupo: "T1",
        tem_baixa_equivalente: false, acordo_numero_ulbra: "52411",
        acordo_status: "CANCELADO", parcela_status: "CANCELADA",
      });
      expect(Number(por(linhas, b).saldo_acordo_aberto)).toBe(0);
    }
  });

  it("71398: T1 / só vínculo, com a identidade provada pela ponte da Prime", async () => {
    const l = por(await fila(db), "50713980001");
    expect(l).toMatchObject({
      classificacao: "SO_VINCULO_BAIXA", grupo: "T1", identidade_comprovada: true,
      matricula_prime: "2024009347", acordo_numero_ulbra: "71398",
    });
    expect(Number(l.valor_pago)).toBeCloseTo(42373.80, 2);
  });

  it("64194: SINAL_FORTE por cópia ATIVA do mesmo número, sem substituto na janela", async () => {
    const l = por(await fila(db), "50641940002");
    expect(l).toMatchObject({
      classificacao: "SINAL_FORTE", grupo: "T2",
      copia_ativa_mesmo_numero: 1, substituto_na_janela: 0, parcelas_abertas_mesmo_valor: 2,
    });
  });

  it("SINAL_FORTE vira COMPROVADO só quando nasce substituto na janela", async () => {
    await db.exec(`update public.acordos set criado_em = '2026-09-23 10:00:30+00'
                    where id = 'cccccccc-0000-0000-0000-00000000004f'`);
    expect(por(await fila(db), "50641940002").classificacao).toBe("COMPROVADO");
  });

  it("sem casamento de valor o desfecho é INVESTIGAR, não SINAL_FORTE", async () => {
    await db.exec(`update public.parcelas set valor = 1.23
                    where acordo_id = 'cccccccc-0000-0000-0000-00000000004f'`);
    expect(por(await fila(db), "50641940002").classificacao).toBe("INVESTIGAR");
  });

  it("baixa equivalente derruba qualquer risco para só vínculo", async () => {
    await db.exec(`insert into public.baixas_pagamento (aluno_id, data_pagamento, valor_pago, parcela_id)
      values ('aaaaaaaa-0000-0000-0000-000000000001','2026-10-07',781.38,
              'dddddddd-0000-0000-0000-000000000002')`);
    const l = por(await fila(db), "50710060002");
    expect(l.classificacao).toBe("SO_VINCULO_BAIXA");
    expect(l.baixa_sem_vinculo).toBe(false);
  });

  it("sem matrícula não há prova de identidade, e a linha ainda aparece", async () => {
    await db.exec(`update public.pagamentos set matricula = null
                    where numero_parcela_completo = '50713980001'`);
    const l = por(await fila(db), "50713980001");
    expect(l.identidade_comprovada).toBe(false);
    expect(l.matricula_prime).toBeNull();
  });

  it("CPF divergente entre Prime e aluno reprova a identidade", async () => {
    await db.exec(`update public.prime_contratos set cpf = '99999999999' where registration = '2024009347'`);
    expect(por(await fila(db), "50713980001").identidade_comprovada).toBe(false);
  });

  it("duas linhas da Prime com CPFs diferentes para a mesma matrícula reprovam", async () => {
    await db.exec(`insert into public.prime_contratos values ('2024009347','98765432100')`);
    expect(por(await fila(db), "50713980001").identidade_comprovada).toBe(false);
  });

  it("boleto duplicado NÃO entra: sem unicidade não há vínculo determinístico", async () => {
    await db.exec(`insert into public.parcelas (acordo_id, numero, valor, status, boleto)
      values ('cccccccc-0000-0000-0000-000000000003', 9, 1.00, 'CANCELADA', '050713980001')`);
    expect(por(await fila(db), "50713980001")).toBeUndefined();
  });

  it("parcela aberta dentro de acordo cancelado entra em escopo próprio", async () => {
    await db.exec(`update public.parcelas set status = 'VENCIDA'
                    where boleto = '50713980001'`);
    const l = por(await fila(db), "50713980001");
    expect(l.escopo).toBe("ACORDO_CANCELADO_PARCELA_ABERTA");
    expect(l.parcela_status).toBe("VENCIDA");
  });

  it("parcela e acordo saudáveis saem da fila por inteiro", async () => {
    await db.exec(`
      update public.parcelas set status = 'VENCIDA' where boleto = '50713980001';
      update public.acordos set status = 'ATIVO' where numero_ulbra = '71398';`);
    expect(por(await fila(db), "50713980001")).toBeUndefined();
  });

  it("COMPROVADO vem primeiro na ordenação, para a tela não precisar reordenar", async () => {
    const linhas = await fila(db);
    expect(linhas[0].classificacao).toBe("COMPROVADO");
    const ordem = linhas.map((l) => l.classificacao);
    const peso = { COMPROVADO: 1, SINAL_FORTE: 2, INVESTIGAR: 3, SO_VINCULO_BAIXA: 4 };
    expect(ordem.map((c) => peso[c])).toEqual([...ordem.map((c) => peso[c])].sort());
  });

  it("authenticated recebe EXECUTE e public/anon não", async () => {
    const r = await db.query(`
      select has_function_privilege('authenticated','public.fila_pagamento_parcela_cancelada()','EXECUTE') aut,
             has_function_privilege('anon','public.fila_pagamento_parcela_cancelada()','EXECUTE') anon`);
    expect(r.rows[0].aut).toBe(true);
    expect(r.rows[0].anon).toBe(false);
  });
});
