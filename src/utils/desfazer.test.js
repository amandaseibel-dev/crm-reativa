import { describe, it, expect, vi, beforeEach } from "vitest";

// O supabase real abre sessão e rede: aqui só interessa PARA ONDE a chamada vai
// (Edge no termo, RPC no resto) e o que volta para a tela.
const rpc = vi.fn();
const invoke = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpc(...a), functions: { invoke: (...a) => invoke(...a) } },
}));

const { desfazerAcao, listarDesfazer, explicarBloqueio } = await import("./desfazer");

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
});

describe("explicarBloqueio", () => {
  it("traduz o código do banco em instrução para o operador", () => {
    expect(explicarBloqueio("link_ja_em_atendimento")).toMatch(/ADM já assumiu/);
    expect(explicarBloqueio("houve_acao_depois")).toMatch(/outro atendimento depois/);
  });

  it("não vaza código cru quando o motivo é desconhecido", () => {
    expect(explicarBloqueio("motivo_que_nao_existe")).toBe("Não é mais possível desfazer esta ação.");
  });

  it("sem bloqueio não inventa frase", () => {
    expect(explicarBloqueio(null)).toBe("");
  });
});

describe("desfazerAcao — por onde cada tipo passa", () => {
  it("termo vai pela Edge, que é quem pode apagar o anexo do Storage", async () => {
    invoke.mockResolvedValue({ data: { ok: true, status_restaurado: "EM_NEGOCIACAO", pendentes_no_storage: 0 }, error: null });

    const res = await desfazerAcao({ id: "abc", tipo: "TERMO_ENVIADO" });

    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("documento-financeiro-url", {
      body: { acao: "desfazer_acao", id: "abc", motivo: null },
    });
    expect(res).toEqual({ ok: true, statusRestaurado: "EM_NEGOCIACAO", anexosPendentes: 0 });
  });

  it("link e tabulação vão direto na RPC — não tocam em arquivo", async () => {
    rpc.mockResolvedValue({ data: { ok: true, status_restaurado: "CONTATAR" }, error: null });

    await desfazerAcao({ id: "xyz", tipo: "LINK_SOLICITADO" }, "pedi no aluno errado");

    expect(invoke).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("desfazer_acao", { p_id: "xyz", p_motivo: "pedi no aluno errado" });
  });

  it("anexo que não saiu do Storage é reportado, não escondido", async () => {
    invoke.mockResolvedValue({ data: { ok: true, status_restaurado: null, pendentes_no_storage: 2 }, error: null });

    const res = await desfazerAcao({ id: "abc", tipo: "TERMO_ENVIADO" });

    expect(res.ok).toBe(true);
    expect(res.anexosPendentes).toBe(2);
  });

  it("recusa do banco vira frase, não código", async () => {
    rpc.mockResolvedValue({ data: { ok: false, erro: "link_ja_em_atendimento" }, error: null });

    const res = await desfazerAcao({ id: "xyz", tipo: "LINK_SOLICITADO" });

    expect(res.ok).toBe(false);
    expect(res.erro).toMatch(/ADM já assumiu/);
  });

  it("recusa da Edge preserva o motivo real que veio no corpo", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { context: { json: async () => ({ error: "termo_ja_tratado" }) } },
    });

    const res = await desfazerAcao({ id: "abc", tipo: "TERMO_ENVIADO" });

    expect(res.ok).toBe(false);
    expect(res.erro).toMatch(/ADM já tratou/);
  });

  it("ação sem id não chega a bater no banco", async () => {
    const res = await desfazerAcao({ tipo: "TABULACAO" });
    expect(res).toEqual({ ok: false, erro: "Ação inválida." });
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("listarDesfazer", () => {
  it("erro de rede devolve lista vazia em vez de quebrar a ficha", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } });

    const res = await listarDesfazer("aluno-1");

    expect(res.ok).toBe(false);
    expect(res.itens).toEqual([]);
  });

  it("sem aluno pede as ações do próprio operador", async () => {
    rpc.mockResolvedValue({ data: { ok: true, itens: [] }, error: null });

    await listarDesfazer();

    expect(rpc).toHaveBeenCalledWith("desfazer_listar", { p_aluno_id: null, p_limite: 10 });
  });
});
