// EFETIVIDADE — ETAPA 1: a view `efetividade_caixa_origem`, migration REAL
// 20261023131709, sobre a fixture de produção `confirmacao_d2` (dados FICTÍCIOS)
// em Postgres real (PGlite).
//
// O TESTE DE ACEITAÇÃO É O PRIMEIRO BLOCO, e é o que dá sentido aos outros:
// `count(*)` e `sum(valor_pago)` da view são IDÊNTICOS aos de `pagamentos`.
// Uma view de rastreabilidade que resolve 100% dos casos fáceis e deixa os
// difíceis de fora passaria em qualquer asserção de conteúdo e estaria errada
// no que importa -- esconderia dinheiro. Por isso a soma vem antes.
//
// O segundo bloco é a precedência das portas, e ele é deliberadamente
// desconfortável: o cenário P3 tem a porta PROVADA apontando para um acordo SEM
// título e uma porta de chave exata apontando para um acordo COM título. O
// resultado certo é INDETERMINADA -- a porta provada diz qual acordo foi pago, e
// usar o outro porque ele é mais conveniente seria inventar vínculo. Medido em
// produção em 23/10/2026: as portas concordam em 4.051 de 4.212 pagamentos; nos
// 161 em que discordam é esta regra que decide.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

const MIG = "20261023131709_efetividade_caixa_origem";
const TIMEOUT = 120000;

// ids fixos para poder asserir linha a linha
const AC_A = "aaaaaaaa-0000-4000-8000-000000000001"; // porta 1, 1 titulo, 2025/1
const AC_B = "aaaaaaaa-0000-4000-8000-000000000002"; // porta 2, 1 titulo, 2026/1
const AC_C = "aaaaaaaa-0000-4000-8000-000000000003"; // porta 1 SEM titulo (P3)
const AC_D = "aaaaaaaa-0000-4000-8000-000000000004"; // porta 2 COM titulo (P3)
const AC_E1 = "aaaaaaaa-0000-4000-8000-000000000005"; // numero_ulbra duplicado
const AC_E2 = "aaaaaaaa-0000-4000-8000-000000000006"; // numero_ulbra duplicado
const AC_F = "aaaaaaaa-0000-4000-8000-000000000007"; // 2 semestres
const AC_G = "aaaaaaaa-0000-4000-8000-000000000008"; // titulo sem serie
// AC_H existe porque o cenario do MUTIRAO precisava de um acordo LIMPO. O
// titulo de mutirao estava em AC_E1, que tem `numero_ulbra` duplicado com
// AC_E2: o pagamento cai em ACORDO_AMBIGUO, `alcance` nao roda (exige
// `acordos = 1`) e a segunda perna da CTE `tit` nunca era exercida. Era por
// isso que a assercao daquele teste tinha de ser fraca.
const AC_H = "aaaaaaaa-0000-4000-8000-000000000009"; // titulo SO pelo mutirao

const P = {
  provada: "bbbbbbbb-0000-4000-8000-000000000001",
  chave: "bbbbbbbb-0000-4000-8000-000000000002",
  discorda: "bbbbbbbb-0000-4000-8000-000000000003",
  ambiguo: "bbbbbbbb-0000-4000-8000-000000000004",
  multi: "bbbbbbbb-0000-4000-8000-000000000005",
  foraDoCrm: "bbbbbbbb-0000-4000-8000-000000000006",
  semSerie: "bbbbbbbb-0000-4000-8000-000000000007",
  mutirao: "bbbbbbbb-0000-4000-8000-000000000008",
};

const ROLES = `
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I', r);
    end if;
  end loop;
end $$;`;

// Um acordo, sua parcela (com boleto de 11 digitos) e seus titulos.
const CENARIO = `
-- valor_total distinto em cada um de propósito: produção tem um gatilho
-- ACORDO_DUPLICADO que recusa dois acordos ATIVOS do mesmo aluno com o mesmo
-- valor e as mesmas parcelas. O cenário tem de ser legal à luz das regras reais.
insert into public.acordos (id, aluno_id, status, numero_ulbra, valor_total, qtd_parcelas) values
  ('${AC_A}',  '${H.ALUNO_A}', 'ATIVO', '90001', 1001, 1),
  ('${AC_B}',  '${H.ALUNO_A}', 'ATIVO', '90002', 1002, 1),
  ('${AC_C}',  '${H.ALUNO_A}', 'ATIVO', '90003', 1003, 1),
  ('${AC_D}',  '${H.ALUNO_A}', 'ATIVO', '90004', 1004, 1),
  ('${AC_E1}', '${H.ALUNO_A}', 'ATIVO', '90005', 1005, 1),
  ('${AC_E2}', '${H.ALUNO_A}', 'ATIVO', '90005', 1015, 1),
  ('${AC_F}',  '${H.ALUNO_A}', 'ATIVO', '90006', 1006, 1),
  ('${AC_G}',  '${H.ALUNO_A}', 'ATIVO', '90007', 1007, 1),
  -- H: numero_ulbra UNICO e SEM parcela, para que so a porta 3 possa resolver
  ('${AC_H}',  '${H.ALUNO_A}', 'ATIVO', '90008', 1008, 1);

-- parcelas: o boleto e a chave da porta 2; origem_baixa_ref e a da porta 1
insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, origem_baixa_ref) values
  ('${AC_A}', 1, 100, current_date, 'PAGO',     '50900010001', '${P.provada}'),
  ('${AC_B}', 1, 100, current_date, 'A_VENCER', '50900020001', null),
  -- P3: a porta PROVADA leva ao acordo C (sem titulo)...
  ('${AC_C}', 1, 100, current_date, 'PAGO',     '50900030001', '${P.discorda}'),
  -- ...e a porta de chave exata, pelo boleto do pagamento, leva ao acordo D (com titulo)
  ('${AC_D}', 1, 100, current_date, 'A_VENCER', '50900040001', null),
  ('${AC_F}', 1, 100, current_date, 'A_VENCER', '50900060001', null),
  ('${AC_G}', 1, 100, current_date, 'A_VENCER', '50900070001', null);

insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, situacao, status, tipo_boleto, acordo_id) values
  ('cccccccc-0000-4000-8000-000000000001','${H.ALUNO_A}','11111111111','7000001', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_A}'),
  ('cccccccc-0000-4000-8000-000000000002','${H.ALUNO_A}','11111111111','7000002', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_B}'),
  ('cccccccc-0000-4000-8000-000000000004','${H.ALUNO_A}','11111111111','7000004', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_D}'),
  -- acordo F cobre dois semestres
  ('cccccccc-0000-4000-8000-000000000006','${H.ALUNO_A}','11111111111','7000006', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_F}'),
  ('cccccccc-0000-4000-8000-000000000007','${H.ALUNO_A}','11111111111','7000007', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_F}'),
  -- acordo G: titulo existe, serie do Prime nao
  ('cccccccc-0000-4000-8000-000000000008','${H.ALUNO_A}','11111111111','7000008', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade','${AC_G}');

-- acordo E1 recebe titulo pela porta do MUTIRAO (vinculo), nao pela direta
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, situacao, status, tipo_boleto) values
  ('cccccccc-0000-4000-8000-000000000005','${H.ALUNO_A}','11111111111','7000005', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade');
insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo)
  values ('${AC_E1}', 'cccccccc-0000-4000-8000-000000000005', true);

-- acordo H: MESMO caminho (titulo sem acordo_id, so o vinculo), mas com
-- numero_ulbra unico -- e por isso ele resolve e prova a segunda perna da CTE tit.
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, situacao, status, tipo_boleto) values
  ('cccccccc-0000-4000-8000-000000000009','${H.ALUNO_A}','11111111111','7000009', current_date-200, 500,'NEGOCIADO','em_aberto','Mensalidade');
insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo)
  values ('${AC_H}', 'cccccccc-0000-4000-8000-000000000009', true);
-- E AQUI ESTA O PONTO. Inserir o vinculo dispara logica de producao que PREENCHE
-- acordos_titulos.acordo_id -- entao, sem este update, a perna DIRETA da CTE tit
-- ja acharia o titulo e a perna do mutirao nunca seria exercida: o teste
-- passaria mesmo se ela fosse removida (conferido por mutacao em 23/10/2026).
-- Zerar o acordo_id reproduz o estado REAL dos vinculos historicos: medido em
-- producao em 23/10/2026, dos 5.702 vinculos ativos, 154 apontam para titulo com
-- acordo_id NULO e 1 para titulo cujo acordo_id DIVERGE do vinculo. Esses 155
-- sao alcancaveis SO pela segunda perna.
update public.acordos_titulos set acordo_id = null
 where id = 'cccccccc-0000-4000-8000-000000000009';

insert into public.prime_titulo_semestre (boleto, cpf, semestre) values
  ('7000001','11111111111','2025/1'),
  ('7000002','11111111111','2026/1'),
  ('7000004','11111111111','2026/1'),
  ('7000005','11111111111','2025/2'),
  ('7000006','11111111111','2025/1'),
  ('7000007','11111111111','2026/1'),
  ('7000009','11111111111','2025/2');
  -- 7000008 de proposito AUSENTE

insert into public.pagamentos
  (id, aluno_id, data_pagamento, valor_pago, valor_honorario, tipo_pagamento, titulo_numero, numero_parcela_completo) values
  ('${P.provada}',  '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90001', '50900010001'),
  ('${P.chave}',    '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90002', '50900020001'),
  -- P3: titulo_numero/boleto apontam para D, mas a parcela de C aponta para ESTE pagamento
  ('${P.discorda}', '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90004', '50900040001'),
  ('${P.ambiguo}',  '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90005', '99999999999'),
  ('${P.multi}',    '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90006', '50900060001'),
  ('${P.foraDoCrm}','${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '88888', '58888888888'),
  ('${P.semSerie}', '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90007', '50900070001'),
  -- MUTIRAO: titulo_numero casa o acordo H; o boleto NAO casa parcela nenhuma,
  -- entao as portas 1 e 2 nao respondem e sobra a 3.
  ('${P.mutirao}',  '${H.ALUNO_A}', current_date, 100, 7, 'SANTANDER', '90008', '50900089999');`;

const linha = (db, id) =>
  H.q1(db, `select * from public.efetividade_caixa_origem where pagamento_id = $1`, [id]);

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(CENARIO);
  await db.exec(H.MIG(MIG));
  return db;
}

describe("teste de aceitação: nenhum pagamento fica fora", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("count(*) e sum(valor_pago) são idênticos aos de pagamentos", async () => {
    const r = await H.q1(db, `
      select (select count(*) from public.efetividade_caixa_origem) linhas_view,
             (select count(*) from public.pagamentos)                linhas_pag,
             (select coalesce(round(sum(valor_pago),2),0) from public.efetividade_caixa_origem) soma_view,
             (select coalesce(round(sum(valor_pago),2),0) from public.pagamentos)                soma_pag,
             (select coalesce(round(sum(valor_honorario),2),0) from public.efetividade_caixa_origem) hon_view,
             (select coalesce(round(sum(coalesce(valor_honorario,0)),2),0) from public.pagamentos)   hon_pag`);
    expect(Number(r.linhas_view)).toBe(Number(r.linhas_pag));
    expect(Number(r.soma_view)).toBe(Number(r.soma_pag));
    expect(Number(r.hon_view)).toBe(Number(r.hon_pag));
    // a fixture tem pagamentos próprios: a invariante é medida sobre dados mistos
    expect(Number(r.linhas_view)).toBeGreaterThan(7);
  });

  it("toda linha é classificada, e nenhuma é classificada duas vezes", async () => {
    const r = await H.q1(db, `
      select count(*) filter (where semestre_origem is null and motivo_indeterminado is null) sem,
             count(*) filter (where semestre_origem is not null and motivo_indeterminado is not null) ambos
        from public.efetividade_caixa_origem`);
    expect(Number(r.sem)).toBe(0);
    expect(Number(r.ambos)).toBe(0);
  });

  it("uma linha por pagamento — a view não abre por título", async () => {
    const r = await H.q1(db, `
      select count(*) dup from (
        select pagamento_id from public.efetividade_caixa_origem group by 1 having count(*) > 1) x`);
    expect(Number(r.dup)).toBe(0);
  });
});

describe("as três portas e a precedência", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("porta provada (origem_baixa_ref) resolve e marca PROVADA", async () => {
    const l = await linha(db, P.provada);
    expect(l.porta_vinculo).toBe("origem_baixa_ref");
    expect(l.confianca).toBe("PROVADA");
    expect(l.semestre_origem).toBe("2025/1");
    expect(l.acordo_id).toBe(AC_A);
    expect(l.titulo_documento).toBe("7000001");
    expect(l.motivo_indeterminado).toBeNull();
  });

  it("porta do boleto da parcela resolve e marca CHAVE_EXATA, não PROVADA", async () => {
    const l = await linha(db, P.chave);
    expect(l.porta_vinculo).toBe("boleto_parcela");
    expect(l.confianca).toBe("CHAVE_EXATA");
    expect(l.semestre_origem).toBe("2026/1");
  });

  it("porta do número ULBRA alcança título vindo do MUTIRÃO (acordo_titulo_vinculo)", async () => {
    // O acordo H não tem título direto, só o vínculo do mutirão. Sem a segunda
    // perna da CTE `tit` esta linha sai como ACORDO_SEM_TITULO -- e o cenário
    // é construído para que isso aconteça de verdade (ver o `update` no
    // CENARIO). Medido em produção em 23/10/2026: dos 5.702 vínculos ativos,
    // 155 (154 com acordo_id nulo + 1 divergente) só são alcançáveis por esta
    // perna. Os outros 5.547 a perna direta também acha.
    const l = await linha(db, P.mutirao);
    expect(l.porta_vinculo).toBe("numero_ulbra");
    expect(l.acordo_id).toBe(AC_H);
    expect(Number(l.titulos_alcancados)).toBe(1);
    expect(l.semestre_origem).toBe("2025/2");
    expect(l.titulo_documento).toBe("7000009");
  });

  it("PRECEDÊNCIA: a porta provada vence, mesmo levando a um acordo SEM título", async () => {
    const l = await linha(db, P.discorda);
    // a porta provada aponta para o acordo C, que não tem título: o certo é
    // dizer que não sabe, não pegar o acordo D porque ele tem título.
    expect(l.porta_vinculo).toBe("origem_baixa_ref");
    expect(l.acordo_id).toBe(AC_C);
    expect(l.semestre_origem).toBeNull();
    expect(l.motivo_indeterminado).toBe("ACORDO_SEM_TITULO");
    expect(l.confianca).toBe("INDETERMINADA");
  });
});

describe("o que a view recusa a adivinhar", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("número ULBRA repetido em dois acordos não escolhe nenhum", async () => {
    const l = await linha(db, P.ambiguo);
    expect(l.acordo_id).toBeNull();
    expect(l.motivo_indeterminado).toBe("ACORDO_AMBIGUO");
    expect(l.semestre_origem).toBeNull();
  });

  it("acordo que cobre dois semestres não atribui a um deles", async () => {
    const l = await linha(db, P.multi);
    expect(Number(l.semestres_distintos)).toBe(2);
    expect(l.semestre_origem).toBeNull();
    expect(l.motivo_indeterminado).toBe("SEMESTRE_MULTIPLO");
  });

  it("acordo cujo título não tem série no Prime não infere pelo vencimento", async () => {
    const l = await linha(db, P.semSerie);
    expect(Number(l.titulos_alcancados)).toBe(1);
    expect(Number(l.semestres_distintos)).toBe(0);
    expect(l.semestre_origem).toBeNull();
    expect(l.motivo_indeterminado).toBe("TITULO_SEM_SERIE_PRIME");
  });

  it("pagamento sem acordo no CRM aparece, com o motivo nomeado", async () => {
    const l = await linha(db, P.foraDoCrm);
    expect(l).not.toBeUndefined();          // a linha EXISTE -- é o ponto
    expect(l.porta_vinculo).toBeNull();
    expect(l.acordo_id).toBeNull();
    expect(l.motivo_indeterminado).toBe("ACORDO_FORA_DO_CRM");
    expect(Number(l.valor_pago)).toBe(100); // e leva o valor consigo
  });
});

describe("a view nasce fechada", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("anon e authenticated não têm select; service_role tem", async () => {
    const r = await H.q1(db, `
      select has_table_privilege('anon','public.efetividade_caixa_origem','select') anon,
             has_table_privilege('authenticated','public.efetividade_caixa_origem','select') auth,
             has_table_privilege('service_role','public.efetividade_caixa_origem','select') svc`);
    expect(r.anon).toBe(false);
    expect(r.auth).toBe(false);
    expect(r.svc).toBe(true);
  });

  it("não tem privilégio de escrita para ninguém além do dono", async () => {
    const r = await H.q1(db, `
      select count(*) n from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'efetividade_caixa_origem'
         and grantee in ('anon','authenticated','PUBLIC')`);
    expect(Number(r.n)).toBe(0);
  });

  it("roda com as permissões de quem chama (security_invoker)", async () => {
    const r = await H.q1(db, `
      select (select count(*) from pg_options_to_table(c.reloptions)
               where option_name = 'security_invoker' and option_value = 'true') n
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = 'efetividade_caixa_origem'`);
    expect(Number(r.n)).toBe(1);
  });
});
