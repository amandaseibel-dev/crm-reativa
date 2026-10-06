// `ranking_semana_valor` TEM DE ESTAR NO TOPO DO PAYLOAD.
//
// DEFEITO QUE ESTE ARQUIVO PRENDE. A migration 20261006110000 inseriu o
// indicador usando a ancora `'ranking_mes',`, que vive DENTRO do sub-objeto
// `v_dados`. A chave nasceu em `payload.dados.ranking_semana_valor` -- mas a
// tela le o TOPO:
//
//   const semana = snap?.ranking_semana_valor || snap?.dados?.ranking_semana || [];
//
// Com a chave so em `dados`, a tela cai no fallback (que tem `pagos`, nao
// `valor`) e segue exibindo "Mais pagamentos unicos da semana". Medido em
// producao apos a aplicacao: o calculo estava certo (8 operadores, maior JOAO
// com 18.690) e mesmo assim nao chegava na tela.
//
// O teste roda a migration REAL sobre uma funcao com a MESMA forma da de
// producao: `ranking_semana_valor` dentro de `v_dados`, e `v_dados` dentro do
// `jsonb_build_object` do return.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MIGRATION = readFileSync("supabase/migrations/20261006200000_tv_ranking_semana_valor_no_topo.sql", "utf-8");
const ROLLBACK = readFileSync("supabase/rollbacks/20261006200000_tv_ranking_semana_valor_no_topo.rollback.sql", "utf-8");

// Reproduz a forma de producao DEPOIS da 20261006110000: a chave existe, mas
// so dentro de `v_dados`.
const FUNCAO_COM_CHAVE_SO_EM_DADOS = `
  create or replace function public.tv_snapshot_calcular() returns jsonb
   language plpgsql stable as $f$
   declare
     v_dados jsonb; v_proj jsonb := '{}'::jsonb; v_rank jsonb := '{}'::jsonb;
   begin
     v_dados := jsonb_build_object(
       'ranking_semana', jsonb_build_array(jsonb_build_object('operador','ANA','pagos',3)),
       'ranking_semana_valor', jsonb_build_array(jsonb_build_object('operador','ANA','valor',1500)),
       'ranking_mes', jsonb_build_array());
     return jsonb_build_object(
       'dados', v_dados, 'proj', v_proj, 'rank', v_rank);
   end $f$;
`;

const chamar = async (db) =>
  (await db.query(`select public.tv_snapshot_calcular() j`)).rows[0].j;

const defDe = async (db) =>
  (await db.query(`select pg_get_functiondef(p.oid) d from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='tv_snapshot_calcular'`)).rows[0].d;

describe("ranking_semana_valor no topo do payload", () => {
  it("ANTES: a chave só existe em `dados` — é exatamente o defeito", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    const j = await chamar(db);

    expect(j.ranking_semana_valor).toBeUndefined();        // a tela nao acha
    expect(j.dados.ranking_semana_valor).toBeTruthy();     // o dado existe
    await db.close();
  });

  it("DEPOIS: a chave aparece no topo, com o mesmo conteúdo", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    await db.exec(MIGRATION);
    const j = await chamar(db);

    expect(j.ranking_semana_valor).toEqual([{ operador: "ANA", valor: 1500 }]);
    // e continua em `dados`, sem remover nada
    expect(j.dados.ranking_semana_valor).toEqual([{ operador: "ANA", valor: 1500 }]);
    await db.close();
  });

  it("é o que a tela procura: `snap?.ranking_semana_valor` passa a resolver", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    await db.exec(MIGRATION);
    const snap = await chamar(db);

    // mesma expressao do componente
    const semana = snap?.ranking_semana_valor || snap?.dados?.ranking_semana || [];
    const campeao = semana[0];
    const porValor = campeao.valor != null;

    expect(porValor).toBe(true);                 // antes era false
    expect(campeao.operador).toBe("ANA");
    expect(campeao.valor).toBe(1500);
    await db.close();
  });

  it("não mexe em mais nada do payload", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    const antes = await chamar(db);
    await db.exec(MIGRATION);
    const depois = await chamar(db);

    expect(depois.dados).toEqual(antes.dados);
    expect(depois.proj).toEqual(antes.proj);
    expect(depois.rank).toEqual(antes.rank);
    // a unica chave nova e a promovida
    const novas = Object.keys(depois).filter((k) => !(k in antes));
    expect(novas).toEqual(["ranking_semana_valor"]);
    await db.close();
  });

  it("é idempotente: rodar de novo não muda nada", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    await db.exec(MIGRATION);
    const primeira = await defDe(db);
    await db.exec(MIGRATION);
    expect(await defDe(db)).toBe(primeira);
    await db.close();
  });

  it("o rollback devolve o original, e é idempotente", async () => {
    const db = await PGlite.create();
    await db.exec(FUNCAO_COM_CHAVE_SO_EM_DADOS);
    const original = await defDe(db);
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    expect(await defDe(db)).toBe(original);
    await db.exec(ROLLBACK);
    expect(await defDe(db)).toBe(original);
    await db.close();
  });

  it("recusa aplicar se o indicador ainda não existe — ordem das migrations", async () => {
    const db = await PGlite.create();
    await db.exec(`
      create or replace function public.tv_snapshot_calcular() returns jsonb
       language plpgsql stable as $f$
       declare v_dados jsonb := '{}'::jsonb;
       begin return jsonb_build_object('dados', v_dados, 'proj', 1); end $f$;`);
    await expect(db.exec(MIGRATION)).rejects.toThrow(/aplique antes a migration/);
    await db.close();
  });

  it("falha alto se a função não existir", async () => {
    const db = await PGlite.create();
    await expect(db.exec(MIGRATION)).rejects.toThrow(/nao encontrada/);
    await db.close();
  });
});
