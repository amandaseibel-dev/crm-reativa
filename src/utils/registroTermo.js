// Registro administrativo informativo: "Termo físico assinado pelo aluno e arquivado com a gestão".
//
// É só uma linha de histórico em aluno_movimentacoes, no mesmo padrão de CORRECAO_CADASTRO:
// não altera alunos (status, prazo, próxima ação, último acionamento), não é tabulação,
// não é acionamento e não tem efeito financeiro.
//
// O tipo escolhido não está em eh_tipo_acionamento(), não é FINALIZACAO_ATENDIMENTO e
// status_novo fica nulo, então os gatilhos de último acionamento, desfazer tabulação e
// elogio saem cedo (ver fn_atualizar_ultimo_acionamento, _trg_desfazer_cartao_tabulacao e
// sincronizar_elogio_da_movimentacao).

export const TIPO_REGISTRO_TERMO_ARQUIVADO = "REGISTRO_TERMO_FISICO_INFORMATIVO";

export const DESCRICAO_REGISTRO_TERMO_ARQUIVADO =
  "Termo físico assinado pelo aluno e arquivado com a gestão.";

// Mesma lista de identificadores de usuario_e_gestao() no banco. Não inclui perfil "diretoria".
const EMAILS_GESTAO = [
  "amanda.seibel@aelbra.com.br",
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
];

export function podeRegistrarTermoArquivado(email) {
  return EMAILS_GESTAO.includes(String(email || "").toLowerCase().trim());
}

// Monta a linha de histórico. Não contém nenhum campo de status, prazo, retorno ou acionamento.
export function montarMovimentoTermoArquivado({ alunoId, usuario, agora }) {
  return {
    aluno_id: String(alunoId),
    tipo: TIPO_REGISTRO_TERMO_ARQUIVADO,
    descricao: DESCRICAO_REGISTRO_TERMO_ARQUIVADO,
    status_anterior: null,
    status_novo: null,
    registrado_por_nome: usuario?.nome ?? null,
    registrado_por_email: usuario?.email ?? null,
    registrado_em: agora,
  };
}
