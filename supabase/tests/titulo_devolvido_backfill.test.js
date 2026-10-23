// BACKFILL DO TITULO DEVOLVIDO — migrations REAIS 20261008190000 e
// 20261008191000, sobre a fixture de producao `confirmacao_d2`.
//
// Este arquivo REPRODUZ A HISTORIA REAL DE PRODUCAO de 08/10/2026, em vez de
// montar um cenario conveniente:
//
//   1. o motor ANTIGO roda e grava CANCELADA no titulo (Parte A: e esse
//      rotulo, com a auditoria que o proprio motor escreveu, que vira a
//      "devolucao comprovada" dos 19 titulos);
//   2. o motor ANTIGO roda com o titulo parado em EM_CONFIRMACAO e NAO o
//      alcanca -- devolve ok:true com `titulos_encerrados_qtd = 0`. O titulo
//      volta para ABERTO depois e segue contando (Parte B: foi o que aconteceu
//      com 3 alunos, R$ 31.925,06, e virou 4 / R$ 42.291,57 enquanto a gestao
//      tabulava novos casos);
//   3. as duas migrations entram e consertam os dois casos.
//
// E prova o que NAO pode acontecer: os titulos da Conferencia Prime nao se
// mexem, titulo com marca de liquidacao nao e rerrotulado, e nada vira
// quitacao.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_SUSP = "20261008103000_suspensao_fora_do_saldo_cobravel";
const M_DEVOLVIDO = "20261008190000_titulo_devolvido_status";
const M_BACKFILL = "20261008191000_titulo_devolvido_backfill_comprovado";

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

// catalogo de PRODUCAO conferido em 08/10/2026 (as 6 tabulacoes com efeito)
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
   bloqueia_acionamento, sistema, somente_gestao, redireciona_para_email, criado_por)
values
  ('CANCELAMENTO_COBRANCA','Cancelamento de cobrança', true, 900, 'FINANCEIRO','NENHUM',null,null,
   true, false, true, null, 'teste'),
  ('SUSPENSAO_COBRANCA','Suspensão de cobrança', true, 901, 'FINANCEIRO','NENHUM',null,null,
   true, false, true, null, 'teste'),
  ('ANTECIPACAO_SEMESTRE','Antecipação de semestre', true, 902, 'FINANCEIRO','NENHUM',null,null,
   true, false, true, null, 'teste')
on conflict (codigo) do nothing;`;

const TIT_HIST = "33333333-3333-4333-8333-333333333333"; // vira os "19"
const TIT_PRIME = "44444444-4444-4444-8444-444444444444"; // os "29", intocaveis
const TIT_PERDIDO = "55555555-5555-4555-8555-555555555555"; // o que escapou

const TITULO = (id, aluno, doc, valor) => `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
   situacao, status, tipo_boleto)
values
  ('${id}', '${aluno}',
   (select cpf_limpo from public.casos where aluno_id = '${aluno}' limit 1),
   '${doc}', current_date - 90, ${valor}, ${valor}, 'ABERTO', 'em_aberto', 'Mensalidade');`;

// um titulo da Conferencia Prime, ja encerrado, que NAO pode se mexer
const PRIME_ENCERRADO = `
select set_config('conferencia_prime.decisao','on', false);
update public.acordos_titulos
   set situacao = 'CANCELADA', status = 'cancelada',
       origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA',
       origem_encerramento_ref = 'conferencia:teste',
       origem_encerramento_em = now()
 where id = '${TIT_PRIME}';
select set_config('conferencia_prime.decisao','', false);`;

const ESPERADO = `
select set_config('backfill.esperado_relabel_qtd','1', false);
select set_config('backfill.esperado_relabel_valor','1200.00', false);
select set_config('backfill.esperado_preservar_qtd','1', false);`;

const titulo = (d, id) =>
  H.q1(d, `select situacao, status, origem_encerramento, origem_liquidacao, motivo_ajuste
             from public.acordos_titulos where id = $1`, [id]);

// ---------------------------------------------------------------------------
// base comum: motor ANTIGO, com os tres titulos no lugar
// ---------------------------------------------------------------------------
async function baseAntiga() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO(TIT_HIST, H.ALUNO_A, "9900003", 1200.0));
  await db.exec(TITULO(TIT_PRIME, H.ALUNO_B, "9900004", 2500.0));
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(H.MIG(M_SUSP));
  await db.exec(PRIME_ENCERRADO);
  await H.como(db, H.GESTAO);
  return db;
}

describe("Parte A — os históricos CANCELADA viram DEVOLVIDO quando comprovado", () => {
  let db;

  beforeAll(async () => {
    db = await baseAntiga();
    // 1. o motor ANTIGO tabula e grava CANCELADA + escreve a auditoria.
    //    É esse par (rótulo + auditoria) que depois serve de prova.
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.exec(ESPERADO);
    await db.exec(H.MIG(M_DEVOLVIDO));
    await db.exec(H.MIG(M_BACKFILL));
  }, TIMEOUT);

  it("o título histórico passa a DEVOLVIDO/devolvido", async () => {
    const t = await titulo(db, TIT_HIST);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
  });

  it("a origem do encerramento é preservada — a causa continua registrada", async () => {
    expect((await titulo(db, TIT_HIST)).origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
  });

  it("o motivo diz por que o rótulo mudou, e que não é recuperação", async () => {
    const t = await titulo(db, TIT_HIST);
    expect(t.motivo_ajuste).toMatch(/rotulo corrigido de CANCELADA para DEVOLVIDO/i);
    expect(t.motivo_ajuste).toMatch(/nao e recuperacao/i);
  });

  it("os títulos da Conferência Prime NÃO se mexem", async () => {
    const t = await titulo(db, TIT_PRIME);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.status).toBe("cancelada");
    expect(t.origem_encerramento).toBe("CONFERENCIA_PRIME_ADMINISTRATIVA");
  });

  it("há backup linha a linha, porque PITR não está habilitado", async () => {
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento
                               where lote = 'relabel_devolvido_20261008190000'`);
    expect(b.c).toBe(1);
  });

  it("é idempotente pelo lote: rodar de novo não faz nada", async () => {
    await db.exec(H.MIG(M_BACKFILL));
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento
                               where lote = 'relabel_devolvido_20261008190000'`);
    expect(b.c).toBe(1);
  }, TIMEOUT);

  it("o rollback devolve CANCELADA e preserva a Conferência Prime", async () => {
    await db.exec(H.ROLL(M_BACKFILL));
    const t = await titulo(db, TIT_HIST);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.status).toBe("cancelada");
    expect((await titulo(db, TIT_PRIME)).situacao).toBe("CANCELADA");
  }, TIMEOUT);
});

describe("Parte A — a trava recusa o que não está comprovado", () => {
  it("título com marca de liquidação NÃO é rerrotulado: a trava aborta", async () => {
    const db = await baseAntiga();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    // suja a prova 2
    await db.query(`select set_config('conferencia_prime.decisao','on', false)`);
    await db.query(`update public.acordos_titulos set origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL' where id = $1`, [TIT_HIST]);
    await db.query(`select set_config('conferencia_prime.decisao','', false)`);

    await db.exec(ESPERADO);
    await db.exec(H.MIG(M_DEVOLVIDO));
    // o alvo cai para 0 e divergem da medicao fixada (1) -> recusa
    await expect(db.exec(H.MIG(M_BACKFILL))).rejects.toThrow(/universo divergiu da medicao/);

    expect((await titulo(db, TIT_HIST)).situacao).toBe("CANCELADA");
  }, TIMEOUT);

  it("se a contagem da Conferência Prime mudar, aborta antes de escrever", async () => {
    const db = await baseAntiga();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.exec(`
      select set_config('backfill.esperado_relabel_qtd','1', false);
      select set_config('backfill.esperado_relabel_valor','1200.00', false);
      select set_config('backfill.esperado_preservar_qtd','7', false);`); // mentira
    await db.exec(H.MIG(M_DEVOLVIDO));
    await expect(db.exec(H.MIG(M_BACKFILL))).rejects.toThrow(/Conferencia Prime tem/);
  }, TIMEOUT);
});

describe("Parte B — o título que escapou por estar EM_CONFIRMACAO", () => {
  let db;
  let dinheiroAntes;

  beforeAll(async () => {
    db = await baseAntiga();
    await db.exec(TITULO(TIT_PERDIDO, H.ALUNO_A, "9900005", 900.0));
    // apaga o histórico para isolar a Parte B
    await db.query(`select set_config('conferencia_prime.decisao','on', false)`);
    await db.query(`delete from public.acordos_titulos where id = $1`, [TIT_HIST]);
    // o título vai para confirmação, como a Conferência Prime faz
    await db.query(`update public.acordos_titulos set situacao='EM_CONFIRMACAO', status='em_confirmacao' where id = $1`, [TIT_PERDIDO]);
    await db.query(`select set_config('conferencia_prime.decisao','', false)`);

    // 2. o motor ANTIGO tabula e NÃO alcança o título
    await db.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("o motor antigo deixou o título passar — é o defeito de produção", async () => {
    const t = await titulo(db, TIT_PERDIDO);
    expect(t.situacao).toBe("EM_CONFIRMACAO");
    expect(t.origem_encerramento).toBeNull();
    const a = await H.q1(db, `select titulos_encerrados_qtd q
                                from public.parcela_efeito_sem_pagamento_auditoria
                               where aluno_id = $1 order by executado_em desc limit 1`, [H.ALUNO_A]);
    expect(a.q).toBe(0); // exatamente o que produção registrou
  });

  it("depois das duas migrations o título fica DEVOLVIDO", async () => {
    // fotografia do dinheiro ANTES do reparo -- a fixture já tem pagamentos e
    // honorários próprios, então o que se prova é que nada MUDA
    dinheiroAntes = await H.q1(db, `select
      (select count(*)::int from public.pagamentos) pag,
      (select count(*)::int from public.baixas_pagamento) baixas,
      (select coalesce(sum(honorarios),0)::text from public.parcelas) honor`);

    // o título volta para ABERTO, como aconteceu em produção 31 s depois
    await db.query(`select set_config('conferencia_prime.decisao','on', false)`);
    await db.query(`update public.acordos_titulos set situacao='ABERTO', status='em_aberto' where id = $1`, [TIT_PERDIDO]);
    await db.query(`select set_config('conferencia_prime.decisao','', false)`);

    await db.exec(`
      select set_config('backfill.esperado_relabel_qtd','0', false);
      select set_config('backfill.esperado_relabel_valor','0.00', false);
      select set_config('backfill.esperado_preservar_qtd','1', false);
      select set_config('backfill.esperado_reparo_qtd','1', false);
      select set_config('backfill.esperado_reparo_valor','900.00', false);`);
    await db.exec(H.MIG(M_DEVOLVIDO));
    await db.exec(H.MIG(M_BACKFILL));

    const t = await titulo(db, TIT_PERDIDO);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.origem_encerramento).toBe("ANTECIPACAO_SEMESTRE");
  }, TIMEOUT);

  it("o reparo não criou quitação", async () => {
    const r = await H.q1(db, `select
      (select count(*)::int from public.casos where aluno_id = $1 and quitado_em is not null) q,
      (select count(*)::int from public.casos where aluno_id = $1 and origem_quitacao is not null) o,
      (select count(*)::int from public.acordos_titulos
        where id = $2 and origem_liquidacao is not null) liq`, [H.ALUNO_A, TIT_PERDIDO]);
    expect(r.q).toBe(0);
    expect(r.o).toBe(0);
    expect(r.liq).toBe(0);
  });

  it("o dinheiro da base não se move — nem pagamento, nem baixa, nem honorário", async () => {
    // a fixture já tem pagamentos e honorários próprios: o que se prova é que
    // o reparo não ACRESCENTA nem ALTERA nenhum deles
    const depois = await H.q1(db, `select
      (select count(*)::int from public.pagamentos) pag,
      (select count(*)::int from public.baixas_pagamento) baixas,
      (select coalesce(sum(honorarios),0)::text from public.parcelas) honor`);
    expect(depois).toEqual(dinheiroAntes);
  });

  it("o reparo passou pelo motor, então deixou auditoria própria", async () => {
    const a = await H.q1(db, `select count(*)::int c from public.parcela_efeito_sem_pagamento_auditoria
                               where aluno_id = $1 and motivo like 'reparo de 08/10/2026%'`, [H.ALUNO_A]);
    expect(a.c).toBe(1);
  });

  it("o rollback devolve o título ao estado anterior", async () => {
    await db.exec(H.ROLL(M_BACKFILL));
    const t = await titulo(db, TIT_PERDIDO);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  }, TIMEOUT);
});
