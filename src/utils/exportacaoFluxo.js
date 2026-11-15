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

/**
 * Bloqueia nova exportacao (interface) quando o registro esta incerto ou ja foi feito sem arquivo.
 * Em ARQUIVO_FALHOU so resta "Baixar planilha novamente". Recarregar a pagina libera a tela,
 * mas NAO desfaz o lote registrado.
 */
export function bloqueiaNovaExportacao(fase) {
  return fase === FASE.INCERTA || fase === FASE.ARQUIVO_FALHOU;
}

/** Texto para o operador, sem dados pessoais. Separa "arquivo nao baixado" de "resultado desconhecido". */
export function mensagemDaFase(fase) {
  switch (fase) {
    case FASE.CONCLUIDA:
      return "Lote registrado e planilha baixada.";
    case FASE.ARQUIVO_FALHOU:
      return "Lote registrado, arquivo não baixado. Use Baixar planilha novamente. Nova exportação bloqueada nesta tela; recarregar a página libera a tela, mas não desfaz o registro.";
    case FASE.INCERTA:
      return "Resultado do registro desconhecido. Confira o histórico de lotes antes de exportar de novo.";
    case FASE.RECUSADA:
      return "Exportação recusada pela validação. Nada foi registrado.";
    default:
      return "";
  }
}
