-- ROLLBACK de 20260726180000_bloquear_anon_definer_projecao_suspeitas.sql
--
-- ATENÇÃO — RISCO DE SEGURANÇA / LGPD: este script REABRE a exposição ANÔNIMA.
-- Ao reconceder EXECUTE a PUBLIC/anon, as 5 funções SECURITY DEFINER voltam a
-- ser executáveis pelo papel `anon` via /rest/v1/rpc/*, reintroduzindo exatamente
-- os 5 alertas `anon_security_definer_function_executable` do Security Advisor,
-- incluindo dados financeiros e a função de trigger chamável pela API. Use apenas
-- em emergência de compatibilidade e reative a proteção assim que possível.
--
-- Este rollback NÃO fica em supabase/migrations e NÃO altera nenhum dado.
-- Só mexe em GRANTs; os corpos com gate permanecem (o gate ainda protege contra
-- inativos/sem-cadastro mesmo com anon reconcedido — para reverter o gate seria
-- necessário recriar os corpos originais, o que este script deliberadamente NÃO faz).

-- Reabre execução para PUBLIC (inclui anon) nas 4 funções expostas por API:
GRANT EXECUTE ON FUNCTION public.projecao_dashboard(text,text,text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.projecao_unidades_disponiveis() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.projecao_suspeitas_pagamentos_duplicados() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text) TO PUBLIC;

-- Reabre a função de trigger para anon/authenticated/PUBLIC (estado anterior):
GRANT EXECUTE ON FUNCTION public.trg_detectar_suspeita_duplicidade() TO anon, authenticated, PUBLIC;
