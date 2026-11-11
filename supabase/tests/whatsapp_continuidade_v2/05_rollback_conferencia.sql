-- ROLLBACK — conferência DEPOIS de aplicar
-- 20261109120000_whatsapp_continuidade_v2.rollback.sql
--
-- Pré-condição: 01 → 02 → migration v2 → 03 → 04 → rollback, nesta ordem.
--
-- Prova três coisas:
--   1. a função voltou a NÃO ter CONTINUIDADE
--   2. os dois parâmetros desapareceram de whatsapp_config
--   3. o comportamento voltou a ser o da regra ATUAL: o cenário que a v2
--      classificava como CONTINUIDADE volta a ser NOVA_ABORDAGEM
--   4. os grants continuam corretos (authenticated nao, anon nao; so service_role)
--   5. resposta_janela_horas segue 24 — o rollback não mexe nela

\set ON_ERROR_STOP on

drop table if exists _cont_v2_rollback;
create table _cont_v2_rollback (n int, caso text, esperado text, obtido text, ok boolean);

do $rb$
declare
  v_canal uuid;
  v_c     uuid;
  v_op    text := 'op1_cont_v2@test.local';
  v_tem   boolean;
  v_cols  integer;
begin
  -- 1. função sem CONTINUIDADE
  select prosrc ilike '%CONTINUIDADE%' into v_tem
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'whatsapp_cadencia_checar';
  insert into _cont_v2_rollback values
    (1, 'funcao nao contem mais CONTINUIDADE', 'false', coalesce(v_tem,true)::text, null);

  -- 2. parâmetros removidos
  select count(*) into v_cols from information_schema.columns
   where table_schema = 'public' and table_name = 'whatsapp_config'
     and column_name in ('continuidade_janela_horas','continuidade_max_sem_resposta');
  insert into _cont_v2_rollback values
    (2, 'parametros de continuidade removidos', '0', v_cols::text, null);

  -- 3. comportamento volta ao da regra atual.
  -- Mesmo cenário do caso 1 de 03_casos_v2.sql: envio anterior do operador
  -- (que era RESPOSTA) e aluno respondeu há 40h. Com a v2 era CONTINUIDADE.
  v_canal := public._t_canal('_cont_v2_rb', 'ATIVO_CONTROLADO', 5, null);
  v_c := public._t_conversa(v_canal, '5551900400001');
  perform public._t_msg(v_c, 'ENTRADA', 48);
  perform public._t_msg(v_c, 'SAIDA',   46, v_op);
  perform public._t_msg(v_c, 'ENTRADA', 40);
  insert into _cont_v2_rollback values
    (3, 'cenario de CONTINUIDADE volta a ser NOVA_ABORDAGEM',
     'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op), null);

  -- 4. grants
  insert into _cont_v2_rollback values
    (4, 'authenticated SEM EXECUTE (producao so service_role)', 'false',
     has_function_privilege('authenticated',
       'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text, null);
  insert into _cont_v2_rollback values
    (4, 'anon NAO tem EXECUTE', 'false',
     has_function_privilege('anon',
       'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text, null);

  -- 5. resposta_janela_horas intocada
  insert into _cont_v2_rollback values
    (5, 'resposta_janela_horas segue 24', '24',
     (select resposta_janela_horas from public.whatsapp_config limit 1)::text, null);

  update _cont_v2_rollback set ok = (obtido = esperado);
end $rb$;

select n, caso, esperado, obtido,
       case when ok then 'OK' else 'FALHOU' end as veredito
  from _cont_v2_rollback order by n;

do $final$
declare v_falhas integer; v_total integer;
begin
  select count(*) filter (where ok is not true), count(*)
    into v_falhas, v_total from _cont_v2_rollback;
  raise notice 'ROLLBACK: % assercoes, % falhas', v_total, v_falhas;
  if v_falhas > 0 then
    raise exception 'rollback: % assercoes falharam', v_falhas using errcode = '22023';
  end if;
end $final$;
