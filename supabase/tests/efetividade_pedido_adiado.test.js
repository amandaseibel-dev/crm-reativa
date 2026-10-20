// O DRENO NAO DESCARTA PEDIDO QUE ELE NAO ATENDEU — comportamento em
// PostgreSQL real (PGlite), nao em mock.
//
// `carteira_efetividade_recalcular` desiste quando outra passada ja detem o
// advisory lock, e devolve `{"ja_em_andamento": true}` sem recalcular nada. O
// dreno chamava com `perform` — jogando o retorno fora — e apagava o pedido em
// seguida. Resultado: fotografia velha, `atualizacao_pendente` apagado, e
// ninguem mais sabendo que ficou trabalho pendente.
//
// O que este teste prova:
//
//  1. a migration APLICA — se o SQL nao compilar, nada aqui roda;
//  2. retorno `ja_em_andamento` NAO apaga o pedido, e o recorte sai em
//     `adiados`, nao em `reconstruidos` nem em `erros`;
//  3. pedido adiado nao e erro: `ok` continua true;
//  4. a TELA continua dizendo `atualizacao_pendente` — e esta a consequencia
//     visivel do defeito, e a razao de ser deste patch;
//  5. o pedido adiado fica intacto: mesmo `invalidado_em`, mesmo `pedidos`;
//  6. a passada seguinte, com o lock livre, atende e apaga;
//  7. um recorte adiado nao impede outro de ser reconstruido na mesma passada;
//  8. o caminho de ERRO continua como era (pedido fica, `ok` false) — este
//     patch nao mexeu nele;
//  9. o rollback devolve o corpo anterior, com o descarte silencioso de volta.
//
// Dados ficticios. Bancada: fixtures/carteira_pendencias/bancada.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  montar, q1, ROLL, PEDIDO_ADIADO, invalidacoes, drenar, ler, fotoGeradaEm,
} from "./fixtures/carteira_pendencias/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => { db = await montar(); });
afterEach(async () => { await db?.close(); db = null; });

// Troca o recalculo por um duble que diz "ja em andamento" sem recalcular —
// exatamente o que a funcao real devolve quando `pg_try_advisory_xact_lock`
// falha. Em PGlite nao ha duas sessoes para disputar o lock de verdade, e o
// contrato que importa aqui e o do RETORNO.
const comoLockTomado = (db) => db.exec(
  `create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
   returns jsonb language plpgsql as $$
   begin
     return jsonb_build_object('ja_em_andamento', true, 'verificado_em', now());
   end $$;`);

const comoLockLivre = (db) => db.exec(
  `create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
   returns jsonb language plpgsql as $$ begin return '{}'::jsonb; end $$;`);

const pedir = (db, recorte, { idade = "0 minutes", pedidos = 1 } = {}) =>
  db.query(
    `insert into public.carteira_efetividade_invalidacao (recorte, invalidado_em, motivo, origem, pedidos)
     values ($1, now() - $2::interval, 'teste', 'TESTE', $3)`, [recorte, idade, pedidos]);

const limparFila = (db) => db.query("delete from public.carteira_efetividade_invalidacao");

describe("a migration aplica e o dreno continua de pé", () => {
  it("o dreno existe, responde e agora declara `adiados`", async () => {
    await limparFila(db);
    const r = await drenar(db);
    expect(r.ok).toBe(true);
    expect(r.adiados).toEqual([]);
    expect(r.reconstruidos).toEqual([]);
    expect(r.erros).toEqual([]);
  });

  it("as permissões do dreno não mudaram", async () => {
    expect(Boolean((await q1(db, `select has_function_privilege('authenticated',
      'public.carteira_efetividade_recalcular_pendentes()', 'execute') p`)).p)).toBe(false);
    expect(Boolean((await q1(db, `select has_function_privilege('service_role',
      'public.carteira_efetividade_recalcular_pendentes()', 'execute') p`)).p)).toBe(true);
  });
});

describe("recálculo que não aconteceu não apaga o pedido", () => {
  it("`ja_em_andamento` deixa o pedido na fila e sai em `adiados`", async () => {
    await limparFila(db);
    await pedir(db, "2024");
    await comoLockTomado(db);

    const r = await drenar(db);

    expect(r.adiados.map((x) => x.recorte)).toEqual(["2024"]);
    expect(r.adiados[0].motivo).toBe("ja_em_andamento");
    expect(r.reconstruidos).toEqual([]);
    // Pedido adiado NAO e erro: e trabalho pendente.
    expect(r.erros).toEqual([]);
    expect(r.ok).toBe(true);
    // E o que mais importa: o pedido SOBREVIVEU.
    expect((await invalidacoes(db)).map((x) => x.recorte)).toEqual(["2024"]);
  });

  it("a tela continua dizendo que a fotografia está velha", async () => {
    await limparFila(db);
    await pedir(db, "2024");
    expect((await ler(db, "pendencias_por_motivo", "2024")).snapshot.atualizacao_pendente).toBe(true);

    await comoLockTomado(db);
    await drenar(db);

    // ANTES DESTE PATCH esta asserção falhava: o pedido era apagado e a tela
    // passava a dizer que estava em dia, com a fotografia velha.
    expect((await ler(db, "pendencias_por_motivo", "2024")).snapshot.atualizacao_pendente).toBe(true);
  });

  it("o pedido adiado fica intacto — mesmo `invalidado_em`, mesmo `pedidos`", async () => {
    await limparFila(db);
    await pedir(db, "2025", { idade: "3 minutes", pedidos: 7 });
    const antes = (await invalidacoes(db))[0];

    await comoLockTomado(db);
    await drenar(db);

    const depois = (await invalidacoes(db))[0];
    expect(depois.invalidado_em).toEqual(antes.invalidado_em);
    expect(Number(depois.pedidos)).toBe(7);
  });

  it("a fotografia não avança quando o pedido é adiado", async () => {
    await limparFila(db);
    const antes = await fotoGeradaEm(db, "pendencias_por_motivo", "2024");
    await pedir(db, "2024");
    await comoLockTomado(db);
    await drenar(db);
    expect(await fotoGeradaEm(db, "pendencias_por_motivo", "2024")).toEqual(antes);
  });

  it("na passada seguinte, com o lock livre, o pedido é atendido e apagado", async () => {
    await limparFila(db);
    await pedir(db, "2024");

    await comoLockTomado(db);
    expect((await drenar(db)).adiados.map((x) => x.recorte)).toEqual(["2024"]);
    expect((await invalidacoes(db)).map((x) => x.recorte)).toEqual(["2024"]);

    await comoLockLivre(db);
    const r = await drenar(db);

    expect(r.reconstruidos.map((x) => x.recorte)).toEqual(["2024"]);
    expect(r.adiados).toEqual([]);
    expect(await invalidacoes(db)).toEqual([]);
  });

  it("um recorte adiado não impede o outro de ser reconstruído", async () => {
    await limparFila(db);
    await pedir(db, "2024", { idade: "2 minutes" });
    await pedir(db, "2025", { idade: "1 minute" });
    await db.exec(
      `create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
       returns jsonb language plpgsql as $$
       begin
         if p_recorte = '2024' then
           return jsonb_build_object('ja_em_andamento', true);
         end if;
         return '{}'::jsonb;
       end $$;`);

    const r = await drenar(db);

    expect(r.adiados.map((x) => x.recorte)).toEqual(["2024"]);
    expect(r.reconstruidos.map((x) => x.recorte)).toEqual(["2025"]);
    expect(r.ok).toBe(true);
    expect((await invalidacoes(db)).map((x) => x.recorte)).toEqual(["2024"]);
  });
});

describe("o caminho de erro não foi tocado", () => {
  it("recorte que estoura continua ficando na fila, com `ok` false", async () => {
    await limparFila(db);
    await pedir(db, "2024");
    await db.exec(
      `create or replace function public.carteira_efetividade_recalcular(p_recorte text default null)
       returns jsonb language plpgsql as $$ begin raise exception 'quebrou de proposito'; end $$;`);

    const r = await drenar(db);

    expect(r.ok).toBe(false);
    expect(r.erros.map((x) => x.recorte)).toEqual(["2024"]);
    expect(r.adiados).toEqual([]);
    expect((await invalidacoes(db)).map((x) => x.recorte)).toEqual(["2024"]);
  });
});

describe("o rollback devolve o corpo anterior", () => {
  it("depois do rollback, `adiados` desaparece e o descarte silencioso volta", async () => {
    await db.exec(ROLL(PEDIDO_ADIADO));
    await limparFila(db);
    await pedir(db, "2024");
    await comoLockTomado(db);

    const r = await drenar(db);

    expect(r.adiados).toBeUndefined();
    // O defeito de volta, por escrito: o recalculo nao aconteceu e o pedido
    // foi apagado de qualquer forma.
    expect(r.reconstruidos.map((x) => x.recorte)).toEqual(["2024"]);
    expect(await invalidacoes(db)).toEqual([]);
  });

  it("o comentário da função também volta ao texto anterior", async () => {
    await db.exec(ROLL(PEDIDO_ADIADO));
    const c = await q1(db, `select obj_description(p.oid, 'pg_proc') d
                              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public'
                               and p.proname = 'carteira_efetividade_recalcular_pendentes'`);
    expect(c.d).not.toContain("adiados");
    expect(c.d).toContain("Nunca e chamada pelo front.");
  });
});
