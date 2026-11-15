import { describe, it, expect, vi } from "vitest";
import { executarExportacao, baixarNovamente, bloqueiaNovaExportacao, mensagemDaFase, FASE } from "./exportacaoFluxo.js";

// Dados ficticios. Nenhum acesso a producao: a RPC e uma funcao simulada.
const CONTATOS = [{ nome: "Aluno Fictício 1", telefone: "5100000001", email: "a1@teste.local" }];
const montarRel = (contatos) => ({ nomeArquivo: "teste.xlsx", linhas: contatos.map((c) => ({ "Nome do aluno": c.nome })) });
const ARGS = { p_aluno_ids: ["x"], p_canal: "WHATSAPP" };

describe("cenario 1: sucesso", () => {
  it("RPC uma vez, arquivo gerado, fase concluida", async () => {
    const chamarRpc = vi.fn(async () => ({ data: { contatos: CONTATOS, lote_id: "L1" }, error: null }));
    const gerarArquivo = vi.fn();
    const r = await executarExportacao({ args: ARGS, chamarRpc, montarRel, gerarArquivo });
    expect(r.fase).toBe(FASE.CONCLUIDA);
    expect(chamarRpc).toHaveBeenCalledTimes(1);
    expect(gerarArquivo).toHaveBeenCalledTimes(1);
    expect(bloqueiaNovaExportacao(r.fase)).toBe(false);
  });
});

describe("cenario 2: falha do arquivo apos RPC concluida", () => {
  it("lote registrado, arquivo nao baixado: fase arquivo_falhou, resultado guardado", async () => {
    const chamarRpc = vi.fn(async () => ({ data: { contatos: CONTATOS, lote_id: "L2" }, error: null }));
    const gerarArquivo = vi.fn(() => { throw new Error("download bloqueado"); });
    const r = await executarExportacao({ args: ARGS, chamarRpc, montarRel, gerarArquivo });
    expect(r.fase).toBe(FASE.ARQUIVO_FALHOU);
    expect(r.rel).not.toBeNull(); // guardado para baixar de novo
    expect(r.exp.lote_id).toBe("L2");
    expect(bloqueiaNovaExportacao(r.fase)).toBe(false); // pode baixar, nao e incerta
    expect(mensagemDaFase(r.fase)).toMatch(/Lote registrado, arquivo não baixado/);
  });
});

describe("cenario 3: baixar planilha novamente sem repetir a RPC", () => {
  it("usa o resultado guardado; RPC continua chamada apenas uma vez", async () => {
    const chamarRpc = vi.fn(async () => ({ data: { contatos: CONTATOS, lote_id: "L3" }, error: null }));
    let falhas = 1;
    const gerarArquivo = vi.fn(() => { if (falhas-- > 0) throw new Error("falha"); });
    const r1 = await executarExportacao({ args: ARGS, chamarRpc, montarRel, gerarArquivo });
    expect(r1.fase).toBe(FASE.ARQUIVO_FALHOU);
    const r2 = baixarNovamente(r1, gerarArquivo);
    expect(r2.fase).toBe(FASE.CONCLUIDA);
    expect(chamarRpc).toHaveBeenCalledTimes(1); // nenhuma nova exportacao
    expect(gerarArquivo).toHaveBeenCalledTimes(2);
  });
});

describe("cenario 4: perda da resposta da RPC", () => {
  it("resultado desconhecido: fase incerta, bloqueia nova exportacao, nao repete sozinho", async () => {
    const chamarRpc = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const gerarArquivo = vi.fn();
    const r = await executarExportacao({ args: ARGS, chamarRpc, montarRel, gerarArquivo });
    expect(r.fase).toBe(FASE.INCERTA);
    expect(bloqueiaNovaExportacao(r.fase)).toBe(true);
    expect(chamarRpc).toHaveBeenCalledTimes(1); // sem retry automatico
    expect(gerarArquivo).not.toHaveBeenCalled();
    expect(mensagemDaFase(r.fase)).toMatch(/Resultado do registro desconhecido/);
  });

  it("validacao recusada NAO e incerta: pode tentar apos corrigir", async () => {
    const chamarRpc = vi.fn(async () => ({ data: null, error: { code: "22023", message: "x" } }));
    const r = await executarExportacao({ args: ARGS, chamarRpc, montarRel, gerarArquivo: vi.fn() });
    expect(r.fase).toBe(FASE.RECUSADA);
    expect(bloqueiaNovaExportacao(r.fase)).toBe(false);
  });
});

describe("protecao nao vaza dados pessoais nas mensagens", () => {
  it("mensagens das fases nao contem nome, telefone ou e-mail", () => {
    for (const f of Object.values(FASE)) {
      expect(mensagemDaFase(f)).not.toMatch(/Fictício|@|5100000001/);
    }
  });
});
