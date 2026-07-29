// KILL SWITCH TEMPORÁRIO — contenção de carga analítica (incidente P0).
//
// Ponto ÚNICO de verdade. Enquanto `true`, todas as chamadas analíticas
// pesadas (projeções, dashboards, contadores, métricas de carteira) ficam
// suspensas no frontend para não saturar o Supabase. Os fluxos operacionais
// (login, busca/ficha de aluno, casos, acordos, links, baixa, fila, etc.)
// NÃO são afetados.
//
// Controle por ambiente (seguro): PADRÃO = true (produção permanece contida).
// Só desliga quando VITE_MODO_CONTENCAO_ANALITICAS === "false" — o que fazemos
// APENAS na Vercel Preview conectada ao staging. Production não tem essa var,
// então continua `true` (analíticas suspensas). Nunca usar "false" em Production.
const _RAW_CONTENCAO = import.meta.env?.VITE_MODO_CONTENCAO_ANALITICAS;
export const MODO_CONTENCAO_ANALITICAS =
  _RAW_CONTENCAO === undefined ? true : String(_RAW_CONTENCAO).toLowerCase() !== "false";

// Helper único usado por todos os gates.
export function analiticasSuspensas() {
  return MODO_CONTENCAO_ANALITICAS === true;
}

export const MENSAGEM_CONTENCAO =
  "Modo de contenção ativo. Indicadores temporariamente pausados. Os atendimentos continuam disponíveis.";
