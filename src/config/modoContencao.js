// KILL SWITCH TEMPORÁRIO — contenção de carga analítica (incidente P0).
//
// Ponto ÚNICO de verdade. Enquanto `true`, todas as chamadas analíticas
// pesadas (projeções, dashboards, contadores, métricas de carteira) ficam
// suspensas no frontend para não saturar o Supabase. Os fluxos operacionais
// (login, busca/ficha de aluno, casos, acordos, links, baixa, fila, etc.)
// NÃO são afetados.
//
// Para reativar as analíticas quando o banco estabilizar: trocar para `false`
// e publicar. (Não depende de banco, RPC, migration ou config do Supabase.)
export const MODO_CONTENCAO_ANALITICAS = true;

// Helper único usado por todos os gates.
export function analiticasSuspensas() {
  return MODO_CONTENCAO_ANALITICAS === true;
}

export const MENSAGEM_CONTENCAO =
  "Modo de contenção ativo. Indicadores temporariamente pausados. Os atendimentos continuam disponíveis.";
