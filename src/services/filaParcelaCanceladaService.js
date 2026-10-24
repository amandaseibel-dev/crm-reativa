// Leitura da fila de excecoes (pagamento em parcela/acordo CANCELADO).
// Uma chamada, uma RPC `STABLE` com portao de gestao no corpo. Nao escreve nada.
import { selarCancelamento } from "../utils/filaParcelaCancelada";

/**
 * Le a fila inteira. Falha FECHADA: qualquer erro devolve lista vazia e o motivo,
 * nunca uma lista parcial que a tela somaria como se fosse o total.
 *
 * Cada linha ja chega selada com o estado de cancelamento, para que nenhuma camada
 * acima consiga exibir "candidato" sem o aviso -- ver `selarCancelamento`.
 */
export async function lerFilaParcelaCancelada(client) {
  if (!client) return { linhas: [], erro: "PARAMETROS_INVALIDOS" };
  try {
    const { data, error } = await client.rpc("fila_pagamento_parcela_cancelada");
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error("RETORNO_INVALIDO");
    // Toda linha daqui E um pagamento identificado por boleto unico -- e por isso que
    // entra como CANDIDATO_DETERMINISTICO no selo. O selo entao a REBAIXA, porque a
    // parcela ou o acordo esta cancelado. E exatamente o rebaixamento que a #692 nao faz.
    const linhas = data.map((l) => ({
      ...l,
      ...selarCancelamento(
        { situacao: "CANDIDATO_DETERMINISTICO" },
        { status_parcela: l.parcela_status, status_acordo: l.acordo_status },
      ),
    }));
    return { linhas, erro: null };
  } catch (e) {
    // 42501 e o portao da propria funcao: sessao sem gestao.
    const semPermissao = String(e?.code ?? "") === "42501" || /42501/.test(String(e?.message ?? ""));
    return { linhas: [], erro: semPermissao ? "SEM_PERMISSAO_DE_GESTAO" : "LEITURA_NEGADA_OU_INCOMPLETA" };
  }
}
