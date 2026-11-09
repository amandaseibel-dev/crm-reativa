// Leitura sob demanda: portão de identidade e permissão, mapeamento e paginação.
// PROVA SIMULADA: provedor fake. Não é leitura real da Mensageria.
import { describe, it, expect } from "vitest";
import { lerHistorico, mapearPagina, permitirLeitura, type ContextoLeitura, type ProvedorLeitura } from "./leitura.ts";

const OP = "cobranca10@aelbra.com.br";
const base = (over: Partial<ContextoLeitura> = {}): ContextoLeitura => ({
  operador: OP,
  identidade_confirmada: true,
  dono_carteira: OP,
  responsavel_atendimento: null,
  ...over,
});

class ProvedorFake implements ProvedorLeitura {
  chamadas: Array<{ id: string; antesDe: string | null }> = [];
  async lerConversa(id: string, antesDe: string | null) {
    this.chamadas.push({ id, antesDe });
    return {
      mensagens: [
        { quem: "operador", em: "2026-11-09T10:02:00Z", texto: "Olá", autor: null, anexos: [] },
        { quem: "cliente", em: "2026-11-09T10:01:00Z", texto: "Oi", autor: null, anexos: [{ nome: "boleto.pdf" }] },
        { quem: "bot", em: "2026-11-09T10:00:00Z", texto: "Bem-vindo", autor: null, anexos: [] },
        { quem: "estranho", em: "2026-11-09T09:59:00Z", texto: "x" },
      ],
      paginacao: { maisAntigas: true, antesDe: "2026-11-09T10:00:00Z" },
    };
  }
}

describe("portão de leitura", () => {
  it("identidade não confirmada: nega, mesmo para o dono", () => {
    expect(permitirLeitura(base({ identidade_confirmada: false }))).toEqual({ ok: false, motivo: "IDENTIDADE_NAO_CONFIRMADA" });
  });

  it("outro operador, sem ser dono nem responsável: nega", () => {
    expect(permitirLeitura(base({ dono_carteira: "outro@aelbra.com.br" }))).toEqual({ ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" });
  });

  it("responsável pelo atendimento lê mesmo fora da carteira", () => {
    expect(permitirLeitura(base({ dono_carteira: null, responsavel_atendimento: OP }))).toEqual({ ok: true });
  });

  it("negado NÃO chama a Mensageria", async () => {
    const f = new ProvedorFake();
    const r = await lerHistorico(base({ identidade_confirmada: false }), "c1", null, f);
    expect(r.ok).toBe(false);
    expect(f.chamadas).toEqual([]);
  });

  it("permitido chama a Mensageria com o cursor de paginação", async () => {
    const f = new ProvedorFake();
    const r = await lerHistorico(base(), "c1", "2026-11-09T11:00:00Z", f);
    expect(r.ok).toBe(true);
    expect(f.chamadas).toEqual([{ id: "c1", antesDe: "2026-11-09T11:00:00Z" }]);
  });
});

describe("mapeamento da página", () => {
  it("direção por autor: cliente entra, operador sai, bot é automático", async () => {
    const f = new ProvedorFake();
    const r = await lerHistorico(base(), "c1", null, f);
    if (!r.ok) throw new Error("esperado ok");
    const dirs = r.pagina.mensagens.map((m) => m.direcao);
    expect(dirs).toEqual(["AUTOMATICA", "ENTRADA", "SAIDA"]);
  });

  it("ordem cronológica, do mais antigo ao mais novo", async () => {
    const r = mapearPagina({
      mensagens: [
        { quem: "cliente", em: "2026-11-09T10:05:00Z", texto: "b" },
        { quem: "cliente", em: "2026-11-09T10:01:00Z", texto: "a" },
      ],
    });
    expect(r.mensagens.map((m) => m.texto)).toEqual(["a", "b"]);
  });

  it("item com quem desconhecido ou sem horário não aparece", () => {
    const r = mapearPagina({ mensagens: [{ quem: "estranho", em: "2026-11-09T10:00:00Z" }, { quem: "cliente" }] });
    expect(r.mensagens).toEqual([]);
  });

  it("anexos viram nomes; autor nulo continua nulo, sem inventar nome", () => {
    const r = mapearPagina({ mensagens: [{ quem: "operador", em: "2026-11-09T10:00:00Z", texto: "ok", autor: null, anexos: [{ nome: "x.pdf" }] }] });
    expect(r.mensagens[0].anexos).toEqual(["x.pdf"]);
    expect(r.mensagens[0].autor).toBeNull();
  });

  it("cursor de paginação só existe se há mais mensagens antigas", () => {
    expect(mapearPagina({ paginacao: { maisAntigas: true, antesDe: "t" } }).antes_de).toBe("t");
    expect(mapearPagina({ paginacao: { maisAntigas: false, antesDe: "t" } }).antes_de).toBeNull();
    expect(mapearPagina(null).mensagens).toEqual([]);
  });
});
