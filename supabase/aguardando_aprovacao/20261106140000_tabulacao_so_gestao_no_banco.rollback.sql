-- ROLLBACK de 20261106140000_tabulacao_so_gestao_no_banco
--
-- Restaura o corpo de `_encerramento_so_gestao` EXATAMENTE como estava em
-- produção em 06/11/2026 (copiado de `pg_get_functiondef`, incluindo os três
-- `ALEGA_*_CONFIRMADO` que o repositório não registrava) e remove o gatilho de
-- INSERT, que não existia antes.
--
-- ATENÇÃO AO QUE ESTE ROLLBACK DEVOLVE: a lista volta a ser literal. Se neste
-- meio-tempo a tabulação `RETORNO_FINANCEIRO` tiver sido criada, ela deixa de
-- ser barrada no banco -- a proteção dela volta a ser só a do <select>. Então
-- este rollback só faz sentido junto com o rollback da tabulação
-- (20261106120000_tabulacao_retorno_financeiro.rollback.sql, que a desativa),
-- ou com a decisão consciente de voltar à restrição apenas por interface.
--
-- A trava de ENCERRAMENTO (cancelamento, suspensão, jurídico, antecipação e as
-- três confirmações de alegação) continua de pé depois deste rollback: ela está
-- no array literal, que é o que se restaura aqui.

begin;

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

comment on function public._encerramento_so_gestao() is null;

-- Mesmo ACL de 06/11/2026, pelo mesmo motivo do `.pendente`:
-- `create or replace` restaura o padrao do schema, que inclui PUBLIC.
revoke all on function public._encerramento_so_gestao() from public;
revoke all on function public._encerramento_so_gestao() from anon;
grant execute on function public._encerramento_so_gestao() to postgres, authenticated, service_role;

-- O gatilho de UPDATE continua; o de INSERT sai, porque nao existia antes.
drop trigger if exists trg_encerramento_so_gestao on public.alunos;
create trigger trg_encerramento_so_gestao
before update of status_atual, status_jornada, status_acionamento
on public.alunos
for each row execute function public._encerramento_so_gestao();

drop trigger if exists trg_tabulacao_so_gestao_insert on public.alunos;

-- VIGIA do rollback: a trava de encerramento NAO pode cair junto.
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.alunos'::regclass
       and tgname = 'trg_encerramento_so_gestao' and not tgisinternal
  ) then
    raise exception 'rollback deixou public.alunos SEM a trava de encerramento';
  end if;
  if has_function_privilege('public', 'public._encerramento_so_gestao()', 'EXECUTE') then
    raise exception 'rollback deixou PUBLIC com EXECUTE em _encerramento_so_gestao';
  end if;
  if has_function_privilege('anon', 'public._encerramento_so_gestao()', 'EXECUTE') then
    raise exception 'rollback deixou anon com EXECUTE em _encerramento_so_gestao';
  end if;
end
$$;

commit;
