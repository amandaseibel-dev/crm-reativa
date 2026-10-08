// PARCELA DEVOLVIDA E SUSPENSA — migrations REAIS 20261007210000 (fundação) e
// 20261007211500 (regra), sobre a fixture de produção `confirmacao_d2` (funções
// e gatilhos com o texto exato de produção, dados FICTÍCIOS).
//
// As quatro regras aprovadas pela gestão em 07/10/2026, e o que cada uma exige
// que este teste prove:
//
//   1. `PAGO` só com pagamento real  -> nenhum caminho sem dinheiro escreve
//      PAGO, `origem_baixa`, `pago_em` ou `honorarios`;
//   2. saída definitiva -> `DEVOLVIDA`  -> sai do saldo E não é pagamento;
//   3. suspensão temporária -> `SUSPENSA` -> sai da cobrança, a dívida FICA,
//      e existe caminho de volta;
//   4. nada gera pagamento, baixa, honorário ou recuperação -> `pagamentos` e
//      `baixas_pagamento` intocados, `quitado_em` nulo, e — o ponto mais
//      sutil — o ACORDO não vira QUITADO só porque as parcelas saíram.
//
// A regra 4 é a que tinha a armadilha real: `_acordo_fecha_com_a_ultima_parcela`
// fecha o acordo quando não sobra parcela viva, e acordo QUITADO dispara
// `titulos_por_status_acordo` -> `titulo_reavaliar`, que carimbaria
// `origem_liquidacao = 'ACORDO_QUITADO'` nas mensalidades. Sem a guarda de
// pagamento real, devolver um acordo inteiro afirmaria recuperação em cascata.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";

const TIMEOUT = 120000;

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

// A fixture não traz catálogo (ela é do fluxo de confirmação). Estas são as
// linhas de PRODUÇÃO conferidas em 07/10/2026, antes da regra nova.
const CATALOGO = `
-- A fixture cria \`tabulacoes\` sem chave; produção tem PRIMARY KEY (codigo)
-- (conferido em 07/10/2026). Sem ela o \`on conflict (codigo)\` da migration não
-- tem como casar. Acrescentada aqui, e não na fixture compartilhada, para não
-- mexer no schema que os outros 140 arquivos de teste usam.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tabulacoes'::regclass and contype = 'p') then
    alter table public.tabulacoes add primary key (codigo);
  end if;
end $$;

insert into public.tabulacoes
  (codigo, rotulo, ativa, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloqueia_acionamento, sistema, somente_gestao, redireciona_para_email, criado_por)
values
  ('ANTECIPACAO_SEMESTRE','Antecipação de semestre', true, 540, 'ALEGACAO', 'DIAS_UTEIS', 20,
   'AGUARDAR_RETORNO_UNIDADE', true, false, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026'),
  ('CANCELAMENTO_COBRANCA','Cancelamento definitivo de cobrança', true, 420, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, null, 'fixture'),
  ('SUSPENSAO_COBRANCA','Suspensão de cobrança', true, 430, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, null, 'fixture'),
  ('MENSAGEM_ENVIADA','Mensagem enviada', true, 20, 'CONTATO', 'DIAS_UTEIS', 5,
   'CONTATAR', false, false, false, null, 'fixture');`;

// ALUNO_A tem acordo ATIVO com 2 parcelas vivas (VENCIDA 665,89 + A_VENCER
// 665,98) e honorário 49,33 em cada. O título aberto é inserido aqui para que
// exista saldo de ALUNO a sair da conta.
const TITULO = (id, doc) => `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
   situacao, status, tipo_boleto)
values
  ('${id}', '${H.ALUNO_A}',
   (select cpf_limpo from public.casos where aluno_id = '${H.ALUNO_A}' limit 1),
   '${doc}', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade');`;

const TIT_ID = "11111111-1111-4111-8111-111111111111";
const MOTIVO = "unidade Canoas confirmou em 06/10/2026";

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  // `suspensao_cobranca_reativar` confere o portão canônico antes de
  // confirmar a reativação; a fixture não o traz
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO(TIT_ID, "9900001"));
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await H.como(db, H.GESTAO);
  return db;
}

const parcelas = (d) =>
  H.qn(d, `select p.numero, p.status, p.valor, p.honorarios, p.pago_em, p.origem_baixa,
                  p.efeito_sem_pagamento, p.efeito_sem_pagamento_origem
             from public.parcelas p join public.acordos a on a.id = p.acordo_id
            where a.aluno_id = $1 order by p.numero, p.id`, [H.ALUNO_A]);
const saldo = async (d) =>
  Number((await H.q1(d, `select public.aluno_saldo_pendente_detalhe($1, null) s`, [H.ALUNO_A])).s.total);
const dinheiro = (d) =>
  H.q1(d, `select (select count(*) from public.pagamentos) pag,
                  (select count(*) from public.baixas_pagamento) baixas,
                  (select coalesce(sum(valor_honorario),0) from public.pagamentos) honor`);
describe("fundação parcela_viva — tem de ser NEUTRA", () => {
  let db, antes, depois;

  beforeAll(async () => {
    db = await H.montarProd();
    await db.exec(ROLES);
  // `suspensao_cobranca_reativar` confere o portão canônico antes de
  // confirmar a reativação; a fixture não o traz
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
    await db.exec(CATALOGO);
    await db.exec(TITULO(TIT_ID, "9900001"));
    await db.exec(H.MIG(M_ANTECIP));
    antes = await H.snap(db);
    await db.exec(H.MIG(M_FUND));
    depois = await H.snap(db);
  }, TIMEOUT);

  it("não escreve em nenhuma linha", () => {
    expect(H.diff(antes, depois)).toEqual([]);
  });

  it("concorda com as 5 variantes equivalentes, para todo status presente", async () => {
    const r = await H.qn(db, `
      select s, public.parcela_viva(s) as canonica,
             s not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') as v1,
             s not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') as v2,
             s not in ('PAGO','CANCELADA') as v3,
             s not in ('PAGO','CANCELADA','CANCELADO') as v5,
             s not in ('PAGO','CANCELADA','ESTORNADA') as v6
        from (select distinct upper(coalesce(status,'')) s from public.parcelas) z`);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) {
      expect([x.s, x.v1, x.v2, x.v3, x.v5, x.v6]).toEqual([x.s, x.canonica, x.canonica, x.canonica, x.canonica, x.canonica]);
    }
  });

  it("NÃO trata RENEGOCIADA como morta — a divergência dos 6 pontos foi preservada", async () => {
    const r = await H.q1(db, `select public.parcela_viva('RENEGOCIADA') as viva`);
    expect(r.viva).toBe(true);
  });

  it("status desconhecido falha para o lado seguro: continua cobrável", async () => {
    const r = await H.q1(db, `select public.parcela_viva('DEVOLVIDO_TYPO') as viva, public.parcela_viva(null) as nula`);
    expect(r.viva).toBe(true);
    expect(r.nula).toBe(true);
  });

  it("não sobra nenhuma lista equivalente sem migrar", async () => {
    const r = await H.q1(db, `
      select count(*)::int c
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
             lateral regexp_matches(pg_get_functiondef(p.oid),
               '(?:upper\\s*\\(\\s*)?(?:coalesce\\s*\\(\\s*)?((?:[A-Za-z_][A-Za-z0-9_]*\\.)?status)(?:\\s*,\\s*''''\\s*\\))?\\s*\\)?\\s*not\\s+in\\s*\\(\\s*''PAGO''(?:\\s*,\\s*''(?:PAGA|CANCELADA|CANCELADO|ESTORNADA|ESTORNADO)'')*\\s*\\)', 'gi')
       where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'parcela_viva'`);
    expect(r.c).toBe(0);
  });
});

describe("a regra em si — DEVOLVIDA", () => {
  let db, antesDinheiro, r;

  beforeAll(async () => {
    db = await montar();
    antesDinheiro = await dinheiro(db);
    r = (await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'CANCELAMENTO_COBRANCA',false) r`,
      [H.ALUNO_A, MOTIVO])).r;
  }, TIMEOUT);

  it("o retorno do motor descreve o que ele fez", async () => {
    // O payload é contrato da função -- quem chama (gatilho, ficha, rotina) se
    // orienta por ele. Sem esta asserção o número devolvido podia divergir do
    // que foi escrito e nenhum teste veria.
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(false);
    expect(r.efeito).toBe("DEVOLVIDA");
    expect(r.definitivo).toBe(true);
    expect(r.origem).toBe("CANCELAMENTO_COBRANCA");
    expect(r.parcelas_afetadas_qtd).toBe(2);
    expect(Number(r.titulos_encerrados_valor)).toBe(1200);
    expect(Number(r.saldo_depois)).toBe(0);
  });

  it("a parcela fica DEVOLVIDA — nunca PAGO (regra 1)", async () => {
    const p = await parcelas(db);
    const afetadas = p.filter((x) => x.efeito_sem_pagamento === "DEVOLVIDA");
    expect(afetadas).toHaveLength(2);
    expect(afetadas.every((x) => x.status === "DEVOLVIDA")).toBe(true);
    expect(afetadas.every((x) => x.efeito_sem_pagamento_origem === "CANCELAMENTO_COBRANCA")).toBe(true);
  });

  it("não escreve pago_em, origem_baixa nem honorário (regra 1 e 4)", async () => {
    const p = (await parcelas(db)).filter((x) => x.efeito_sem_pagamento === "DEVOLVIDA");
    expect(p.every((x) => x.pago_em === null)).toBe(true);
    expect(p.every((x) => x.origem_baixa === null)).toBe(true);
    // a fixture traz 49,33 nas duas: o valor tem de ficar IGUAL, não só não-nulo
    expect(p.map((x) => Number(x.honorarios))).toEqual([49.33, 49.33]);
  });

  it("o saldo sai da conta e o título é encerrado administrativamente", async () => {
    expect(await saldo(db)).toBe(0);
    const t = await H.q1(db, `select situacao, status, origem_encerramento, origem_liquidacao
                                from public.acordos_titulos where id = $1`, [TIT_ID]);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
    expect(t.origem_liquidacao).toBeNull();
  });

  it("o ACORDO não vira QUITADO — a armadilha da regra 4", async () => {
    const a = await H.qn(db, `select status from public.acordos where aluno_id = $1`, [H.ALUNO_A]);
    expect(a.every((x) => x.status !== "QUITADO")).toBe(true);
  });

  it("nenhuma mensalidade recebe origem_liquidacao = ACORDO_QUITADO", async () => {
    const n = await H.q1(db, `select count(*)::int c from public.acordos_titulos
                               where aluno_id = $1 and origem_liquidacao = 'ACORDO_QUITADO'`, [H.ALUNO_A]);
    expect(n.c).toBe(0);
  });

  it("não cria pagamento nem baixa: o caixa fica intocado (regra 4)", async () => {
    expect(await dinheiro(db)).toEqual(antesDinheiro);
  });

  it("não se disfarça de quitação: quitado_em e origem_quitacao nulos", async () => {
    const c = await H.q1(db, `select quitado_em, origem_quitacao, status_financeiro, nao_acionar
                                from public.casos where aluno_id = $1`, [H.ALUNO_A]);
    expect(c.quitado_em).toBeNull();
    expect(c.origem_quitacao).toBeNull();
    expect(c.nao_acionar).toBe(true);
  });

  it("o alerta D-2 reage aos status novos e rotula certo (estrutural)", async () => {
    // A fixture não monta `acordo_alertas_parcela`, então consultar a tabela
    // passaria por vacuidade -- o teste olha o GATILHO, que é onde a regra
    // mora e que existe em qualquer ambiente.
    const t = await H.q1(db, `
      select pg_get_triggerdef(t.oid) as def
        from pg_trigger t where t.tgname = 'trg_acordo_alerta_resolve_parcela'`);
    expect(t.def).toMatch(/DEVOLVIDA/);
    expect(t.def).toMatch(/SUSPENSA/);

    const f = await H.q1(db, `
      select pg_get_functiondef(oid) as def from pg_proc
       where proname = 'tg_acordo_alerta_resolve_parcela'`);
    // devolução e suspensão não podem ser rotuladas como "SUBSTITUIDA"
    expect(f.def).toMatch(/'DEVOLVIDA' then 'DEVOLVIDA'/);
    expect(f.def).toMatch(/'SUSPENSA' then 'SUSPENSA'/);
  });

  it("audita o efeito, a origem e quem decidiu", async () => {
    const a = await H.q1(db, `select * from public.parcela_efeito_sem_pagamento_auditoria where aluno_id = $1`, [H.ALUNO_A]);
    expect(a.efeito).toBe("DEVOLVIDA");
    expect(a.origem).toBe("CANCELAMENTO_COBRANCA");
    expect(a.executado_por).toBe(H.GESTAO);
    expect(Number(a.saldo_depois)).toBe(0);
  });

  it("aplicar de novo não afeta mais nada", async () => {
    const antes = await parcelas(db);
    const r2 = (await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'CANCELAMENTO_COBRANCA',false) r`,
      [H.ALUNO_A, MOTIVO])).r;
    expect(r2.parcelas_afetadas_qtd).toBe(0);
    expect(await parcelas(db)).toEqual(antes);
  });
});

describe("a regra em si — SUSPENSA e a volta", () => {
  let db, r;

  beforeAll(async () => {
    db = await montar();
    r = (await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'SUSPENSAO_COBRANCA',false) r`,
      [H.ALUNO_A, MOTIVO])).r;
  }, TIMEOUT);

  it("a parcela fica SUSPENSA e sai do cobrável", async () => {
    const p = (await parcelas(db)).filter((x) => x.efeito_sem_pagamento === "SUSPENSA");
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.status === "SUSPENSA")).toBe(true);
    expect(r.definitivo).toBe(false);
  });

  it("a DÍVIDA FICA: o título NÃO é encerrado (diferença de DEVOLVIDA)", async () => {
    const t = await H.q1(db, `select situacao, origem_encerramento from public.acordos_titulos where id = $1`, [TIT_ID]);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
    expect(r.titulos_encerrados_qtd).toBe(0);
    // e por isso o saldo do aluno continua existindo
    expect(await saldo(db)).toBeGreaterThan(0);
  });

  it("a volta devolve a parcela para A_VENCER/VENCIDA pelo vencimento", async () => {
    const v = (await H.q1(db, `select public.suspensao_cobranca_reativar($1,'unidade negou a suspensão',false) r`,
      [H.ALUNO_A])).r;
    expect(v.parcelas_reativadas_qtd).toBe(2);

    const p = await parcelas(db);
    const voltou = p.filter((x) => ["A_VENCER", "VENCIDA"].includes(x.status));
    expect(voltou).toHaveLength(2);
    expect(voltou.every((x) => x.efeito_sem_pagamento === null)).toBe(true);

    const c = await H.q1(db, `select nao_acionar from public.casos where aluno_id = $1`, [H.ALUNO_A]);
    expect(c.nao_acionar).toBe(false);
  });

  it("a reversão fica registrada na auditoria", async () => {
    const a = await H.q1(db, `select revertida_em, revertida_por from public.parcela_efeito_sem_pagamento_auditoria
                               where aluno_id = $1 and efeito = 'SUSPENSA'`, [H.ALUNO_A]);
    expect(a.revertida_em).not.toBeNull();
    expect(a.revertida_por).toBe(H.GESTAO);
  });
});

describe("governança e travas", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("o efeito vem do CATÁLOGO, não do chamador", async () => {
    // SUSPENSAO_COBRANCA está no catálogo como SUSPENDE_PARCELA: mesmo pedindo
    // por ela, não há caminho que devolva a parcela.
    const r = (await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'SUSPENSAO_COBRANCA') r`,
      [H.ALUNO_A, MOTIVO])).r;
    expect(r.efeito).toBe("SUSPENSA");
    expect(r.definitivo).toBe(false);
  });

  it("tabulação sem efeito no catálogo é recusada", async () => {
    await expect(
      db.query(`select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'MENSAGEM_ENVIADA',false)`, [H.ALUNO_A, MOTIVO])
    ).rejects.toThrow(/não tem efeito financeiro/);
  });

  it("dry-run é o padrão e não escreve nada", async () => {
    const antes = await H.snap(db);
    const r = (await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'CANCELAMENTO_COBRANCA') r`,
      [H.ALUNO_A, MOTIVO])).r;
    expect(r.dry_run).toBe(true);
    expect(r.parcelas_afetadas_qtd).toBe(2);
    expect(H.diff(antes, await H.snap(db))).toEqual([]);
  });

  it("operador não aplica, e nada é escrito", async () => {
    await H.como(db, H.OP6);
    const antes = await H.snap(db);
    await expect(
      db.query(`select public.parcela_efeito_sem_pagamento_aplicar($1,$2,'CANCELAMENTO_COBRANCA',false)`, [H.ALUNO_A, MOTIVO])
    ).rejects.toThrow(/decisão da gestão/);
    expect(H.diff(antes, await H.snap(db))).toEqual([]);
    await H.como(db, H.GESTAO);
  });

  it("operador não tabula confirmação de alegação na ficha", async () => {
    await H.como(db, H.OP6);
    await expect(
      db.query(`update public.alunos set status_jornada = 'ALEGA_FIES_CONFIRMADO' where id = $1`, [H.ALUNO_A])
    ).rejects.toThrow(/decisão da gestão/);
    await H.como(db, H.GESTAO);
  });

  it("motivo em branco é recusado", async () => {
    await expect(
      db.query(`select public.parcela_efeito_sem_pagamento_aplicar($1,'   ','CANCELAMENTO_COBRANCA',false)`, [H.ALUNO_A])
    ).rejects.toThrow(/Motivo obrigatório/);
  });

  // LIMITAÇÃO DO HARNESS, medida em 07/10/2026: o PGlite 0.5.8 NÃO aplica esta
  // CHECK de duas colunas -- nem no UPDATE, nem no INSERT. Isolei num banco
  // limpo, fora da fixture, com uma tabela de duas colunas e a mesma forma de
  // constraint: passa nos três casos, inclusive no que deveria falhar. A CHECK
  // de uma coluna (`parcelas_origem_baixa_valida`) recusa normalmente no mesmo
  // banco -- e o teste logo abaixo prova isso.
  //
  // Então aqui a asseguração é ESTRUTURAL: confere que a constraint existe,
  // está VALIDADA e cobre as duas direções. PostgreSQL aplica CHECK em INSERT e
  // UPDATE, então em produção ela morde; o que não existe é como demonstrar
  // isso nesta fixture. Um teste de comportamento aqui passaria por vacuidade,
  // o que é pior que um teste estrutural honesto.
  it("a coerência status×efeito está declarada e validada (estrutural)", async () => {
    const c = await H.q1(db, `select pg_get_constraintdef(oid) as def, convalidated
                                from pg_constraint
                               where conname = 'parcelas_efeito_coerente_com_status'`);
    expect(c).toBeTruthy();
    expect(c.convalidated).toBe(true);
    // status novo exige o campo de efeito preenchido com o mesmo valor...
    expect(c.def).toMatch(/'DEVOLVIDA'::text\) AND \(efeito_sem_pagamento = 'DEVOLVIDA'/);
    expect(c.def).toMatch(/'SUSPENSA'::text\) AND \(efeito_sem_pagamento = 'SUSPENSA'/);
    // ...e status normal exige o campo NULO
    expect(c.def).toMatch(/efeito_sem_pagamento IS NULL/);
  });

  it("origem_baixa volta a ser exclusiva de pagamento real", async () => {
    const p = await H.q1(db, `select p.id from public.parcelas p join public.acordos a on a.id=p.acordo_id
                               where a.aluno_id = $1 limit 1`, [H.ALUNO_A]);
    await expect(
      db.query(`update public.parcelas set origem_baixa = 'ANTECIPACAO_SEMESTRE' where id = $1`, [p.id])
    ).rejects.toThrow(/parcelas_origem_baixa_valida/);
  });
});

describe("tabular aplica, e a antecipação foi corrigida", () => {
  it("tabular CANCELAMENTO_COBRANCA pela ficha devolve a parcela", async () => {
    const db = await montar();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    const p = (await parcelas(db)).filter((x) => x.status === "DEVOLVIDA");
    expect(p).toHaveLength(2);
    const n = await H.q1(db, `select count(*)::int c from public.parcela_efeito_sem_pagamento_auditoria where aluno_id = $1`, [H.ALUNO_A]);
    expect(n.c).toBe(1); // uma aplicação, sem recursão
  }, TIMEOUT);

  it("ANTECIPACAO_SEMESTRE não escreve mais PAGO", async () => {
    const db = await montar();
    await db.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A]);
    const p = await parcelas(db);
    expect(p.filter((x) => x.status === "PAGO" && x.efeito_sem_pagamento !== null)).toHaveLength(0);
    expect(p.filter((x) => x.status === "DEVOLVIDA")).toHaveLength(2);
    const fn = await H.q1(db, `select count(*)::int c from pg_proc where proname = 'antecipacao_semestre_aplicar'`);
    expect(fn.c).toBe(0);
  }, TIMEOUT);
});

describe("rollback", () => {
  it("devolve o mecanismo e a fundação", async () => {
    const db = await montar();
    await db.exec(H.ROLL(M_REGRA));
    await db.exec(H.ROLL(M_FUND));

    const r = await H.q1(db, `select
      (select count(*)::int from pg_proc where proname = 'parcela_viva') fn_viva,
      (select count(*)::int from pg_proc where proname = 'parcela_efeito_sem_pagamento_aplicar') fn_motor,
      (select count(*)::int from pg_proc where proname = 'suspensao_cobranca_reativar') fn_volta,
      (select count(*)::int from pg_trigger where tgname = 'trg_tabulacao_efeito_financeiro') tg,
      (select count(*)::int from public.tabulacoes where efeito_desfecho is not null) com_efeito`);
    expect(r).toEqual({ fn_viva: 0, fn_motor: 0, fn_volta: 0, tg: 0, com_efeito: 0 });

    // e o saldo volta a ser calculável pelas listas literais
    expect(await saldo(db)).toBeGreaterThan(0);
  }, TIMEOUT);
});
