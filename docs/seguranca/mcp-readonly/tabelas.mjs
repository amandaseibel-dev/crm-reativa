export const TABELAS_AUTORIZADAS = new Set([
  "acordos", "alunos", "borderos", "casos",
  "importacoes", "importacoes_acordos", "operadores",
  "pagamentos", "parcelas", "usuarios",
]);

export function validarTabela(tabela) {
  if (!TABELAS_AUTORIZADAS.has(tabela)) {
    throw new Error(`[BLOQUEADO] Tabela '${tabela}' não autorizada.`);
  }
}
