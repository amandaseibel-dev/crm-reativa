-- Acionar deixava de proteger o caso: quem foi trabalhado ontem seguia CRITICO.
--
-- Amanda, 31/08: "ajuste os casos como critico, tem alunos com acionamento dia
-- 28/08 como critico".
--
-- O DIAGNOSTICO. A criticidade nao estava velha -- o cron das 06:00 roda todo
-- dia e rodou hoje, em 50s, com sucesso. Era a REGRA. Os pesos so sabiam PUNIR
-- a ausencia ("sem acionamento ha 10 dias ou mais: +2"); nao havia nada que
-- reconhecesse o acionamento FEITO. Entao um caso com divida vencida (+2),
-- termo pendente (+2) e fim de mes (+1) fecha 5 e vira CRITICO mesmo tendo sido
-- acionado ontem.
--
-- Repare no efeito do fim de mes: nos ultimos 5 dias de CADA mes, todo mundo
-- ganha +1 de graca. E quando a carteira inteira fica vermelha.
--
-- Medido em 31/08 antes da mudanca: 13.040 de 13.373 casos abertos estavam
-- CRITICO -- 97,5%. Criticidade que marca quase todo mundo nao ordena nada, e o
-- operador perde a unica pista que a fila lhe da sobre o que olhar primeiro.
--
-- A CORRECAO. Um peso NEGATIVO para acionamento recente, na mesma estrutura dos
-- outros -- nao um caso especial no codigo. A janela de 10 dias e a mesma que o
-- resto do sistema ja usa para "dentro do prazo".
--
-- COMPATIVEL COM O QUE JA EXISTE: sem a chave `acionado_recente` nas regras, o
-- `max` cai para -1 e a condicao nunca dispara -- a funcao se comporta
-- exatamente como antes. Isso importa porque a Calibragem chama esta mesma
-- funcao para simular cenarios com regras proprias, e a simulacao nao pode
-- mudar de resultado por causa desta migration.
--
-- MEDIDO DEPOIS DE APLICAR (recalculo de 14.108 alunos, 0 erros):
--
--                 antes    depois   acionados de 28/08 pra ca
--   CRITICO      13.040     7.516        0   <- era 2.775
--   URGENTE          63     5.525    2.775
--   ATENCAO           0        60       27
--   NORMAL          270       271       37
--
-- OS DOIS NUMEROS SAO AJUSTAVEIS SEM MIGRATION, em `calibragem_parametros`,
-- chave `criticidade_regras`, em `pesos.acionado_recente`:
--   `max`  = ate quantos dias o acionamento ainda conta como recente (hoje 10)
--   `peso` = quanto desconta da pontuacao                            (hoje -2)
--
-- DESFAZER: supabase/rollbacks/20260831130000_criticidade_desconta_acionamento_recente.rollback.sql

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

  -- ACIONAMENTO RECENTE: peso negativo. Sem a chave nas regras o `max` cai para
  -- -1 e isto nunca dispara -- a funcao segue identica a de antes.
  if coalesce(p_dias_sem_ac, 9999) <= coalesce((p->'acionado_recente'->>'max')::int, -1)
    then s := s + coalesce((p->'acionado_recente'->>'peso')::numeric,0); end if;

  if    s >= coalesce((n->>'critico')::numeric,5) then return 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric,3) then return 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric,1) then return 'ATENCAO';
  else  return 'NORMAL'; end if;
end; $function$;

-- A janela de 10 dias e a mesma do "dentro do prazo" que o resto do sistema usa.
update public.calibragem_parametros
   set valor = jsonb_set(valor, '{pesos,acionado_recente}',
                         '{"max": 10, "peso": -2}'::jsonb, true)
 where chave = 'criticidade_regras';

-- Sem isto a carteira so mudaria na virada das 06:00 do dia seguinte.
-- Executado em prod em 31/08: 14.108 alunos recalculados, 0 erros.
-- select public.recalcular_situacao_virada_diaria('ajuste_criticidade_31_08');
