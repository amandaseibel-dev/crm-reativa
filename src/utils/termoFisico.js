// Funções puras do registro administrativo do termo físico (sem React, para teste).

export const SITUACOES_TERMO_FISICO = Object.freeze({
  EM_ANDAMENTO: "Termo físico assinado, em andamento",
  ARQUIVADO: "Termo físico arquivado",
});

export function rotuloSituacaoTermoFisico(situacao) {
  return SITUACOES_TERMO_FISICO[situacao] || "Sem registro";
}

// "SEM_PERMISSAO" (o componente some) ou "FALHA_TECNICA" (o componente avisa).
export function classificarErroTermoFisico(error) {
  if (!error) return null;
  const code = String(error.code || "");
  const msg = String(error.message || "").toLowerCase();
  if (code === "42501" || msg.includes("sem permissão")) return "SEM_PERMISSAO";
  return "FALHA_TECNICA";
}
