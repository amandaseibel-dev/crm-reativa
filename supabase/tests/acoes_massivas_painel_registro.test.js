// PAINEL "REGISTRO DAS ACOES MASSIVAS": a funcao de leitura que alimenta a tela.
//
// Bancada PGlite (Postgres real, dados inventados): producao + registro
// automatico (MIG7) + a migration nova 20261019171500.
//
// O que prova:
//   1. os tres estados saem com o rotulo certo (REGISTRADO / PENDENTE / DESCARTADO);
//   2. lote de setembro, que nao tem a coluna `registrados`, ainda mostra
//      quantos entraram -- o numero vem do `resultado`;
//   3. lote PENDENTE nunca some do painel, por mais antigo que seja (era a
//      garantia do painel anterior, que nao tinha recorte de data);
//   4. lote ja REGISTRADO fora da janela some, senao o painel vira arquivo;
//   5. quando registrou menos que o total, o motivo vem junto, com os numeros
//      do proprio lote;
//   6. operador comum nao le lote de acao massiva (portao de gestao, 42501);
//   7. a funcao NAO escreve: nenhuma linha muda em lote nem em movimentacao.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  novoBanco, comoGestao, comoOperador, GESTAO, OP_A, U,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const MIG = readFileSync(
  resolve("supabase/migrations/20261019201558_acoes_massivas_painel_registro.sql"), "utf8");

const banco = async () => {
  const db = await novoBanco({ registroAutomatico: true });
  await db.exec(MIG);
  await comoGestao(db);
  return db;
};

/** Insere um lote com o estado pedido. `diasAtras` conta da exportacao. */
async function lote(db, {
  id, situacao, total = 100, registrados = null, diasAtras = 1,
  canal = "WHATSAPP", automatico = true, resultado = null, arquivo = "planilha.xlsx",
}) {
  const exportadoEm = `now() - interval '${diasAtras} days'`;
  const confirmado = situacao === "REGISTRADO" ? exportadoEm : "null";
  const descartado = situacao === "DESCARTADO" ? exportadoEm : "null";
  await db.query(
    `insert into public.acoes_massivas_lotes
       (id, canal, operador_email, arquivo, aluno_ids, total, exportado_por_email,
        exportado_em, confirmado_em, confirmado_por_email, descartado_em,
        resultado, tipo_cobranca, registrados, registro_automatico)
     values ($1, $2, null, $3, '{}', $4, $5, ${exportadoEm}, ${confirmado},
             case when ${confirmado} is null then null else $5 end, ${descartado},
             $6, 'MENSALIDADES', $7, $8)`,
    [id, canal, arquivo, total, GESTAO, resultado, registrados, automatico]);
}

const painel = async (db, dias = 7) =>
  (await db.query(`select public.acoes_massivas_lotes_registro($1) as p`, [dias])).rows[0].p;

const porId = (p, id) => p.find((l) => l.id === id);

describe("painel de registro das acoes massivas", () => {
  it("mostra os tres estados com o rotulo e os numeros certos", async () => {
    const db = await banco();
    await lote(db, { id: U(1), situacao: "REGISTRADO", total: 300, registrados: 300 });
    await lote(db, { id: U(2), situacao: "PENDENTE", total: 142, automatico: false });
    await lote(db, { id: U(3), situacao: "DESCARTADO", total: 1000, automatico: false });

    const p = await painel(db);
    expect(p).toHaveLength(3);
    expect(porId(p, U(1)).situacao).toBe("REGISTRADO");
    expect(porId(p, U(1)).registrados_efetivos).toBe(300);
    expect(porId(p, U(1)).registro_automatico).toBe(true);
    expect(porId(p, U(2)).situacao).toBe("PENDENTE");
    expect(porId(p, U(2)).confirmado_em).toBeNull();
    expect(porId(p, U(3)).situacao).toBe("DESCARTADO");
    expect(porId(p, U(3)).descartado_em).not.toBeNull();
  });

  it("lote de setembro, sem a coluna registrados, mostra o numero do resultado", async () => {
    const db = await banco();
    // A coluna `registrados` nasceu em 02/10 (MIG7); o numero ja estava no
    // `resultado` desde 17/09. O painel tem de ler os dois.
    await lote(db, {
      id: U(4), situacao: "REGISTRADO", total: 97, registrados: null, diasAtras: 2,
      automatico: false, resultado: JSON.stringify({ registrados: 89 }),
    });
    const p = await painel(db);
    expect(porId(p, U(4)).registrados).toBeNull();
    expect(porId(p, U(4)).registrados_efetivos).toBe(89);
  });

  it("lote PENDENTE nao some do painel, por mais antigo que seja", async () => {
    const db = await banco();
    await lote(db, { id: U(5), situacao: "PENDENTE", diasAtras: 80, automatico: false });
    const p = await painel(db, 7);
    expect(porId(p, U(5))).toBeTruthy();
    expect(porId(p, U(5)).situacao).toBe("PENDENTE");
  });

  it("lote ja registrado fora da janela sai do painel", async () => {
    const db = await banco();
    await lote(db, { id: U(6), situacao: "REGISTRADO", diasAtras: 30, registrados: 100 });
    expect(porId(await painel(db, 7), U(6))).toBeUndefined();
    // e volta quando a janela alcanca
    expect(porId(await painel(db, 60), U(6))).toBeTruthy();
  });

  it("quando registrou menos que o total, traz o motivo com os numeros do lote", async () => {
    const db = await banco();
    await lote(db, {
      id: U(7), situacao: "REGISTRADO", total: 300, registrados: 81, automatico: false,
      resultado: JSON.stringify({
        registrados: 81,
        excluidos_acionados_apos_exportacao: 219,
        excluidos_confirmacao: 0,
        excluidos_por_motivo: { acao_massiva_recente: 4 },
      }),
    });
    const l = porId(await painel(db), U(7));
    expect(l.excluidos.acionados_apos_exportacao).toBe(219);
    // zero nao polui o painel
    expect(l.excluidos.confirmacao_pagamento).toBeUndefined();
    expect(l.excluidos_por_motivo).toEqual({ acao_massiva_recente: 4 });
  });

  it("operador comum nao le lote de acao massiva", async () => {
    const db = await banco();
    await lote(db, { id: U(8), situacao: "REGISTRADO", registrados: 100 });
    await comoOperador(db, OP_A);
    await expect(painel(db)).rejects.toThrow(/Acesso negado/i);
  });

  it("nao escreve nada: lote e movimentacao ficam intactos", async () => {
    const db = await banco();
    await lote(db, { id: U(9), situacao: "REGISTRADO", total: 300, registrados: 300 });
    await lote(db, { id: U(10), situacao: "PENDENTE", automatico: false });

    const foto = async () => (await db.query(
      `select (select count(*) from public.acoes_massivas_lotes) as lotes,
              (select count(*) from public.aluno_movimentacoes) as movs,
              (select md5(string_agg(id::text || coalesce(confirmado_em::text,'-') ||
                                     coalesce(descartado_em::text,'-') ||
                                     coalesce(registrados::text,'-'), '|' order by id))
                 from public.acoes_massivas_lotes) as assinatura`)).rows[0];

    const antes = await foto();
    await painel(db);
    await painel(db, 90);
    expect(await foto()).toEqual(antes);
  });
});
