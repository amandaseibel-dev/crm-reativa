// Caminho real da decisão de histórico (mesma função usada pelo handler), com dependências simuladas.
import { describe, it, expect, vi } from "vitest";
import { capacidadeHistorico, lerHistoricoAutorizado, type DepsHistorico } from "./historico-leitura.ts";

const CONV = "a".repeat(24);
const CLIENTE = "cli-1";
const ALUNO = "aluno-1";

interface Cenario {
  email?: string;
  usuarioAtivo?: boolean;
  flagLigada?: boolean;
  temConversa?: boolean;
  vinculoCpf?: boolean;
  donos?: string[];
  responsaveis?: string[];
  pessoaConexao?: string | null;
  conexaoOk?: boolean;
  auditoriaOk?: boolean;
  leituraErro?: boolean;
}

function monta(c: Cenario = {}) {
  const lerConversa = vi.fn(async () => ({ dados: { mensagens: [{ quem: "cliente", em: "2026-11-16T10:00:00Z", texto: "oi" }], paginacao: { maisAntigas: false } } }));
  const auditar = vi.fn(async () => c.auditoriaOk ?? true);
  const deps: DepsHistorico = {
    email: c.email ?? "operador@aelbra.com.br",
    usuarioAtivo: c.usuarioAtivo ?? true,
    flagLigada: c.flagLigada ?? true,
    conversaId: CONV,
    antesDe: null,
    buscarClienteDaConversa: async () => ((c.temConversa ?? true) ? CLIENTE : null),
    alunoDoCliente: async () => ((c.vinculoCpf ?? true) ? ALUNO : null),
    donosDoAluno: async () => c.donos ?? [],
    responsaveisDoCliente: async () => c.responsaveis ?? [],
    conexao: async () =>
      (c.conexaoOk ?? true)
        ? { ok: true as const, access_token: "tok-individual", pessoa_email: c.pessoaConexao === undefined ? (c.email ?? "operador@aelbra.com.br") : c.pessoaConexao }
        : { ok: false as const, motivo: "SEM_CONEXAO" },
    lerConversa: lerConversa as unknown as DepsHistorico["lerConversa"],
    reservarCota: async () => "OK" as const,
    auditar,
  };
  return { deps, lerConversa, auditar };
}

describe("histórico: caminho real da decisão (handler)", () => {
  it("amanda.seibel (leitura global) lê, com conexão individual e auditoria antes do texto", async () => {
    const { deps, lerConversa, auditar } = monta({ email: "amanda.seibel@aelbra.com.br", donos: ["outro@aelbra.com.br"] });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(lerConversa).toHaveBeenCalledWith("tok-individual", expect.objectContaining({ id: CONV }));
    expect(auditar).toHaveBeenCalledWith(expect.objectContaining({ acao: "ULBRA_HISTORICO_LEITURA", conversa_id: CONV }));
  });

  it("cobranca04 (Fernanda) lê globalmente", async () => {
    const { deps } = monta({ email: "cobranca04@aelbra.com.br", donos: ["outro@aelbra.com.br"] });
    expect((await lerHistoricoAutorizado(deps)).status).toBe(200);
  });

  it("cobranca07 (Amanda ADM) NÃO lê fora da carteira; sem chamada à Mensageria", async () => {
    const { deps, lerConversa } = monta({ email: "cobranca07@aelbra.com.br", donos: ["outro@aelbra.com.br"] });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(lerConversa).not.toHaveBeenCalled();
  });

  it("cobranca07 lê a própria carteira", async () => {
    const { deps } = monta({ email: "cobranca07@aelbra.com.br", donos: ["cobranca07@aelbra.com.br"] });
    expect((await lerHistoricoAutorizado(deps)).status).toBe(200);
  });

  it("operador lê só a própria carteira/responsabilidade", async () => {
    const fora = monta({ donos: ["outro@aelbra.com.br"] });
    expect((await lerHistoricoAutorizado(fora.deps)).status).toBe(403);
    expect(fora.lerConversa).not.toHaveBeenCalled();
    const resp = monta({ responsaveis: ["operador@aelbra.com.br"] });
    expect((await lerHistoricoAutorizado(resp.deps)).status).toBe(200);
  });

  it("usuário inativo é recusado antes de qualquer leitura", async () => {
    const { deps, lerConversa } = monta({ email: "amanda.seibel@aelbra.com.br", usuarioAtivo: false });
    expect((await lerHistoricoAutorizado(deps)).status).toBe(403);
    expect(lerConversa).not.toHaveBeenCalled();
  });

  it("identidade divergente (conta conectada não é a do JWT) é recusada, sem ler", async () => {
    const { deps, lerConversa } = monta({ donos: ["operador@aelbra.com.br"], pessoaConexao: "outra.pessoa@aelbra.com.br" });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("IDENTIDADE_DIVERGENTE");
    expect(lerConversa).not.toHaveBeenCalled();
  });

  it("sem vínculo confirmado por CPF, recusa", async () => {
    const { deps, lerConversa } = monta({ vinculoCpf: false, donos: ["operador@aelbra.com.br"] });
    expect((await lerHistoricoAutorizado(deps)).status).toBe(403);
    expect(lerConversa).not.toHaveBeenCalled();
  });

  it("flag do backend desligada: recusa sem tocar em nada", async () => {
    const { deps, lerConversa, auditar } = monta({ flagLigada: false, donos: ["operador@aelbra.com.br"] });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.corpo.motivo).toBe("HISTORICO_DESLIGADO");
    expect(lerConversa).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("auditoria NÃO gravada: o texto não é devolvido", async () => {
    const { deps } = monta({ email: "amanda.seibel@aelbra.com.br", auditoriaOk: false });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(500);
    expect(r.corpo.motivo).toBe("AUDITORIA_NAO_GRAVADA");
    expect(r.corpo.pagina).toBeUndefined();
  });

  it("falha da Mensageria: 502, sem texto", async () => {
    const { deps } = monta({ email: "amanda.seibel@aelbra.com.br" });
    deps.lerConversa = async () => ({ erro: true });
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(502);
    expect(r.corpo.pagina).toBeUndefined();
  });
});

describe("histórico: capacidade calculada no servidor (sem ler a Mensageria)", () => {
  it("mostra o que a leitura permitiria, sem chamar a Mensageria", async () => {
    const { deps, lerConversa } = monta({ email: "amanda.seibel@aelbra.com.br", donos: [] });
    expect(await capacidadeHistorico(deps)).toEqual({ pode: true, motivo: null });
    expect(lerConversa).not.toHaveBeenCalled();
  });
  it("negativa para operador fora da carteira", async () => {
    const { deps } = monta({ donos: ["outro@aelbra.com.br"] });
    expect((await capacidadeHistorico(deps)).pode).toBe(false);
  });
  it("negativa com a flag desligada, mesmo para gestão", async () => {
    const { deps } = monta({ email: "amanda.seibel@aelbra.com.br", flagLigada: false });
    expect(await capacidadeHistorico(deps)).toEqual({ pode: false, motivo: "HISTORICO_DESLIGADO" });
  });
});
