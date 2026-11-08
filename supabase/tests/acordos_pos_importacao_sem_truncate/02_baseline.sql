-- Baseline: a função COMO ESTÁ hoje, antes do patch.
--
-- O corpo aqui é um STAND-IN SIMPLIFICADO: tem a mesma assinatura, os mesmos
-- DEFAULT, os mesmos SET, o mesmo portão interno e -- o que importa para este
-- teste -- a MESMA ÂNCORA, byte a byte:
--   execute format('alter table public.%I enable row level security', '_backup_pos_import_' || v_lote);
-- A lógica de negócio (casamento de parcela, updates, vínculos) foi deixada de
-- fora de propósito: o patch não toca nela, então reproduzi-la aqui não
-- provaria nada e só daria chance de divergir do real.
\set ON_ERROR_STOP on

create or replace function public.acordos_pos_importacao(
  p_importacao_id uuid default null::uuid,
  p_confirmar boolean default false
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
  set statement_timeout to '600s'
as $fn$
declare
  v_lote text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _alvo on commit drop as
  select t.* from public.acordos_titulos t
   where upper(coalesce(t.situacao,'')) = 'ABERTO';

  if not coalesce(p_confirmar,false) then
    return jsonb_build_object('modo','previa','titulos_no_alvo',(select count(*) from _alvo));
  end if;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
     select t.*, now() salvo_em from public.acordos_titulos t
      where t.id in (select id from _alvo)', '_backup_pos_import_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_pos_import_' || v_lote);

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'backup', '_backup_pos_import_' || v_lote);
end;
$fn$;

-- Os mesmos grants de produção: postgres, authenticated e service_role.
-- Sem anon, sem PUBLIC.
revoke all on function public.acordos_pos_importacao(uuid, boolean) from public;
grant execute on function public.acordos_pos_importacao(uuid, boolean)
  to postgres, authenticated, service_role;

-- O ambiente tem de casar com o de produção nos pontos que a migration confere.
do $$
declare v_cfg text; v_args text; v_acl text; v_ancora integer;
begin
  select array_to_string(p.proconfig, ', '), pg_get_function_arguments(p.oid),
         (select string_agg(x.grantee::regrole::text||':'||x.privilege_type, ', ' order by x.grantee::regrole::text)
            from aclexplode(p.proacl) x),
         (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid),
            'execute format(''alter table public.%I enable row level security'', ''_backup_pos_import_'' || v_lote);','')))
         / length('execute format(''alter table public.%I enable row level security'', ''_backup_pos_import_'' || v_lote);')
    into v_cfg, v_args, v_acl, v_ancora
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='acordos_pos_importacao';

  if v_cfg is distinct from 'search_path=public, statement_timeout=600s' then
    raise exception 'baseline infiel: config [%]', v_cfg;
  end if;
  if position('DEFAULT' in upper(v_args)) = 0 then
    raise exception 'baseline infiel: argumentos sem DEFAULT [%]', v_args;
  end if;
  if v_acl is distinct from 'authenticated:EXECUTE, postgres:EXECUTE, service_role:EXECUTE' then
    raise exception 'baseline infiel: EXECUTE [%]', v_acl;
  end if;
  if v_ancora <> 1 then
    raise exception 'baseline infiel: ancora aparece % vez(es), esperado 1', v_ancora;
  end if;
  raise notice 'baseline fiel: % / % / ancora 1x', v_cfg, v_acl;
end
$$;

-- ===========================================================================
-- O PROBLEMA, DEMONSTRADO: hoje a função cria tabela de backup já esvaziável
-- por `authenticated`.
-- ===========================================================================
do $$
declare v_lote text; v_tab text; v_acl text; v_linhas integer;
begin
  select (public.acordos_pos_importacao(null, true) ->> 'backup') into v_tab;

  select (select a::text from unnest(relacl) a where a::text like 'authenticated=%')
    into v_acl from pg_class where oid = ('public.'||quote_ident(v_tab))::regclass;

  if position('D' in split_part(v_acl,'/',1)) = 0 then
    raise exception 'esperado que a tabela nascesse COM TRUNCATE, veio %', v_acl;
  end if;

  -- e o TRUNCATE de fato passa, apesar da RLS
  set local role authenticated;
  execute format('truncate table public.%I', v_tab);
  reset role;

  execute format('select count(*) from public.%I', v_tab) into v_linhas;
  if v_linhas <> 0 then
    raise exception 'TRUNCATE nao esvaziou (% linhas)', v_linhas;
  end if;

  raise notice 'PROBLEMA CONFIRMADO: a funcao criou % com % e authenticated esvaziou a tabela apesar da RLS', v_tab, v_acl;

  -- guarda o nome para o caso 4 conferir que o patch NAO mexe nela
  create table public._teste_tabela_do_baseline as select v_tab as nome;
end
$$;
