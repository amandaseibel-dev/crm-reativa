-- Reversão de 20261112120000_preventivo_visao_geral_historico.sql.
-- Só funções novas de leitura: remover não afeta nenhum dado.
drop function if exists public.preventivo_aluno_historico(text);
drop function if exists public.preventivo_remessa_mudancas(uuid);
drop function if exists public.preventivo_visao_geral(text);
drop function if exists public.preventivo_periodo_academico(date);
