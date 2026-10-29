// A VIRADA DIARIA VOLTA A ENXERGAR QUEM VOLTOU A DEVER.
//
// Roda a migration REAL e o rollback REAL
// (supabase/migrations/20261001175200_virada_diaria_revisita_quitado_com_divida.sql e o rollback de mesmo nome)
// sobre uma bancada PGlite minima. O que se testa aqui e QUEM a varredura
// visita -- que e exatamente o que a migration muda. A recalculadora de verdade
// e enorme e nao e o objeto deste teste, entao entra como duble que so registra
// quem foi chamado (mesmo padrao da bancada de acoes_massivas_universo).
//
// DADOS FICTICIOS: nomes, CPFs e ids sao inventados. Os cenarios sao os reais
// medidos em producao em 01/10/2026, nao os registros.
//
// Cada cenario e testado NOS DOIS ESTADOS:
//   antes  = producao hoje (rollback aplicado)
//   depois = producao + migration
// Assim o teste prova a mudanca, nao so o estado final.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (d, p) => readFileSync(resolve(AQUI, "..", d, p), "utf8");
const MIGRATION = ler("migrations", "20261001175200_virada_diaria_revisita_quitado_com_divida.sql");
const ROLLBACK = ler("rollbacks", "20261001175200_virada_diaria_revisita_quitado_com_divida.rollback.sql");

const ESQUEMA = `
  create table public.alunos (
    id uuid primary key,
    status_atual text
  );
  create table public.casos (
    id uuid primary key,
    aluno_id uuid,
    situacao_operacional text,
    encerrado_operacional boolean default false,
    criticidade text,
    caso_atualizado_em timestamptz default now()
  );
  create table public.acordos (
    id uuid primary key,
    status text
  );
  create table public.acordos_titulos (
    id uuid primary key,
    aluno_id uuid,
    situacao text,
    status text,
    tipo_boleto text,
    valor_cobranca_ajustado numeric,
    saldo_corrigido numeric,
    valor_em_aberto numeric,
    valor_original numeric
  );
  create table public.acordo_titulo_vinculo (
    titulo_id uuid,
    acordo_id uuid,
    ativo boolean default true
  );
  create table public.baixas_pagamento (
    aluno_id text,
    status_baixa text
  );
  -- duble: registra QUEM a varredura mandou recalcular.
  create table public._recalc_log (aluno_id uuid, lote text);
  create function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null)
    returns jsonb language plpgsql as $$
    begin insert into public._recalc_log values (p_aluno_id, p_lote); return '{}'::jsonb; end $$;
`;

const U = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Monta um aluno com um caso e, opcionalmente, um titulo cobravel. */
async function cenario(db, n, {
  situacao = "QUITADO",
  encerrado = false,
  statusAluno = "MENSAGEM_ENVIADA",
  titulo = null,            // {situacao, status, tipo_boleto, valor} ou null
  vinculoAcordoStatus = null, // se setado, cria vinculo ativo a um acordo nesse status
  baixaPendente = false,
} = {}) {
  const al = U(n), ca = U(n + 1000), ti = U(n + 2000), ac = U(n + 3000);
  await db.query("insert into public.alunos(id,status_atual) values ($1,$2)", [al, statusAluno]);
  await db.query(
    "insert into public.casos(id,aluno_id,situacao_operacional,encerrado_operacional) values ($1,$2,$3,$4)",
    [ca, al, situacao, encerrado]
  );
  if (titulo) {
    await db.query(
      `insert into public.acordos_titulos(id,aluno_id,situacao,status,tipo_boleto,valor_original)
       values ($1,$2,$3,$4,$5,$6)`,
      [ti, al, titulo.situacao ?? "ABERTO", titulo.status ?? "em_aberto",
       titulo.tipo_boleto ?? "Cursos de Graduação Presencial", titulo.valor ?? 1000]
    );
  }
  if (vinculoAcordoStatus) {
    await db.query("insert into public.acordos(id,status) values ($1,$2)", [ac, vinculoAcordoStatus]);
    await db.query("insert into public.acordo_titulo_vinculo(titulo_id,acordo_id,ativo) values ($1,$2,true)", [ti, ac]);
  }
  if (baixaPendente) {
    await db.query("insert into public.baixas_pagamento(aluno_id,status_baixa) values ($1,'PENDENTE')", [al]);
  }
  return al;
}

/** Roda a varredura e devolve a lista de aluno_id visitados. */
async function varrer(db) {
  await db.exec("delete from public._recalc_log");
  await db.query("select public.recalcular_situacao_virada_diaria('teste')");
  const r = await db.query("select aluno_id from public._recalc_log");
  return r.rows.map((x) => x.aluno_id);
}

async function banco(fase) {
  const db = await PGlite.create();
  await db.exec(ESQUEMA);
  await db.exec(fase === "depois" ? MIGRATION : ROLLBACK);
  return db;
}

describe("virada diaria — reentrada segura do QUITADO que voltou a dever", () => {
  let antes, depois, ids;

  beforeAll(async () => {
    const montar = async (db) => ({
      // 1) acordo cancelado reabriu a divida: o titulo voltou a ABERTO e o
      //    vinculo que existia aponta para um acordo CANCELADO.
      acordoCancelado: await cenario(db, 1, { titulo: { valor: 2095.4 }, vinculoAcordoStatus: "CANCELADO" }),
      // 2) divida NOVA entrando depois do QUITADO (sem acordo nenhum).
      dividaNova: await cenario(db, 2, { titulo: { valor: 1300 } }),
      // 3) AGUARDANDO_BAIXA: pagamento pode estar parado na fila.
      aguardandoBaixa: await cenario(db, 3, { titulo: { valor: 5156.48 }, statusAluno: "AGUARDANDO_BAIXA" }),
      // 4) CANCELAMENTO_COBRANCA: cobranca cancelada.
      cancelamento: await cenario(db, 4, { titulo: { valor: 1300 }, statusAluno: "CANCELAMENTO_COBRANCA" }),
      // 5) encerrado operacionalmente: so a gestao reabre.
      encerrado: await cenario(db, 5, { titulo: { valor: 11090.91 }, encerrado: true }),
      // 6) QUITADO legitimo: nenhum titulo cobravel.
      quitadoLimpo: await cenario(db, 6, { titulo: null }),
      // 7) conciliacao pendente registrada em baixas_pagamento.
      baixaPendente: await cenario(db, 7, { titulo: { valor: 900 }, baixaPendente: true }),
      // 8) titulo existe mas e o boleto do PROPRIO acordo: nao e divida nova.
      boletoDoAcordo: await cenario(db, 8, { titulo: { valor: 900, tipo_boleto: "Acordo" } }),
      // 9) titulo preso a acordo VIVO: ja esta coberto, nao e divida solta.
      acordoVivo: await cenario(db, 9, { titulo: { valor: 900 }, vinculoAcordoStatus: "ATIVO" }),
      // 10) caso que nunca foi QUITADO: tem de ser varrido nos dois estados.
      emCobranca: await cenario(db, 10, { situacao: "COBRANCA_VENCIDA", titulo: { valor: 500 } }),
      // 11) titulo com valor zero nao e divida.
      valorZero: await cenario(db, 11, { titulo: { valor: 0 } }),
    });
    antes = await banco("antes");
    ids = await montar(antes);
    depois = await banco("depois");
    await montar(depois);
  });

  it("ANTES: a varredura ignora todo QUITADO, inclusive quem voltou a dever", async () => {
    const visitados = await varrer(antes);
    expect(visitados).toEqual([ids.emCobranca]);
  });

  it("acordo cancelado reabrindo divida volta a ser recalculado", async () => {
    expect(await varrer(depois)).toContain(ids.acordoCancelado);
  });

  it("divida nova entrando depois do QUITADO volta a ser recalculada", async () => {
    expect(await varrer(depois)).toContain(ids.dividaNova);
  });

  it("AGUARDANDO_BAIXA continua bloqueado — pode ter pagamento parado na fila", async () => {
    expect(await varrer(depois)).not.toContain(ids.aguardandoBaixa);
  });

  it("CANCELAMENTO_COBRANCA continua bloqueado", async () => {
    expect(await varrer(depois)).not.toContain(ids.cancelamento);
  });

  it("encerrado_operacional continua bloqueado — reabrir e decisao de gestao", async () => {
    expect(await varrer(depois)).not.toContain(ids.encerrado);
  });

  it("QUITADO legitimo sem divida permanece intacto", async () => {
    expect(await varrer(depois)).not.toContain(ids.quitadoLimpo);
  });

  it("conciliacao pendente em baixas_pagamento continua bloqueada", async () => {
    expect(await varrer(depois)).not.toContain(ids.baixaPendente);
  });

  it("boleto do proprio acordo nao conta como divida reaberta", async () => {
    expect(await varrer(depois)).not.toContain(ids.boletoDoAcordo);
  });

  it("titulo preso a acordo VIVO nao conta como divida reaberta", async () => {
    expect(await varrer(depois)).not.toContain(ids.acordoVivo);
  });

  it("titulo com valor zero nao conta como divida", async () => {
    expect(await varrer(depois)).not.toContain(ids.valorZero);
  });

  it("quem nunca foi QUITADO continua sendo varrido nos dois estados", async () => {
    expect(await varrer(antes)).toContain(ids.emCobranca);
    expect(await varrer(depois)).toContain(ids.emCobranca);
  });

  it("DEPOIS: entram exatamente os dois que podem voltar, e mais ninguem", async () => {
    const visitados = await varrer(depois);
    expect(visitados.sort()).toEqual([ids.acordoCancelado, ids.dividaNova, ids.emCobranca].sort());
  });
});
