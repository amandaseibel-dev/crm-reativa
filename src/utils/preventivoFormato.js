// Formatação do Preventivo. Vive fora da página para que a tela exporte só
// componentes (é o que o fast refresh do React espera) e para que os quatro
// painéis formatem dinheiro e data do mesmo jeito.

export function moeda(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function dataCurta(d) {
  if (!d) return "—";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}

// Sempre em America/Sao_Paulo: o servidor guarda em UTC e, entre 21h e
// meia-noite, "ontem" e "hoje" trocam de lugar se o fuso não for fixado.
export function dataHora(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// `datetime-local` fala HORA LOCAL. `toISOString().slice(0,16)` devolve UTC e,
// em Brasília (UTC-3), joga o campo 3 horas para a frente -- uma extração das
// 21h de ontem viraria 00h de hoje, mudando o DIA e, com ele, a ordem das
// remessas. Aqui o valor é montado a partir dos componentes locais.
export function agoraLocalParaInput(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Percentual no padrao brasileiro: virgula decimal, uma casa, e "—" quando o
// numero nao existe. Sem isto a tela mistura "R$ 4.248.050,67" com "17.4%" na
// MESMA linha -- o mesmo separador significando coisas diferentes.
export function pct(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// DINHEIRO COM MOEDA DECLARADA. O custo da ação pode ter sido pago em real ou
// em dólar, e escrever "R$" num valor em dólar não é detalhe de formatação: é
// afirmar um fato falso sobre dinheiro, que depois vira comparação errada com
// o saldo da carteira.
//
// Moeda NULA não vira real. Devolve o número sem símbolo, e quem chama diz
// "moeda não informada" — não presumir é o ponto.
const SIMBOLO = { BRL: "R$", USD: "US$" };

export function moedaEm(v, m) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const texto = n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const s = SIMBOLO[m];
  return s ? `${s} ${texto}` : texto;
}

// O rótulo que acompanha um valor sem moeda declarada.
export const SEM_MOEDA = "moeda não informada";
