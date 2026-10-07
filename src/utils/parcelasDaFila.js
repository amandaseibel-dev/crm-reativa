// PARCELAS DO ACORDO REGISTRADO PELA FILA DE BAIXAS.
//
// Quando o operador baixa um link de pagamento parcelado, a fila registra o
// acordo e as parcelas para o parcelamento ficar rastreavel. A primeira linha
// e o pagamento que acabou de ser baixado -- nasce PAGA, com data e autor.
//
// As DEMAIS nao podem mais nascer 'A_VENCER' fixo. Os vencimentos comecam em
// hoje, mas o operador edita cada um na mao antes de salvar: basta digitar uma
// data passada para a parcela nascer com o status errado e so ser corrigida no
// cron das 03:05 -- a mesma janela que a ficha da Keyla expos em 29/09/2026.
//
// Esta funcao e PURA e roda no momento do insert, nao na geracao das linhas na
// tela, para que o status saia do vencimento FINAL, ja editado.
import { statusInicialParcela, STATUS_PARCELA_TERMINAL } from "./statusParcela";

export function montarParcelasDaFila({ acordoId, parcelas, email, agoraISO }) {
  return (parcelas || []).map((p, i) => {
    const paga = i === 0;
    return {
      acordo_id: acordoId,
      numero: i + 1,
      valor: Number(p.valor) || 0,
      vencimento: p.vencimento || null,
      // Status terminal que ja tenha vindo na linha passa intacto: nele a data
      // nao manda mais. Hoje so a primeira linha chega assim.
      status: paga
        ? "PAGO"
        : STATUS_PARCELA_TERMINAL.has(p.status)
        ? p.status
        : statusInicialParcela(p.vencimento),
      pago_em: paga ? agoraISO : null,
      confirmado_por_email: paga ? email : null,
    };
  });
}
