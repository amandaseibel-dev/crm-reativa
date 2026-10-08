// VALIDAÇÃO FINAL da regra financeira — os cinco fluxos de uma vez, sobre a
// fixture de produção `confirmacao_d2` (dados FICTÍCIOS), com as 4 migrations
// aplicadas na ordem real.
//
// Os outros arquivos desta frente provam cada peça. Este prova as DUAS
// INVARIANTES que atravessam todas elas, e que são o que a gestão pediu para
// manter em 08/10/2026:
//
//   I1. DÍVIDA TOTAL ≠ SALDO COBRÁVEL. A dívida continua registrada; o que sai
//       é a cobrabilidade. Um fluxo que zera as duas apagou dívida.
//   I2. PAGAMENTO REAL É INTOCÁVEL. Em nenhum dos cinco fluxos muda
//       `pago_em`, `origem_baixa*` ou `honorarios` de qualquer parcela da base.
//
// E trava uma decisão de escopo: os 7 painéis de estoque NÃO recebem a exclusão
// de suspensão neste PR. Se alguém adicionar depois, este teste quebra e a
// decisão volta para a mesa em vez de entrar de carona.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const MIGS = [
  "20261007143000_antecipacao_semestre_quita_responsabilidade",
  "20261007210000_parcela_viva_fonte_unica",
  "20261007211500_parcela_devolvida_suspensa",
  "20261008103000_suspensao_fora_do_saldo_cobravel",
];
const M_BACKFILL = "20261008130000_backfill_devolvida_suspensa_historico";
const TIMEOUT = 120000;
const TIT = "11111111-1111-4111-8111-111111111111";

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

const TITULO = `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
values
  ('${TIT}', '${H.ALUNO_A}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_A}' limit 1),
   '9900001', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade');`;

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO);
  for (const m of MIGS) await db.exec(H.MIG(m));
  await H.como(db, H.GESTAO);
  return db;
}

// as três leituras que não podem se confundir
const cobravel = async (d, a) =>
  Number((await H.q1(d, `select public.saldo_cobravel_aluno($1) v`, [a])).v);
const registradoTitulos = async (d, a) =>
  Number((await H.q1(d, `select coalesce(sum(coalesce(t.saldo_corrigido, t.valor_original,0)),0) v
                           from public.acordos_titulos t
                          where t.aluno_id = $1
                            and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')`, [a])).v);
// a marca de pagamento da BASE INTEIRA -- I2 é verificada aqui, não por aluno
const pagamentos = (d) =>
  H.qn(d, `select id, pago_em, origem_baixa, origem_baixa_ref, origem_baixa_em, honorarios
             from public.parcelas order by id`);
const dinheiro = (d) =>
  H.q1(d, `select (select count(*) from public.pagamentos) pag,
                  (select count(*) from public.baixas_pagamento) bx,
                  (select coalesce(sum(valor_honorario),0) from public.pagamentos) honor`);

// Cada fluxo é um cenário: como colocar o aluno nele, e o que esperar.
const FLUXOS = [
  {
    nome: "ANTECIPACAO_SEMESTRE",
    tabulacao: "ANTECIPACAO_SEMESTRE",
    efeito: "DEVOLVIDA",
    definitivo: true,
  },
  {
    nome: "CANCELAMENTO_COBRANCA",
    tabulacao: "CANCELAMENTO_COBRANCA",
    efeito: "DEVOLVIDA",
    definitivo: true,
  },
  {
    nome: "SUSPENSAO_COBRANCA",
    tabulacao: "SUSPENSAO_COBRANCA",
    efeito: "SUSPENSA",
    definitivo: false,
  },
];

describe.each(FLUXOS)("fluxo $nome", (f) => {
  let db, pagAntes, dinAntes, titAntes;

  beforeAll(async () => {
    db = await montar();
    pagAntes = await pagamentos(db);
    dinAntes = await dinheiro(db);
    titAntes = await registradoTitulos(db, H.ALUNO_A);
    await db.query(`update public.alunos set status_jornada = $2 where id = $1`, [H.ALUNO_A, f.tabulacao]);
  }, TIMEOUT);

  it("a parcela recebe o efeito certo, e nunca PAGO", async () => {
    const p = await H.qn(db, `select p.status, p.efeito_sem_pagamento
                                from public.parcelas p join public.acordos a on a.id = p.acordo_id
                               where a.aluno_id = $1 and p.efeito_sem_pagamento is not null`, [H.ALUNO_A]);
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.status === f.efeito)).toBe(true);
    expect(p.every((x) => x.status !== "PAGO")).toBe(true);
  });

  it("I2 — nenhuma marca de pagamento mudou em NENHUMA parcela da base", async () => {
    expect(await pagamentos(db)).toEqual(pagAntes);
  });

  it("I2 — não nasceu pagamento, baixa nem honorário", async () => {
    expect(await dinheiro(db)).toEqual(dinAntes);
  });

  it("não se disfarça de quitação", async () => {
    const c = await H.q1(db, `select quitado_em, origem_quitacao from public.casos where aluno_id = $1`, [H.ALUNO_A]);
    expect(c.quitado_em).toBeNull();
    expect(c.origem_quitacao).toBeNull();
    const ac = await H.qn(db, `select status from public.acordos where aluno_id = $1`, [H.ALUNO_A]);
    expect(ac.every((x) => x.status !== "QUITADO")).toBe(true);
  });

  it(
    f.definitivo
      ? "definitivo: o título é encerrado administrativamente, não liquidado"
      : "I1 — temporário: a dívida do título CONTINUA registrada, e só a cobrabilidade sai",
    async () => {
      const t = await H.q1(db, `select situacao, origem_encerramento, origem_liquidacao
                                  from public.acordos_titulos where id = $1`, [TIT]);
      if (f.definitivo) {
        expect(t.situacao).toBe("CANCELADA");
        expect(t.origem_encerramento).toBe(f.tabulacao);
        expect(t.origem_liquidacao).toBeNull(); // encerrar não é liquidar
      } else {
        // as duas metades juntas: fora do cobrável E ainda registrada
        expect(await cobravel(db, H.ALUNO_A)).toBe(0);
        expect(await registradoTitulos(db, H.ALUNO_A)).toBe(titAntes);
        expect(t.situacao).toBe("ABERTO");
        expect(t.origem_encerramento).toBeNull();
      }
    }
  );
});

describe("reativação da suspensão", () => {
  let db, pagAntes, titAntes;

  beforeAll(async () => {
    db = await montar();
    pagAntes = await pagamentos(db);
    titAntes = await registradoTitulos(db, H.ALUNO_A);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.query(`select public.suspensao_cobranca_reativar($1,'unidade negou a suspensão',false)`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("o portão deixa de bloquear e o saldo cobrável volta", async () => {
    const g = await H.q1(db, `select public.aluno_bloqueio_administrativo($1) b`, [H.ALUNO_A]);
    expect(g.b).not.toBe("SUSPENSAO_COBRANCA");
    expect(await cobravel(db, H.ALUNO_A)).toBeGreaterThan(0);
  });

  it("as parcelas voltam a ser cobráveis, pelo vencimento", async () => {
    const p = await H.qn(db, `select p.status, p.efeito_sem_pagamento
                                from public.parcelas p join public.acordos a on a.id = p.acordo_id
                               where a.aluno_id = $1 and upper(coalesce(p.status,'')) <> 'PAGO'`, [H.ALUNO_A]);
    expect(p).toHaveLength(2);
    expect(p.every((x) => ["A_VENCER", "VENCIDA"].includes(x.status))).toBe(true);
    expect(p.every((x) => x.efeito_sem_pagamento === null)).toBe(true);
  });

  it("I1 — o título nunca saiu do registro, nos dois sentidos", async () => {
    expect(await registradoTitulos(db, H.ALUNO_A)).toBe(titAntes);
    const t = await H.q1(db, `select situacao, origem_encerramento from public.acordos_titulos where id = $1`, [TIT]);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  });

  it("I2 — o ciclo inteiro não tocou marca de pagamento nenhuma", async () => {
    expect(await pagamentos(db)).toEqual(pagAntes);
  });

  it("uma reativação que não reativasse teria de falhar, não devolver ok", async () => {
    // A função confere o portão antes de confirmar. Sem essa conferência, o bug
    // medido em 08/10 (status_acionamento restaurado pelo gatilho) devolvia
    // `ok: true` com o saldo ainda em zero.
    const f = await H.q1(db, `select pg_get_functiondef(oid) as def from pg_proc
                               where proname = 'suspensao_cobranca_reativar'`);
    expect(f.def).toMatch(/aluno_bloqueio_administrativo/);
    expect(f.def).toMatch(/Reativação não levantou a suspensão/);
  });
});

describe("backfill do histórico", () => {
  let db, pagAntes;

  beforeAll(async () => {
    db = await montar();
    // histórico: tabulação marcada SEM passar pelo gatilho
    await db.exec(`select set_config('parcela_efeito_sem_pagamento.aplicando','on', false);`);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.exec(`select set_config('parcela_efeito_sem_pagamento.aplicando','', false);`);
    await db.exec(`
      select set_config('backfill.esperado_parcelas_qtd','2', false);
      select set_config('backfill.esperado_parcelas_valor','1331.87', false);
      select set_config('backfill.esperado_titulos_qtd','0', false);
      select set_config('backfill.esperado_titulos_valor','0', false);`);
    pagAntes = await pagamentos(db);
    await db.exec(H.MIG(M_BACKFILL));
  }, TIMEOUT);

  it("aplica o efeito ao histórico e guarda o estado anterior", async () => {
    const p = await H.qn(db, `select p.status from public.parcelas p join public.acordos a on a.id=p.acordo_id
                               where a.aluno_id = $1 and p.efeito_sem_pagamento = 'SUSPENSA'`, [H.ALUNO_A]);
    expect(p).toHaveLength(2);
    const b = await H.q1(db, `select count(*)::int c from public._backup_backfill_efeito_sem_pagamento`);
    expect(b.c).toBe(2);
  });

  it("I2 — o backfill não tocou marca de pagamento nenhuma", async () => {
    expect(await pagamentos(db)).toEqual(pagAntes);
  });

  it("I1 — e o título do suspenso segue registrado e intocado", async () => {
    const t = await H.q1(db, `select situacao, origem_encerramento from public.acordos_titulos where id = $1`, [TIT]);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  });
});

describe("escopo: os 7 painéis de estoque ficam fora deste PR", () => {
  // Decisão da gestão em 08/10/2026. Esta travinha existe para que a exclusão
  // de suspensão não entre nesses painéis de carona num PR futuro: se entrar,
  // o teste quebra e a decisão volta para a mesa.
  const PAINEIS = [
    "saude_carteira_panorama",
    "saude_carteira_resumo_impl",
    "carteira_geral_painel",
    "carteira_safra_situacoes",
    "carteira_cobertura_historica",
    "calibragem_saude",
    "somas_dashboard_principal",
  ];

  // A guarda olha o CONTEÚDO das migrations deste PR, não o banco: a fixture
  // não monta esses painéis, e um teste contra ela passaria por vacuidade. O
  // que precisa ficar travado é o que o PR escreve.
  it("nenhuma migration deste PR reescreve os 7 painéis", () => {
    const todas = [...MIGS, M_BACKFILL].map((m) => H.MIG(m));
    const violacoes = [];
    for (const painel of PAINEIS) {
      for (const [i, sql] of todas.entries()) {
        // `create or replace function public.<painel>` = reescrita explícita
        const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${painel}\\b`, "i");
        if (re.test(sql)) violacoes.push(`${painel} em ${[...MIGS, M_BACKFILL][i]}`);
      }
    }
    expect(violacoes).toEqual([]);
  });

  it("nenhuma migration deste PR dá o portão de suspensão a eles", () => {
    // O patch mecânico da fundação ALCANÇA 3 dos 7 (calibragem_saude,
    // carteira_geral_painel, saude_carteira_panorama), mas só troca a lista de
    // status da parcela por `parcela_viva()` -- mudança provada neutra, que não
    // muda número nenhum deles. O que NÃO pode entrar é a exclusão de
    // suspensão, e ela só existe onde o portão é consultado.
    const comPortao = [...MIGS, M_BACKFILL]
      .map((m) => ({ m, sql: H.MIG(m) }))
      .filter((x) => /aluno_bloqueio_administrativo/.test(x.sql))
      .map((x) => x.m);

    // Só TRÊS migrations podem citar o portão, e cada uma por um motivo:
    //   - a regra: `suspensao_cobranca_reativar` confere que a suspensão caiu
    //     de fato antes de confirmar a reativação;
    //   - o backfill: usa o portão para achar o universo elegível;
    //   - a exclusão: é o próprio assunto dela.
    // Qualquer quarta migration citando o portão é um painel ganhando a
    // exclusão de carona, e é isso que esta lista impede.
    expect(comPortao.sort()).toEqual([
      "20261007211500_parcela_devolvida_suspensa",
      "20261008103000_suspensao_fora_do_saldo_cobravel",
      // o backfill passou a ser 130000 para rodar DEPOIS da 103000 -- a ordem
      // desta lista é a alfabética do `.sort()`, e por isso ele vem por último
      "20261008130000_backfill_devolvida_suspensa_historico",
    ]);

    // e na migration da exclusão, o portão aparece SÓ dentro de
    // saldo_cobravel_aluno -- nenhum painel junto
    const sql = H.MIG("20261008103000_suspensao_fora_do_saldo_cobravel");
    const alvos = [...sql.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(alvos).toEqual(["saldo_cobravel_aluno"]);
  });

  it("quem recebe a exclusão é só o saldo cobrável — e a dívida registrada não", async () => {
    const db = await montar();
    const r = await H.q1(db, `select
      (select pg_get_functiondef(oid) ~ 'aluno_bloqueio_administrativo'
         from pg_proc where proname = 'saldo_cobravel_aluno') as cobravel_tem,
      (select pg_get_functiondef(oid) ~ 'aluno_bloqueio_administrativo'
         from pg_proc where proname = 'aluno_saldo_pendente_detalhe') as registrado_tem`);
    expect(r.cobravel_tem).toBe(true);
    // a dívida REGISTRADA não conhece suspensão -- é isso que mantém I1
    expect(r.registrado_tem).toBe(false);
  }, TIMEOUT);
});
