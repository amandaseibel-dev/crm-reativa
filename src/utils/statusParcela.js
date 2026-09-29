// ROTULO DA PARCELA NA TELA -- uma regra so, para nao nascerem duas verdades.
//
// Mora aqui, e nao dentro da ficha, por dois motivos: e regra pura (nao depende
// de React) e o .jsx nao pode exportar nada alem do componente sem quebrar o
// fast refresh.

export function paraDataISO(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let d = m[1], mo = m[2], ano = m[3];
    if (ano.length === 2) ano = "20" + ano;
    return `${ano}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

// Dia LOCAL, nunca o UTC: toISOString() jogaria a virada do dia para outro
// fuso e uma parcela que vence hoje nasceria vencida.
export function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// STATUS INICIAL DA PARCELA: quem manda e a DATA, nao a hora do lancamento.
//
// Antes toda parcela nascia 'A_VENCER'. Acordo antigo lancado hoje -- o caso
// normal de acordo que so agora entra no sistema -- nascia inteiro "a vencer"
// e so virava VENCIDA no cron das 03:05. Nessa janela a Saude da Carteira dava
// o acordo como EM_DIA, a parcela vencida mais antiga vinha nula e as Acoes
// Massivas nao enxergavam o acordo (elas filtram status = 'VENCIDA').
//
// Mesma semantica que o banco ja usa em desfazer_baixa_parcela:
//   case when vencimento < current_date then 'VENCIDA' else 'A_VENCER' end
//
// A comparacao e por DATA, entre strings ISO: 'YYYY-MM-DD' ordena igual ao
// calendario, entao nao existe Date, nem hora, nem fuso para virar o dia.
// Vencimento HOJE e A_VENCER -- so o dia anterior esta vencido.
//
// Data ausente ou ilegivel devolve A_VENCER: sem data nao da para afirmar que
// venceu, e o cron corrige se um dia a data aparecer.
export function statusInicialParcela(vencimento) {
  const iso = paraDataISO(vencimento);
  if (!iso) return "A_VENCER";
  return iso < hojeISO() ? "VENCIDA" : "A_VENCER";
}

// Status que a data NAO decide mais: a parcela ja teve desfecho.
export const STATUS_PARCELA_TERMINAL = new Set(["PAGO", "CANCELADA", "RENEGOCIADA"]);

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
