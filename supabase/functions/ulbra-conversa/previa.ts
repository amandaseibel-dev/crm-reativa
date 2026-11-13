// ===========================================================================
// PRÉVIA REGISTRADA NO SERVIDOR, antes da confirmação do envio.
//
// A prévia NÃO chama a Mensageria. Ela só valida o pedido com o estado atual do
// espelho e registra: operador, atendimento, cliente, hash do texto exato e
// validade curta. A confirmação consome a prévia UMA vez, revalida tudo e só
// então envia (envio.ts). Custo e janela vindos do navegador não são usados.
//
// Ficam de fora, de propósito: qualquer chamada de ferramenta de envio com
// `previa: true`, porque o comportamento desse parâmetro não está comprovado.
// ===========================================================================
import { enviarResposta, hashConteudo, validarPedido, type DependenciasEnvio, type PedidoEnvio, type ResultadoEnvio } from "./envio.ts";

/** Validade curta: a confirmação precisa vir logo depois da prévia. */
export const VALIDADE_PREVIA_MS = 5 * 60 * 1000;

export interface PreviaRegistro {
  id: string;
  operador_email: string;
  atendimento_id: string;
  ulbra_cliente_id: string;
  conteudo_hash: string;
  expira_em_ms: number;
  consumida_em_ms: number | null;
}

export interface RepositorioPrevia {
  inserir(p: PreviaRegistro): Promise<void>;
  buscar(id: string): Promise<PreviaRegistro | null>;
  /**
   * Marca a prévia como consumida SOMENTE se ainda não foi consumida, do mesmo operador
   * e dentro da validade. Devolve true apenas para quem consumiu de fato (uma vez).
   */
  consumir(id: string, operador: string, agoraMs: number): Promise<boolean>;
}

export type ResultadoPrevia =
  | { situacao: "CRIADA"; previa_id: string; expira_em_ms: number; janela_aberta: true }
  | { situacao: "BLOQUEADO"; motivos: string[] };

export interface DependenciasPrevia {
  repositorioPrevia: RepositorioPrevia;
  gerarId: () => string;
  agora: () => number;
}

const bloqueado = (motivos: string[]) => ({ situacao: "BLOQUEADO" as const, motivos });

/** Valida o pedido agora e registra a prévia. Não envia nada. */
export async function criarPrevia(pedido: PedidoEnvio, deps: DependenciasPrevia): Promise<ResultadoPrevia> {
  const motivos = validarPedido(pedido);
  if (!pedido.ulbra_cliente_id) motivos.push("DESTINATARIO_NAO_IDENTIFICADO");
  if (motivos.length > 0) return bloqueado(motivos);
  const agora = deps.agora();
  const id = deps.gerarId();
  await deps.repositorioPrevia.inserir({
    id,
    operador_email: pedido.operador.toLowerCase(),
    atendimento_id: pedido.atendimento_id,
    ulbra_cliente_id: pedido.ulbra_cliente_id!,
    conteudo_hash: await hashConteudo(pedido.texto),
    expira_em_ms: agora + VALIDADE_PREVIA_MS,
    consumida_em_ms: null,
  });
  return { situacao: "CRIADA", previa_id: id, expira_em_ms: agora + VALIDADE_PREVIA_MS, janela_aberta: true };
}

/**
 * Confirma o envio a partir de uma prévia. Ordem:
 *  1. repetição da mesma chave: devolve o envio já gravado, sem consumir a prévia de novo;
 *  2. a prévia existe, é deste operador, não foi usada, está dentro da validade;
 *  3. o conteúdo é EXATAMENTE o da prévia (hash);
 *  4. o atendimento e o cliente são os da prévia;
 *  5. identidade, responsabilidade e janela são revalidadas agora;
 *  6. consumo único atômico; só então o envio.
 */
export async function confirmarPrevia(
  pedido: PedidoEnvio,
  previaId: string,
  deps: DependenciasEnvio & DependenciasPrevia,
): Promise<ResultadoEnvio | { situacao: "BLOQUEADO"; motivos: string[] }> {
  const operador = pedido.operador.toLowerCase();
  const existente = await deps.repositorio.buscar(pedido.operador, pedido.chave);
  if (existente) return { situacao: "JA_PROCESSADO", envio: existente };

  const previa = await deps.repositorioPrevia.buscar(previaId);
  const agora = deps.agora();
  if (!previa) return bloqueado(["PREVIA_NAO_ENCONTRADA"]);
  if (previa.operador_email !== operador) return bloqueado(["PREVIA_DE_OUTRA_CONTA"]);
  if (previa.consumida_em_ms !== null) return bloqueado(["PREVIA_JA_USADA"]);
  if (agora >= previa.expira_em_ms) return bloqueado(["PREVIA_EXPIRADA"]);
  if (previa.conteudo_hash !== (await hashConteudo(pedido.texto))) return bloqueado(["CONTEUDO_ALTERADO"]);
  if (previa.atendimento_id !== pedido.atendimento_id) return bloqueado(["ATENDIMENTO_DIVERGENTE"]);
  if (!pedido.ulbra_cliente_id || previa.ulbra_cliente_id !== pedido.ulbra_cliente_id) {
    return bloqueado(["DESTINATARIO_DIVERGENTE"]);
  }
  const motivos = validarPedido(pedido);
  if (motivos.length > 0) return bloqueado(motivos);

  const consumiu = await deps.repositorioPrevia.consumir(previaId, operador, agora);
  if (!consumiu) return bloqueado(["PREVIA_JA_USADA"]);
  return enviarResposta(pedido, deps, previaId);
}
