// C2 -- regras puras do mural de ideias. Ficam fora do .jsx porque o componente
// so pode exportar componente (react-refresh/only-export-components).

export const SEM_IDEIAS = "Nenhuma ideia em avaliação no momento. Envie a sua.";

// Áreas que o Portal oferece. As três primeiras já são o vocabulário do Painel de
// Sugestões; as demais cobrem os temas que a Home pede (atendimento, processos,
// operação, ambiente de trabalho) e entram como `area` — a coluna é texto livre,
// então a gestão passa a ver essas áreas novas no Painel.
export const AREAS = [
  "Atendimento",
  "Processos",
  "Operação",
  "Ambiente de trabalho",
  "Sistema ReATIVA",
  "CRM Mensageria",
  "Portal Reativa",
];

// A ideia entra no MESMO fluxo do Painel de Sugestões. `tipo` e `tela` já existem
// no vocabulário de lá e marcam a origem para a gestão triar.
export const TIPO_IDEIA = "Nova ideia";
export const TELA_IDEIA = "Portal — Ideias da equipe";

export const LIMITE_DESCRICAO = 500;

export function validarIdeia({ descricao, area }) {
  const texto = String(descricao || "").trim();
  if (texto.length < 10) return "Escreva a ideia com pelo menos 10 caracteres.";
  if (texto.length > LIMITE_DESCRICAO) return `A ideia tem no máximo ${LIMITE_DESCRICAO} caracteres.`;
  if (!AREAS.includes(area)) return "Escolha a área da ideia.";
  return null;
}

export const ORDENS = [
  { valor: "curtidas", rotulo: "Mais curtidas" },
  { valor: "recentes", rotulo: "Mais recentes" },
];

// Status REAIS do fluxo de sugestoes, conferidos em producao em 30/09/2026:
// FEITA (43), DESCARTADA (2), REABERTO (2), NOVA (1). Nao ha CHECK na coluna -- o
// dominio e definido pelo Painel de Sugestoes, e esta tela apenas TRADUZ para
// rotulo legivel. Nao inventa status, nao altera o fluxo e nao escreve nada.
//
// "Em analise" e "Aprovada" nao existem no fluxo atual, entao nao aparecem aqui:
// inventa-las criaria vocabulario que a gestao nao tem como preencher.
export const ROTULO_STATUS = {
  NOVA: "Nova",
  REABERTO: "Reaberta",
  FEITA: "Implementada",
  DESCARTADA: "Não seguirá",
};

// Status desconhecido nao vira erro nem some: aparece capitalizado. Se o Painel
// de Sugestoes ganhar um status novo, o mural continua legivel sem deploy --
// e a funcao do banco usa filtro negativo, entao ele tambem nao some do mural.
export function rotuloStatus(status) {
  const s = String(status || "").toUpperCase().trim();
  if (!s) return "Sem status";
  return ROTULO_STATUS[s] ?? (s.charAt(0) + s.slice(1).toLowerCase());
}
