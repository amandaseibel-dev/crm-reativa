-- A primeira versao de quitacao_sugerida era larga demais.
--
-- MEDIDO antes de qualquer uso: dos 379 sugeridos, 105 tinham parcela A VENCER
-- no futuro -- acordo em andamento, R$ 535.027,63 de receita ja contratada. O
-- aluno pagou a entrada (que sozinha cobre o saldo atual pela conta antiga) e
-- ainda tem parcelas pela frente. Quitar apagaria a cobranca das proximas.
-- Outros 2 tinham titulo novo que entrou DEPOIS do ultimo pagamento.
--
-- Regra nova, com tres travas. So sugere quando:
--   a) o pagamento cobre o saldo, E
--   b) NAO ha parcela de acordo vivo vencendo no futuro, E
--   c) NAO entrou titulo novo depois do ultimo pagamento.
--
-- Sobram 273 alunos / R$ 441.255,67 -- todos com a divida inteira ja vencida e
-- coberta pelo que o aluno pagou. E 0,94% da carteira, nao "zera a base".

create or replace function public.quitacao_sugerida(p_dias int default 30)
returns table (
  aluno_id uuid, nome text, cpf text, responsavel text,
  pago numeric, saldo numeric, sobra numeric,
  qtd_pagamentos int, ultimo_pagamento date
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $$
  with pagos as (
    select p.aluno_id, sum(p.valor_pago) as pago, count(*)::int as qtd,
           max(p.data_pagamento) as ultimo
      from public.pagamentos p
     where p.aluno_id is not null
       and p.data_pagamento >= current_date - greatest(coalesce(p_dias,30), 1)
     group by 1
  )
  select pg.aluno_id, al.nome, al.cpf,
         coalesce(al.responsavel_atual_nome, '(sem dono)'),
         round(pg.pago, 2), round(s.saldo, 2), round(pg.pago - s.saldo, 2),
         pg.qtd, pg.ultimo
    from pagos pg
    join public.alunos al on al.id = pg.aluno_id
    join lateral (
      select (public.aluno_saldo_pendente_detalhe(pg.aluno_id)->>'total')::numeric as saldo
    ) s on true
   where s.saldo > 0.005
     and pg.pago >= s.saldo
     and not exists (
       select 1 from public.parcelas pa
         join public.acordos ac on ac.id = pa.acordo_id
        where ac.aluno_id = pg.aluno_id
          and upper(coalesce(ac.status,'')) not in ('CANCELADO','CANCELADA')
          and upper(coalesce(pa.status,'')) in ('A_VENCER','VENCIDA')
          and pa.vencimento > current_date)
     and not exists (
       select 1 from public.acordos_titulos t
        where t.aluno_id = pg.aluno_id
          and upper(coalesce(t.situacao,'')) = 'ABERTO'
          and t.created_at::date > pg.ultimo)
   order by s.saldo desc;
$$;

revoke all on function public.quitacao_sugerida(int) from public, anon;
grant execute on function public.quitacao_sugerida(int) to authenticated, service_role;
