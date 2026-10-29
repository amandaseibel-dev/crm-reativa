// TRIAGEM DA FILA DE PAGAMENTOS — a logica da faixa, separada da tela.
//
// A classificacao e TODA do banco (`vw_fila_pagamento_triagem`). Aqui nao se
// decide categoria nenhuma: so se agrupa, se conta, se ordena e se descobre
// quem a lista principal nao mostra. Manter isto fora do JSX e o que permite
// testar o fechamento das contas sem montar componente.
//
// A ORDEM DAS CATEGORIAS E A ORDEM DE TRABALHO, nao alfabetica: primeiro o que
// o Administrativo resolve hoje, depois o que espera informacao, depois o que
// esta parado por decisao de configuracao, e por fim o que precisa de
// conferencia caso a caso.

export const CATEGORIAS = {
  ACIONAVEL_ADMINISTRATIVO: {
    ordem: 1,
    rotulo: "Acionável agora",
    ajuda: "Tem caminho pronto: escolher o aluno sugerido ou conferir e encerrar a parcela já paga.",
    tom: "verde",
  },
  AGUARDANDO_INFORMACAO_ACORDO: {
    ordem: 2,
    rotulo: "Aguardando o acordo",
    ajuda: "Falta a estrutura do acordo, que a API da Prime não entrega hoje. Não há ação no CRM.",
    tom: "azul",
  },
  BLOQUEADO_ETAPA_DESATIVADA: {
    ordem: 3,
    rotulo: "Parado por etapa desligada",
    ajuda:
      "A única saída automática depende de uma etapa que a gestão desligou. " +
      "Enquanto ela estiver desligada, a rodada horária reencosta na linha sem poder resolver.",
    tom: "ambar",
  },
  CONFERENCIA_HUMANA: {
    ordem: 4,
    rotulo: "Divergência a conferir",
    ajuda:
      "Precisa de conferência caso a caso. Nenhuma ação genérica é segura aqui — " +
      "inclui o que já tem decisão registrada e continua pendente.",
    tom: "vermelho",
  },
};

// Rotulos dos submotivos. Texto curto, porque vive dentro da linha. Submotivo
// desconhecido NAO desaparece: devolve o proprio codigo, para a tela mostrar
// algo verdadeiro em vez de vazio.
export const SUBCATEGORIAS = {
  escolher_aluno_sugerido: "Há sugestão de aluno para escolher",
  ja_paga_conferir_e_encerrar: "Parcela já estava paga: conferir e encerrar",
  acordo_ausente_no_crm: "Acordo não está no CRM",
  consulta_portador: "Consulta ao portador está desligada",
  decidida_mas_ainda_pendente: "Tem decisão registrada e continua pendente",
  acordo_sem_parcela_livre: "Acordo sem parcela livre para o boleto",
  parcela_paga_antes_da_extracao: "Parcela paga antes da extração",
  acordo_cancelado_fluxo_proprio: "Acordo cancelado: tratado na fila própria",
  boleto_reemitido_vencimento_anterior: "Boleto reemitido: vencimento da parcela anterior",
  valor_fora_da_faixa: "Valor fora da faixa aceita",
  pendente_sem_linha_na_fila: "Pendente sem linha na fila",
  nao_classificado: "Sem classificação — conferir",
};

export function rotuloSubcategoria(sub) {
  if (!sub) return "—";
  return SUBCATEGORIAS[sub] || sub;
}

const soma = (linhas) => linhas.reduce((s, l) => s + Number(l.valor_pago || 0), 0);

// Indexa a triagem por pagamento para a linha da lista principal poder exibir a
// sua categoria sem varrer o array a cada render.
export function indexarTriagem(triagem) {
  const mapa = new Map();
  for (const t of triagem || []) if (t && t.pagamento_id) mapa.set(t.pagamento_id, t);
  return mapa;
}

// O resumo da faixa. Devolve SEMPRE as quatro categorias, inclusive as de
// contagem zero: uma faixa que esconde a categoria vazia faz a pessoa achar
// que a categoria nao existe.
export function resumoPorCategoria(triagem) {
  const porCat = new Map();
  for (const chave of Object.keys(CATEGORIAS)) porCat.set(chave, []);
  for (const t of triagem || []) {
    if (!t || !t.categoria) continue;
    if (!porCat.has(t.categoria)) porCat.set(t.categoria, []);
    porCat.get(t.categoria).push(t);
  }
  return [...porCat.entries()]
    .map(([categoria, itens]) => ({
      categoria,
      rotulo: CATEGORIAS[categoria]?.rotulo || categoria,
      ajuda: CATEGORIAS[categoria]?.ajuda || "",
      tom: CATEGORIAS[categoria]?.tom || "cinza",
      quantidade: itens.length,
      valor: soma(itens),
      // A etapa que explica a parada, quando a categoria inteira aponta para a
      // mesma. Mais de uma etapa -> nula, porque nomear uma seria escolher.
      etapa: (() => {
        const etapas = [...new Set(itens.map((i) => i.etapa_desligada).filter(Boolean))];
        return etapas.length === 1 ? etapas[0] : null;
      })(),
      // Submotivos da categoria, do maior volume de dinheiro para o menor.
      submotivos: [
        ...itens
          .reduce((m, i) => {
            const k = i.subcategoria || "nao_classificado";
            const a = m.get(k) || { subcategoria: k, quantidade: 0, valor: 0 };
            a.quantidade += 1;
            a.valor += Number(i.valor_pago || 0);
            return m.set(k, a);
          }, new Map())
          .values(),
      ].sort((a, b) => b.valor - a.valor),
    }))
    .sort((a, b) => (CATEGORIAS[a.categoria]?.ordem ?? 99) - (CATEGORIAS[b.categoria]?.ordem ?? 99));
}

export function totalDaTriagem(triagem) {
  return { quantidade: (triagem || []).length, valor: soma(triagem || []) };
}

// AS PENDENCIAS QUE A LISTA PRINCIPAL NAO MOSTRA — o ponto do item 3.
//
// `pagamentos_sem_aluno` exclui quem tem decisao registrada na fila:
//
//     and not exists (... fd.decisao is not null)
//
// O mesmo predicado esta em `fluxo_pagamentos_incremental`. Decididas, saem da
// tela; decididas, a rodada as pula. Sao 33 em producao (R$ 83.203,30), com
// status de conciliacao ainda pendente. Esta funcao e o que as traz de volta
// para a conferencia, sem mexer na RPC da lista principal -- que e compartilhada
// com outras frentes.
export function pendenciasSoNaTriagem(triagem, linhas) {
  const naLista = new Set((linhas || []).map((l) => l && l.pagamento_id).filter(Boolean));
  return (triagem || [])
    .filter((t) => t && t.pagamento_id && !naLista.has(t.pagamento_id))
    .sort((a, b) => Number(b.valor_pago || 0) - Number(a.valor_pago || 0));
}

// Filtra a lista principal pela categoria escolhida na faixa. Pagamento que nao
// esta na triagem (ela pode ter falhado ou estar indisponivel) permanece visivel
// em "TODAS": filtrar por ausencia de dado esconderia pendencia.
// DE QUE ARQUIVO VEIO CADA PENDENCIA (23/10/2026).
//
// `fila_pagamento_sem_vinculo` ja guarda `importacao_id` e `arquivo_nome`, e em
// 23/10/2026 as 420 pendencias abertas em producao tinham os dois preenchidos
// (420/420). O que faltava era a fila mostrar. Aqui nao se infere nada: se o
// banco nao mandou arquivo, a linha cai num balde proprio e a tela diz isso --
// chutar o arquivo seria pior do que nao saber.
//
// Uma linha por arquivo, da que mais pesa para a que menos pesa. O balde sem
// arquivo vai sempre por ULTIMO, mesmo que seja o maior: ele nao e um arquivo,
// e deixa-lo no topo faria a faixa parecer dizer que a maior origem e "nenhuma".
export const SEM_ARQUIVO = "(sem arquivo registrado)";

export function resumoPorArquivo(triagem) {
  const porArquivo = new Map();
  for (const t of triagem || []) {
    if (!t) continue;
    const nome = String(t.arquivo_nome || "").trim() || SEM_ARQUIVO;
    if (!porArquivo.has(nome)) {
      porArquivo.set(nome, {
        arquivo_nome: nome,
        importacao_id: nome === SEM_ARQUIVO ? null : t.importacao_id || null,
        itens: 0,
        valor: 0,
      });
    }
    const linha = porArquivo.get(nome);
    linha.itens += 1;
    const v = Number(t.valor_pago);
    if (Number.isFinite(v)) linha.valor += v;
  }
  return [...porArquivo.values()].sort((a, b) => {
    if (a.arquivo_nome === SEM_ARQUIVO) return 1;
    if (b.arquivo_nome === SEM_ARQUIVO) return -1;
    if (b.itens !== a.itens) return b.itens - a.itens;
    return a.arquivo_nome.localeCompare(b.arquivo_nome);
  });
}

// O rotulo do recorte quando a fila foi aberta a partir de um arquivo.
//
// Devolve null quando nao ha recorte -- e `null` NAO e "nenhum resultado": e
// "sem filtro", e a tela nao deve mostrar faixa de recorte nesse caso. Quando
// ha recorte mas nenhuma linha daquele arquivo, o nome vem vazio e a tela diz
// que o recorte nao tem pendencia, em vez de sugerir que o arquivo nao existe.
export function recorteDoArquivo(triagem, importacaoId) {
  const id = String(importacaoId || "").trim();
  if (!id) return null;
  const doArquivo = (triagem || []).filter((t) => t && t.importacao_id === id);
  const nome = doArquivo.find((t) => String(t.arquivo_nome || "").trim())?.arquivo_nome || "";
  return {
    importacao_id: id,
    arquivo_nome: String(nome || "").trim(),
    itens: doArquivo.length,
    valor: doArquivo.reduce((soma, t) => {
      const v = Number(t?.valor_pago);
      return Number.isFinite(v) ? soma + v : soma;
    }, 0),
  };
}

export function filtrarPorCategoria(linhas, mapaTriagem, categoria) {
  if (!categoria || categoria === "TODAS") return linhas || [];
  return (linhas || []).filter((l) => mapaTriagem.get(l?.pagamento_id)?.categoria === categoria);
}

// O RECORTE DO BLOCO "fora da lista acima" (27/10/2026).
//
// POR QUE EXISTE. `pendenciasSoNaTriagem` devolve tudo que a lista principal
// nao trouxe -- nao so as decididas. Quando `pagamentos_sem_aluno` estoura o
// `statement_timeout` de 8 s (medido em producao: 13,2 s), `linhas` fica vazia
// e TODA a pendencia cai nesse bloco. O titulo entao afirmava que as 470 tinham
// "decisao registrada", o que e falso, e o bloco nao oferecia acao nenhuma --
// deixando sem botao os casos que a triagem declara acionaveis.
//
// Esta funcao e so o recorte e a contagem: nao classifica nada e nao decide
// quem ganha botao (isso e de `podeEncaminhar`, no vocabulario do
// encaminhamento). Fica aqui, fora do JSX, para ter teste sem montar tela.
export function recorteForaDaLista(foraDaLista, categoria) {
  const todas = Array.isArray(foraDaLista) ? foraDaLista.filter(Boolean) : [];
  // Categoria ausente ou "TODAS" nao filtra. Filtrar por ausencia de dado
  // esconderia pendencia -- mesma regra de `filtrarPorCategoria`.
  const itens =
    !categoria || categoria === "TODAS"
      ? todas
      : todas.filter((l) => l.categoria === categoria);
  return {
    itens,
    quantidade: itens.length,
    comDecisao: itens.filter((l) => l.decisao).length,
    valor: soma(itens),
  };
}
