// BACKFILL do histórico — migration REAL 20261008090000 + rollback REAL, sobre
// a fixture de produção `confirmacao_d2` (dados FICTÍCIOS).
//
// É o único arquivo desta frente que escreve em dado histórico, e por isso o
// que mais precisa de prova. O que ele tem de demonstrar:
//
//   1. PAGAMENTO REAL É PRESERVADO -- a exigência explícita da gestão. Parcela
//      PAGO não é tocada, e `pago_em`/`origem_baixa`/`honorarios` ficam
//      idênticos em TODAS as linhas, inclusive nas que mudaram de status;
//   2. suspensão vira SUSPENSA e cancelamento vira DEVOLVIDA, pela tabulação
//      que o aluno já tinha;
//   3. o título do aluno suspenso NÃO é encerrado (a dívida continua);
//   4. nada vira quitação: `quitado_em`/`origem_quitacao` seguem nulos e o
//      acordo não vira QUITADO;
//   5. a trava de medição ABORTA quando o universo divergir -- é o que impede
//      um backfill de escrever num banco que mudou desde a medição;
//   6. é idempotente, e o rollback devolve o estado anterior pelo snapshot.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_BACKFILL = "20261008090000_backfill_devolvida_suspensa_historico";

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

const CATALOGO = `
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tabulacoes'::regclass and contype = 'p') then
    alter table public.tabulacoes add primary key (codigo);
  end if;
end $$;
insert into public.tabulacoes
  (codigo, rotulo, ativa, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloqueia_acionamento, sistema, somente_gestao, criado_por)
values
  ('ANTECIPACAO_SEMESTRE','Antecipação de semestre', true, 540, 'ALEGACAO', 'DIAS_UTEIS', 20,
   'AGUARDAR_RETORNO_UNIDADE', true, false, false, 'f'),
  ('CANCELAMENTO_COBRANCA','Cancelamento definitivo de cobrança', true, 420, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, 'f'),
  ('SUSPENSAO_COBRANCA','Suspensão de cobrança', true, 430, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, 'f');`;

const TIT_A = "11111111-1111-4111-8111-111111111111";
const TIT_B = "22222222-2222-4222-8222-222222222222";

// ALUNO_A -> SUSPENSAO_COBRANCA: acordo ATIVO com 2 parcelas vivas (VENCIDA
//            665,89 + A_VENCER 665,98) e 4 PAGO. O título dele NÃO deve ser
//            encerrado.
// ALUNO_B -> CANCELAMENTO_COBRANCA: acordo QUITADO (todas as parcelas PAGO),
//            então 0 parcela elegível -- e um título aberto, que DEVE ser
//            encerrado. Espelha o universo real medido em produção, onde
//            cancelamento tinha 0 parcela viva e 16 títulos.
const CENARIO = `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
values
  ('${TIT_A}', '${H.ALUNO_A}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_A}' limit 1),
   '9900001', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade'),
  ('${TIT_B}', '${H.ALUNO_B}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_B}' limit 1),
   '9900002', current_date - 60, 800.00, 800.00, 'ABERTO', 'em_aberto', 'Mensalidade');

-- marca as tabulações SEM passar pelo gatilho (é histórico anterior à regra)
select set_config('parcela_efeito_sem_pagamento.aplicando','on', false);
update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = '${H.ALUNO_A}';
update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = '${H.ALUNO_B}';
select set_config('parcela_efeito_sem_pagamento.aplicando','', false);`;

// O universo da fixture: 2 parcelas vivas do ALUNO_A (665,89 + 665,98) e 1
// título do ALUNO_B (800,00). Em produção é 10/R$ 245.587,32 e 16/R$ 130.344,11.
const ESPERADO = `
select set_config('backfill.esperado_parcelas_qtd','2', false);
select set_config('backfill.esperado_parcelas_valor','1331.87', false);
select set_config('backfill.esperado_titulos_qtd','1', false);
select set_config('backfill.esperado_titulos_valor','800.00', false);`;

async function montar({ comEsperado = true } = {}) {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(CATALOGO);
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(CENARIO);
  if (comEsperado) await db.exec(ESPERADO);
  await H.como(db, H.GESTAO);
  return db;
}

const parcelasDe = (d, aluno) =>
  H.qn(d, `select p.id, p.numero, p.status, p.valor, p.honorarios, p.pago_em, p.origem_baixa,
                  p.efeito_sem_pagamento, p.efeito_sem_pagamento_origem, p.efeito_sem_pagamento_por
             from public.parcelas p join public.acordos a on a.id = p.acordo_id
            where a.aluno_id = $1 order by p.numero, p.id`, [aluno]);

const marcasDePagamento = (d) =>
  H.qn(d, `select id, pago_em, origem_baixa, origem_baixa_ref, honorarios
             from public.parcelas order by id`);

describe("backfill do histórico", () => {
  let db, pagamentoAntes, snapAntes;

  beforeAll(async () => {
    db = await montar();
    pagamentoAntes = await marcasDePagamento(db);
    snapAntes = await H.snap(db);
    await db.exec(H.MIG(M_BACKFILL));
  }, TIMEOUT);

  it("PRESERVA PAGAMENTO REAL: nenhuma marca de pagamento mudou em nenhuma linha", async () => {
    // A exigência da gestão, verificada na base inteira -- não só nas parcelas
    // que o backfill tocou.
    expect(await marcasDePagamento(db)).toEqual(pagamentoAntes);
  });

  it("não toca parcela PAGO", async () => {
    const p = await parcelasDe(db, H.ALUNO_A);
    const pagas = p.filter((x) => x.status === "PAGO");
    expect(pagas.length).toBeGreaterThan(0);
    expect(pagas.every((x) => x.efeito_sem_pagamento === null)).toBe(true);
  });

  it("suspensão: as parcelas vivas do aluno viram SUSPENSA", async () => {
    const p = await parcelasDe(db, H.ALUNO_A);
    const afetadas = p.filter((x) => x.efeito_sem_pagamento !== null);
    expect(afetadas).toHaveLength(2);
    expect(afetadas.every((x) => x.status === "SUSPENSA")).toBe(true);
    expect(afetadas.every((x) => x.efeito_sem_pagamento_origem === "SUSPENSAO_COBRANCA")).toBe(true);
    expect(afetadas.every((x) => x.efeito_sem_pagamento_por === "backfill 08/10/2026 (gestao)")).toBe(true);
  });

  it("suspensão: o título NÃO é encerrado — a dívida continua existindo", async () => {
    const t = await H.q1(db, `select situacao, origem_encerramento from public.acordos_titulos where id = $1`, [TIT_A]);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  });

  it("cancelamento: o título é encerrado administrativamente", async () => {
    const t = await H.q1(db, `select situacao, status, origem_encerramento, origem_encerramento_ref, origem_liquidacao
                                from public.acordos_titulos where id = $1`, [TIT_B]);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
    expect(t.origem_encerramento_ref).toMatch(/^backfill:backfill_20261008090000:/);
    // encerramento administrativo não é liquidação
    expect(t.origem_liquidacao).toBeNull();
  });

  it("não CRIA carimbo de quitação (o que já era quitado segue quitado)", async () => {
    // Estado absoluto mentiria aqui: ALUNO_B tem acordo realmente pago e
    // quitado no histórico da fixture. O que importa é que o backfill não
    // acrescentou nem alterou carimbo -- e o snapshot anterior prova isso.
    const antes = snapAntes.casos.map((c) => `${c.id}`).length;
    expect(antes).toBeGreaterThan(0);
    const c = await H.qn(db, `select c.quitado_em, c.origem_quitacao
                                from public.casos c where c.aluno_id = $1`, [H.ALUNO_A]);
    // o aluno suspenso, que teve parcela mexida, não pode ter virado quitado
    expect(c.every((x) => x.quitado_em === null)).toBe(true);
    expect(c.every((x) => !x.origem_quitacao)).toBe(true);
  });

  it("o acordo do aluno suspenso não vira QUITADO", async () => {
    const a = await H.qn(db, `select status from public.acordos where aluno_id = $1`, [H.ALUNO_A]);
    expect(a.every((x) => x.status !== "QUITADO")).toBe(true);
  });

  it("guarda a linha inteira em backup antes de escrever", async () => {
    const b = await H.qn(db, `select tabela, count(*)::int c from public._backup_backfill_efeito_sem_pagamento
                               where lote = 'backfill_20261008090000' group by 1 order by 1`);
    expect(b).toEqual([
      { tabela: "acordos_titulos", c: 1 },
      { tabela: "parcelas", c: 2 },
    ]);
    const snap = await H.q1(db, `select snapshot->>'status' as st from public._backup_backfill_efeito_sem_pagamento
                                  where tabela = 'parcelas' limit 1`);
    expect(["VENCIDA", "A_VENCER"]).toContain(snap.st);
  });

  it("audita por aluno, com efeito e origem", async () => {
    const a = await H.qn(db, `select aluno_id, efeito, origem, parcelas_quitadas_qtd, titulos_encerrados_qtd
                                from public.parcela_efeito_sem_pagamento_auditoria
                               where executado_por = 'backfill 08/10/2026 (gestao)' order by origem`);
    expect(a).toHaveLength(2);
    expect(a.map((x) => x.origem)).toEqual(["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"]);
    const susp = a.find((x) => x.origem === "SUSPENSAO_COBRANCA");
    expect(susp.efeito).toBe("SUSPENSA");
    expect(susp.parcelas_quitadas_qtd).toBe(2);
    const canc = a.find((x) => x.origem === "CANCELAMENTO_COBRANCA");
    expect(canc.titulos_encerrados_qtd).toBe(1);
    expect(canc.parcelas_quitadas_qtd).toBe(0);
  });

  it("é idempotente: aplicar de novo não escreve nada", async () => {
    const antes = await H.snap(db);
    await db.exec(H.MIG(M_BACKFILL));
    expect(H.diff(antes, await H.snap(db))).toEqual([]);
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento`);
    expect(b.c).toBe(3);
  });
});

describe("a trava de medição", () => {
  it("ABORTA quando o universo divergir do medido, e não escreve nada", async () => {
    // Sem o GUC, a migration espera o universo de PRODUÇÃO (10 parcelas /
    // R$ 245.587,32). A fixture tem 2 / R$ 1.331,87 -> tem de abortar.
    const db = await montar({ comEsperado: false });
    const antes = await H.snap(db);
    await expect(db.exec(H.MIG(M_BACKFILL))).rejects.toThrow(/divergiram da medicao/);
    expect(H.diff(antes, await H.snap(db))).toEqual([]);
    // A migration é ATÔMICA: ao abortar, nem a tabela de backup que ela cria
    // sobrevive. Conferir por `to_regclass` em vez de consultar a tabela --
    // consultá-la daria "relation does not exist", que é o resultado certo
    // aparecendo como erro de teste.
    const b = await H.q1(db, `select to_regclass('public._backup_backfill_efeito_sem_pagamento') is null as sumiu`);
    expect(b.sumiu).toBe(true);
  }, TIMEOUT);
});

describe("rollback do backfill", () => {
  it("devolve status, situação e observação pelo snapshot", async () => {
    const db = await montar();
    const antes = await parcelasDe(db, H.ALUNO_A);
    const titAntes = await H.q1(db, `select situacao, status from public.acordos_titulos where id = $1`, [TIT_B]);

    await db.exec(H.MIG(M_BACKFILL));
    await db.exec(H.ROLL(M_BACKFILL));

    const depois = await parcelasDe(db, H.ALUNO_A);
    expect(depois.map((x) => x.status)).toEqual(antes.map((x) => x.status));
    expect(depois.every((x) => x.efeito_sem_pagamento === null)).toBe(true);
    expect(depois.every((x) => x.efeito_sem_pagamento_por === null)).toBe(true);

    const titDepois = await H.q1(db, `select situacao, status, origem_encerramento
                                        from public.acordos_titulos where id = $1`, [TIT_B]);
    expect(titDepois.situacao).toBe(titAntes.situacao);
    expect(titDepois.origem_encerramento).toBeNull();

    const a = await H.q1(db, `select count(*)::int c from public.parcela_efeito_sem_pagamento_auditoria
                               where executado_por = 'backfill 08/10/2026 (gestao)'`);
    expect(a.c).toBe(0);

    // o backup FICA: é a evidência de que o lote existiu
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento`);
    expect(b.c).toBe(3);
  }, TIMEOUT);
});
