import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carregarIdsEmConfirmacao,
  alunoEmConfirmacao,
  separarPorConfirmacao,
  MENSAGEM_ERRO_PROTECAO_CONFIRMACAO,
} from "./filaConfirmacao";

const clienteCom = (resposta) => ({ rpc: vi.fn().mockResolvedValue(resposta) });

describe("carregarIdsEmConfirmacao (fonte unica: RPC alunos_em_confirmacao_pendente)", () => {
  it("chama o RPC certo e monta o conjunto (lista de textos)", async () => {
    const c = clienteCom({ data: ["a1", "a2", "a2"], error: null });
    const r = await carregarIdsEmConfirmacao(c);
    expect(c.rpc).toHaveBeenCalledWith("alunos_em_confirmacao_pendente");
    expect(r.ok).toBe(true);
    expect([...r.ids].sort()).toEqual(["a1", "a2"]);
  });

  it("aceita tambem linhas-objeto do PostgREST", async () => {
    const r = await carregarIdsEmConfirmacao(clienteCom({ data: [{ alunos_em_confirmacao_pendente: "x9" }], error: null }));
    expect(r.ok).toBe(true);
    expect(r.ids.has("x9")).toBe(true);
  });

  it("FAIL-CLOSED: erro do RPC -> ok:false, sem conjunto", async () => {
    const r = await carregarIdsEmConfirmacao(clienteCom({ data: null, error: { message: "boom" } }));
    expect(r).toEqual({ ok: false, ids: null, erro: "boom" });
  });

  it("FAIL-CLOSED: resposta que nao e lista -> ok:false", async () => {
    expect((await carregarIdsEmConfirmacao(clienteCom({ data: null, error: null }))).ok).toBe(false);
    expect((await carregarIdsEmConfirmacao(clienteCom({ data: { a: 1 }, error: null }))).ok).toBe(false);
  });

  it("FAIL-CLOSED: excecao/rede -> ok:false", async () => {
    const r = await carregarIdsEmConfirmacao({ rpc: () => Promise.reject(new Error("rede")) });
    expect(r.ok).toBe(false);
    expect(r.erro).toBe("rede");
  });
});

describe("separarPorConfirmacao (classificacao, nao so visual)", () => {
  const alunos = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];

  it("quem tem confirmacao aberta vai para protegidos e sai dos acionaveis", () => {
    const { acionaveis, protegidos } = separarPorConfirmacao(alunos, new Set(["a2"]));
    expect(acionaveis.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(protegidos.map((a) => a.id)).toEqual(["a2"]);
  });

  it("todos os alunos com confirmacao aberta (ex.: os 140 de producao) -> 0 acionaveis", () => {
    const todos = Array.from({ length: 140 }, (_, i) => ({ id: `id-${i}` }));
    const ids = new Set(todos.map((a) => a.id));
    const { acionaveis, protegidos } = separarPorConfirmacao(todos, ids);
    expect(acionaveis).toHaveLength(0);
    expect(protegidos).toHaveLength(140);
  });

  it("sem ninguem em confirmacao a fila fica exatamente como era", () => {
    const { acionaveis, protegidos } = separarPorConfirmacao(alunos, new Set());
    expect(acionaveis).toEqual(alunos);
    expect(protegidos).toEqual([]);
  });

  it("id numerico ou uuid vs texto: compara como texto", () => {
    expect(alunoEmConfirmacao({ id: 7 }, new Set(["7"]))).toBe(true);
    expect(alunoEmConfirmacao({ id: "u" }, null)).toBe(false);
  });
});

describe("FilaOperacional.jsx usa a protecao e nao tem fallback sem ela", () => {
  const fonte = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../pages/FilaOperacional.jsx"), "utf8");
  const trecho = fonte.slice(fonte.indexOf("async function carregarFila()"), fonte.indexOf("async function abrirAlunoNaFila"));

  it("consulta a fonte unica e separa antes de montar a lista", () => {
    expect(trecho).toContain("carregarIdsEmConfirmacao(supabase)");
    expect(trecho).toContain("separarPorConfirmacao(dados, protecao.ids)");
    expect(trecho.indexOf("carregarIdsEmConfirmacao")).toBeLessThan(trecho.indexOf("setAlunos([...urgentes"));
  });

  it("FAIL-CLOSED: sem a lista, mostra erro claro, zera a fila e RETORNA antes de listar", () => {
    const i = trecho.indexOf("if (!protecao.ok)");
    expect(i).toBeGreaterThan(-1);
    const bloco = trecho.slice(i, trecho.indexOf("setIdsEmConfirmacao(protecao.ids)"));
    expect(bloco).toContain("setErro(MENSAGEM_ERRO_PROTECAO_CONFIRMACAO)");
    expect(bloco).toContain("setAlunos([])");
    expect(bloco).toContain("return;");
    expect(MENSAGEM_ERRO_PROTECAO_CONFIRMACAO).toMatch(/fila não foi carregada/);
  });

  it("os protegidos nunca entram em emCobranca (vao para o grupo fora da cobranca)", () => {
    expect(trecho).toMatch(/const emCobranca = acionaveis\.filter/);
    expect(trecho).toMatch(/\.\.\.protegidos,/);
  });

  it("nao ha regra financeira duplicada no front (sem consulta direta a solicitacoes)", () => {
    expect(trecho).not.toContain("solicitacoes_confirmacao_pagamento");
  });
});
