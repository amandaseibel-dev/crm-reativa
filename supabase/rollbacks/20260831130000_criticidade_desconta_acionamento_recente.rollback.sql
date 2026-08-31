-- DESFAZER 20260831130000_criticidade_desconta_acionamento_recente.sql
--
-- ATENCAO: desfazer volta a marcar como CRITICO quem foi acionado ontem. Em
-- 31/08 isso eram 5.525 casos, e a criticidade voltava a marcar 97,5% da
-- carteira -- ou seja, a deixar de ordenar qualquer coisa.
--
-- ANTES DE DESFAZER, considere so AJUSTAR: os dois numeros ficam em
-- `calibragem_parametros`, chave `criticidade_regras`, em `pesos.acionado_recente`.
--   `max`  = quantos dias de acionamento ainda contam como recente (hoje 10)
--   `peso` = quanto desconta  (hoje -2)
-- Mexer neles nao exige migration nenhuma.

-- 1) tira o peso das regras
update public.calibragem_parametros
   set valor = valor #- '{pesos,acionado_recente}'
 where chave = 'criticidade_regras';

-- 2) volta a funcao sem o trecho do acionamento recente
create or replace function public.calibragem_nivel_criticidade(
  p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric,
  p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb
)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare s numeric := 0; p jsonb := p_regras->'pesos'; n jsonb := p_regras->'niveis';
begin
  if coalesce(p_dias_venc,0)   >= coalesce((p->'dias_vencido'->>'min')::int, 2147483647)        then s := s + coalesce((p->'dias_vencido'->>'peso')::numeric,0); end if;
  if coalesce(p_dias_sem_ac,0) >= coalesce((p->'dias_sem_acionamento'->>'min')::int, 2147483647) then s := s + coalesce((p->'dias_sem_acionamento'->>'peso')::numeric,0); end if;
  if coalesce(p_valor,0)       >= coalesce((p->'valor'->>'min')::numeric, 1e18)                   then s := s + coalesce((p->'valor'->>'peso')::numeric,0); end if;
  if coalesce(p_termo_pendente,false) then s := s + coalesce((p->'termo_pendente'->>'peso')::numeric,0); end if;
  if coalesce(p_fim_mes,false)        then s := s + coalesce((p->'fim_mes'->>'peso')::numeric,0); end if;
  if    s >= coalesce((n->>'critico')::numeric,5) then return 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric,3) then return 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric,1) then return 'ATENCAO';
  else  return 'NORMAL'; end if;
end; $function$;

-- 3) e preciso recalcular, senao a carteira fica com o valor da versao nova
-- select public.recalcular_situacao_virada_diaria('rollback_criticidade');
