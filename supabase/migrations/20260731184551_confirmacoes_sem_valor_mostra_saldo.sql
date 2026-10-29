-- "Acordo sem valor" volta a listar TODAS as confirmacoes pendentes valor 0
-- (fila de checagem manual), agora com SALDO REAL por linha (tem_debito -> dispara
-- pra base; sem debito -> retira). Reverte a versao que ESCONDIA os com valor.
drop function if exists public.listar_confirmacoes_sem_valor();
create function public.listar_confirmacoes_sem_valor()
returns table(id uuid, aluno_id text, aluno_nome text, aluno_cpf text,
              operador_email text, operador_nome text, forma_pagamento text,
              motivo text, criado_em timestamptz, saldo_real numeric, tem_debito boolean)
language sql stable security definer set search_path to 'public' as $$
  select s.id, s.aluno_id, s.aluno_nome, s.aluno_cpf, s.operador_email, s.operador_nome,
         s.forma_pagamento, s.motivo, s.criado_em,
         round(coalesce(sr.saldo,0),2) as saldo_real,
         coalesce(sr.saldo,0) > 0.005 as tem_debito
  from public.solicitacoes_confirmacao_pagamento s
  left join lateral (
    select case when s.aluno_id ~ '^[0-9a-f-]{36}$' then (
      (select coalesce(sum(p.valor),0)
         from public.parcelas p join public.acordos a on a.id=p.acordo_id
        where a.aluno_id = s.aluno_id::uuid
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
          and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO'))
      + (select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0)
         from public.acordos_titulos t
        where t.aluno_id = s.aluno_id::uuid
          and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO'))
    ) else 0 end as saldo
  ) sr on true
  where s.status='AGUARDANDO_CONFIRMACAO'
    and coalesce(s.valor_informado,0)=0
    and coalesce(s.valor_entrada,0)=0
  order by (coalesce(sr.saldo,0) > 0.005) desc, s.criado_em desc;
$$;
revoke all on function public.listar_confirmacoes_sem_valor() from public, anon;
grant execute on function public.listar_confirmacoes_sem_valor() to authenticated, service_role;
