-- COPIA BYTE A BYTE DE PRODUCAO, medida em 22/10/2026.
--
-- Esta e a funcao que decide URGENTE. Ela entra no teste de regressao do
-- `termo_pendente` porque e o unico lugar onde os pesos, os limiares e a
-- escada de 8/9/10 dias viram uma palavra -- testar a regra com uma versao
-- reescrita provaria o teste, nao a producao.
--
-- O corpo (prosrc) e conferido por md5 no proprio teste:
--   md5  = b0e1c029d9c35701d8caf60a0be854de
--   char = 2675
-- Reconferir em producao com:
--   select md5(prosrc), length(prosrc) from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'calibragem_nivel_criticidade';
--
-- Nenhuma linha abaixo pode ser editada: a migration do termo NAO toca esta
-- funcao, e o teste existe justamente para provar isso.
CREATE OR REPLACE FUNCTION public.calibragem_nivel_criticidade(p_dias_venc integer, p_dias_sem_ac integer, p_valor numeric, p_termo_pendente boolean, p_fim_mes boolean, p_regras jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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

  -- ESCADA POR DIAS SEM ACIONAMENTO (Amanda, 02/09): "8 urgente, 9 critico,
  -- 10 perdendo caso". E PISO, nunca teto: o score ainda pode subir o nivel,
  -- nunca baixar. Sem a chave `escada_dias` nas regras, nada disto dispara e a
  -- funcao se comporta como antes.
  --
  -- O dia 10 fecha com a fidelizacao: `caso_dentro_prazo_fidelizacao` protege
  -- ate dua+10, e no 11o o caso pode ser retirado. "PERDENDO" e o aviso do
  -- ultimo dia em que ainda da para segurar.
  --
  -- Nunca acionado chega aqui como 9999 e cai em PERDENDO de proposito: a
  -- fidelizacao so comeca no 1o acionamento, entao esse caso nao esta protegido.
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
