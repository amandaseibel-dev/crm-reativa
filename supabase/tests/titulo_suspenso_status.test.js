// TITULO SUSPENSO — migrations REAIS 20261008192000 e 20261008193000, sobre a
// fixture de produção `confirmacao_d2`.
//
// Pedido da gestão em 08/10/2026 (noite): "Suspensão deve ficar como SUSPENSO",
// e mensalidade de aluno tabulado nunca pode ficar em "confirmação de pagamento".
//
// O QUE MUDA DE REGRA, e está declarado: até a manhã de 08/10 a suspensão NÃO
// tocava o título — ele seguia ABERTO e saía só do saldo COBRÁVEL, por derivação
// do estado. A gestão foi informada de que marcar o título o tira TAMBÉM do
// saldo registrado (R$ 462.784,01) e decidiu assim. Este arquivo prova o
// comportamento novo; `suspensao_fora_do_saldo_cobravel.test.js` segue válido
// para o desenho anterior, porque carrega a cadeia só até ali.
//
// O QUE A GESTÃO NÃO ACEITOU, e que por isso é provado aqui: quitação ou
// encerramento automático do suspenso. Suspender um título o tira de
// ('ABERTO','NEGOCIADO'), e é exatamente aí que `_trg_auto_quitar_titulo`
// chamaria `_talvez_quitar_aluno` — a mesma armadilha que o DEVOLVIDO teve.
//
// E a reversibilidade é contrato, não detalhe: sem o estado anterior gravado, a
// mensalidade suspensa ficaria presa fora do saldo para sempre. O título que
// estava em EM_CONFIRMACAO tem de VOLTAR para EM_CONFIRMACAO.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_SALDO = "20261008103000_suspensao_fora_do_saldo_cobravel";
const M_DEVOLVIDO = "20261008190000_titulo_devolvido_status";
const M_SUSPENSO = "20261008192000_titulo_suspenso_status";
const M_BACKFILL = "20261008193000_titulo_suspenso_backfill";

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
   bloqueia_acionamento, sistema, somente_gestao, redireciona_para_email, criado_por)
values
  ('SUSPENSAO_COBRANCA','Suspensão de cobrança', true, 901, 'FINANCEIRO','NENHUM',null,null,
   true, false, true, null, 'teste'),
  ('CANCELAMENTO_COBRANCA','Cancelamento de cobrança', true, 900, 'FINANCEIRO','NENHUM',null,null,
   true, false, true, null, 'teste')
on conflict (codigo) do nothing;`;

const TIT_ABERTO = "66666666-6666-4666-8666-666666666666";
const TIT_CONF = "77777777-7777-4777-8777-777777777777";
const MOTIVO = "unidade confirmou a suspensão em 08/10/2026";

const TITULO = (id, doc, valor) => `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
   situacao, status, tipo_boleto)
values
  ('${id}', '${H.ALUNO_A}',
   (select cpf_limpo from public.casos where aluno_id = '${H.ALUNO_A}' limit 1),
   '${doc}', current_date - 90, ${valor}, ${valor}, 'ABERTO', 'em_aberto', 'Mensalidade');`;

// coloca um título em EM_CONFIRMACAO como a Conferência Prime faz
const EM_CONFIRMACAO = (id) => `
select set_config('conferencia_prime.decisao','on', false);
update public.acordos_titulos set situacao='EM_CONFIRMACAO', status='em_confirmacao' where id = '${id}';
select set_config('conferencia_prime.decisao','', false);`;

async function montar({ comBackfill = false } = {}) {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO(TIT_ABERTO, "9900006", 1200.0));
  await db.exec(TITULO(TIT_CONF, "9900007", 800.0));
  await db.exec(EM_CONFIRMACAO(TIT_CONF));
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(H.MIG(M_SALDO));
  await db.exec(H.MIG(M_DEVOLVIDO));
  await db.exec(H.MIG(M_SUSPENSO));
  if (comBackfill) {
    await db.exec(`
      select set_config('backfill.esperado_suspenso_qtd','2', false);
      select set_config('backfill.esperado_suspenso_valor','2000.00', false);`);
  }
  await H.como(db, H.GESTAO);
  return db;
}

const titulo = (d, id) =>
  H.q1(d, `select situacao, status, origem_encerramento, origem_liquidacao,
                  suspensao_situacao_anterior, suspensao_status_anterior,
                  suspensao_origem, suspensao_em, motivo_ajuste
             from public.acordos_titulos where id = $1`, [id]);

const quitacao = (d) =>
  H.q1(d, `select (select count(*)::int from public.casos
                    where aluno_id = $1 and quitado_em is not null) casos_quitados,
                  (select status_jornada from public.alunos where id = $1) jornada`,
      [H.ALUNO_A]);

const dinheiro = (d) =>
  H.q1(d, `select (select count(*)::int from public.pagamentos) pag,
                  (select count(*)::int from public.baixas_pagamento) baixas,
                  (select coalesce(sum(honorarios),0)::text from public.parcelas) honor`);

describe("1. a suspensão marca a mensalidade", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("o par é SUSPENSO/suspenso", async () => {
    const t = await titulo(db, TIT_ABERTO);
    expect(t.situacao).toBe("SUSPENSO");
    expect(t.status).toBe("suspenso");
  });

  it("NÃO encerra: origem_encerramento fica nula", async () => {
    // é isto que mantém o título mutável e a suspensão reversível
    expect((await titulo(db, TIT_ABERTO)).origem_encerramento).toBeNull();
  });

  it("o estado anterior é gravado — sem ele a suspensão seria irreversível", async () => {
    const t = await titulo(db, TIT_ABERTO);
    expect(t.suspensao_situacao_anterior).toBe("ABERTO");
    expect(t.suspensao_status_anterior).toBe("em_aberto");
    expect(t.suspensao_origem).toBe("SUSPENSAO_COBRANCA");
    expect(t.suspensao_em).not.toBeNull();
  });

  it("o motivo diz que a dívida continua existindo", async () => {
    const t = await titulo(db, TIT_ABERTO);
    expect(t.motivo_ajuste).toMatch(/cobranca suspensa/i);
    expect(t.motivo_ajuste).toMatch(/nao encerrada/i);
  });
});

describe("2. o título em confirmação sai de lá — e guarda que estava lá", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("deixa de ficar em CONFIRMAÇÃO DE PAGAMENTO, que é o que a gestão proibiu", async () => {
    const t = await titulo(db, TIT_CONF);
    expect(t.situacao).toBe("SUSPENSO");
    expect(t.situacao).not.toBe("EM_CONFIRMACAO");
  });

  it("mas o estado anterior gravado é EM_CONFIRMACAO, não ABERTO", async () => {
    // se gravasse ABERTO, a reativação devolveria o título para a fila errada
    expect((await titulo(db, TIT_CONF)).suspensao_situacao_anterior).toBe("EM_CONFIRMACAO");
  });
});

describe("3. suspensão não quita nem encerra — a garantia que a gestão não abriu mão", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("nenhum caso ganhou carimbo de quitação", async () => {
    expect((await quitacao(db)).casos_quitados).toBe(0);
  });

  it("o aluno fica na tabulação, não em status de recuperado", async () => {
    expect((await quitacao(db)).jornada).toBe("SUSPENSAO_COBRANCA");
  });

  it("o early return do auto_quitar cobre SUSPENSO", async () => {
    const f = await H.q1(db, `select pg_get_functiondef(p.oid) d from pg_proc p
                                join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname='public' and p.proname='_trg_auto_quitar_titulo'`);
    expect(f.d).toMatch(/'CANCELADA'\s*,\s*'DEVOLVIDO'\s*,\s*'SUSPENSO'/);
  });

  it("o título não recebe origem_liquidacao", async () => {
    expect((await titulo(db, TIT_ABERTO)).origem_liquidacao).toBeNull();
  });
});

describe("4. a volta: reativação devolve o estado EXATO", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.query(`select public.suspensao_cobranca_reativar($1, $2, false)`,
                   [H.ALUNO_A, "unidade liberou a cobrança em 08/10/2026"]);
  }, TIMEOUT);

  it("o que era ABERTO volta ABERTO", async () => {
    const t = await titulo(db, TIT_ABERTO);
    expect(t.situacao).toBe("ABERTO");
    expect(t.status).toBe("em_aberto");
  });

  it("o que era EM_CONFIRMACAO volta EM_CONFIRMACAO, não ABERTO", async () => {
    // a prova de que a reversão lê o estado gravado em vez de chutar
    const t = await titulo(db, TIT_CONF);
    expect(t.situacao).toBe("EM_CONFIRMACAO");
    expect(t.status).toBe("em_confirmacao");
  });

  it("as colunas de suspensão são limpas", async () => {
    for (const id of [TIT_ABERTO, TIT_CONF]) {
      const t = await titulo(db, id);
      expect(t.suspensao_situacao_anterior).toBeNull();
      expect(t.suspensao_origem).toBeNull();
      expect(t.suspensao_em).toBeNull();
    }
  });

  it("nenhuma mensalidade sobra SUSPENSO", async () => {
    const r = await H.q1(db, `select count(*)::int c from public.acordos_titulos
                               where aluno_id = $1 and upper(coalesce(situacao,'')) = 'SUSPENSO'`,
                         [H.ALUNO_A]);
    expect(r.c).toBe(0);
  });
});

describe("5. nenhum dinheiro se move", () => {
  it("suspender e reativar não cria pagamento, baixa nem honorário", async () => {
    const db = await montar();
    const antes = await dinheiro(db);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    expect(await dinheiro(db)).toEqual(antes);
    await db.query(`select public.suspensao_cobranca_reativar($1, $2, false)`, [H.ALUNO_A, MOTIVO]);
    expect(await dinheiro(db)).toEqual(antes);
  }, TIMEOUT);
});

describe("6. o backfill dos que já estavam suspensos", () => {
  let db;
  beforeAll(async () => {
    db = await montar({ comBackfill: true });
    // tabula SEM disparar o gatilho, para simular quem já estava suspenso
    // antes de a regra marcar a mensalidade
    await db.query(`select set_config('parcela_efeito_sem_pagamento.aplicando','on', false)`);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.query(`select set_config('parcela_efeito_sem_pagamento.aplicando','', false)`);
  }, TIMEOUT);

  it("antes do backfill os títulos seguem como estavam", async () => {
    expect((await titulo(db, TIT_ABERTO)).situacao).toBe("ABERTO");
    expect((await titulo(db, TIT_CONF)).situacao).toBe("EM_CONFIRMACAO");
  });

  it("depois do backfill os dois ficam SUSPENSO, com o estado anterior certo", async () => {
    await db.exec(H.MIG(M_BACKFILL));
    const a = await titulo(db, TIT_ABERTO);
    const c = await titulo(db, TIT_CONF);
    expect(a.situacao).toBe("SUSPENSO");
    expect(c.situacao).toBe("SUSPENSO");
    expect(a.suspensao_situacao_anterior).toBe("ABERTO");
    expect(c.suspensao_situacao_anterior).toBe("EM_CONFIRMACAO");
  }, TIMEOUT);

  it("é idempotente pelo lote", async () => {
    await db.exec(H.MIG(M_BACKFILL));
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento
                               where lote = 'suspenso_titulo_20261008193000' and tabela = 'acordos_titulos'`);
    expect(b.c).toBe(2);
  }, TIMEOUT);

  it("o rollback devolve cada um ao estado de origem, inclusive a confirmação", async () => {
    await db.exec(H.ROLL(M_BACKFILL));
    expect((await titulo(db, TIT_ABERTO)).situacao).toBe("ABERTO");
    expect((await titulo(db, TIT_CONF)).situacao).toBe("EM_CONFIRMACAO");
  }, TIMEOUT);
});

describe("7. a trava do backfill recusa divergência", () => {
  it("se o universo não casar com a medição, aborta sem escrever", async () => {
    const db = await montar();
    await db.exec(`
      select set_config('backfill.esperado_suspenso_qtd','99', false);
      select set_config('backfill.esperado_suspenso_valor','1.00', false);`);
    await db.query(`select set_config('parcela_efeito_sem_pagamento.aplicando','on', false)`);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.query(`select set_config('parcela_efeito_sem_pagamento.aplicando','', false)`);

    await expect(db.exec(H.MIG(M_BACKFILL))).rejects.toThrow(/universo divergiu da medicao/);
    expect((await titulo(db, TIT_ABERTO)).situacao).toBe("ABERTO");
  }, TIMEOUT);
});

describe("8. rollback da migration", () => {
  it("devolve as funções e não deixa título preso em SUSPENSO", async () => {
    const db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    expect((await titulo(db, TIT_ABERTO)).situacao).toBe("SUSPENSO");

    await db.exec(H.ROLL(M_SUSPENSO));

    // o dado volta ANTES das funções, senão ficaria sem caminho de volta
    expect((await titulo(db, TIT_ABERTO)).situacao).toBe("ABERTO");
    expect((await titulo(db, TIT_CONF)).situacao).toBe("EM_CONFIRMACAO");

    const f = await H.q1(db, `select
      (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='_trg_auto_quitar_titulo') quitar,
      (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='suspensao_cobranca_reativar') reativar`);
    expect(f.quitar).not.toMatch(/'SUSPENSO'/);
    expect(f.reativar).not.toMatch(/suspensao_situacao_anterior/);
  }, TIMEOUT);
});
