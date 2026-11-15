// Fluxo de exportacao de Acoes Massivas: estados e regra de bloqueio da interface.
//
// LIMITE: isto e protecao de INTERFACE. Nao prova idempotencia no servidor, nao vale entre abas
// nem apos recarregar a pagina. O servidor pode ter registrado o lote mesmo quando a resposta se perdeu.

import { classificarFalhaExportacao } from "./exportacaoMassiva.js";

export const FASE = Object.freeze({
  OCIOSO: "ocioso",
  CONCLUIDA: "concluida", // lote registrado e arquivo baixado
  ARQUIVO_FALHOU: "arquivo_falhou", // lote registrado pela RPC, arquivo NAO baixado
  INCERTA: "incerta", // resultado do registro DESCONHECIDO (resposta perdida ou erro sem codigo)
  RECUSADA: "recusada", // validacao recusou: nada foi registrado; pode tentar apos corrigir
});

/** Enquanto o resultado do registro for desconhecido, nao permitir nova exportacao. */
export function bloqueiaNovaExportacao(fase) {
  return fase === FASE.INCERTA;
}

/** Texto para o operador, sem dados pessoais. Diferencia os dois casos pedidos. */
export function mensagemDaFase(fase) {
  switch (fase) {
    case FASE.CONCLUIDA:
      return "Lote registrado e planilha baixada.";
    case FASE.ARQUIVO_FALHOU:
      return "Lote registrado, arquivo não baixado. Use Baixar planilha: ele não registra o lote de novo.";
    case FASE.INCERTA:
      return "Resultado do registro desconhecido. Confira o histórico de lotes antes de exportar de novo.";
    case FASE.RECUSADA:
      return "Exportação recusada pela validação. Nada foi registrado.";
    default:
      return "";
  }
}

/**
 * Executa a exportacao. Chamada UMA vez; nunca repete a RPC.
 * Deps injetadas: chamarRpc(args) -> {data, error}; gerarArquivo(rel) (lanca em falha).
 * Retorna { fase, rel, exp, erro } para a interface guardar.
 */
export async function executarExportacao({ args, chamarRpc, montarRel, gerarArquivo }) {
  let exp;
  try {
    const { data, error } = await chamarRpc(args);
    if (error) throw error;
    exp = data;
  } catch (e) {
    const f = classificarFalhaExportacao("rpc", e);
    return { fase: f.etapa === "validacao" ? FASE.RECUSADA : FASE.INCERTA, rel: null, exp: null, erro: f };
  }
  const contatos = exp?.contatos || [];
  if (contatos.length === 0) {
    return { fase: FASE.CONCLUIDA, rel: null, exp, erro: null };
  }
  const rel = montarRel(contatos);
  try {
    gerarArquivo(rel);
    return { fase: FASE.CONCLUIDA, rel, exp, erro: null };
  } catch {
    // Lote JA registrado. Guarda o resultado para baixar de novo sem nova RPC.
    return { fase: FASE.ARQUIVO_FALHOU, rel, exp, erro: classificarFalhaExportacao("arquivo", null) };
  }
}

/** Baixar novamente: so gera o arquivo a partir do resultado guardado. Nunca chama a RPC. */
export function baixarNovamente(resultado, gerarArquivo) {
  if (!resultado || !resultado.rel) {
    return { ...resultado, fase: resultado?.fase ?? FASE.OCIOSO };
  }
  try {
    gerarArquivo(resultado.rel);
    return { ...resultado, fase: FASE.CONCLUIDA, erro: null };
  } catch {
    return { ...resultado, fase: FASE.ARQUIVO_FALHOU, erro: classificarFalhaExportacao("arquivo", null) };
  }
}
