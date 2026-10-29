-- Duplicados: gestao passa a poder filtrar por operador.
--
-- Contexto honesto: eu li errado um pedido da Amanda ("podemos liberar para
-- cada um ver o seu?") e abri esta tela para o operador. Ela corrigiu na hora
-- -- "nao, a tela de acordos nao duplicados apenas o seu controle de entrada",
-- falando do Controle de Acordos, que ja estava liberado por operador desde o
-- PR anterior. A abertura foi revertida no mesmo dia, antes de qualquer uso.
--
-- Duplicidade de acordo leva a cancelar acordo, que devolve divida -- e a Prime
-- nao reverte. Fica com a gestao.
--
-- O que SOBRA de util da ida e volta: o parametro p_email, que deixa a gestao
-- filtrar a lista por operador em vez de olhar a base inteira de uma vez.
--
-- Somente leitura, como antes. Nao ha acao destrutiva nesta tela de proposito.

create or replace function public.acordos_duplicados_sinalizados(p_email text default null)
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
declare
  v_alvo text := nullif(lower(coalesce(p_email,'')), '');
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
    and (
      v_alvo is null
      or lower(coalesce(nullif(n.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )
  order by n.criado_em desc, al.nome;
end;
$function$;

comment on function public.acordos_duplicados_sinalizados(text) is
  'Acordos que a importacao deixou entrar marcados como duplicata (acordos.duplicado_de), com o novo e o que ja existia lado a lado e as parcelas pagas de cada um. SO GESTAO -- decidir aqui leva a cancelar acordo, que devolve divida e a Prime nao reverte. p_email filtra por operador. Somente leitura.';

revoke all on function public.acordos_duplicados_sinalizados(text) from public;
grant execute on function public.acordos_duplicados_sinalizados(text) to authenticated;
