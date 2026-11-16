-- BASELINE — o estado de PRODUÇÃO em 06/11/2026, ANTES da migration
--
-- Corpo copiado verbatim de `pg_get_functiondef` em produção (ref
-- ahattpqrjmhkzsmnbdzs), incluindo os três `ALEGA_*_CONFIRMADO` que o
-- repositório não registrava. Importa que seja fiel: é contra este estado que
-- os casos medem o que a migration muda, e é para este estado que o rollback
-- volta.
--
-- Duas características deste baseline que os casos vão cobrar:
--   1. a lista de códigos é LITERAL -- o catálogo não é lido;
--   2. só existe gatilho de UPDATE -- a porta do INSERT está aberta.

\set ON_ERROR_STOP on

create or replace function public._encerramento_so_gestao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  -- + ANTECIPACAO_SEMESTRE (07/10/2026): passou a quitar parcela, virou decisao
  --   de gestao como cancelamento, suspensao e juridico.
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO','ANTECIPACAO_SEMESTRE','ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO'];
  v_novo text[];
  v_antigo text[];
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  v_novo := array[upper(coalesce(new.status_atual,'')), upper(coalesce(new.status_jornada,'')),
                  upper(coalesce(new.status_acionamento,''))];
  v_antigo := array[upper(coalesce(old.status_atual,'')), upper(coalesce(old.status_jornada,'')),
                    upper(coalesce(old.status_acionamento,''))];

  -- So barra quando o encerramento e NOVO: reescrever o que ja estava la nao e
  -- o operador encerrando nada.
  if (v_novo && v_encerra) and not (v_antigo && v_encerra) then
    raise exception
      'Encerrar cobrança (cancelamento, suspensão, jurídico ou antecipação de semestre) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function public._encerramento_so_gestao() from public;
revoke all on function public._encerramento_so_gestao() from anon;
grant execute on function public._encerramento_so_gestao() to postgres, authenticated, service_role;

drop trigger if exists trg_encerramento_so_gestao on public.alunos;
create trigger trg_encerramento_so_gestao
before update of status_atual, status_jornada, status_acionamento
on public.alunos
for each row execute function public._encerramento_so_gestao();

-- PROVA DO BASELINE: antes da migration, a porta do INSERT está aberta e o
-- catálogo não é consultado. Se um destes dois deixar de ser verdade aqui, o
-- baseline não é o estado de produção e os casos medem a coisa errada.
do $$
begin
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.alunos'::regclass
       and tgname = 'trg_tabulacao_so_gestao_insert' and not tgisinternal
  ) then
    raise exception 'baseline invalido: gatilho de INSERT nao deveria existir antes da migration';
  end if;

  if pg_get_functiondef('public._encerramento_so_gestao()'::regprocedure) ilike '%somente_gestao%' then
    raise exception 'baseline invalido: a funcao nao deveria ler o catalogo antes da migration';
  end if;
end
$$;
