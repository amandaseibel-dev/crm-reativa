// @vitest-environment node
// Registro administrativo do termo físico (tabulação restrita à gestão).
// Prova no front: a gravação vai SÓ para o histórico, com tipo que não é
// acionamento, e não toca em alunos (sem contato, fidelização, retorno ou fila).
// A restrição real é do banco (trigger em aluno_movimentacoes); aqui só a
// conferência da forma do que é enviado.
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const update = vi.fn();
const from = vi.fn((tabela) => ({
  insert: (payload) => {
    insert(tabela, payload);
    return Promise.resolve({ error: null });
  },
  update: (payload) => {
    update(tabela, payload);
    return { eq: () => Promise.resolve({ error: null }) };
  },
}));
vi.mock("../services/supabase", () => ({ supabase: { from: (t) => from(t) } }));

import {
  DESCRICAO_REGISTRO_ADMINISTRATIVO,
  tabulacaoEhRegistroAdministrativo,
  registrarAdministrativoNoHistorico,
  TABULACOES_REGISTRO_ADMINISTRATIVO,
  TABULACOES_SO_GESTAO,
  TIPO_REGISTRO_ADMINISTRATIVO,
} from "./tabulacoes";

const TIPOS_ACIONAMENTO = [
  "FINALIZACAO_ATENDIMENTO", "FINALIZACAO", "ACAO_MASSIVA_EXTERNA", "ACAO_MASSIVA_EXTERNA_EMAIL", "CONTATO",
  "LINK_ENVIADO_AO_ALUNO", "SOLICITACAO_LINK_PAGAMENTO", "COMPROVANTE_ENVIADO_BAIXA",
  "QUITADO_MANUAL", "TERMO_ENVIADO_ADM", "RETORNO_ADM_CRIADO", "RETORNO_ADM_CONCLUIDO",
];

beforeEach(() => {
  insert.mockClear();
  update.mockClear();
  from.mockClear();
});

describe("registro administrativo do termo físico", () => {
  it("os dois códigos estão na lista de só-gestão e são reconhecidos", () => {
    expect(TABULACOES_REGISTRO_ADMINISTRATIVO).toEqual(["TERMO_FISICO_EM_ANDAMENTO", "TERMO_FISICO_ARQUIVADO"]);
    for (const c of TABULACOES_REGISTRO_ADMINISTRATIVO) {
      expect(TABULACOES_SO_GESTAO).toContain(c);
      expect(tabulacaoEhRegistroAdministrativo(c)).toBe(true);
      expect(tabulacaoEhRegistroAdministrativo(c.toLowerCase() + " ")).toBe(true);
    }
    expect(tabulacaoEhRegistroAdministrativo("CONTATAR")).toBe(false);
  });

  it("grava SÓ no histórico, com tipo que não é acionamento", async () => {
    await registrarAdministrativoNoHistorico({
      alunoId: "a0000000-0000-0000-0000-000000000042",
      codigo: "TERMO_FISICO_ARQUIVADO",
      operadorEmail: "amanda.seibel@aelbra.com.br",
      operadorNome: "Amanda",
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const [tabela, payload] = insert.mock.calls[0];
    expect(tabela).toBe("aluno_movimentacoes");
    expect(payload.tipo).toBe(TIPO_REGISTRO_ADMINISTRATIVO);
    expect(TIPOS_ACIONAMENTO).not.toContain(payload.tipo);
    expect(payload.status_novo).toBe("TERMO_FISICO_ARQUIVADO");
    expect(payload.registrado_por_email).toBe("amanda.seibel@aelbra.com.br");
    expect(payload.registrado_em).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.descricao).toBe(DESCRICAO_REGISTRO_ADMINISTRATIVO);
    // Triagem Prime: nenhuma palavra-chave da leitura da triagem casa com a descrição.
    expect(payload.descricao).not.toMatch(/fies|isen|bolsa|tranc|cancel.*matr|desist/i);
  });

  it("não escreve em alunos (sem contato, fidelização, retorno, fila nem status)", async () => {
    await registrarAdministrativoNoHistorico({
      alunoId: "a0000000-0000-0000-0000-000000000042",
      codigo: "TERMO_FISICO_EM_ANDAMENTO",
      operadorEmail: "cobranca07@aelbra.com.br",
      operadorNome: null,
    });
    expect(update).not.toHaveBeenCalled();
    expect(from.mock.calls.map((c) => c[0])).toEqual(["aluno_movimentacoes"]);
  });

  it("propaga erro de gravação para quem chama (nada de falha silenciosa)", async () => {
    from.mockImplementationOnce(() => ({
      insert: () => Promise.resolve({ error: { code: "42501", message: "restrita" } }),
    }));
    await expect(
      registrarAdministrativoNoHistorico({
        alunoId: "x", codigo: "TERMO_FISICO_ARQUIVADO", operadorEmail: "a@b", operadorNome: null,
      })
    ).rejects.toMatchObject({ code: "42501" });
  });
});
