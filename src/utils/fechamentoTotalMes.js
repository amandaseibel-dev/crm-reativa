// Como o "total do mês" do Fechamento aparece para a gestão: de onde veio o
// número e, quando veio do relatório do Prime, de qual conferência.
// `totalMes` é o bloco `total_mes` devolvido por calcular_fechamento_remuneracao.

export function dataHoraBR(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function rotuloFonteTotal(totalMes) {
  if (!totalMes) return "";
  if (totalMes.fonte === "relatorio") {
    const quando = totalMes.conferencia_em ? ` (conferência de ${dataHoraBR(totalMes.conferencia_em)})` : "";
    return `relatório do Prime${quando}`;
  }
  if (totalMes.conferencia_id) return "sistema (escolha da gestão)";
  return "sistema (sem conferência no mês)";
}
