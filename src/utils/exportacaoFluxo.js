// Estados da exportacao de Acoes Massivas e regra de bloqueio da interface.
//
// LIMITE: e protecao de INTERFACE. Nao prova idempotencia no servidor, nao vale entre abas
// nem apos recarregar a pagina. O servidor pode ter registrado o lote mesmo com a resposta perdida.

export const FASE = Object.freeze({
  OCIOSO: "ocioso",
  CONCLUIDA: "concluida", // lote registrado e arquivo baixado
  ARQUIVO_FALHOU: "arquivo_falhou", // lote registrado pela RPC, arquivo NAO baixado
  INCERTA: "incerta", // resultado do registro DESCONHECIDO (resposta perdida ou erro sem codigo de validacao)
  RECUSADA: "recusada", // validacao recusou: nada foi registrado
});

/** Enquanto o resultado do registro for desconhecido, a tela nao permite nova exportacao. */
export function bloqueiaNovaExportacao(fase) {
  return fase === FASE.INCERTA;
}

/** Texto para o operador, sem dados pessoais. Separa "arquivo nao baixado" de "resultado desconhecido". */
export function mensagemDaFase(fase) {
  switch (fase) {
    case FASE.CONCLUIDA:
      return "Lote registrado e planilha baixada.";
    case FASE.ARQUIVO_FALHOU:
      return "Lote registrado, arquivo não baixado. Use Baixar planilha novamente; não exporte de novo para obter o mesmo arquivo.";
    case FASE.INCERTA:
      return "Resultado do registro desconhecido. Confira o histórico de lotes antes de exportar de novo.";
    case FASE.RECUSADA:
      return "Exportação recusada pela validação. Nada foi registrado.";
    default:
      return "";
  }
}
