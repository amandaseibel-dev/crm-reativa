// @vitest-environment node
// Registro administrativo: o front APENAS chama a operação do banco. Não escreve nada.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpc(...a), from: (...a) => from(...a) },
}));

import {
  registrarAdministrativoNoHistorico,
  tabulacaoEhRegistroAdministrativo,
  TABULACOES_REGISTRO_ADMINISTRATIVO,
  TABULACOES_SO_GESTAO,
} from "./tabulacoes";

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe("registro administrativo do termo físico (front)", () => {
  it("os dois códigos estão na lista de só-gestão e são reconhecidos", () => {
    expect(TABULACOES_REGISTRO_ADMINISTRATIVO).toEqual(["TERMO_FISICO_EM_ANDAMENTO", "TERMO_FISICO_ARQUIVADO"]);
    for (const c of TABULACOES_REGISTRO_ADMINISTRATIVO) {
      expect(TABULACOES_SO_GESTAO).toContain(c);
      expect(tabulacaoEhRegistroAdministrativo(c)).toBe(true);
    }
    expect(tabulacaoEhRegistroAdministrativo("CONTATAR")).toBe(false);
  });

  it("chama a operação do banco com aluno e código normalizados", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await registrarAdministrativoNoHistorico({ alunoId: "a0000000-0000-0000-0000-000000000042", codigo: " termo_fisico_arquivado " });
    expect(rpc).toHaveBeenCalledWith("registrar_administrativo_termo_fisico", {
      p_aluno_id: "a0000000-0000-0000-0000-000000000042",
      p_codigo: "TERMO_FISICO_ARQUIVADO",
    });
  });

  it("não escreve diretamente em nenhuma tabela (nem alunos, nem histórico)", async () => {
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await registrarAdministrativoNoHistorico({ alunoId: "x", codigo: "TERMO_FISICO_EM_ANDAMENTO" });
    expect(from).not.toHaveBeenCalled();
  });

  it("propaga o erro do banco para quem chama (sem falha silenciosa)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "restrito" } });
    await expect(
      registrarAdministrativoNoHistorico({ alunoId: "x", codigo: "TERMO_FISICO_ARQUIVADO" })
    ).rejects.toMatchObject({ code: "42501" });
  });
});
