-- Escada por dias sem acionamento: 8 urgente, 9 critico, 10 perdendo o caso.
--
-- Amanda, 02/09: "mensagem enviada deixe 7 dias apos o 8 urgente 9 critico
-- 10 perdendo caso". O prazo de 7 dias saiu em 20260902190000; aqui vem a
-- escada.
--
-- POR QUE NAO ERA SO CONFIGURAR. A criticidade nunca foi escada de dias: e
-- soma de pesos (vencido, valor, termo pendente, fim de mes) com corte em
-- 1/3/5 -> ATENCAO/URGENTE/CRITICO. Pior: o peso `acionado_recente` dava -2
-- para quem tinha ate 10 dias sem acionamento, ou seja, empurrava para NORMAL
-- exatamente nos dias 8, 9 e 10 -- o oposto do pedido.
--
-- TRES MUDANCAS:
--   1. `criticidade_rank` -- gravidade dos niveis. PERDENDO e o mais grave.
--   2. `calibragem_nivel_criticidade` aplica a escada como PISO: devolve o
--      mais grave entre o score e a escada. O score ainda sobe o nivel, nunca
--      baixa. Sem a chave `escada_dias` nas regras, nada dispara e a funcao se
--      comporta como antes.
--   3. `acionado_recente.max` de 10 para 7, para o bonus nao anular a escada.
--      7 e o mesmo prazo da tabulacao "Mensagem enviada".
--
-- O DIA 10 FECHA COM A FIDELIZACAO: `caso_dentro_prazo_fidelizacao` protege
-- ate dua+10 e o caso so pode ser retirado no 11o. "PERDENDO" e o aviso do
-- ultimo dia em que ainda da para segurar. Nunca acionado chega como 9999 e
-- cai em PERDENDO de proposito -- a fidelizacao so comeca no 1o acionamento.
--
-- MEDIDO EM PROD ANTES DE APLICAR (02/09, casos com operador e nao encerrados):
--   0-7 dias .................. 4.042 casos, sem escada
--   8 dias .................... 517 -> URGENTE (413 eram ATENCAO, 18 NORMAL)
--   9 dias .................... 416 -> CRITICO (326 eram ATENCAO, 11 NORMAL)
--   10+ ou nunca acionado ..... 671 -> PERDENDO (167 eram NORMAL)
--   Total que muda de nivel: 1.604.
--
-- Os niveis gravados em alunos/casos so mudam quando `recalcular_situacao_aluno`
-- roda; o cron `recalcular_situacao_virada_diaria` (06:00) faz a virada. Nao foi
-- forcado recalculo geral no expediente por causa do historico de brownout.

create or replace function public.criticidade_rank(p_nivel text)
returns int
language sql
immutable
as $$
  select case upper(coalesce(p_nivel,''))
           when 'PERDENDO' then 4
           when 'CRITICO'  then 3
           when 'URGENTE'  then 2
           when 'ATENCAO'  then 1
           else 0
         end;
$$;

comment on function public.criticidade_rank(text) is
  'Gravidade dos niveis de criticidade, do menor para o maior. PERDENDO e o mais grave.';

create or replace function public.calibragem_nivel_criticidade(
  p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric,
  p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  s numeric := 0;
  p jsonb := p_regras->'pesos';
  n jsonb := p_regras->'niveis';
  e jsonb := p_regras->'escada_dias';
  v_score  text;
  v_escada text := null;
  d int := coalesce(p_dias_sem_ac, 0);
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

  if    s >= coalesce((n->>'critico')::numeric,5) then v_score := 'CRITICO';
  elsif s >= coalesce((n->>'urgente')::numeric,3) then v_score := 'URGENTE';
  elsif s >= coalesce((n->>'atencao')::numeric,1) then v_score := 'ATENCAO';
  else  v_score := 'NORMAL'; end if;

  -- ESCADA POR DIAS SEM ACIONAMENTO (Amanda, 02/09). E PISO, nunca teto.
  if e is not null then
    if    d >= coalesce((e->>'perdendo')::int, 2147483647) then v_escada := 'PERDENDO';
    elsif d >= coalesce((e->>'critico')::int,  2147483647) then v_escada := 'CRITICO';
    elsif d >= coalesce((e->>'urgente')::int,  2147483647) then v_escada := 'URGENTE';
    end if;
  end if;

  if v_escada is null then return v_score; end if;
  return case when public.criticidade_rank(v_escada) > public.criticidade_rank(v_score)
              then v_escada else v_score end;
end;
$function$;

update public.calibragem_parametros
   set valor = (valor
         || jsonb_build_object('escada_dias',
              jsonb_build_object('urgente', 8, 'critico', 9, 'perdendo', 10))
         || jsonb_build_object('pesos',
              (valor->'pesos') || jsonb_build_object('acionado_recente',
                 jsonb_build_object('max', 7, 'peso', -2)))),
       atualizado_em  = now(),
       atualizado_por = 'amanda.seibel@aelbra.com.br'
 where chave = 'criticidade_regras';
