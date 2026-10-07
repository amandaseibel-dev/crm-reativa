// ANTECIPACAO DE SEMESTRE — migration REAL 20261007143000 + rollback REAL,
// sobre a fixture de producao `confirmacao_d2` (funcoes e gatilhos com o texto
// exato de producao, dados FICTICIOS).
//
// O que este teste precisa provar, porque e disso que depende a liberacao:
//
//   1. o SALDO do aluno deixa de contabilizar -- `aluno_saldo_pendente_detalhe`
//      vai a zero, e o titulo sai como CANCELADA com `origem_encerramento`,
//      NUNCA como PAGO (PAGO afirmaria recuperacao nossa);
//   2. a PARCELA sob nossa responsabilidade e quitada, com `origem_baixa`
//      proprio -- e `honorarios` fica EXATAMENTE como estava;
//   3. nao nasce pagamento nem baixa: `pagamentos` e `baixas_pagamento` ficam
//      byte a byte iguais;
//   4. `casos.quitado_em` e `origem_quitacao` ficam NULOS -- a antecipacao nao
//      se disfarca de quitacao, mesmo com `_talvez_quitar_aluno` rodando no meio
//      da transacao (e esse e o ponto que a mudanca em 6.3 protege);
//   5. OPERADOR nao consegue tabular: `_encerramento_so_gestao` recusa com
//      mensagem, e nada e escrito;
//   6. TABULAR aplica: gestao grava `status_jornada` na ficha e o desfecho
//      acontece sozinho, sem recursao;
//   7. o dry-run (padrao) nao escreve NADA e ainda assim devolve os numeros;
//   8. idempotencia -- aplicar de novo nao quita nada a mais;
//   9. o rollback devolve o mecanismo ao estado anterior.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";

// NOME COMPLETO, com o timestamp, de proposito: o `harness.MIG` da `main`
// monta o caminho direto (`supabase/migrations/${n}.sql`) e so acha o arquivo
// assim; o da branch do Gate 1 resolve pelo sufixo funcional e tira o
// timestamp antes de procurar. A forma completa funciona nas duas.
const M = "20261007143000_antecipacao_semestre_quita_responsabilidade";

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

// A fixture nao traz linha em `tabulacoes` (ela e do fluxo de confirmacao). O
// catalogo de producao TEM ANTECIPACAO_SEMESTRE desde 10/09/2026 -- conferido em
// 07/10/2026 --, e a migration ATUALIZA essa linha. Sem recria-la aqui o
// UPDATE acertaria 0 linhas e o teste passaria sem testar nada.
const CATALOGO_10_09 = `
insert into public.tabulacoes
  (codigo, rotulo, ativa, ordem, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
   bloqueia_acionamento, sistema, somente_gestao, redireciona_para_email, criado_por)
values
  ('ANTECIPACAO_SEMESTRE','Antecipação de semestre', true, 540, 'ALEGACAO', 'DIAS_UTEIS', 20,
   'AGUARDAR_RETORNO_UNIDADE', true, false, false, 'cobranca07@aelbra.com.br', 'gestao 10/09/2026'),
  ('MENSAGEM_ENVIADA','Mensagem enviada', true, 20, 'CONTATO', 'DIAS_UTEIS', 5,
   'CONTATAR', false, false, false, null, 'fixture');`;

// ALUNO_A tem acordo ATIVO com 2 parcelas vivas (VENCIDA + A_VENCER) e NENHUM
// titulo. O titulo aberto e inserido aqui para que exista saldo de ALUNO a
// deixar de contabilizar -- que e a metade do pedido que a fixture nao cobre.
const TITULO_ABERTO = `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido,
   situacao, status, tipo_boleto)
values
  ('11111111-1111-4111-8111-111111111111', '${H.ALUNO_A}',
   (select cpf_limpo from public.casos where aluno_id = '${H.ALUNO_A}' limit 1),
   '9900001', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade');`;

const MOTIVO = "unidade Canoas confirmou a antecipação do semestre 2026/2 em 06/10/2026";

// Montar a fixture de producao no PGlite leva alguns segundos; os 5.000ms de
// padrao do vitest nao cobrem isso quando a suite inteira roda em paralelo --
// medido em 07/10/2026: o `beforeAll` estourava e os 19 testes eram PULADOS,
// que e pior que falhar (a suite fica verde sem ter verificado nada). Mesmo
// recurso que `grupo_a_confirmacao_prime` ja usa.
const TIMEOUT = 120000;

let db;
let ANTES, DEPOIS;

const parcelas = (d) =>
  H.qn(d, `select p.id, p.status, p.valor, p.honorarios, p.origem_baixa, p.origem_baixa_ref, p.pago_em
             from public.parcelas p join public.acordos a on a.id = p.acordo_id
            where a.aluno_id = $1 order by p.numero, p.id`, [H.ALUNO_A]);
const titulos = (d) =>
  H.qn(d, `select id, situacao, status, origem_encerramento, origem_encerramento_ref, origem_liquidacao
             from public.acordos_titulos where aluno_id = $1 order by documento`, [H.ALUNO_A]);
const saldo = async (d) =>
  Number((await H.q1(d, `select public.aluno_saldo_pendente_detalhe($1, null) s`, [H.ALUNO_A])).s.total);
const caso = (d) =>
  H.q1(d, `select status_atual, status_jornada, status_financeiro, quitado_em, origem_quitacao,
                  total_em_aberto, nao_acionar, encerrado_operacional
             from public.casos where aluno_id = $1`, [H.ALUNO_A]);
const aluno = (d) =>
  H.q1(d, `select status_atual, status_jornada, status_acionamento, valor_em_aberto
             from public.alunos where id = $1`, [H.ALUNO_A]);
const dinheiro = (d) =>
  H.q1(d, `select (select count(*) from public.pagamentos) pagamentos,
                  (select count(*) from public.baixas_pagamento) baixas,
                  (select coalesce(sum(valor_honorario),0) from public.pagamentos) honorario_pagamentos`);

beforeAll(async () => {
  db = await H.montarProd();
  await db.exec(ROLES);
  await db.exec(CATALOGO_10_09);
  await db.exec(TITULO_ABERTO);
  ANTES = await H.snap(db);
  await db.exec(H.MIG(M));
  DEPOIS = await H.snap(db);
}, TIMEOUT);

describe("antecipação de semestre — a migration em si", () => {
  it("não escreve em nenhuma linha de dado (só catálogo, função e gatilho)", () => {
    // `tabulacoes` muda de proposito -- e o catalogo, nao dado operacional, e
    // por isso nao esta no snapshot do harness.
    expect(H.diff(ANTES, DEPOIS)).toEqual([]);
  });

  it("deixa a tabulação como desfecho, somente gestão, sem retorno e sem redirecionamento", async () => {
    const t = await H.q1(db, `select * from public.tabulacoes where codigo = 'ANTECIPACAO_SEMESTRE'`);
    expect(t.efeito_desfecho).toBe("ANTECIPACAO_SEMESTRE");
    expect(t.somente_gestao).toBe(true);
    expect(t.bloqueia_acionamento).toBe(true);
    expect(t.retorno_modo).toBe("NENHUM");
    expect(t.retorno_dias_uteis).toBeNull();
    expect(t.redireciona_para_email).toBeNull();
  });

  it("recusa origem fora do vocabulário, nas duas tabelas", async () => {
    await expect(
      db.query(`update public.parcelas set origem_baixa = 'INVENTADO' where id =
                 (select id from public.parcelas limit 1)`)
    ).rejects.toThrow(/parcelas_origem_baixa_valida/);
    await expect(
      db.query(`update public.acordos_titulos set origem_encerramento = 'INVENTADO'
                 where id = '11111111-1111-4111-8111-111111111111'`)
    ).rejects.toThrow(/acordos_titulos_origem_encerramento_valida/);
  });

  it("é idempotente: aplicar a migration de novo não muda nada", async () => {
    const a = await H.snap(db);
    await db.exec(H.MIG(M));
    expect(await H.snap(db)).toEqual(a);
  });
});

describe("antecipação de semestre — prévia e permissão", () => {
  it("dry-run devolve os números e não escreve nada", async () => {
    await H.como(db, H.GESTAO);
    const antes = await H.snap(db);
    const r = (await H.q1(db, `select public.antecipacao_semestre_aplicar($1, $2) r`, [H.ALUNO_A, MOTIVO])).r;
    expect(r.dry_run).toBe(true);
    expect(r.parcelas_a_quitar_qtd).toBe(2);
    expect(Number(r.titulos_a_encerrar_valor)).toBe(1200);
    expect(await H.snap(db)).toEqual(antes);
  });

  it("operador não aplica, e nada é escrito", async () => {
    await H.como(db, H.OP6);
    const antes = await H.snap(db);
    await expect(
      db.query(`select public.antecipacao_semestre_aplicar($1, $2, false)`, [H.ALUNO_A, MOTIVO])
    ).rejects.toThrow(/decisão da gestão/);
    expect(await H.snap(db)).toEqual(antes);
  });

  it("operador não tabula antecipação na ficha: o gatilho de encerramento recusa", async () => {
    await H.como(db, H.OP6);
    const antes = await H.snap(db);
    await expect(
      db.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A])
    ).rejects.toThrow(/decisão da gestão/);
    expect(await H.snap(db)).toEqual(antes);
  });

  it("motivo em branco é recusado", async () => {
    await H.como(db, H.GESTAO);
    await expect(
      db.query(`select public.antecipacao_semestre_aplicar($1, '   ', false)`, [H.ALUNO_A])
    ).rejects.toThrow(/Motivo obrigatório/);
  });
});

describe("antecipação de semestre — o desfecho, aplicado pela gestão", () => {
  let antesDinheiro, r;

  beforeAll(async () => {
    await H.como(db, H.GESTAO);
    antesDinheiro = await dinheiro(db);
    r = (await H.q1(db, `select public.antecipacao_semestre_aplicar($1, $2, false) r`, [H.ALUNO_A, MOTIVO])).r;
  }, TIMEOUT);

  it("quita as duas parcelas sob nossa responsabilidade, com origem própria", async () => {
    expect(r.parcelas_quitadas_qtd).toBe(2);
    const p = await parcelas(db);
    expect(p.every((x) => x.status === "PAGO")).toBe(true);
    const nossas = p.filter((x) => x.origem_baixa === "ANTECIPACAO_SEMESTRE");
    expect(nossas).toHaveLength(2);
    expect(nossas.every((x) => x.origem_baixa_ref === `antecipacao_semestre:${H.ALUNO_A}`)).toBe(true);
  });

  it("não escreve honorário em nenhuma parcela", async () => {
    const p = await parcelas(db);
    // A fixture ja traz 49.33 nas parcelas deste acordo: o valor tem de ficar
    // IGUAL. Um teste que so exigisse "nao nulo" passaria com valor reescrito.
    const nossas = p.filter((x) => x.origem_baixa === "ANTECIPACAO_SEMESTRE");
    expect(nossas.map((x) => Number(x.honorarios))).toEqual([49.33, 49.33]);
  });

  it("tira o saldo do aluno da conta — título CANCELADA, nunca PAGO", async () => {
    expect(await saldo(db)).toBe(0);
    const t = (await titulos(db)).find((x) => x.id === "11111111-1111-4111-8111-111111111111");
    expect(t.situacao).toBe("CANCELADA");
    expect(t.status).toBe("cancelada");
    expect(t.origem_encerramento).toBe("ANTECIPACAO_SEMESTRE");
    expect(t.origem_liquidacao).toBeNull();
    expect(Number(r.titulos_encerrados_valor)).toBe(1200);
  });

  it("não cria pagamento nem baixa: o caixa fica intocado", async () => {
    expect(await dinheiro(db)).toEqual(antesDinheiro);
  });

  it("não se disfarça de quitação: quitado_em e origem_quitacao ficam nulos", async () => {
    const c = await caso(db);
    expect(c.quitado_em).toBeNull();
    expect(c.origem_quitacao).toBeNull();
    expect(c.status_financeiro).toBe("ANTECIPACAO_SEMESTRE");
    expect(c.nao_acionar).toBe(true);
    expect(Number(c.total_em_aberto)).toBe(0);
  });

  it("o aluno sai das filas e da contagem dos 500", async () => {
    const a = await aluno(db);
    expect(a.status_jornada).toBe("ANTECIPACAO_SEMESTRE");
    expect(Number(a.valor_em_aberto)).toBe(0);
    expect((await caso(db)).encerrado_operacional).toBe(true);
  });

  it("audita o que foi feito, com valores e com quem decidiu", async () => {
    const a = await H.q1(db, `select * from public.antecipacao_semestre_auditoria where aluno_id = $1`, [H.ALUNO_A]);
    expect(a.motivo).toBe(MOTIVO);
    expect(a.executado_por).toBe(H.GESTAO);
    expect(a.parcelas_quitadas_qtd).toBe(2);
    expect(a.titulos_encerrados_qtd).toBe(1);
    expect(Number(a.saldo_antes)).toBeGreaterThan(0);
    expect(Number(a.saldo_depois)).toBe(0);
    const mov = await H.q1(db, `select tipo, descricao from public.aluno_movimentacoes
                                 where aluno_id = $1 and tipo = 'ANTECIPACAO_SEMESTRE'`, [H.ALUNO_A]);
    expect(mov.descricao).toMatch(/Nenhum pagamento e nenhum honorário foram criados/);
  });

  it("aplicar de novo não quita nada a mais", async () => {
    const antes = await parcelas(db);
    const r2 = (await H.q1(db, `select public.antecipacao_semestre_aplicar($1, $2, false) r`, [H.ALUNO_A, MOTIVO])).r;
    expect(r2.parcelas_quitadas_qtd).toBe(0);
    expect(r2.titulos_encerrados_qtd).toBe(0);
    expect(await parcelas(db)).toEqual(antes);
  });
});

describe("antecipação de semestre — tabular aplica", () => {
  let db2;

  beforeAll(async () => {
    db2 = await H.montarProd();
    await db2.exec(ROLES);
    await db2.exec(CATALOGO_10_09);
    await db2.exec(TITULO_ABERTO);
    await db2.exec(H.MIG(M));
    await H.como(db2, H.GESTAO);
    await db2.query(`update public.alunos set status_jornada = 'ANTECIPACAO_SEMESTRE' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("o desfecho acontece pelo ato de tabular, sem recursão", async () => {
    const p = await H.qn(db2, `select p.status, p.origem_baixa from public.parcelas p
                                 join public.acordos a on a.id = p.acordo_id
                                where a.aluno_id = $1 and p.origem_baixa = 'ANTECIPACAO_SEMESTRE'`, [H.ALUNO_A]);
    expect(p).toHaveLength(2);
    const t = await H.q1(db2, `select situacao, origem_encerramento from public.acordos_titulos
                                where id = '11111111-1111-4111-8111-111111111111'`);
    expect(t.situacao).toBe("CANCELADA");
    expect(t.origem_encerramento).toBe("ANTECIPACAO_SEMESTRE");
    // uma aplicacao, nao N: a marca de transacao cortou a reentrada do gatilho.
    const n = await H.q1(db2, `select count(*)::int c from public.antecipacao_semestre_auditoria where aluno_id = $1`, [H.ALUNO_A]);
    expect(n.c).toBe(1);
  });

  it("tabulação sem efeito_desfecho não aplica nada", async () => {
    const db3 = await H.montarProd();
    await db3.exec(ROLES);
    await db3.exec(CATALOGO_10_09);
    await db3.exec(TITULO_ABERTO);
    await db3.exec(H.MIG(M));
    await H.como(db3, H.GESTAO);
    await db3.query(`update public.alunos set status_jornada = 'MENSAGEM_ENVIADA' where id = $1`, [H.ALUNO_A]);
    const n = await H.q1(db3, `select count(*)::int c from public.antecipacao_semestre_auditoria`);
    expect(n.c).toBe(0);
    const t = await H.q1(db3, `select situacao from public.acordos_titulos
                                where id = '11111111-1111-4111-8111-111111111111'`);
    expect(t.situacao).toBe("ABERTO");
  }, TIMEOUT);
});

describe("antecipação de semestre — rollback", () => {
  it("devolve o mecanismo: tabulação volta a alegação, gatilho e motor somem", async () => {
    const db4 = await H.montarProd();
    await db4.exec(ROLES);
    await db4.exec(CATALOGO_10_09);
    await db4.exec(TITULO_ABERTO);
    await db4.exec(H.MIG(M));
    await db4.exec(H.ROLL(M));

    const t = await H.q1(db4, `select grupo, retorno_modo, retorno_dias_uteis, somente_gestao,
                                      redireciona_para_email
                                 from public.tabulacoes where codigo = 'ANTECIPACAO_SEMESTRE'`);
    expect(t.grupo).toBe("ALEGACAO");
    expect(t.retorno_modo).toBe("DIAS_UTEIS");
    expect(t.retorno_dias_uteis).toBe(20);
    expect(t.somente_gestao).toBe(false);
    expect(t.redireciona_para_email).toBe("cobranca07@aelbra.com.br");

    const sobrou = await H.q1(db4, `select
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'antecipacao_semestre_aplicar') fn,
      (select count(*)::int from pg_trigger
        where tgname = 'trg_tabulacao_antecipacao_semestre') tg,
      (select count(*)::int from information_schema.columns
        where table_schema = 'public' and table_name = 'tabulacoes'
          and column_name = 'efeito_desfecho') col`);
    expect(sobrou).toEqual({ fn: 0, tg: 0, col: 0 });
  }, TIMEOUT);
});
