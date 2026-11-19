// Caminhos do HANDLER de histórico (executarAcaoHistorico) com transporte externo simulado.
// Cobre: flag desligada; usuário fora do piloto; João sem conexão; João com conexão e responsabilidade;
// falha de autorização e falha de auditoria. Prova: caminhos negados não chamam a Mensageria,
// e a leitura usa só o token individual devolvido por conexao() (nunca credencial central).
import { describe, it, expect, vi } from "vitest";
import { executarAcaoHistorico, type AdaptadoresHistorico } from "./historico-acao.ts";

const CONV = "a".repeat(24);
const JOAO = "cobranca10@aelbra.com.br";
const TOKEN_INDIVIDUAL = "tok-individual-do-operador";
const CENTRAL = "tok-central-NAO-PODE-SER-USADO";

interface Cen {
  email?: string;
  habilitadoEnv?: boolean;
  listaPiloto?: string | null;
  temConexao?: boolean;
  responsavel?: boolean;
  auditoriaOk?: boolean;
  transporteFalha?: boolean;
}

function monta(c: Cen = {}) {
  const email = c.email ?? JOAO;
  const transporte = vi.fn(async (_tok: string, _args: Record<string, unknown>) => {
    if (c.transporteFalha) throw new Error("ULBRA_HTTP_503");
    return { dados: { mensagens: [{ quem: "cliente", em: "2026-11-16T10:00:00Z", texto: "pode me ligar?" }], paginacao: { maisAntigas: false } } };
  });
  const auditar = vi.fn(async (_d: Record<string, unknown>) => c.auditoriaOk ?? true);
  const a: AdaptadoresHistorico = {
    email,
    usuarioAtivo: true,
    habilitadoEnv: c.habilitadoEnv ?? true,
    listaPilotoEnv: c.listaPiloto === undefined ? JOAO : c.listaPiloto,
    buscarClienteDaConversa: async () => "cli-1",
    alunoDoCliente: async () => "aluno-1",
    donosDoAluno: async () => (c.responsavel ? [email] : []),
    responsaveisDoCliente: async () => (c.responsavel ? [email] : []),
    conexao: async () =>
      (c.temConexao ?? true)
        ? { ok: true as const, access_token: TOKEN_INDIVIDUAL, pessoa_email: email }
        : { ok: false as const, motivo: "SEM_CONEXAO" },
    lerConversa: transporte as unknown as AdaptadoresHistorico["lerConversa"],
    reservarCota: async () => "OK" as const,
    auditar,
  };
  return { a, transporte, auditar };
}

const corpoLer = { conversa_id: CONV };

describe("histórico — flag desligada", () => {
  it("historico_ler: 403 HISTORICO_DESLIGADO e nenhuma chamada à Mensageria", async () => {
    const { a, transporte, auditar } = monta({ habilitadoEnv: false });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(403);
    expect(r.corpo).toEqual({ ok: false, motivo: "HISTORICO_DESLIGADO" });
    expect(transporte).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("historico_capacidade: pode=false, sem chamada à Mensageria", async () => {
    const { a, transporte } = monta({ habilitadoEnv: false });
    const r = await executarAcaoHistorico("historico_capacidade", corpoLer, a);
    expect(r.corpo).toMatchObject({ ok: true, pode: false, motivo: "HISTORICO_DESLIGADO" });
    expect(transporte).not.toHaveBeenCalled();
  });
});

describe("histórico — piloto", () => {
  it("flag ligada e usuário FORA da lista do piloto: negado sem chamada à Mensageria", async () => {
    const { a, transporte, auditar } = monta({ email: "cobranca07@aelbra.com.br", responsavel: true });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("HISTORICO_DESLIGADO");
    expect(transporte).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("lista do piloto vazia: ninguém lê (fail-closed)", async () => {
    const { a, transporte } = monta({ listaPiloto: "", responsavel: true });
    expect((await executarAcaoHistorico("historico_ler", corpoLer, a)).status).toBe(403);
    expect(transporte).not.toHaveBeenCalled();
  });

  it("João no piloto SEM conexão individual ativa: 403 SEM_CONEXAO, sem chamada à Mensageria e sem fallback", async () => {
    const { a, transporte, auditar } = monta({ temConexao: false, responsavel: true });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(403);
    expect(r.corpo).toEqual({ ok: false, motivo: "SEM_CONEXAO" });
    expect(transporte).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("João no piloto COM conexão e responsabilidade: 200, token individual, auditoria antes do texto", async () => {
    const { a, transporte, auditar } = monta({ responsavel: true });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(200);
    expect(r.corpo.ok).toBe(true);
    expect(transporte).toHaveBeenCalledTimes(1);
    expect(transporte.mock.calls[0][0]).toBe(TOKEN_INDIVIDUAL);
    expect(transporte.mock.calls[0][0]).not.toBe(CENTRAL);
    expect(auditar).toHaveBeenCalledWith(expect.objectContaining({ acao: "ULBRA_HISTORICO_LEITURA" }));
  });

  it("João no piloto COM conexão mas SEM responsabilidade: 403 SEM_PERMISSAO_NA_CONVERSA, sem chamada", async () => {
    const { a, transporte } = monta({ responsavel: false });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(403);
    expect(r.corpo.motivo).toBe("SEM_PERMISSAO_NA_CONVERSA");
    expect(transporte).not.toHaveBeenCalled();
  });
});

describe("histórico — falhas", () => {
  it("falha de auditoria: 500 AUDITORIA_NAO_GRAVADA e o texto NÃO sai", async () => {
    const { a, auditar } = monta({ responsavel: true, auditoriaOk: false });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(500);
    expect(r.corpo).toEqual({ ok: false, motivo: "AUDITORIA_NAO_GRAVADA" });
    expect(JSON.stringify(r.corpo)).not.toContain("pode me ligar");
    expect(auditar).toHaveBeenCalledTimes(1);
  });

  it("falha da Mensageria: 502 ULBRA_INDISPONIVEL, sem texto", async () => {
    const { a } = monta({ responsavel: true, transporteFalha: true });
    const r = await executarAcaoHistorico("historico_ler", corpoLer, a);
    expect(r.status).toBe(502);
    expect(r.corpo.motivo).toBe("ULBRA_INDISPONIVEL");
  });
});
