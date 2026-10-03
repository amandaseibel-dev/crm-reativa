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
