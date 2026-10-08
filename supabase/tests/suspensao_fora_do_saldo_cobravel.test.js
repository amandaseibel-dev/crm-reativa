// SUSPENSÃO FORA DO SALDO COBRÁVEL — migration REAL 20261008103000 + rollback
// REAL, sobre a fixture de produção `confirmacao_d2` (dados FICTÍCIOS).
//
// A exigência da gestão tem DUAS metades, e o risco está em cumprir uma e
// quebrar a outra:
//
//   1. os títulos ficam fora do saldo cobrável ativo enquanto a suspensão durar;
//   2. e CONTINUAM registrados como dívida -- sem encerramento definitivo.
//
// Um teste que só checasse a metade 1 passaria com o título apagado, que é
// exatamente o erro a evitar. Por isso cada asserção de exclusão vem com a
// asserção de permanência ao lado.
//
// A terceira exigência é reversibilidade, e ela é a prova de que a exclusão é
// DERIVADA do estado e não gravada: levantar a suspensão devolve o saldo sem
// nenhuma escrita em `acordos_titulos`.
import { describe, it, expect, beforeAll } from "vitest";
import * as H from "./fixtures/confirmacao_d2/harness.js";
import { PORTAO_BLOQUEIO_ADMINISTRATIVO } from "./fixtures/portao_bloqueio_administrativo.js";

const M_ANTECIP = "20261007143000_antecipacao_semestre_quita_responsabilidade";
const M_FUND = "20261007210000_parcela_viva_fonte_unica";
const M_REGRA = "20261007211500_parcela_devolvida_suspensa";
const M_SALDO = "20261008103000_suspensao_fora_do_saldo_cobravel";

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
  ('SUSPENSAO_COBRANCA','Suspensão de cobrança', true, 430, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, 'f'),
  ('CANCELAMENTO_COBRANCA','Cancelamento definitivo de cobrança', true, 420, 'ENCERRAMENTO',
   'NENHUM', null, 'CONTATAR', false, false, false, 'f');`;

const TITULO = `
insert into public.acordos_titulos
  (id, aluno_id, cpf, documento, vencimento, valor_original, saldo_corrigido, situacao, status, tipo_boleto)
values
  ('${TIT}', '${H.ALUNO_A}', (select cpf_limpo from public.casos where aluno_id='${H.ALUNO_A}' limit 1),
   '9900001', current_date - 90, 1200.00, 1200.00, 'ABERTO', 'em_aberto', 'Mensalidade');`;

const cobravel = async (d, aluno) =>
  Number((await H.q1(d, `select public.saldo_cobravel_aluno($1) v`, [aluno])).v);
const registrado = async (d, aluno) =>
  Number((await H.q1(d, `select (public.aluno_saldo_pendente_detalhe($1,null)->>'total')::numeric v`, [aluno])).v);
const titulo = (d) =>
  H.q1(d, `select situacao, status, origem_encerramento, origem_liquidacao,
                  coalesce(saldo_corrigido, valor_original) as valor
             from public.acordos_titulos where id = $1`, [TIT]);

async function montar() {
  const db = await H.montarProd();
  await db.exec(ROLES);
  // o portão canônico não vem na fixture; é dele que sai o universo do
  // backfill e a exclusão do saldo cobrável
  await db.exec(PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await db.exec(CATALOGO);
  await db.exec(TITULO);
  await db.exec(H.MIG(M_ANTECIP));
  await db.exec(H.MIG(M_FUND));
  await db.exec(H.MIG(M_REGRA));
  await db.exec(H.MIG(M_SALDO));
  await H.como(db, H.GESTAO);
  return db;
}

describe("antes da suspensão", () => {
  let db;
  beforeAll(async () => { db = await montar(); }, TIMEOUT);

  it("o aluno tem saldo cobrável e saldo registrado", async () => {
    expect(await cobravel(db, H.ALUNO_A)).toBeGreaterThan(0);
    expect(await registrado(db, H.ALUNO_A)).toBeGreaterThan(0);
  });
});

describe("com a cobrança suspensa", () => {
  let db, registradoAntes, tituloAntes;

  beforeAll(async () => {
    db = await montar();
    registradoAntes = await registrado(db, H.ALUNO_A);
    tituloAntes = await titulo(db);
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
  }, TIMEOUT);

  it("METADE 1 — sai do saldo cobrável ativo", async () => {
    expect(await cobravel(db, H.ALUNO_A)).toBe(0);
  });

  it("METADE 2 — o TÍTULO continua registrado como dívida, com o mesmo valor", async () => {
    // Se esta asserção cair junto com a de cima, a dívida foi apagada em vez de
    // excluída -- que é o erro que a gestão pediu para evitar.
    //
    // O valor registrado cai de 2.531,87 para 1.200,00, e isso é CORRETO: os
    // 1.331,87 que saíram são as PARCELAS, que a regra manda marcar como
    // SUSPENSA -- elas deixam de ser cobráveis por decisão explícita da gestão,
    // e o registro delas continua na própria linha (status + valor + colunas de
    // efeito). O que a exigência protege são os TÍTULOS, e os R$ 1.200,00 do
    // título seguem somando no saldo registrado.
    const t = await titulo(db);
    expect(await registrado(db, H.ALUNO_A)).toBe(Number(t.valor));
    expect(Number(t.valor)).toBe(1200);
    expect(registradoAntes).toBeGreaterThan(Number(t.valor));
  });

  it("sem encerramento definitivo: o título não é tocado", async () => {
    const t = await titulo(db);
    expect(t).toEqual(tituloAntes);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
    expect(t.origem_liquidacao).toBeNull();
  });

  it("o portão canônico é quem decide — não uma coluna gravada no título", async () => {
    const g = await H.q1(db, `select public.aluno_bloqueio_administrativo($1) as bloqueio`, [H.ALUNO_A]);
    expect(g.bloqueio).toBe("SUSPENSAO_COBRANCA");
  });

  it("REVERSIBILIDADE — levantar a suspensão devolve o saldo cobrável", async () => {
    await db.query(`select public.suspensao_cobranca_reativar($1,'unidade negou a suspensão',false)`, [H.ALUNO_A]);
    expect(await cobravel(db, H.ALUNO_A)).toBeGreaterThan(0);
    // e o título segue o mesmo: nada foi escrito nele em nenhum dos dois sentidos
    expect(await titulo(db)).toEqual(tituloAntes);
  });
});

describe("a guarda é só de suspensão", () => {
  it("cancelamento NÃO entra nela — esse caminho encerra o título", async () => {
    // Pôr cancelamento e jurídico na mesma guarda esconderia dívida que
    // ninguém suspendeu. Cancelamento sai do saldo pelo encerramento do
    // título, que é explícito e auditado, não por derivação de status.
    const db = await montar();
    const antes = await cobravel(db, H.ALUNO_A);
    expect(antes).toBeGreaterThan(0);

    await db.exec(`select set_config('parcela_efeito_sem_pagamento.aplicando','on', false);`);
    await db.query(`update public.alunos set status_jornada = 'CANCELAMENTO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    await db.exec(`select set_config('parcela_efeito_sem_pagamento.aplicando','', false);`);

    // sem o encerramento do título, o saldo cobrável continua lá
    expect(await cobravel(db, H.ALUNO_A)).toBe(antes);
  }, TIMEOUT);
});

describe("rollback", () => {
  it("devolve o corpo anterior e o saldo volta a contar", async () => {
    const db = await montar();
    await db.query(`update public.alunos set status_jornada = 'SUSPENSAO_COBRANCA' where id = $1`, [H.ALUNO_A]);
    expect(await cobravel(db, H.ALUNO_A)).toBe(0);

    await db.exec(H.ROLL(M_SALDO));

    expect(await cobravel(db, H.ALUNO_A)).toBeGreaterThan(0);
    const f = await H.q1(db, `select pg_get_functiondef(oid) as def from pg_proc where proname='saldo_cobravel_aluno'`);
    expect(f.def).not.toMatch(/aluno_bloqueio_administrativo/);
    // e nenhuma linha de título mudou em nenhum dos dois sentidos
    const t = await titulo(db);
    expect(t.situacao).toBe("ABERTO");
    expect(t.origem_encerramento).toBeNull();
  }, TIMEOUT);
});
