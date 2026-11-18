// Cota OBRIGATÓRIA no caminho real da leitura: sem adaptador de cota, nada chega à Mensageria.
import { describe, it, expect, vi } from "vitest";
import { lerHistoricoAutorizado, type DepsHistorico } from "./historico-leitura.ts";

const CONV = "a".repeat(24);

function deps(extra: Partial<DepsHistorico> = {}): DepsHistorico & { lerConversa: ReturnType<typeof vi.fn> } {
  const lerConversa = vi.fn(async () => ({ dados: { mensagens: [], paginacao: {} } }));
  return {
    email: "cobranca10@aelbra.com.br",
    usuarioAtivo: true,
    flagLigada: true,
    conversaId: CONV,
    antesDe: null,
    buscarClienteDaConversa: async () => "cli-1",
    alunoDoCliente: async () => "aluno-1",
    donosDoAluno: async () => ["cobranca10@aelbra.com.br"],
    responsaveisDoCliente: async () => [],
    conexao: async () => ({ ok: true as const, access_token: "tok", pessoa_email: "cobranca10@aelbra.com.br" }),
    lerConversa,
    auditar: async () => true,
    reservarCota: async () => "OK" as const,
    ...extra,
  } as DepsHistorico & { lerConversa: ReturnType<typeof vi.fn> };
}

describe("cota obrigatória (caminho real)", () => {
  it("(c-obr-1) SEM adaptador de cota: 503 COTA_INDISPONIVEL e NENHUMA chamada à Mensageria", async () => {
    const d = deps();
    delete (d as Partial<DepsHistorico>).reservarCota;
    const r = await lerHistoricoAutorizado(d);
    expect(r.status).toBe(503);
    expect(r.corpo.motivo).toBe("COTA_INDISPONIVEL");
    expect(d.lerConversa).not.toHaveBeenCalled();
  });

  it("(c-obr-2) com adaptador e cota OK: a Mensageria é chamada (controle)", async () => {
    const d = deps();
    const r = await lerHistoricoAutorizado(d);
    expect(r.status).toBe(200);
    expect(d.lerConversa).toHaveBeenCalledTimes(1);
  });
});
