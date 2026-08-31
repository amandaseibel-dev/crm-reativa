-- FILA DE CONCILIACAO PELO EXTRATO DO SANTANDER.
--
-- Amanda, 29/08/2026: "sempre a fila pela entradas do santander, ali definimos
-- quem realmente pagou" e "vamos conseguir trabalhar e estancar os maiores casos
-- primeiro".
--
-- FORMA, pedida assim: uma linha por ALUNO, julho e agosto COMPACTADOS num
-- registro so, valor pago somado, e ordem pelo MAIOR SALDO -- nao pela maior
-- entrada. O objetivo e estancar quem ainda deve mais.
--
-- Estado em 29/08/2026: 1.365 alunos, R$ 4.132.598,44 entraram no extrato e
-- R$ 6.323.939,30 seguem em aberto (R$ 4.733.691,17 em parcela de acordo e
-- R$ 1.564.120,00 em mensalidade). 68 alunos com entrada acima de R$ 10 mil
-- somam R$ 1.873.262,10.
--
-- O SALDO VEM PARTIDO EM DOIS porque sao decisoes diferentes: parcela de acordo
-- ja e valor NEGOCIADO (embute juros, multa e honorarios) e mensalidade e divida
-- original. Um total unico esconde isso.
--
-- VALOR PAGO NAO SE COMPARA COM SALDO. Amanda: "sempre o valor do pagamento a
-- vista por exemplo sera maior que o valor principal". O extrato traz valor
-- cheio, o nosso registro traz principal -- pagar mais que o saldo e o normal de
-- quem quitou a vista, nao anomalia. Casar por aluno + data, nunca por valor.
-- Mesmo fenomeno medido na Prime: paidAmount > netAmount em 89,4% dos casos.
--
-- ENTRADA ZERO FICA FORA: a fila e de quem pagou.
--
-- O QUE SAI DA FILA: quem ja tem decisao gravada em conciliacao_santander_decisao
-- ("o que nao foi ajustado ainda") e quem ja esta com saldo zerado.

create table if not exists public.conciliacao_santander_decisao (
  aluno_id uuid primary key,
  decisao text not null check (decisao in ('CONFIRMADO','REJEITADO','QUITADO')),
  motivo text,
  valor_considerado numeric,
  decidido_por text,
  decidido_em timestamptz not null default now()
);
alter table public.conciliacao_santander_decisao enable row level security;
drop policy if exists conciliacao_decisao_gestao on public.conciliacao_santander_decisao;
create policy conciliacao_decisao_gestao on public.conciliacao_santander_decisao
  for select to authenticated using (public.usuario_e_gestao());

create or replace function public.conciliacao_santander(p_desde date default date '2026-07-01')
returns table (
  aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos int, primeiro_pagamento date, ultimo_pagamento date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, operadores text
)
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $$
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  return query
  with entrada as (
    select p.aluno_id, sum(p.valor_pago) entrou, count(*)::int qtd,
           min(p.data_pagamento) primeiro, max(p.data_pagamento) ultimo,
           string_agg(distinct coalesce(p.operador_nome,'-'), ', ') ops
      from public.pagamentos p
     where p.aluno_id is not null and p.data_pagamento >= p_desde
     group by p.aluno_id
    having sum(p.valor_pago) > 0.005
  )
  select e.aluno_id, al.nome, al.cpf,
         coalesce(al.responsavel_atual_nome,'(sem dono)'),
         round(e.entrou,2), e.qtd, e.primeiro, e.ultimo,
         round(coalesce(al.saldo_total,0),2),
         round(coalesce(pc.parcelas,0),2),
         round(coalesce(tt.titulos,0),2),
         round(coalesce(al.saldo_vencido,0),2),
         e.ops
    from entrada e
    join public.alunos al on al.id = e.aluno_id
    left join lateral (
      select coalesce(sum(pa.valor),0) parcelas
        from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
       where ac.aluno_id = e.aluno_id and upper(coalesce(ac.status,'')) = 'ATIVO' and pa.status <> 'PAGO'
    ) pc on true
    left join lateral (
      select coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0) titulos
        from public.acordos_titulos t
       where t.aluno_id = e.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
    ) tt on true
   where coalesce(al.saldo_total,0) > 0.005
     and not exists (select 1 from public.conciliacao_santander_decisao d where d.aluno_id = e.aluno_id)
   -- Maior saldo primeiro. aluno_id por ultimo: desempate estavel entre paginas.
   order by coalesce(al.saldo_total,0) desc, e.aluno_id;
end;
$$;

-- Grava a decisao. As acoes financeiras (confirmar_baixa_caso, quitar_e_encerrar_caso)
-- sao chamadas pela tela ANTES desta -- aqui so fica o registro do que foi decidido,
-- que e o que tira a linha da fila.
create or replace function public.conciliacao_santander_decidir(
  p_aluno_id uuid, p_decisao text, p_motivo text default null, p_valor numeric default null
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if upper(coalesce(p_decisao,'')) not in ('CONFIRMADO','REJEITADO','QUITADO') then
    raise exception 'Decisao invalida: use CONFIRMADO, REJEITADO ou QUITADO.';
  end if;
  if upper(p_decisao) = 'REJEITADO' and coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio para rejeitar.';
  end if;

  insert into public.conciliacao_santander_decisao
    (aluno_id, decisao, motivo, valor_considerado, decidido_por)
  values (p_aluno_id, upper(p_decisao), nullif(btrim(coalesce(p_motivo,'')),''), p_valor, v_email)
  on conflict (aluno_id) do update
     set decisao = excluded.decisao, motivo = excluded.motivo,
         valor_considerado = excluded.valor_considerado,
         decidido_por = excluded.decidido_por, decidido_em = now();

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id, 'decisao', upper(p_decisao));
end;
$$;

revoke all on function public.conciliacao_santander(date) from public, anon;
grant execute on function public.conciliacao_santander(date) to authenticated, service_role;
revoke all on function public.conciliacao_santander_decidir(uuid, text, text, numeric) from public, anon;
grant execute on function public.conciliacao_santander_decidir(uuid, text, text, numeric) to authenticated, service_role;
revoke all on table public.conciliacao_santander_decisao from public, anon;
grant select on table public.conciliacao_santander_decisao to authenticated;
