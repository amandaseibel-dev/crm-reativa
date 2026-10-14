// TÍTULO DEVOLVIDO — migration REAL 20261009090000, sobre a fixture de
// produção `confirmacao_d2` (dados FICTÍCIOS).
//
// A regra aprovada tem DUAS metades, e cumprir uma e quebrar a outra é o risco:
//
//   1. a cobrança encerrada sem recuperação da ReATIVA ZERA o saldo cobrável;
//   2. e NÃO vira pagamento — nenhum centavo entrou por nosso trabalho.
//
// Um teste que só checasse a metade 1 passaria com o título marcado como pago,
// que é exatamente o erro a evitar. Por isso toda asserção de saída do saldo
// vem com a asserção de "não é recuperação" ao lado: `origem_liquidacao` nula e
// zero linhas novas em pagamentos, acordos, parcelas e vínculos.
//
// A terceira exigência é a diferença entre DEVOLVIDO e CANCELADA: são desfechos
// distintos e o novo não pode ser reescrito para o antigo pela trava de
// reabertura — há teste para isso, porque a trava antiga fazia exatamente isso.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_SALDO = "20261008103000_suspensao_fora_do_saldo_cobravel";
// a Conferência Prime nasce aqui: é esta migration que cria
// `prime_conferencia_encerrar_administrativo`, que a nova regra patcheia
const M_CONF = "20260919160000_prime_conferencia_encerramento_administrativo";
const M_DEV = "20261009090000_titulo_devolvido";

const TIMEOUT = 120000;
const TIT = "22222222-2222-4222-8222-222222222222";
const TIT_CONF = "33333333-3333-4333-8333-333333333333";

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
  ('CANCELAMENTO_COBRANCA','Cancelamento definitivo de cobrança', true, 420, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, 'f')
on conflict (codigo) do nothing;`;

// A FIXTURE É ANTIGA neste ponto: a tabela de decisão dela só conhece
// CONFIRMADO/REJEITADO, enquanto produção já tem PENDENTE, VINCULADO e
// ENCERRADO_ADMINISTRATIVO (constraint copiada de produção em 09/10/2026).
// Trazer o vocabulário é preparar o cenário, não afrouxar a asserção: o que o
// teste prova é que a migration ESCREVE ENCERRADO_ADMINISTRATIVO e tira o
// título da fila.
const VOCABULARIO_DECISAO = `
alter table public.prime_conferencia_decisao
  drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao
  add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO','ENCERRADO_ADMINISTRATIVO']));
`;

// Um título em aberto e um título preso na Conferência Prime, do mesmo aluno.
const TITULOS = `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
values
  ('${TIT}', '${H.ALUNO_A}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_A}' limit 1),
   '9910001', current_date - 90, 1500.00, 1500.00, 'ABERTO', 'em_aberto', 'Mensalidade');

-- o segundo entra EM_CONFIRMACAO pela porta oficial (o gatilho só deixa por ali)
select set_config('conferencia_prime.decisao','on', false);
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
values
  ('${TIT_CONF}', '${H.ALUNO_A}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_A}' limit 1),
   '9910002', current_date - 120, 800.00, 800.00, 'EM_CONFIRMACAO', 'em_confirmacao', 'Mensalidade');
insert into public.prime_conferencia_decisao (titulo_id, decisao)
values ('${TIT_CONF}', 'PENDENTE')
on conflict do nothing;
select set_config('conferencia_prime.decisao','off', false);`;

const cobravel = async (d, aluno) =>
  Number((await H.q1(d, `select public.saldo_cobravel_aluno($1) v`, [aluno])).v);
const tit = (d, id) =>
  H.q1(d, `select situacao, status, origem_encerramento, origem_encerramento_ref,
                  origem_liquidacao, valor_em_aberto, motivo_ajuste,
                  coalesce(saldo_corrigido, valor_original) as valor
             from public.acordos_titulos where id = $1`, [id]);
const contarFinanceiras = async (d) => {
  const r = await H.q1(d, `select
    (select count(*) from public.pagamentos) p,
    (select count(*) from public.acordos) a,
    (select count(*) from public.parcelas) pa,
    (select count(*) from public.acordo_titulo_vinculo) v`);
  return { p: Number(r.p), a: Number(r.a), pa: Number(r.pa), v: Number(r.v) };
};

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(VOCABULARIO_DECISAO);
  await db.exec(TITULOS);
  // ORDEM CRONOLÓGICA, como em produção. A de setembro redefine a constraint
  // de `origem_encerramento`; rodá-la depois das de outubro reinstalaria o
  // vocabulário antigo e derrubaria CANCELAMENTO_COBRANCA.
  await db.exec(H.MIG(M_CONF));
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(H.MIG(M_SALDO));
  await db.exec(H.MIG(M_DEV));
  await H.como(db, H.GESTAO);
  return db;
}

describe("DEVOLVIDO — a conta fecha e não vira pagamento", () => {
  let db, antes, financeirasAntes;

  beforeAll(async () => {
    db = await montar();
    antes = await cobravel(db, H.ALUNO_A);
    financeirasAntes = await contarFinanceiras(db);
    await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1, $2, $3, false)`,
      [H.ALUNO_A, "cobrança cancelada pela instituição em auditoria de matrícula", "CANCELAMENTO_COBRANCA"]);
  }, TIMEOUT);

  it("antes havia saldo cobrável", () => {
    expect(antes).toBeGreaterThan(0);
  });

  it("METADE 1 — o saldo cobrável do aluno ZERA", async () => {
    expect(await cobravel(db, H.ALUNO_A)).toBe(0);
  });

  it("o título fica DEVOLVIDO/devolvido, e não CANCELADA", async () => {
    const t = await tit(db, TIT);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
    expect(Number(t.valor_em_aberto)).toBe(0);
  });

  it("METADE 2 — não é pagamento: origem_liquidacao segue nula", async () => {
    const t = await tit(db, TIT);
    expect(t.origem_liquidacao).toBeNull();
  });

  it("METADE 2 — nada de dinheiro foi criado", async () => {
    // pagamento, acordo, parcela ou vínculo novo seria recuperação inventada
    expect(await contarFinanceiras(db)).toEqual(financeirasAntes);
  });

  it("a DÍVIDA continua registrada: o valor do título não é apagado", async () => {
    const t = await tit(db, TIT);
    expect(Number(t.valor)).toBe(1500);
  });

  it("motivo, origem e data ficam preservados", async () => {
    const t = await tit(db, TIT);
    expect(t.origem_encerramento).toBe("CANCELAMENTO_COBRANCA");
    expect(t.origem_encerramento_ref).toContain(H.ALUNO_A);
    expect(t.motivo_ajuste).toContain("auditoria de matrícula");
    expect(t.motivo_ajuste).toContain("Sem pagamento, acordo ou recuperação");
  });

  it("deixa trilha de auditoria", async () => {
    const r = await H.q1(db,
      `select count(*) n from public.aluno_movimentacoes where aluno_id = $1::text`, [H.ALUNO_A]);
    expect(Number(r.n)).toBeGreaterThan(0);
  });
});

describe("DEVOLVIDO alcança o título preso na Conferência Prime", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1, $2, $3, false)`,
      [H.ALUNO_A, "cobrança cancelada pela instituição", "CANCELAMENTO_COBRANCA"]);
  }, TIMEOUT);

  it("o título EM_CONFIRMACAO também é devolvido", async () => {
    const t = await tit(db, TIT_CONF);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
  });

  it("a decisão pendente é encerrada — o título SAI da fila", async () => {
    const d = await H.q1(db,
      `select decisao, decidido_em from public.prime_conferencia_decisao where titulo_id = $1`, [TIT_CONF]);
    expect(d.decisao).toBe("ENCERRADO_ADMINISTRATIVO");
    expect(d.decidido_em).not.toBeNull();
  });

  it("e continua sem ser pagamento", async () => {
    const t = await tit(db, TIT_CONF);
    expect(t.origem_liquidacao).toBeNull();
  });
});

describe("DEVOLVIDO é terminal e não volta a ser CANCELADA", () => {
  let db;
  beforeAll(async () => {
    db = await montar();
    await H.q1(db, `select public.parcela_efeito_sem_pagamento_aplicar($1, $2, $3, false)`,
      [H.ALUNO_A, "cobrança cancelada pela instituição", "CANCELAMENTO_COBRANCA"]);
  }, TIMEOUT);

  it("a trava de reabertura NÃO reescreve DEVOLVIDO como CANCELADA", async () => {
    // era o comportamento antigo: a trava conhecia um desfecho só e sobrescrevia
    await db.query(`update public.acordos_titulos set motivo_ajuste = motivo_ajuste || ' .' where id = $1`, [TIT]);
    const t = await tit(db, TIT);
    expect(t.situacao).toBe("DEVOLVIDO");
    expect(t.status).toBe("devolvido");
  });

  it("tentar reabrir para ABERTO é recusado e auditado", async () => {
    await db.query(`update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto' where id = $1`, [TIT]);
    const t = await tit(db, TIT);
    expect(t.situacao).toBe("DEVOLVIDO");
    const a = await H.q1(db,
      `select count(*) n from public.auditoria
        where acao = 'TITULO_ENCERRADO_ADMINISTRATIVO_REABERTURA_RECUSADA' and registro_id = $1`, [TIT]);
    expect(Number(a.n)).toBeGreaterThan(0);
  });

  // Esta fixture não tem `titulos_disponiveis_para_acordo` — é um dos objetos
  // que a migration PULA quando ausente. Em produção ela existe, e lá a prova
  // final da própria migration exige que ela conheça 'devolvido'. Aqui o teste
  // se declara pulado em vez de fingir que verificou.
  it("não é oferecido para um acordo novo", async (ctx) => {
    const tem = await H.q1(db,
      `select to_regprocedure('public.titulos_disponiveis_para_acordo(uuid)') is not null as ok`);
    if (!tem.ok) return ctx.skip();
    const r = await H.qn(db, `select * from public.titulos_disponiveis_para_acordo($1::uuid)`, [H.ALUNO_A]);
    expect(r.map((x) => x.id ?? x.titulo_id)).not.toContain(TIT);
  });
});
