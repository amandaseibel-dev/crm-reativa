-- A lista do que a importacao sinalizou.
--
-- Sinalizar so serve se alguem consegue VER. Esta e a lista dos acordos que
-- entraram marcados como duplicata: o novo, o que ja existia, e o aluno --
-- com a contagem de parcelas pagas dos DOIS, que e o que decide qual cancelar.
--
-- So gestao: cancelar acordo devolve divida e a Prime nao reverte sozinha.

create or replace function public.acordos_duplicados_sinalizados()
returns table(
  acordo_id uuid, numero_acordo bigint, aluno_id uuid, aluno_nome text, cpf text,
  valor_total numeric, qtd_parcelas integer, criado_em timestamptz, observacao text,
  operador_email text,
  existente_id uuid, existente_numero bigint, existente_criado_em timestamptz,
  existente_status text, existente_observacao text,
  parcelas_novo integer, parcelas_pagas_novo integer,
  parcelas_existente integer, parcelas_pagas_existente integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(),'') <> 'service_role' and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: requer gestão.' using errcode = '42501';
  end if;

  return query
  select
    n.id, n.numero_acordo, n.aluno_id, coalesce(al.nome,'-'), coalesce(n.cpf, al.cpf),
    round(coalesce(n.valor_total,0),2), n.qtd_parcelas, n.criado_em, n.observacao,
    lower(coalesce(nullif(n.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    v.id, v.numero_acordo, v.criado_em, v.status, v.observacao,
    (select count(*)::int from public.parcelas p where p.acordo_id = n.id),
    (select count(*)::int from public.parcelas p where p.acordo_id = n.id and upper(coalesce(p.status,'')) = 'PAGO'),
    (select count(*)::int from public.parcelas p where p.acordo_id = v.id),
    (select count(*)::int from public.parcelas p where p.acordo_id = v.id and upper(coalesce(p.status,'')) = 'PAGO')
  from public.acordos n
  join public.acordos v on v.id = n.duplicado_de
  left join public.alunos al on al.id = n.aluno_id
  where n.duplicado_de is not null
    and n.status = 'ATIVO'
  order by n.criado_em desc, al.nome;
end;
$function$;

comment on function public.acordos_duplicados_sinalizados() is
  'Acordos que a importacao deixou entrar marcados como duplicata (acordos.duplicado_de). Mostra lado a lado o novo e o que ja existia, com contagem de parcelas pagas de cada um, para decidir qual cancelar. So gestao.';

revoke all on function public.acordos_duplicados_sinalizados() from public;
grant execute on function public.acordos_duplicados_sinalizados() to authenticated;
