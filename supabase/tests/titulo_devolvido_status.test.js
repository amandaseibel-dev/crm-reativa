// TITULO DEVOLVIDO — migration REAL 20261008190000, sobre a fixture de produção
// `confirmacao_d2` (funções e gatilhos com o texto exato de produção, dados
// FICTÍCIOS).
//
// A regra da gestão de 08/10/2026 para o status da MENSALIDADE:
//   DEVOLVIDO — tabulação que encerra o saldo sem recuperação pela ReATIVA;
//   NEGOCIADO — acordo realizado com parcelas ainda pendentes;
//   QUITADO   — todas as parcelas quitadas ou pagamento confirmado.
// Mais: os gatilhos têm de PRESERVAR esses status, sem reversão automática; e
// valor devolvido não pode contar como recuperação financeira.
//
// O QUE ESTE ARQUIVO PROVA, e por que cada prova existe:
//
//   1. o motor grava DEVOLVIDO, não CANCELADA. CANCELADA já significava outra
//      coisa (saída administrativa pela Conferência Prime, 29 títulos);
//
//   2. título em EM_CONFIRMACAO é ALCANÇADO. Era o defeito medido em produção
//      em 08/10: 3 alunos tabulados ANTECIPACAO_SEMESTRE seguiam com a
//      mensalidade contando (R$ 31.925,06) porque o título estava parado em
//      confirmação na hora da tabulação. O motor devolvia ok:true com
//      titulos_encerrados_qtd = 0;
//
//   3. a devolução NÃO quita o aluno. Esta é a prova da regra 6 e a armadilha
//      mais perigosa do conjunto: `_trg_auto_quitar_titulo` tinha o early
//      return fixado em 'CANCELADA'. Com DEVOLVIDO ele não casaria, cairia no
//      bloco seguinte e chamaria `_talvez_quitar_aluno` — a devolução geraria
//      recuperação que nunca existiu;
//
//   4. o rótulo não apodrece. `_titulo_encerrado_administrativo_protegido`
//      FIXAVA 'CANCELADA' em qualquer toque posterior, então um título
//      devolvido voltaria a "cancelado" sozinho, sem ninguém mexer;
//
//   5. suspensão continua sem tocar o título (a dívida fica);
//
//   6. e nenhuma das duas escreve marca de pagamento.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_SUSP = "20261008103000_suspensao_fora_do_saldo_cobravel";
const M_DEVOLVIDO = "20261008190000_titulo_devolvido_status";

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

const TIT_ID = "22222222-2222-4222-8222-222222222222";

const TITULO = (id, doc) => `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
   situacao, status, tipo_boleto)
values
  ('${id}', '${H.ALUNO_A}',
   (select cpf_limpo from public.casos where aluno_id = '${H.ALUNO_A}' limit 1),
   '${doc}', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade');`;

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO(TIT_ID, "9900002"));
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(H.MIG(M_SUSP));
  await db.exec(H.MIG(M_DEVOLVIDO));
  await H.como(db, H.GESTAO);
  return db;
}

const titulo = (d) =>
  H.q1(d, `select situacao, status, origem_encerramento, origem_encerramento_ref,
                  origem_liquidacao, motivo_ajuste
             from public.acordos_titulos where id = $1`, [TIT_ID]);

const dinheiro = (d) =>
  H.q1(d, `select (select count(*)::int from public.pagamentos) pag,
                  (select count(*)::int from public.baixas_pagamento) baixas,
                  (select coalesce(sum(valor_honorario),0) from public.pagamentos) honor,
                  (select coalesce(sum(honorarios),0) from public.parcelas) honor_parc`);

const quitacao = (d) =>
  H.q1(d, `select (select count(*)::int from public.casos
                    where aluno_id = $1 and quitado_em is not null) casos_quitados,
                  (select count(*)::int from public.casos
                    where aluno_id = $1 and origem_quitacao is not null) casos_com_origem,
                  (select status_jornada from public.alunos where id = $1) jornada`,
      [H.ALUNO_A]);

// põe o título em EM_CONFIRMACAO como a Conferência Prime faz: com a chave
// oficial, porque `_titulo_em_confirmacao_protegido` recusa a entrada sem ela
async function emConfirmacao(db) {
  await db.query(`select set_config('conferencia_prime.decisao','on', false)`);
  await db.query(
    `update public.acordos_titulos set situacao = 'EM_CONFIRMACAO', status = 'em_confirmacao' where id = $1`,
    [TIT_ID]);
  await db.query(`select set_config('conferencia_prime.decisao','', false)`);
}

describe("1. o motor grava DEVOLVIDO, não CANCELADA", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("situação e status formam o par DEVOLVIDO/devolvido", async () => {
    const t = await titulo(db);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
  });

  it("a origem do encerramento continua registrando QUAL tabulação causou", async () => {
    const t = await titulo(db);
    expect(t.origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
    expect(t.origem_encerramento_ref).toContain("cancelamento_cobranca:");
  });

  it("o motivo diz devolução, não encerramento administrativo", async () => {
    const t = await titulo(db);
    expect(t.motivo_ajuste).toMatch(/devolvido sem recupera/i);
    expect(t.motivo_ajuste).toMatch(/Sem pagamento, acordo ou recupera/i);
  });

  it("CANCELADA não é mais escrito pelo motor em lugar nenhum", async () => {
    const r = await H.q1(db, `select count(*)::int c from public.acordos_titulos
                               where aluno_id = $1 and upper(coalesce(situacao,'')) = 'CANCELADA'`,
                         [H.ALUNO_A]);
    expect(r.c).toBe(0);
  });
});

describe("2. título em EM_CONFIRMACAO é alcançado — o defeito de 08/10", () => {
  it("antes da correção o título escapava; agora é devolvido", async () => {
    const db = await montar();
    await emConfirmacao(db);
    expect((await titulo(db)).situacao).toBe("EM_CONFIRMACAO");

    await db.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A]);

    const t = await titulo(db);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.origem_encerramento).toBe("ANTECIPACAO_SEMESTRE");
  }, TIMEOUT);

  it("a auditoria passa a CONTAR o título, em vez de registrar zero", async () => {
    const db = await montar();
    await emConfirmacao(db);
    await db.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A]);

    const a = await H.q1(db, `select titulos_encerrados_qtd q, titulos_encerrados_valor v
                                from public.parcela_efeito_sem_pagamento_auditoria
                               where aluno_id = $1 order by executado_em desc limit 1`, [H.ALUNO_A]);
    // era exatamente isto que vinha 0 em produção
    expect(a.q).toBe(1);
    expect(Number(a.v)).toBeCloseTo(1200, 2);
  }, TIMEOUT);
});

describe("3. a devolução NÃO quita o aluno — a garantia da regra 6", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("nenhum caso ganhou carimbo de quitação", async () => {
    const q = await quitacao(db);
    expect(q.casos_quitados).toBe(0);
    expect(q.casos_com_origem).toBe(0);
  });

  it("o aluno fica na tabulação, não num status de recuperado", async () => {
    const q = await quitacao(db);
    expect(q.jornada).toBe("CANCELAMENTO_COBRANCA");
    // a lista de `funil_historico_recuperacao` que conta como recuperado
    expect([
      "QUITADO_MANUAL", "QUITADO", "BAIXA_REALIZADA", "ACORDO_FECHADO",
      "AGUARDANDO_BAIXA", "ELOGIO_ATENDIMENTO", "SEM_SALDO_EM_ABERTO",
      "SALDO_ZERO_CONFIRMADO", "ENCERRADO",
    ]).not.toContain(q.jornada);
  });

  it("o título não recebe origem_liquidacao — não houve liquidação", async () => {
    expect((await titulo(db)).origem_liquidacao).toBeNull();
  });

  it("o early return do auto_quitar cobre DEVOLVIDO (a regressão que isto trava)", async () => {
    const f = await H.q1(db, `select pg_get_functiondef(p.oid) d from pg_proc p
                                join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname='public' and p.proname='_trg_auto_quitar_titulo'`);
    expect(f.d).toMatch(/'CANCELADA'\s*,\s*'DEVOLVIDO'/);
  });
});

describe("4. o rótulo não apodrece para CANCELADA", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("tentar reabrir o título não o transforma em CANCELADA", async () => {
    await db.query(`update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto' where id = $1`, [TIT_ID]);
    const t = await titulo(db);
    expect(t.situacao).toBe("DEVOLVIDO"); // a proteção restaurou o rótulo CERTO
    expect(t.status).toBe("devolvido");
    expect(t.origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
  });

  it("um toque em campo qualquer também preserva o par", async () => {
    await db.query(`update public.acordos_titulos set atualizado_em = now() where id = $1`, [TIT_ID]);
    const t = await titulo(db);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
  });

  it("a recusa fica registrada em auditoria, como antes", async () => {
    const r = await H.q1(db, `select count(*)::int c from public.auditoria
                               where acao = 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA'`);
    expect(r.c).toBeGreaterThan(0);
  });

  it("CANCELADA segue preservado quando era CANCELADA (os 29 da Conferência Prime)", async () => {
    const db2 = await montar();
    await db2.query(`select set_config('conferencia_prime.decisao','on', false)`);
    await db2.query(`update public.acordos_titulos
                        set situacao='CANCELADA', status='cancelada',
                            origem_encerramento='CONFERENCIA_PRIME_ADMINISTRATIVA',
                            origem_encerramento_em = now()
                      where id = $1`, [TIT_ID]);
    await db2.query(`select set_config('conferencia_prime.decisao','', false)`);

    await db2.query(`update public.acordos_titulos set situacao='ABERTO', status='em_aberto' where id = $1`, [TIT_ID]);
    const t = await titulo(db2);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.status).toBe("cancelada");
    expect(t.origem_encerramento).toBe("CONFERENCIA_PRIME_ADMINISTRATIVA");
  }, TIMEOUT);
});

// NOTA: isto vale para a cadeia DESTE arquivo, que para na 20261008190000.
// A 20261008192000 passou a marcar o título como SUSPENSO, por pedido da
// gestão -- ver supabase/tests/titulo_suspenso_status.test.js. O caso aqui
// continua provando o que a 190000 faz: a devolução mexe no título e a
// suspensão, naquele desenho, não.
describe("5. suspensão não toca o título — a dívida fica (desenho da 190000)", () => {
  it("SUSPENSAO_COBRANCA deixa o título como estava", async () => {
    const db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    const t = await titulo(db);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  }, TIMEOUT);
});

describe("6. nenhuma marca de pagamento, em nenhum dos caminhos", () => {
  it("devolução e suspensão não criam pagamento, baixa nem honorário", async () => {
    for (const tab of ["CANCELAMENTO_COBRANCA", "ANTECIPACAO_SEMESTRE", "SUSPENSAO_COBRANCA"]) {
      const db = await montar();
      const antes = await dinheiro(db);
      await db.query(`update public.alunos set status_jornada = $2 where id = $1`, [H.ALUNO_A, tab]);
      const depois = await dinheiro(db);
      expect(depois).toEqual(antes);
    }
  }, TIMEOUT);
});

describe("7. rollback", () => {
  it("devolve o motor e os três gatilhos ao estado anterior", async () => {
    const db = await montar();
    await db.exec(H.ROLL(M_DEVOLVIDO));

    const r = await H.q1(db, `select
      (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='parcela_efeito_sem_pagamento_aplicar') motor,
      (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='_trg_auto_quitar_titulo') quitar,
      (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='_titulo_encerrado_administrativo_protegido') prot`);

    expect(r.motor).toMatch(/situacao = 'CANCELADA'/);
    expect(r.motor).not.toMatch(/'DEVOLVIDO'/);
    expect(r.quitar).not.toMatch(/'CANCELADA'\s*,\s*'DEVOLVIDO'/);
    expect(r.prot).toMatch(/new\.situacao := 'CANCELADA'/);
  }, TIMEOUT);
});
