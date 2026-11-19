import { describe, it, expect } from "vitest";
import {
  TIPO_REGISTRO_TERMO_ARQUIVADO,
  DESCRICAO_REGISTRO_TERMO_ARQUIVADO,
  podeRegistrarTermoArquivado,
  montarMovimentoTermoArquivado,
} from "./registroTermo";

// Tipos que disparam efeito em aluno (lista de eh_tipo_acionamento no banco) e os tipos de tabulação.
const TIPOS_COM_EFEITO_DE_ACIONAMENTO = [
  "FINALIZACAO_ATENDIMENTO",
  "FINALIZACAO",
  "ACAO_MASSIVA_EXTERNA",
  "ACAO_MASSIVA_EXTERNA_EMAIL",
  "CONTATO",
  "LINK_ENVIADO_AO_ALUNO",
  "SOLICITACAO_LINK_PAGAMENTO",
  "COMPROVANTE_ENVIADO_BAIXA",
  "QUITADO_MANUAL",
  "TERMO_ENVIADO_ADM",
  "RETORNO_ADM_CRIADO",
  "RETORNO_ADM_CONCLUIDO",
];

describe("podeRegistrarTermoArquivado", () => {
  it("libera apenas as três contas de gestão, sem diferenciar maiúsculas", () => {
    expect(podeRegistrarTermoArquivado("amanda.seibel@aelbra.com.br")).toBe(true);
    expect(podeRegistrarTermoArquivado("  COBRANCA04@aelbra.com.br ")).toBe(true);
    expect(podeRegistrarTermoArquivado("cobranca07@aelbra.com.br")).toBe(true);
  });

  it("nega operador comum, e-mail vazio ou ausente", () => {
    expect(podeRegistrarTermoArquivado("operador.teste@exemplo.local")).toBe(false);
    expect(podeRegistrarTermoArquivado("")).toBe(false);
    expect(podeRegistrarTermoArquivado(null)).toBe(false);
    expect(podeRegistrarTermoArquivado(undefined)).toBe(false);
  });
});

describe("montarMovimentoTermoArquivado", () => {
  const usuario = { nome: "Gestão Teste", email: "gestao.titular@exemplo.local" };
  const agora = "2026-11-19T12:00:00.000Z";
  const linha = montarMovimentoTermoArquivado({ alunoId: 42, usuario, agora });

  it("grava aluno, tipo, descrição fixa, autor e data/hora", () => {
    expect(linha).toEqual({
      aluno_id: "42",
      tipo: TIPO_REGISTRO_TERMO_ARQUIVADO,
      descricao: DESCRICAO_REGISTRO_TERMO_ARQUIVADO,
      status_anterior: null,
      status_novo: null,
      registrado_por_nome: "Gestão Teste",
      registrado_por_email: "gestao.titular@exemplo.local",
      registrado_em: agora,
    });
    expect(DESCRICAO_REGISTRO_TERMO_ARQUIVADO).toBe(
      "Termo físico assinado pelo aluno e arquivado com a gestão."
    );
  });

  it("não contém campos de status, prazo, retorno ou acionamento", () => {
    const proibidos = [
      "status_jornada",
      "status_atual",
      "status_acionamento",
      "data_retorno",
      "data_ultimo_acionamento",
      "proxima_acao",
      "retorno_dias_uteis",
    ];
    for (const campo of proibidos) {
      expect(Object.keys(linha)).not.toContain(campo);
    }
  });

  it("usa um tipo que não dispara acionamento, tabulação nem efeito de elogio", () => {
    expect(TIPOS_COM_EFEITO_DE_ACIONAMENTO).not.toContain(TIPO_REGISTRO_TERMO_ARQUIVADO);
    expect(TIPO_REGISTRO_TERMO_ARQUIVADO).not.toBe("FINALIZACAO_ATENDIMENTO");
    expect(linha.status_novo).toBeNull();
  });

  it("aceita usuário ausente sem quebrar, deixando autor nulo", () => {
    const sem = montarMovimentoTermoArquivado({ alunoId: "x", usuario: null, agora });
    expect(sem.registrado_por_nome).toBeNull();
    expect(sem.registrado_por_email).toBeNull();
  });
});
