// CONFERÊNCIA POR ARQUIVO — os rótulos e o fechamento das contas, fora do JSX.
//
// Nenhuma categoria é decidida aqui: quem classifica é a view
// `vw_importacao_conferencia`, no banco. Este arquivo só nomeia, ordena e
// CONFERE se a conta fecha. Manter isto fora do componente é o que permite
// testar o fechamento sem montar React.
//
// A ORDEM É A DE TRABALHO, não alfabética: primeiro o que precisa de gente,
// depois o que já está resolvido, e por último o que está fora da janela por
// decisão da gestão.

import { rotuloSubcategoria } from "./filaPagamentoTriagem";

export const CATEGORIAS = {
  DIVERGENCIA: {
    ordem: 1,
    rotulo: "Divergência",
    ajuda: "Precisa de conferência caso a caso. Nenhuma ação genérica é segura aqui.",
    tom: "vermelho",
    campoQtd: "divergencia",
    campoValor: "divergencia_valor",
  },
  SEM_VINCULO: {
    ordem: 2,
    rotulo: "Sem vínculo",
    ajuda: "O acordo não está no CRM. A estrutura não vem da API da Prime hoje.",
    tom: "ambar",
    campoQtd: "sem_vinculo",
    campoValor: "sem_vinculo_valor",
  },
  BAIXA_PENDENTE: {
    ordem: 3,
    rotulo: "Baixa pendente",
    ajuda: "Importado, sem baixa registrada, e com caminho de resolução aberto.",
    tom: "azul",
    campoQtd: "baixa_pendente",
    campoValor: "baixa_pendente_valor",
  },
  BAIXA_REGISTRADA_CRM: {
    ordem: 4,
    rotulo: "Baixa registrada no CRM",
    // A fronteira que a gestão pediu para preservar, escrita no rótulo e na
    // ajuda em vez de deixada implícita: existe parcela apontando para este
    // pagamento. Isso NÃO é afirmação de pagamento bancário comprovado -- a
    // evidência bancária é o próprio arquivo do Santander, que originou a linha.
    ajuda:
      "Existe parcela no CRM apontando para este pagamento (origem_baixa_ref). " +
      "Não é afirmação de comprovação bancária: a evidência bancária é o próprio arquivo.",
    tom: "verde",
    campoQtd: "baixa_registrada_crm",
    campoValor: "baixa_registrada_valor",
  },
  FORA_DA_JANELA: {
    ordem: 5,
    rotulo: "Fora da janela",
    ajuda:
      "Pagamento anterior a 14/09/2026, que o motor não avalia por decisão da gestão. " +
      "Não é pendência.",
    tom: "cinza",
    campoQtd: "fora_da_janela",
    campoValor: "fora_da_janela_valor",
  },
  NAO_CLASSIFICADO: {
    ordem: 6,
    rotulo: "Não classificado",
    ajuda:
      "Não foi possível apurar a categoria com segurança. Aparece aqui em vez de " +
      "ser somado no lugar errado.",
    tom: "vermelho",
    campoQtd: "nao_classificado",
    campoValor: null,
  },
};

export function rotuloCategoria(chave) {
  return CATEGORIAS[chave]?.rotulo || chave || "—";
}

const numero = (v) => Number(v || 0);

// O resumo de um arquivo, na ordem de trabalho. Categoria com zero NÃO
// desaparece: sumir com ela faria a gestão não saber se é zero ou se a tela
// deixou de contar.
export function resumoDoArquivo(arquivo) {
  if (!arquivo) return [];
  return Object.entries(CATEGORIAS)
    .sort((a, b) => a[1].ordem - b[1].ordem)
    .map(([chave, meta]) => ({
      chave,
      rotulo: meta.rotulo,
      ajuda: meta.ajuda,
      tom: meta.tom,
      qtd: numero(arquivo[meta.campoQtd]),
      valor: meta.campoValor ? numero(arquivo[meta.campoValor]) : null,
    }));
}

// O FECHAMENTO DAS CONTAS, na tela e não só no teste. A gestão pediu
// explicitamente "totais conciliáveis, sem duplicar pagamentos entre
// categorias" -- então a tela confere e, se não fechar, DIZ, em vez de exibir
// um número que não soma.
export function fechamento(arquivo) {
  if (!arquivo) return { fecha: true, qtdSoma: 0, qtdTotal: 0, valorSoma: 0, valorTotal: 0 };
  const itens = resumoDoArquivo(arquivo);
  const qtdSoma = itens.reduce((s, i) => s + i.qtd, 0);
  const valorSoma = itens.reduce((s, i) => s + (i.valor || 0), 0);
  const qtdTotal = numero(arquivo.pagamentos);
  const valorTotal = numero(arquivo.valor_total);
  return {
    qtdSoma,
    qtdTotal,
    valorSoma,
    valorTotal,
    // Centavos: comparar float direto erraria por arredondamento.
    fecha: qtdSoma === qtdTotal && Math.round(valorSoma * 100) === Math.round(valorTotal * 100),
  };
}

export const dinheiro = (v) =>
  numero(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const contagem = (v) => numero(v).toLocaleString("pt-BR");

// Rótulo de um arquivo na lista. Arquivo com zero pagamento aparece dizendo
// isso -- em produção há 230 deles, e esconder faria a gestão não distinguir
// "importou zero" de "o arquivo não está aqui".
export function rotuloArquivo(arquivo) {
  if (!arquivo) return "—";
  const quando = arquivo.importado_em
    ? new Date(arquivo.importado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "—";
  const n = numero(arquivo.pagamentos);
  const quantos = n === 0 ? "nenhum pagamento" : n === 1 ? "1 pagamento" : `${contagem(n)} pagamentos`;
  const substituida = arquivo.importacao_status && arquivo.importacao_status !== "CONCLUIDO"
    ? ` · ${arquivo.importacao_status}`
    : "";
  return `${arquivo.arquivo_nome || "(sem nome)"} — ${quando} · ${quantos}${substituida}`;
}

// O motivo de uma linha, reaproveitando o vocabulário da #737. Sem motivo
// devolve "—" em vez de string vazia, para a célula não ficar muda.
export function motivoDaLinha(linha) {
  if (!linha) return "—";
  if (linha.triagem_subcategoria) return rotuloSubcategoria(linha.triagem_subcategoria);
  if (linha.triagem_motivo) return linha.triagem_motivo;
  if (linha.categoria === "BAIXA_REGISTRADA_CRM") return "Baixa registrada";
  if (linha.categoria === "FORA_DA_JANELA") return "Anterior a 14/09/2026";
  return "—";
}

// A evidência que sustenta a afirmação de baixa. Sem isto a tela diria
// "baixado" sem poder mostrar o que prova.
export function evidenciaDaLinha(linha) {
  if (!linha?.parcela_baixada_id) return null;
  const quando = linha.baixa_em
    ? new Date(linha.baixa_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : null;
  return [linha.baixa_origem || "origem não registrada", quando].filter(Boolean).join(" · ");
}
