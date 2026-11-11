// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../services/supabase", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "tok-op" } } }) } },
}));
vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");

import {
  MOTIVOS_HISTORICO, ROTULO_CONEXAO, conexaoIniciar, conexaoPermiteEnvio, envioConfirmar, envioPrevia, lerHistorico,
  mapearHistorico, resumirPrevia,
} from "./ulbraConversaCliente";

const fetchMock = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

function respondeCom(json, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status < 300, status, json: async () => json });
}

describe("chamadas às funções (JWT do usuário, nunca credencial central)", () => {
  it("histórico: função ulbra-historico com conversa_id e antes_de e o Bearer da sessão", async () => {
    respondeCom({ ok: true, origem: "ulbra", chamadas: 1, pagina: { mensagens: [], antes_de: null } });
    const r = await lerHistorico("a".repeat(24), "cursor-1");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:54321/functions/v1/ulbra-historico");
    expect(init.headers.Authorization).toBe("Bearer tok-op");
    expect(JSON.parse(init.body)).toEqual({ conversa_id: "a".repeat(24), antes_de: "cursor-1" });
  });
  it("conexão e envio vão à ulbra-conversa com a ação certa; a confirmação leva chave e prévia", async () => {
    respondeCom({ ok: true, url: "https://crm.ulbra.ai/api/oauth/auth?x=1" });
    expect((await conexaoIniciar()).url).toMatch(/oauth\/auth/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ acao: "conexao_iniciar" });
    respondeCom({ ok: true, previa: { custoEstimado: 0.0123, janelaAberta: true } });
    await envioPrevia("b".repeat(24), "oi");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ acao: "envio_previa", conversa_id: "b".repeat(24), texto: "oi" });
    respondeCom({ ok: true, situacao: "PROCESSADO", envio: { status: "ENVIADO" } });
    await envioConfirmar("b".repeat(24), "oi", "chave-12345678", { custo_usd: 0.0123, janela_aberta: true, em: "2026-11-11T15:00:00Z" });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ acao: "envio_confirmar", conversa_id: "b".repeat(24), texto: "oi", chave: "chave-12345678", previa_custo_usd: 0.0123, previa_janela_aberta: true, previa_em: "2026-11-11T15:00:00Z" });
  });
  it("sem sessão não chama nada; resposta não-JSON vira motivo com o HTTP", async () => {
    const { supabase } = await import("../services/supabase");
    supabase.auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    expect(await lerHistorico("a".repeat(24))).toEqual({ ok: false, motivo: "SEM_SESSAO", http: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new Error("x"); } });
    expect((await lerHistorico("a".repeat(24))).motivo).toBe("HTTP_503");
  });
});

describe("mapeamento do histórico", () => {
  it("ok com cursor = parcial; sem cursor = ok; vazio; páginas anteriores entram ANTES das já mostradas", () => {
    const p1 = mapearHistorico({ ok: true, origem: "ulbra", pagina: { mensagens: [{ em: "2026-11-10T10:00:00Z", direcao: "ENTRADA", texto: "b" }], antes_de: "c1" } });
    expect(p1.estado).toBe("parcial");
    expect(p1.antesDe).toBe("c1");
    const p2 = mapearHistorico({ ok: true, origem: "cache", pagina: { mensagens: [{ em: "2026-11-09T10:00:00Z", direcao: "SAIDA", texto: "a" }], antes_de: null } }, p1);
    expect(p2.estado).toBe("ok");
    expect(p2.mensagens.map((m) => m.texto)).toEqual(["a", "b"]);
    expect(mapearHistorico({ ok: true, pagina: { mensagens: [], antes_de: null } }).estado).toBe("vazio");
  });
  it("bloqueio vira erro legível e não inventa mensagens", () => {
    const e = mapearHistorico({ ok: false, motivo: "LIMITE_OPERADOR_DIA" });
    expect(e.estado).toBe("erro");
    expect(e.erro).toBe(MOTIVOS_HISTORICO.LIMITE_OPERADOR_DIA);
    expect(e.mensagens).toEqual([]);
  });
});

describe("conexão e prévia", () => {
  it("só ATIVA e EXPIRANDO permitem envio; rótulos existem para todos os estados", () => {
    expect(conexaoPermiteEnvio("ATIVA")).toBe(true);
    expect(conexaoPermiteEnvio("EXPIRANDO")).toBe(true);
    for (const e of ["SEM_CONEXAO", "EXPIRADA", "REVOGADA", undefined]) expect(conexaoPermiteEnvio(e)).toBe(false);
    for (const e of ["SEM_CONEXAO", "ATIVA", "EXPIRANDO", "EXPIRADA", "REVOGADA"]) expect(ROTULO_CONEXAO[e]).toBeTruthy();
  });
  it("prévia resume custo e janela sem inventar; recusa da Mensageria vira ok=false com o motivo", () => {
    const ok = resumirPrevia({ ok: true, previa: { custoEstimado: 0.05, janelaAberta: true, texto: "oi" } });
    expect(ok).toMatchObject({ ok: true, custo_usd: 0.05, janela_aberta: true, texto: "oi" });
    const semCusto = resumirPrevia({ ok: true, previa: {}, contexto: { janela_aberta: false } });
    expect(semCusto.custo_usd).toBeNull();
    expect(semCusto.janela_aberta).toBe(false);
    const recusa = resumirPrevia({ ok: false, recusa: "janela de 24h fechada" });
    expect(recusa).toMatchObject({ ok: false, recusa: "janela de 24h fechada" });
    const bloqueio = resumirPrevia({ ok: false, situacao: "BLOQUEADO", motivos: ["SEM_CONEXAO_INDIVIDUAL"] });
    expect(bloqueio.recusa).toBe("SEM_CONEXAO_INDIVIDUAL");
  });
});
