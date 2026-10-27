// Regras de apresentacao do detalhamento das mensalidades na Minha Carteira.
// Puro: nao conhece React, nao fala com o banco e NAO decide nada sobre a
// divida -- os valores e o sinal de vencida chegam prontos de
// `consolidarFinanceiro` (PainelCarteira), que e quem soma o total da linha.

// Situacao de UMA mensalidade. Mesma distincao que a caixa de "Valor aberto" ja
// faz para escolher a cor do total (vencido / a vencer), e vinda do MESMO
// sinal: `vencida` e calculado la com `diasAtraso`.
export function situacaoMensalidade(item) {
  if (item?.vencida) return { texto: "Vencida", cor: "var(--rv-vermelho-texto)" };
  return { texto: "A vencer", cor: "var(--rv-ambar-texto)" };
}

// Vencimento mais antigo primeiro -- a ordem em que o operador cobra. Sem
// vencimento vai para o fim (nao inventa data). Empate pelo numero do titulo,
// para a ordem nao mudar entre duas aberturas da mesma linha. Nao muta a
// entrada.
export function ordenarMensalidades(itens) {
  return [...(itens || [])].sort((a, b) => {
    const va = a?.vencimento ? String(a.vencimento).slice(0, 10) : "";
    const vb = b?.vencimento ? String(b.vencimento).slice(0, 10) : "";
    if (va !== vb) {
      if (!va) return 1;
      if (!vb) return -1;
      return va < vb ? -1 : 1;
    }
    return String(a?.documento || "").localeCompare(String(b?.documento || ""));
  });
}
