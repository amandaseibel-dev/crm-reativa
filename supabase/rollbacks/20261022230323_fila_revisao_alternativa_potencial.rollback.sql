-- ============================================================================
-- ROLLBACK: a fila de revisao volta ao corpo do A7, sem alternativa_potencial.
--
-- EFEITO: o Administrativo perde a separacao entre "tem contato cadastrado a
-- conferir" e "precisa conferir titularidade do zero". A fila continua
-- funcionando e protegida pelo mesmo portao -- so volta a nao dizer o que cada
-- ficha pede, e a descoberta volta a ser ficha por ficha (84 para achar 15).
--
-- Volta tambem o `exists` correlacionado por aluno que a ida removeu.
--
-- ZERO DML na ida e na volta. Nenhum bloqueio, contato, titularidade,
-- distribuicao, fidelizacao ou registro de auditoria e tocado em nenhuma das
-- duas direcoes.
--
-- O corpo abaixo foi extraido VERBATIM de
-- supabase/migrations/20261022120000_a7_contato_compartilhado_bloqueia_massiva.sql
-- -- nao foi redigitado.
-- ============================================================================

create or replace function public.contato_fila_revisao(p_canal text default null,
                                                       p_limite integer default 200)
returns table(canal text, contato text, pessoas integer, fichas integer,
              revisao_prioritaria boolean, alunos jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.usuario_pode_revalidar_contato() then
    raise exception 'Acesso negado: fila de revisao cadastral restrita ao Administrativo e a supervisao.'
      using errcode = '42501';
  end if;

  return query
    select s.canal, s.contato, s.pessoas, s.fichas, s.revisao_prioritaria,
           coalesce(jsonb_agg(jsonb_build_object(
             'aluno_id', n.aluno_id,
             'nome', a.nome,
             -- mostra se bloquear este canal deixa a ficha sem canal nenhum:
             -- e o que separa "ainda cobravel" de "parado ate a revisao"
             'tem_canal_alternativo', exists (
                select 1 from public.vw_contato_normalizado n2
                 where n2.aluno_id = n.aluno_id
                   and n2.canal <> s.canal
                   and n2.contato is not null
                   and not public.contato_e_placeholder(n2.canal, n2.contato)
                   and not exists (select 1 from public.vw_contato_bloqueio b2
                                    where b2.aluno_id = n2.aluno_id
                                      and b2.canal = n2.canal)
             )
           ) order by a.nome), '[]'::jsonb)
      from public.vw_contato_compartilhado s
      join public.vw_contato_normalizado n
        on n.canal = s.canal and n.contato = s.contato
      join public.alunos a on a.id = n.aluno_id
     where p_canal is null or upper(btrim(p_canal)) = s.canal
     group by s.canal, s.contato, s.pessoas, s.fichas, s.revisao_prioritaria
     order by s.revisao_prioritaria desc, s.pessoas desc, s.canal, s.contato
     limit least(greatest(coalesce(p_limite, 200), 1), 1000);
end;
$$;

comment on function public.contato_fila_revisao(text, integer) is
  'A7/decisao 5: fila de revisao cadastral dos contatos compartilhados. Administrativo e supervisao apenas. Prioritarios (>= 5 pessoas) primeiro.';

revoke all on function public.contato_fila_revisao(text, integer) from public;
grant execute on function public.contato_fila_revisao(text, integer) to authenticated;

do $g$
begin
  if position('alternativa_potencial' in (
        select pg_get_functiondef(p.oid) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'contato_fila_revisao')) > 0 then
    raise exception 'rollback: alternativa_potencial ainda esta no corpo.';
  end if;
  if not has_function_privilege('authenticated', 'public.contato_fila_revisao(text,integer)', 'EXECUTE') then
    raise exception 'rollback: authenticated perdeu o EXECUTE.';
  end if;
end
$g$;
