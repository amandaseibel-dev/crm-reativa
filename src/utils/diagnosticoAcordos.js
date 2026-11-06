// Resumo do diagnóstico de acordos (`prime-sync`, ação `provar_match`).
//
// POR QUE EM ARQUIVO PRÓPRIO, e não na tela: exportar função de um arquivo de
// componente quebra o fast refresh, e o lint diz isso com razão
// (`react-refresh/only-export-components`). Não há aqui a restrição de
// topologia que obriga a duplicação em `ProjecaoHoraHora.jsx` — então o lugar
// certo é um utilitário, e a catraca do lint fica onde estava.
//
// O QUE ESTA FUNÇÃO GARANTE: o payload de `provar_match` traz CPF, matrícula e
// o objeto cru do acordo. Nada disso atravessa. Só saem contagens e NOMES de
// campo. Há teste de privacidade que joga um payload com dado pessoal e exige
// que ele não apareça no resultado.

export function resumirProvarMatch(relatorio) {
  const linhas = Array.isArray(relatorio) ? relatorio : [];
  const campos = new Set();
  let comAcordo = 0;
  let acordos = 0;
  let docsPrime = 0;
  let docsCasados = 0;
  let parcelasPagas = 0;
  let parcelasNaoPagas = 0;
  let situacaoConhecida = false;

  for (const l of linhas) {
    const p = l?.prime ?? {};
    const qtd = Number(p.qtd_acordos) || 0;
    acordos += qtd;
    if (qtd > 0) comAcordo++;
    for (const c of p.campos_do_acordo_prime ?? []) campos.add(String(c));
    docsPrime += Number(p.docs_prime_total ?? (p.docs_prime ?? []).length) || 0;
    docsCasados += Number(l?.crm?.docs_casados_total) || 0;

    // Parcelas pagas x não pagas: só quando a própria resposta trouxer a lista
    // E um campo de situação/pagamento. Nunca inferido por ausência — é a
    // diferença entre medir e supor.
    const ac = p.amostra_acordo ?? null;
    const parcelas = ac?.newInstallments ?? ac?.installments ?? null;
    if (Array.isArray(parcelas)) {
      for (const parc of parcelas) {
        const alvo = parc ?? {};
        const temSinal =
          "paymentDate" in alvo ||
          "paidAmount" in alvo ||
          "status" in alvo ||
          "situation" in alvo;
        if (!temSinal) continue;
        situacaoConhecida = true;
        const pago =
          alvo.paymentDate != null ||
          Number(alvo.paidAmount) > 0 ||
          /quitad|pag/i.test(String(alvo.status ?? alvo.situation ?? ""));
        if (pago) parcelasPagas++;
        else parcelasNaoPagas++;
      }
    }
  }

  return {
    consultas: linhas.length,
    com_acordo: comAcordo,
    acordos_encontrados: acordos,
    campos: Array.from(campos).sort(),
    docs_prime: docsPrime,
    docs_casados: docsCasados,
    parcelas_pagas: parcelasPagas,
    parcelas_nao_pagas: parcelasNaoPagas,
    // false = a resposta não trouxe campo de situação. NÃO significa "não há
    // parcela não paga".
    situacao_conhecida: situacaoConhecida,
  };
}
