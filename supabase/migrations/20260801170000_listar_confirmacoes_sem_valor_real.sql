-- "Acordo sem valor" corrigido: sem valor = confirmacao pendente cujo aluno NAO
-- tem parcela de acordo nem titulo em aberto (saldo real zero). Antes usava so
-- valor_informado=0 e listava acordos que TEM valor. EXISTS (barato).
create or replace function public.listar_confirmacoes_sem_valor()
returns table(id uuid, aluno_id text, aluno_nome text, aluno_cpf text,
              operador_email text, operador_nome text, forma_pagamento text,
              motivo text, criado_em timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select s.id, s.aluno_id, s.aluno_nome, s.aluno_cpf, s.operador_email, s.operador_nome,
         s.forma_pagamento, s.motivo, s.criado_em
  from public.solicitacoes_confirmacao_pagamento s
  where s.status='AGUARDANDO_CONFIRMACAO' and coalesce(s.valor_informado,0)=0 and coalesce(s.valor_entrada,0)=0
    and ( s.aluno_id !~ '^[0-9a-f-]{36}$'
      or ( not exists (select 1 from public.parcelas p join public.acordos a on a.id=p.acordo_id
                       where a.aluno_id=s.aluno_id::uuid and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
                         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO'))
           and not exists (select 1 from public.acordos_titulos t where t.aluno_id=s.aluno_id::uuid
                           and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')) ) );
$$;
revoke all on function public.listar_confirmacoes_sem_valor() from public, anon;
grant execute on function public.listar_confirmacoes_sem_valor() to authenticated, service_role;
