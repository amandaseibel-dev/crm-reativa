// Prova de que o histórico NÃO tem fallback de credencial: sem conexão individual ativa, a leitura é
// recusada antes da Mensageria, mesmo com ULBRA_HISTORICO_HABILITADO=true. E que o código da função
// nunca lê ULBRA_MCP_TOKEN (nem qualquer outra credencial central) fora de comentários.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lerHistoricoAutorizado, type DepsHistorico } from "./historico-leitura.ts";

const CONV = "a".repeat(24);

function semConexao(email = "cobranca10@aelbra.com.br") {
  const lerConversa = vi.fn(async () => ({ dados: { mensagens: [] } }));
  const auditar = vi.fn(async () => true);
  const deps: DepsHistorico = {
    email,
    usuarioAtivo: true,
    flagLigada: true, // a flag está LIGADA: o teste isola a ausência de conexão
    conversaId: CONV,
    antesDe: null,
    buscarClienteDaConversa: async () => "cli-1",
    alunoDoCliente: async () => "aluno-1",
    donosDoAluno: async () => [email],
    responsaveisDoCliente: async () => [email],
    conexao: async () => ({ ok: false as const, motivo: "SEM_CONEXAO" }),
    lerConversa: lerConversa as unknown as DepsHistorico["lerConversa"],
    auditar,
  };
  return { deps, lerConversa, auditar };
}

describe("histórico sem conexão individual ativa (flag ligada)", () => {
  it("recusa com 403 e NÃO chama a Mensageria nem grava auditoria de leitura", async () => {
    const { deps, lerConversa, auditar } = semConexao();
    const r = await lerHistoricoAutorizado(deps);
    expect(r.status).toBe(403);
    expect(r.corpo).toEqual({ ok: false, motivo: "SEM_CONEXAO" });
    expect(lerConversa).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("mesmo quem tem carteira e responsabilidade não lê sem a própria conexão", async () => {
    const { deps, lerConversa } = semConexao("amanda.seibel@aelbra.com.br");
    expect((await lerHistoricoAutorizado(deps)).status).toBe(403);
    expect(lerConversa).not.toHaveBeenCalled();
  });
});

describe("sem fallback para credencial central", () => {
  const DIR = join(__dirname);
  const arquivos = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("nenhum arquivo da função lê ULBRA_MCP_TOKEN (só comentários o citam)", () => {
    for (const f of arquivos) {
      const linhas = readFileSync(join(DIR, f), "utf8").split("\n");
      const usos = linhas.filter((l) => /ULBRA_MCP_TOKEN/.test(l) && !/^\s*\/\//.test(l));
      expect(usos, `${f} lê ULBRA_MCP_TOKEN fora de comentário`).toEqual([]);
    }
  });

  it("a leitura só usa o token do próprio operador (chamarComoOperador), nunca outra credencial", () => {
    const index = readFileSync(join(DIR, "index.ts"), "utf8");
    expect(index).toMatch(/lerConversa: \(token, args\) => chamarComoOperador\(token, "ler_conversa", args\)/);
    expect(index).not.toMatch(/Deno\.env\.get\("ULBRA_MCP_TOKEN"\)/);
  });
});
