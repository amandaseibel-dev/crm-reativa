-- Fila de pagamentos sem aluno: o que o vinculo automatico nao resolveu.
-- Dois motivos possiveis, e a tela mostra qual:
--   NOME_REPETIDO   -> existe mais de um aluno com esse nome; so a gestao decide
--   SEM_CADASTRO    -> nao existe aluno com esse nome na base
-- Gestao busca o aluno certo e vincula, ou cria o cadastro na hora.

create or replace function public.pagamentos_sem_aluno(p_mes text default null)
returns table (
  pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
  titulo_numero text, numero_parcela_completo text,
  valor_pago numeric, valor_honorario numeric,
  operador_nome text, operador_email text, motivo text, candidatos int
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with mes as (
    select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM')) as m
  )
  select p.id, p.data_pagamento, p.aluno_nome, p.matricula,
         p.titulo_numero, p.numero_parcela_completo,
         p.valor_pago, p.valor_honorario,
         p.operador_nome, p.operador_email,
         case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end,
         coalesce(c.qtd, 0)::int
    from public.pagamentos p, mes
    left join lateral (
      select count(*)::int as qtd from public.alunos a
       where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))
    ) c on true
   where p.aluno_id is null
     and to_char(p.data_pagamento, 'YYYY-MM') = mes.m
   order by p.valor_pago desc;
$$;

revoke all on function public.pagamentos_sem_aluno(text) from public, anon;
grant execute on function public.pagamentos_sem_aluno(text) to authenticated, service_role;

-- Vincular um pagamento a um aluno escolhido pela gestao.
create or replace function public.pagamento_vincular_aluno(
  p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_nome text; v_cpf text; v_ant uuid;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  select a.nome, a.cpf into v_nome, v_cpf from public.alunos a where a.id = p_aluno_id;
  if v_nome is null then
    return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
  end if;

  select aluno_id into v_ant from public.pagamentos where id = p_pagamento_id;

  update public.pagamentos
     set aluno_id = p_aluno_id, cpf = coalesce(cpf, v_cpf)
   where id = p_pagamento_id;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'PAGAMENTO_VINCULADO',
          'Pagamento vinculado manualmente pela gestao.'
          || case when p_observacao is null then '' else ' ' || p_observacao end,
          coalesce(auth.jwt() ->> 'email', 'gestao'),
          coalesce(auth.jwt() ->> 'email', 'gestao'), now());

  return jsonb_build_object('ok', true, 'aluno_nome', v_nome, 'aluno_id_anterior', v_ant);
end;
$$;

revoke all on function public.pagamento_vincular_aluno(uuid, uuid, text) from public, anon;
grant execute on function public.pagamento_vincular_aluno(uuid, uuid, text) to authenticated, service_role;
