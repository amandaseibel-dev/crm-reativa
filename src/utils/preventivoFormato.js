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
