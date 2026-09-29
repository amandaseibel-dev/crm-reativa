// ROTULO DA PARCELA NA TELA -- uma regra so, para nao nascerem duas verdades.
//
// Mora aqui, e nao dentro da ficha, por dois motivos: e regra pura (nao depende
// de React) e o .jsx nao pode exportar nada alem do componente sem quebrar o
// fast refresh.

export const STATUS_PARCELA_LABEL = {
  A_VENCER: "A vencer",
  VENCIDA: "Vencida",
  PAGO: "Paga",
  CANCELADA: "Cancelada",
  RENEGOCIADA: "Renegociada",
};

// Parcela ainda em aberto: e a DATA que diz se venceu, nao a coluna status.
const STATUS_PARCELA_ABERTA = new Set(["A_VENCER", "VENCIDA"]);

// SELO DA PARCELA: o texto sai da mesma verdade que a cor.
//
// A cor sempre veio da data (diasAtraso); o texto vinha de p.status. Acordo
// lancado com vencimento retroativo nasce 'A_VENCER' e so vira VENCIDA no cron
// das 03:05 -- entao a MESMA linha saia com fundo vermelho de vencida e o texto
// "A vencer". A tela nao pode depender de que horas o cron rodou.
//
// Estado terminal (paga, cancelada, renegociada) continua vindo do status: nele
// a data nao diz mais nada.
//
// Status fora do catalogo NAO vira "A vencer" em silencio. Antes qualquer valor
// desconhecido -- RENEGOCIADA, um status novo, null -- era exibido como
// "A vencer", que e a leitura mais perigosa possivel: afirma que nao ha nada a
// cobrar. Agora ele aparece como veio, para dar na vista de quem abrir a ficha.
export function rotuloParcela(status, vencida) {
  if (STATUS_PARCELA_ABERTA.has(status)) return vencida ? "Vencida" : "A vencer";
  if (STATUS_PARCELA_LABEL[status]) return STATUS_PARCELA_LABEL[status];
  return status ? `Status inesperado: ${status}` : "Sem status";
}
