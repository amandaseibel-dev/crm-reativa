-- ROLLBACK do alinhamento de prazo para data de Brasilia.
-- Volta a helper para current_date (corpo anterior, de producao).
begin;
create or replace function public.caso_dentro_prazo_fidelizacao(p_data_ultimo_acionamento date)
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  select p_data_ultimo_acionamento is not null
     and p_data_ultimo_acionamento + 10 >= current_date;
$function$;
-- casos_elegiveis_liberacao_fidelizacao: reverter o trecho de data (ancora inversa), mesma tecnica do patch.
do $rb$
declare
  v_def text := pg_get_functiondef('public.casos_elegiveis_liberacao_fidelizacao()'::regprocedure);
  v_novo text := '(c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)';
  v_ancora text := '(c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < (now() at time zone ''America/Sao_Paulo'')::date)';
begin
  if position(v_ancora in v_def) > 0 then
    execute replace(v_def, v_ancora, v_novo);
  end if;
end
$rb$;
-- MARCADOR: reverte o marcador do prazo somente se for exatamente o gravado (comentario anterior era nulo, verificado pela guarda).
do $rbm$ begin
  if obj_description(to_regprocedure('public.caso_dentro_prazo_fidelizacao(date)'), 'pg_proc') is distinct from 'ordem-953:prazo-20261114100000' then
    raise exception 'ROLLBACK PRAZO: marcador ausente ou alterado; nao remover.';
  end if;
  comment on function public.caso_dentro_prazo_fidelizacao(date) is null;
end $rbm$;

commit;
