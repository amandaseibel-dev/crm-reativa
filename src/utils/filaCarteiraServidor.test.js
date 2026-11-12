import { describe, it, expect } from "vitest";
import { buscarFilaCarteira, montarConsultaFilaCarteira } from "./filaCarteiraServidor";

const DIA = 86400000;
const AGORA = Date.parse("2026-11-10T12:00:00Z");

// Builder falso que registra as chamadas, para provar o que vai ao servidor.
function fakeSupabase(resultado) {
  const chamadas = [];
  const builder = {
    select: (...a) => (chamadas.push(["select", ...a]), builder),
    eq: (...a) => (chamadas.push(["eq", ...a]), builder),
    not: (...a) => (chamadas.push(["not", ...a]), builder),
    lte: (...a) => (chamadas.push(["lte", ...a]), builder),
    order: (...a) => (chamadas.push(["order", ...a]), builder),
    range: (...a) => (chamadas.push(["range", ...a]), Promise.resolve(resultado)),
  };
  return { supabase: { from: (t) => (chamadas.push(["from", t]), builder) }, chamadas };
}
const linha = (id, dias) => ({ aluno_id: id, nome: `Aluno ${id}`, data_ultimo_acionamento: new Date(AGORA - dias * DIA).toISOString().slice(0, 10), operador_email: "cobranca10@aelbra.com.br" });

describe("consulta enviada ao servidor", () => {
  it("filtra pelo operador, corta em 8 dias, exige aluno e ordena no servidor", () => {
    const { supabase, chamadas } = fakeSupabase({ data: [], error: null });
    montarConsultaFilaCarteira(supabase, { operador: "cobranca10@aelbra.com.br", agoraMs: AGORA, de: 0, ate: 49 });
    expect(chamadas).toContainEqual(["from", "casos"]);
    expect(chamadas).toContainEqual(["eq", "operador_email", "cobranca10@aelbra.com.br"]);
    expect(chamadas).toContainEqual(["lte", "data_ultimo_acionamento", "2026-11-02"]);
    expect(chamadas).toContainEqual(["not", "aluno_id", "is", null]);
    expect(chamadas).toContainEqual(["range", 0, 49]);
  });
});

describe("linhas e paginação", () => {
  it("devolve só fora do prazo, com faixa, e avisa quando há próxima página", async () => {
    const { supabase } = fakeSupabase({ data: [linha("a", 12), linha("b", 9), linha("c", 8)], error: null });
    const r = await buscarFilaCarteira(supabase, { operador: "cobranca10@aelbra.com.br", agoraMs: AGORA, pagina: 0, tamanho: 2 });
    expect(r.linhas.map((x) => x.faixa)).toEqual(["PERDENDO", "CRITICO"]);
    expect(r.temMais).toBe(true);
  });
  it("caso sem vínculo ULBRA aparece (carteira interna não depende de vínculo)", async () => {
    const { supabase } = fakeSupabase({ data: [linha("sem-vinculo", 20)], error: null });
    const r = await buscarFilaCarteira(supabase, { operador: "cobranca10@aelbra.com.br", agoraMs: AGORA });
    expect(r.linhas[0].aluno_id).toBe("sem-vinculo");
    expect(r.linhas[0].origem).toBe("carteira");
  });
  it("erro do servidor vira erro explícito, não fila vazia", async () => {
    const { supabase } = fakeSupabase({ data: null, error: { message: "permission denied" } });
    const r = await buscarFilaCarteira(supabase, { operador: "x@y", agoraMs: AGORA });
    expect(r.erro).toMatch(/permission denied/);
    expect(r.linhas).toEqual([]);
  });
});

describe("casos sem operador não entram na fila do operador", () => {
  it("a consulta sempre exige operador_email igual ao usuário; casos sem operador ficam de fora", () => {
    const { supabase, chamadas } = fakeSupabase({ data: [], error: null });
    montarConsultaFilaCarteira(supabase, { operador: "cobranca10@aelbra.com.br", agoraMs: AGORA });
    const exigeOperador = chamadas.some((c) => c[0] === "eq" && c[1] === "operador_email" && c[2] === "cobranca10@aelbra.com.br");
    expect(exigeOperador).toBe(true);
  });
  it("se o servidor devolver caso sem operador (ou de outro), o cliente também não o inclui", async () => {
    const { supabase } = fakeSupabase({ data: [{ ...linha("x", 12), operador_email: null }], error: null });
    const r = await buscarFilaCarteira(supabase, { operador: "cobranca10@aelbra.com.br", agoraMs: AGORA });
    expect(r.linhas).toEqual([]);
  });
});

describe("gestão: todas as carteiras (todas: true)", () => {
  it("consulta casos com operador NÃO nulo, sem eq de operador, mesmo corte e ordem", () => {
    const { supabase, chamadas } = fakeSupabase({ data: [], error: null });
    montarConsultaFilaCarteira(supabase, { todas: true, agoraMs: AGORA });
    expect(chamadas).toContainEqual(["not", "operador_email", "is", null]);
    expect(chamadas.some((c) => c[0] === "eq" && c[1] === "operador_email")).toBe(false);
    expect(chamadas).toContainEqual(["lte", "data_ultimo_acionamento", "2026-11-02"]);
  });
  it("cada linha traz o operador da carteira e não é 'minha'; caso sem operador continua fora", async () => {
    const { supabase } = fakeSupabase({ data: [
      linha("a", 12), { ...linha("b", 9), operador_email: "cobranca05@aelbra.com.br" }, { ...linha("x", 15), operador_email: null },
    ], error: null });
    const r = await buscarFilaCarteira(supabase, { todas: true, agoraMs: AGORA });
    expect(r.linhas.map((l) => [l.aluno_id, l.responsavel_reativa, l.minha])).toEqual([
      ["a", "cobranca10@aelbra.com.br", false],
      ["b", "cobranca05@aelbra.com.br", false],
    ]);
  });
  it("sem `todas` e sem operador, não consulta: devolve erro explícito", async () => {
    const { supabase, chamadas } = fakeSupabase({ data: [linha("a", 12)], error: null });
    const r = await buscarFilaCarteira(supabase, { operador: "", agoraMs: AGORA });
    expect(r.erro).toMatch(/operador/);
    expect(chamadas).toEqual([]);
  });
});
