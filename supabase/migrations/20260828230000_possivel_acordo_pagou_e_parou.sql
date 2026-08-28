-- POSSIVEL ACORDO: quem pagou alguma coisa, ainda deve e nao tem acordo.
--
-- Ideia da Amanda: "os alunos que tem pagamento menor que o saldo, poderia
-- criar como possibilidade de acordo?".
--
-- E o publico mais quente que existe: colocou dinheiro e parou no meio.
-- Medido em 28/08/2026: 71 alunos, R$ 227.547,79 em aberto, e ja pagaram
-- R$ 80.455,88. Saldo medio R$ 3.204,90; 47 pagaram nos ultimos 30 dias.
--
-- Quem JA tem acordo ativo fica de fora (eram 718): esses nao sao oportunidade,
-- estao pagando as parcelas do acordo que ja existe. Sem esse corte a lista
-- viraria ruido.
--
-- Juridico, cancelamento e suspensao tambem ficam de fora: sairam da cobranca
-- por decisao da gestao, nao se oferece acordo para eles.

create or replace function public.possivel_acordo()
returns table (
  aluno_id uuid, nome text, cpf text, responsavel text, responsavel_email text,
  pago numeric, saldo numeric, falta numeric,
  qtd_pagamentos int, ultimo_pagamento date, dias_desde_pagamento int
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
     group by 1
  )
  select pg.aluno_id, al.nome, al.cpf,
         coalesce(al.responsavel_atual_nome, '(sem dono)'), al.responsavel_atual_email,
         round(pg.pago, 2), round(s.saldo, 2), round(s.saldo - pg.pago, 2),
         pg.qtd, pg.ultimo, (current_date - pg.ultimo)::int
    from pagos pg
    join public.alunos al on al.id = pg.aluno_id
    join lateral (
      select (public.aluno_saldo_pendente_detalhe(pg.aluno_id)->>'total')::numeric as saldo
    ) s on true
   where s.saldo > 0.005
     and pg.pago < s.saldo
     and not exists (
       select 1 from public.acordos a
        where a.aluno_id = pg.aluno_id and upper(coalesce(a.status,'')) = 'ATIVO')
     and upper(coalesce(al.status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO'
   order by s.saldo - pg.pago desc;
$$;

revoke all on function public.possivel_acordo() from public, anon;
grant execute on function public.possivel_acordo() to authenticated, service_role;
