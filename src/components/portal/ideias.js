// C2 -- regras puras do mural de ideias. Ficam fora do .jsx porque o componente
// so pode exportar componente (react-refresh/only-export-components).

export const SEM_IDEIAS = "Ainda não há ideias publicadas para a equipe.";

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
// de Sugestoes ganhar um status novo, o mural continua legivel sem deploy.
export function rotuloStatus(status) {
  const s = String(status || "").toUpperCase().trim();
  if (!s) return "Sem status";
  return ROTULO_STATUS[s] ?? (s.charAt(0) + s.slice(1).toLowerCase());
}
