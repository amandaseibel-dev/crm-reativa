// RELATORIO "NAO BAIXADOS / REJEITADOS" DA PROJECAO -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) aplicando o ARQUIVO da migration.
//
// O QUE ESTE TESTE PROVA
//   * so entra pagamento que veio de importacao PROJECAO_DIARIA;
//   * quem baixou certo NAO entra, a nao ser com o filtro de historico completo;
//   * NENHUMA linha sai com motivo vazio -- a regra critica da gestao --,
//     inclusive a que nao tem estado gravado, que sai MOTIVO_NAO_CLASSIFICADO;
//   * PENDENTE / FEITO / REJEITADO saem com conclusao, motivo da rejeicao,
//     observacao, responsavel e data da decisao;
//   * baixa que foi desfeita depois aparece mesmo sem nenhum filtro;
//   * os contadores e a visao por aluno respeitam os filtros;
//   * a funcao e STABLE: o Postgres recusa escrita dentro dela -- e por isso
//     que abrir a tela nao baixa, nao reprocessa e nao mexe na fila;
//   * quem nao e da gestao nao le o relatorio.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(AQUI, "..", "migrations", "20260923140000_projecao_nao_baixados_relatorio.sql"), "utf8");

const BANCADA = `
  do $$ begin if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon; end if; end $$;
  do $$ begin if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role; end if; end $$;
  create schema if not exists auth;
  create or replace function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
  create or replace function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select coalesce(current_setting('teste.gestao', true), 'on') = 'on' $$;

  create table public.importacoes (
    id uuid primary key default gen_random_uuid(),
    tipo text, arquivo_nome text, created_at timestamp default now()
  );
  create table public.alunos (
    id uuid primary key default gen_random_uuid(),
    nome text, matricula text, cpf_mascarado text,
    saldo_total numeric, saldo_vencido numeric
  );
  create table public.acordos (
    id uuid primary key default gen_random_uuid(),
    numero_ulbra text, status text
  );
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(),
    acordo_id uuid references public.acordos(id),
    numero int, status text, vencimento date, boleto text unique
  );
  create table public.pagamentos (
    id uuid primary key default gen_random_uuid(),
    importacao_id uuid references public.importacoes(id),
    aluno_id uuid references public.alunos(id),
    aluno_nome text, matricula text, cpf text, titulo_numero text,
    numero_parcela_completo text, data_pagamento date,
    valor_pago numeric, valor_honorario numeric, operador_nome text,
    status_conciliacao text, conciliacao_motivo text, conciliacao_em timestamptz
  );
  create table public.fila_pagamento_sem_vinculo (
    id bigserial primary key,
    pagamento_id uuid not null unique references public.pagamentos(id) on delete cascade,
    boleto text, motivo text, observacao text, status_conciliacao text,
    decisao text, decidido_por text, decidido_em timestamptz,
    conclusao text, motivo_rejeicao text,
    detectado_em timestamptz not null default now(),
    primeira_tentativa_em timestamptz default now(),
    ultima_tentativa_em timestamptz default now(),
    quantidade_tentativas integer not null default 1
  );
`;

// Um caso de cada desfecho que a Projecao ja produziu de verdade.
const CENARIO = `
  insert into public.importacoes (id, tipo, arquivo_nome, created_at) values
    ('11111111-1111-1111-1111-111111111111','PROJECAO_DIARIA','17.09 11.03.xlsx','2026-09-17 14:04:00'),
    ('22222222-2222-2222-2222-222222222222','BORDERO','bordero.xlsx','2026-09-17 14:04:00');

  insert into public.alunos (id, nome, matricula, cpf_mascarado, saldo_total, saldo_vencido) values
    ('aaaaaaaa-0000-0000-0000-000000000001','Ana Pendente','2320001','600.548.710-85', 5000, 2000),
    ('aaaaaaaa-0000-0000-0000-000000000002','Bruno Rejeitado','2320002','111.222.333-44', 0, 0),
    ('aaaaaaaa-0000-0000-0000-000000000003','Carla Feito','2320003','555.666.777-88', 1200, 1200);

  insert into public.acordos (id, numero_ulbra, status) values
    ('bbbbbbbb-0000-0000-0000-000000000001','71262','ATIVO');
  insert into public.parcelas (id, acordo_id, numero, status, vencimento, boleto) values
    ('cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',1,'PAGO','2026-09-19','5071262000'),
    ('cccccccc-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001',2,'VENCIDA','2026-08-19','5071262001');

  insert into public.pagamentos
    (id, importacao_id, aluno_id, aluno_nome, matricula, cpf, titulo_numero,
     numero_parcela_completo, data_pagamento, valor_pago, valor_honorario,
     operador_nome, status_conciliacao, conciliacao_motivo)
  values
    -- 1. PENDENTE: aguardando acordo, sem decisao na fila
    ('dddddddd-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Pendente','2320001','60054871085','71859',
     '50718590001','2026-09-17', 1000.00, 80.00,'Nataly','AGUARDANDO_ACORDO',
     'boleto 50718590001 nao existe em parcelas e o acordo 071859 nao esta no CRM'),
    -- 2. REJEITADO pela gestao
    ('dddddddd-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000002','Bruno Rejeitado','2320002','11122233344','71860',
     '50718600001','2026-09-16', 2500.00, 200.00,'Luana','AGUARDANDO_ACORDO',
     'boleto 50718600001 nao existe em parcelas e o acordo 071860 nao esta no CRM'),
    -- 3. FEITO: encerrado sem baixa financeira
    ('dddddddd-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000003','Carla Feito','2320003','55566677788','71861',
     '50718610001','2026-09-15', 300.00, 24.00,'Olga','PARCELA_JA_PAGA',
     'a parcela ja estava PAGO antes deste pagamento entrar'),
    -- 4. BAIXADO certo: NAO e pendencia
    ('dddddddd-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Pendente','2320001','60054871085','71262',
     '05071262000','2026-09-14', 700.00, 56.00,'Nataly','BAIXADO', null),
    -- 5. BAIXADO mas a parcela voltou a VENCIDA: pendencia mesmo sem filtro
    ('dddddddd-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001','Ana Pendente','2320001','60054871085','71262',
     '05071262001','2026-09-13', 650.00, 52.00,'Nataly','BAIXADO', null),
    -- 6. ANTERIOR A 14/09: sem estado e sem motivo gravado
    ('dddddddd-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',
     null,'Diego Antigo','2320004','99988877766','70001',
     '50700010001','2026-08-20', 4321.00, 345.68,'Nataly', null, null),
    -- 7. NAO e da Projecao: importacao de borderô
    ('dddddddd-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222',
     'aaaaaaaa-0000-0000-0000-000000000002','Bruno Rejeitado','2320002','11122233344','71999',
     '50719990001','2026-09-17', 9999.00, 800.00,'Luana','AGUARDANDO_ACORDO','nao deveria aparecer');

  insert into public.fila_pagamento_sem_vinculo
    (pagamento_id, boleto, motivo, status_conciliacao, decisao, decidido_por, decidido_em,
     conclusao, motivo_rejeicao, observacao, quantidade_tentativas,
     primeira_tentativa_em, ultima_tentativa_em)
  values
    ('dddddddd-0000-0000-0000-000000000001','50718590001','acordo 071859 nao esta no CRM',
     'AGUARDANDO_ACORDO', null, null, null, null, null, null, 3,
     '2026-09-17 14:04:00+00','2026-09-22 09:00:00+00'),
    ('dddddddd-0000-0000-0000-000000000002','50718600001','acordo 071860 nao esta no CRM',
     'AGUARDANDO_ACORDO','REJEITADO','amanda.seibel@aelbra.com.br','2026-09-22 10:00:00+00',
     null,'NAO_E_ENTRADA_DE_ACORDO','conferido no Prime: e mensalidade avulsa', 2,
     '2026-09-16 14:00:00+00','2026-09-22 10:00:00+00'),
    ('dddddddd-0000-0000-0000-000000000003','50718610001','parcela ja paga',
     'PARCELA_JA_PAGA','FEITO','cobranca04@aelbra.com.br','2026-09-21 11:00:00+00',
     'JA_TRATADO', null,'baixa antiga apenas com referencia deslocada', 1,
     '2026-09-15 14:00:00+00','2026-09-21 11:00:00+00');
`;

let db;
const ler = async (filtros = {}) => {
  const r = await db.query("select public.projecao_nao_baixados($1::jsonb) j", [JSON.stringify(filtros)]);
  return r.rows[0].j;
};

beforeEach(async () => {
  db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(MIGRATION);
  await db.exec(CENARIO);
});

describe("projecao_nao_baixados -- populacao", () => {
  it("traz so o que nao baixou, e so o que veio da PROJECAO_DIARIA", async () => {
    const r = await ler();
    const boletos = r.linhas.map((l) => l.boleto).sort();
    // 1 pendente + 1 rejeitado + 1 feito + 1 baixa desfeita depois.
    expect(boletos).toEqual(["05071262001", "50718590001", "50718600001", "50718610001"]);
    // o de borderô nunca entra, mesmo estando AGUARDANDO_ACORDO
    expect(r.linhas.some((l) => l.boleto === "50719990001")).toBe(false);
    // o que baixou certo tambem nao
    expect(r.linhas.some((l) => l.boleto === "05071262000")).toBe(false);
  });

  it("baixa desfeita depois e pendencia, sem precisar de filtro nenhum", async () => {
    const l = (await ler()).linhas.find((x) => x.boleto === "05071262001");
    expect(l.status_baixa).toBe("BAIXADO");
    expect(l.situacao_parcela).toBe("VENCIDA");
    expect(l.motivo_categoria).toBe("BAIXA_DESFEITA_DEPOIS");
    expect(l.motivo_texto).toMatch(/nao esta mais PAGO/);
  });

  it("os anteriores a 14/09 so entram quando a gestao pede", async () => {
    expect((await ler()).linhas.some((l) => l.boleto === "50700010001")).toBe(false);
    const r = await ler({ incluir_sem_estado: true });
    const antigo = r.linhas.find((l) => l.boleto === "50700010001");
    expect(antigo.status_baixa).toBe("NAO_REGISTRADO");
    expect(antigo.motivo_categoria).toBe("MOTIVO_NAO_CLASSIFICADO");
    expect(antigo.motivo_texto).toMatch(/antes de 14\/09\/2026/);
    expect(antigo.resultado_analise).toBe("SEM_ANALISE");
  });

  it("historico completo traz ate o que baixou certo", async () => {
    const r = await ler({ incluir_baixados: true });
    const ok = r.linhas.find((l) => l.boleto === "05071262000");
    expect(ok.motivo_categoria).toBe("SEM_PENDENCIA");
    expect(ok.resultado_analise).toBe("BAIXADO_SEM_PENDENCIA");
    expect(r.contadores.linhas).toBe(6);
  });
});

describe("projecao_nao_baixados -- a regra critica", () => {
  it("NENHUMA linha sai sem motivo, em nenhum dos tres recortes", async () => {
    for (const filtros of [{}, { incluir_sem_estado: true }, { incluir_baixados: true }]) {
      const r = await ler(filtros);
      expect(r.contadores.sem_motivo).toBe(0);
      for (const l of r.linhas) {
        expect(String(l.motivo_categoria || "").trim()).not.toBe("");
        expect(String(l.motivo_texto || "").trim()).not.toBe("");
      }
    }
  });
});

describe("projecao_nao_baixados -- a decisao", () => {
  it("PENDENTE e a ausencia de decisao, e traz as tentativas", async () => {
    const l = (await ler()).linhas.find((x) => x.boleto === "50718590001");
    expect(l.resultado_analise).toBe("PENDENTE");
    expect(l.status_fila).toBe("ABERTA");
    expect(l.decisao).toBe(null);
    expect(l.quantidade_tentativas).toBe(3);
    expect(l.primeira_tentativa_em).toBeTruthy();
    expect(l.ultima_tentativa_em).toBeTruthy();
  });

  it("REJEITADO mostra o motivo, a observacao, quem decidiu e quando", async () => {
    const l = (await ler()).linhas.find((x) => x.boleto === "50718600001");
    expect(l.resultado_analise).toBe("REJEITADO");
    expect(l.motivo_rejeicao).toBe("NAO_E_ENTRADA_DE_ACORDO");
    expect(l.observacao).toMatch(/mensalidade avulsa/);
    expect(l.decidido_por).toBe("amanda.seibel@aelbra.com.br");
    expect(l.decidido_em).toBeTruthy();
    expect(l.conclusao).toBe(null);
  });

  it("FEITO mostra a conclusao e continua sendo um pagamento sem baixa", async () => {
    const l = (await ler()).linhas.find((x) => x.boleto === "50718610001");
    expect(l.resultado_analise).toBe("FEITO");
    expect(l.conclusao).toBe("JA_TRATADO");
    expect(l.motivo_rejeicao).toBe(null);
    expect(l.status_baixa).toBe("NAO_BAIXADO");
  });
});

describe("projecao_nao_baixados -- contadores e agrupamento", () => {
  it("os contadores batem com o recorte padrao", async () => {
    const c = (await ler()).contadores;
    expect(c.linhas).toBe(4);
    expect(c.pendentes).toBe(1);
    expect(c.feito).toBe(1);
    expect(c.rejeitado).toBe(1);
    expect(Number(c.valor_pendente)).toBe(1000);
    expect(Number(c.valor_rejeitado)).toBe(2500);
    expect(c.alunos_unicos).toBe(3);
    expect(Number(c.valor_total)).toBe(4450);
  });

  it("os contadores respeitam o filtro aplicado", async () => {
    const c = (await ler({ resultado: ["REJEITADO"] })).contadores;
    expect(c.linhas).toBe(1);
    expect(c.rejeitado).toBe(1);
    expect(c.pendentes).toBe(0);
    expect(Number(c.valor_total)).toBe(2500);
  });

  it("array de filtro vazio nao zera o relatorio", async () => {
    const c = (await ler({ resultado: [], status_conciliacao: [] })).contadores;
    expect(c.linhas).toBe(4);
  });

  it("a visao por aluno soma o aluno inteiro", async () => {
    const ana = (await ler()).por_aluno.find((a) => a.aluno_nome === "Ana Pendente");
    expect(ana.qtd).toBe(2);           // o pendente + a baixa desfeita
    expect(ana.qtd_pendente).toBe(1);
    expect(Number(ana.valor_total)).toBe(1650);
    expect(Number(ana.saldo_total)).toBe(5000);
    expect(ana.pagamento_mais_antigo).toBe("2026-09-13");
    expect(ana.ultimo_pagamento).toBe("2026-09-17");
  });

  it("ordena por maior valor, e tambem do mais antigo para o mais recente", async () => {
    const porValor = (await ler()).linhas.map((l) => Number(l.valor_pago));
    expect(porValor).toEqual([...porValor].sort((a, b) => b - a));
    const porData = (await ler({ ordem: "ANTIGO_PRIMEIRO" })).linhas.map((l) => l.data_pagamento);
    expect(porData).toEqual([...porData].sort());
  });

  it("filtra por periodo, valor, saldo e busca livre", async () => {
    expect((await ler({ pagamento_de: "2026-09-16" })).contadores.linhas).toBe(2);
    expect((await ler({ valor_min: 1000 })).contadores.linhas).toBe(2);
    expect((await ler({ saldo: "ZERO" })).contadores.linhas).toBe(1);
    expect((await ler({ termo: "Bruno" })).contadores.linhas).toBe(1);
    expect((await ler({ termo: "111.222.333-44" })).contadores.linhas).toBe(1);
    expect((await ler({ boleto: "50718590001" })).contadores.linhas).toBe(1);
    // curinga digitado nao pode virar filtro: `%` nao casa com nada aqui
    expect((await ler({ termo: "%" })).contadores.linhas).toBe(0);
  });

  it("o teto corta a lista, nunca a conta", async () => {
    const r = await ler({ limite: 1 });
    expect(r.linhas.length).toBe(1);
    expect(r.truncado).toBe(true);
    expect(r.contadores.linhas).toBe(4);
    expect(Number(r.contadores.valor_total)).toBe(4450);
  });

  it("nao devolve o CPF cru -- so o mascarado do cadastro", async () => {
    const l = (await ler()).linhas[0];
    expect(l.cpf).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(l, "cpf_mascarado")).toBe(true);
  });
});

describe("projecao_nao_baixados -- so leitura, so gestao", () => {
  it("e STABLE: o Postgres recusa escrita dentro dela", async () => {
    const r = await db.query(
      "select provolatile from pg_proc where oid = 'public.projecao_nao_baixados(jsonb)'::regprocedure");
    expect(r.rows[0].provolatile).toBe("s");
  });

  it("ler o relatorio nao muda pagamento, parcela nem fila", async () => {
    const antes = await db.query(`select
        (select count(*) from public.pagamentos where status_conciliacao is distinct from 'BAIXADO') p,
        (select count(*) from public.parcelas where status = 'PAGO') pa,
        (select count(*) from public.fila_pagamento_sem_vinculo where decisao is null) f,
        (select md5(string_agg(id::text || coalesce(status_conciliacao,'-') || coalesce(conciliacao_motivo,'-'), '|' order by id))
           from public.pagamentos) h`);
    await ler();
    await ler({ incluir_baixados: true });
    const depois = await db.query(`select
        (select count(*) from public.pagamentos where status_conciliacao is distinct from 'BAIXADO') p,
        (select count(*) from public.parcelas where status = 'PAGO') pa,
        (select count(*) from public.fila_pagamento_sem_vinculo where decisao is null) f,
        (select md5(string_agg(id::text || coalesce(status_conciliacao,'-') || coalesce(conciliacao_motivo,'-'), '|' order by id))
           from public.pagamentos) h`);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });

  it("quem nao e da gestao nao le", async () => {
    await db.exec("set teste.gestao = 'off'");
    await expect(ler()).rejects.toThrow(/gestao financeira/i);
  });

  it("anon nao pode executar", async () => {
    const r = await db.query(
      "select has_function_privilege('anon','public.projecao_nao_baixados(jsonb)','EXECUTE') pode");
    expect(r.rows[0].pode).toBe(false);
  });
});
