-- DUAS COISAS QUE A AMANDA FAZIA NA MAO, medidas em 14 dias:
--   definir responsavel do acordo -- 46 por dia
--   quitar caso                   -- 39 por dia

-- 1) ACORDO HERDA O RESPONSAVEL DO ALUNO.
-- 1.512 acordos ativos estao sem responsavel; em 656 o aluno ja tem dono. Era
-- copiar um campo para o outro na mao. So vale para acordo NOVO (decisao da
-- Amanda): os que ja existem ficam para revisao, porque pode haver caso em que
-- o dono do acordo e de proposito diferente do dono do aluno.
create or replace function public._acordo_herda_responsavel_do_aluno()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_email text; v_nome text;
begin
  if new.operador_responsavel_email is not null then return new; end if;
  select al.responsavel_atual_email, al.responsavel_atual_nome
    into v_email, v_nome
    from public.alunos al where al.id = new.aluno_id;
  if v_email is not null then
    new.operador_responsavel_email := v_email;
    new.operador_responsavel_nome  := coalesce(new.operador_responsavel_nome, v_nome);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_acordo_herda_responsavel on public.acordos;
create trigger trg_acordo_herda_responsavel
before insert on public.acordos
for each row execute function public._acordo_herda_responsavel_do_aluno();

-- 2) SUGESTAO DE QUITACAO.
-- Alunos cujo pagamento vinculado nos ultimos N dias cobre o saldo em aberto.
-- NAO quita nada: so lista. Quem decide e a gestao -- foi o que a Amanda pediu,
-- e e o certo, porque "pagou mais do que deve" tambem acontece quando a divida
-- nova entrou depois do pagamento antigo.
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
   order by s.saldo desc;
$$;

revoke all on function public.quitacao_sugerida(int) from public, anon;
grant execute on function public.quitacao_sugerida(int) to authenticated, service_role;
