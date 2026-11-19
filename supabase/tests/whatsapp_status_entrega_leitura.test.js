// CENTRAL WHATSAPP: STATUS DE ENTREGA E DE LEITURA -- COMPORTAMENTO.
//
// Roda num PostgreSQL real (PGlite). A bancada é mínima de propósito: a função
// nova toca UMA tabela e três colunas dela (wamid, direcao, status), então é
// só isso que existe aqui. A migration aplicada é o arquivo de verdade.
//
// O QUE ESTE TESTE PROVA
//   * o status só avança: ENVIADO -> ENTREGUE -> LIDO, e nunca regride;
//   * recibo repetido não escreve nada (devolve false);
//   * FALHOU não é sobrescrito;
//   * mensagem de ENTRADA não ganha tracinho;
//   * wamid desconhecido devolve false, sem erro;
//   * entrada inválida é erro;
//   * ACL: anon e authenticated NÃO executam; service_role executa.
//
// NENHUM DADO REAL: tudo inventado.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(AQUI, "../migrations/20261119120000_whatsapp_status_entrega_leitura.sql"),
  "utf8",
);

let db;
const statusDe = async (wamid) =>
  (await db.query("select status from public.whatsapp_mensagens where wamid = $1", [wamid])).rows[0]?.status;
const atualizar = async (wamid, status) =>
  (await db.query("select public.whatsapp_mensagem_atualizar_status($1, $2) as ok", [wamid, status])).rows[0].ok;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.whatsapp_mensagens (
      id      serial primary key,
      wamid   text unique,
      direcao text not null,
      status  text
    );
    insert into public.whatsapp_mensagens (wamid, direcao, status) values
      ('SAIDA-1',  'SAIDA',   'ENVIADO'),
      ('SAIDA-2',  'SAIDA',   'ENVIADO'),
      ('SAIDA-NULA','SAIDA',  null),
      ('FALHOU-1', 'SAIDA',   'FALHOU'),
      ('ENTRADA-1','ENTRADA', null);
  `);
  await db.exec(MIGRATION);
});

describe("whatsapp_mensagem_atualizar_status", () => {
  it("avança ENVIADO -> ENTREGUE -> LIDO", async () => {
    expect(await atualizar("SAIDA-1", "ENTREGUE")).toBe(true);
    expect(await statusDe("SAIDA-1")).toBe("ENTREGUE");
    expect(await atualizar("SAIDA-1", "LIDO")).toBe(true);
    expect(await statusDe("SAIDA-1")).toBe("LIDO");
  });

  it("não regride: ENTREGUE atrasado não apaga LIDO", async () => {
    expect(await atualizar("SAIDA-1", "ENTREGUE")).toBe(false);
    expect(await statusDe("SAIDA-1")).toBe("LIDO");
  });

  it("recibo repetido não escreve", async () => {
    expect(await atualizar("SAIDA-1", "LIDO")).toBe(false);
  });

  it("LIDO direto, sem passar por ENTREGUE, é aceito", async () => {
    expect(await atualizar("SAIDA-2", "LIDO")).toBe(true);
    expect(await statusDe("SAIDA-2")).toBe("LIDO");
  });

  it("mensagem de saída sem status também recebe o recibo", async () => {
    expect(await atualizar("SAIDA-NULA", "ENTREGUE")).toBe(true);
    expect(await statusDe("SAIDA-NULA")).toBe("ENTREGUE");
  });

  it("FALHOU não é sobrescrito", async () => {
    expect(await atualizar("FALHOU-1", "ENTREGUE")).toBe(false);
    expect(await atualizar("FALHOU-1", "LIDO")).toBe(false);
    expect(await statusDe("FALHOU-1")).toBe("FALHOU");
  });

  it("mensagem de ENTRADA não ganha tracinho", async () => {
    expect(await atualizar("ENTRADA-1", "LIDO")).toBe(false);
    expect(await statusDe("ENTRADA-1")).toBeNull();
  });

  it("wamid desconhecido devolve false, sem erro", async () => {
    expect(await atualizar("NAO-EXISTE", "ENTREGUE")).toBe(false);
  });

  it("entrada inválida é erro", async () => {
    await expect(atualizar("SAIDA-1", "ENVIADO")).rejects.toThrow(/status invalido/);
    await expect(atualizar("SAIDA-1", "FALHOU")).rejects.toThrow(/status invalido/);
    await expect(atualizar("SAIDA-1", null)).rejects.toThrow(/status invalido/);
    await expect(atualizar("  ", "LIDO")).rejects.toThrow(/wamid obrigatorio/);
  });

  it("ACL: anon e authenticated não executam; service_role executa", async () => {
    const pode = async (papel) =>
      (await db.query(
        "select has_function_privilege($1, 'public.whatsapp_mensagem_atualizar_status(text,text)', 'execute') as p",
        [papel],
      )).rows[0].p;
    expect(await pode("anon")).toBe(false);
    expect(await pode("authenticated")).toBe(false);
    expect(await pode("service_role")).toBe(true);
  });

  it("é SECURITY DEFINER com search_path fixo", async () => {
    const { rows } = await db.query(`
      select prosecdef, proconfig from pg_proc
       where oid = 'public.whatsapp_mensagem_atualizar_status(text,text)'::regprocedure`);
    expect(rows[0].prosecdef).toBe(true);
    expect(String(rows[0].proconfig)).toMatch(/search_path=public/);
  });
});
