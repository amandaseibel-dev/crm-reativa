-- CONFERENCIA RASTREADA POR PAGAMENTO -- o vinculo que nao existia.
--
-- Amanda: "quero que essa aba siga os pagamentos efetuados no mes que nao
-- tiveram nenhuma conferencia via extrato do santander"; depois "vamos usar
-- julho e agosto, os que estao zerado ja foram conferidos" e "traga as
-- quantidades".
--
-- O BURACO: `solicitacoes_confirmacao_pagamento.pagamento_id` existe e estava
-- NULO nas 8.209 solicitacoes. A conferencia era rastreada por ALUNO, por TITULO
-- e por CASO -- nunca por PAGAMENTO. A resposta formal a "quais pagamentos de
-- agosto foram conferidos" era: nenhum. 3.313 pagamentos, R$ 4.119.677,22.
--
-- A SOLUCAO: a decisao carimba QUAIS pagamentos cobriu. Decidir um aluno marca
-- os pagamentos dele na janela e a fila para de mostra-los -- entao "pagamento
-- sem conferencia" virou pergunta respondivel e o mes fecha quando a lista zera.
--
-- Estado ao ligar: 1.364 alunos, 2.687 pagamentos, R$ 4.132.598,44 entraram e
-- R$ 6.321.793,56 seguem em aberto. Por faixa: 50k+ = 23 alunos e 66 pagamentos
-- (R$ 892.440,50); 10k+ = 95 e 210 (R$ 1.807.643,80); 5k+ = 215 e 492.

create table if not exists public.conciliacao_pagamento_conferido (
  pagamento_id uuid primary key,
  aluno_id uuid,
  decisao text,
  conferido_por text,
  conferido_em timestamptz not null default now()
);
alter table public.conciliacao_pagamento_conferido enable row level security;
drop policy if exists conf_pag_gestao on public.conciliacao_pagamento_conferido;
create policy conf_pag_gestao on public.conciliacao_pagamento_conferido
  for select to authenticated using (public.usuario_e_gestao());
create index if not exists ix_conf_pag_aluno on public.conciliacao_pagamento_conferido(aluno_id);

create or replace function public.conciliacao_santander_decidir(
  p_aluno_id uuid, p_decisao text, p_motivo text default null,
  p_valor numeric default null, p_desde date default date '2026-07-01'
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_n int;
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

  insert into public.conciliacao_pagamento_conferido (pagamento_id, aluno_id, decisao, conferido_por)
  select p.id, p.aluno_id, upper(p_decisao), v_email
    from public.pagamentos p
   where p.aluno_id = p_aluno_id and p.data_pagamento >= p_desde
  on conflict (pagamento_id) do update
     set decisao = excluded.decisao, conferido_por = excluded.conferido_por, conferido_em = now();
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id,
                            'decisao', upper(p_decisao), 'pagamentos_conferidos', v_n);
end;
$$;

create or replace function public.conciliacao_santander_desfazer(p_aluno_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare v_apagadas int;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  delete from public.conciliacao_santander_decisao where aluno_id = p_aluno_id;
  get diagnostics v_apagadas = row_count;
  delete from public.conciliacao_pagamento_conferido where aluno_id = p_aluno_id;
  return jsonb_build_object('ok', v_apagadas > 0, 'aluno_id', p_aluno_id);
end;
$$;

drop function if exists public.conciliacao_santander(date, numeric, int);

-- DOIS CORTES, por decisao da gestao: janela julho + agosto, e saldo ZERO fica
-- de fora ("os que estao zerado ja foram conferidos").
-- Devolve as QUANTIDADES do conjunto todo, nao so da pagina -- sem isso a tela
-- nao sabe quanto falta alem do limite, e truncar em silencio e o defeito que a
-- premissa 13 proibe.
create or replace function public.conciliacao_santander(
  p_desde date default date '2026-07-01',
  p_faixa_min numeric default 0,
  p_limite int default 300
)
returns table (
  aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos int, primeiro_pagamento date, ultimo_pagamento date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, operadores text,
  total_faixa int, pagamentos_faixa int, entrou_faixa numeric, saldo_faixa numeric
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
    select p.aluno_id x_id, sum(p.valor_pago) x_entrou, count(*)::int x_qtd,
           min(p.data_pagamento) x_primeiro, max(p.data_pagamento) x_ultimo,
           string_agg(distinct coalesce(p.operador_nome,'-'), ', ') x_ops
      from public.pagamentos p
     where p.aluno_id is not null
       and p.data_pagamento >= p_desde
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
     group by p.aluno_id
    having sum(p.valor_pago) > 0.005
  ),
  base as (
    select e.x_id, al.nome x_nome, al.cpf x_cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') x_resp,
           round(e.x_entrou,2) x_entrou, e.x_qtd, e.x_primeiro, e.x_ultimo,
           round(coalesce(al.saldo_total,0),2) x_saldo,
           round(coalesce(pc.parcelas,0),2) x_acordo,
           round(coalesce(tt.titulos,0),2) x_mens,
           round(coalesce(al.saldo_vencido,0),2) x_venc,
           e.x_ops
      from entrada e
      join public.alunos al on al.id = e.x_id
      left join lateral (
        select coalesce(sum(pa.valor),0) parcelas
          from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
         where ac.aluno_id = e.x_id and upper(coalesce(ac.status,'')) = 'ATIVO' and pa.status <> 'PAGO'
      ) pc on true
      left join lateral (
        select coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0) titulos
          from public.acordos_titulos t
         where t.aluno_id = e.x_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
      ) tt on true
     where coalesce(al.saldo_total,0) > greatest(coalesce(p_faixa_min,0), 0.005)
  ),
  resumo as (
    select count(*)::int x_n, coalesce(sum(b2.x_qtd),0)::int x_p,
           coalesce(sum(b2.x_entrou),0) x_e, coalesce(sum(b2.x_saldo),0) x_s
      from base b2
  )
  select b.x_id, b.x_nome, b.x_cpf, b.x_resp, b.x_entrou, b.x_qtd, b.x_primeiro, b.x_ultimo,
         b.x_saldo, b.x_acordo, b.x_mens, b.x_venc, b.x_ops,
         r.x_n, r.x_p, round(r.x_e,2), round(r.x_s,2)
    from base b cross join resumo r
   order by b.x_saldo desc, b.x_id
   limit greatest(coalesce(p_limite, 300), 1);
end;
$$;

revoke all on function public.conciliacao_santander(date, numeric, int) from public, anon;
grant execute on function public.conciliacao_santander(date, numeric, int) to authenticated, service_role;
revoke all on function public.conciliacao_santander_decidir(uuid, text, text, numeric, date) from public, anon;
grant execute on function public.conciliacao_santander_decidir(uuid, text, text, numeric, date) to authenticated, service_role;
revoke all on function public.conciliacao_santander_desfazer(uuid) from public, anon;
grant execute on function public.conciliacao_santander_desfazer(uuid) to authenticated, service_role;
revoke all on table public.conciliacao_pagamento_conferido from public, anon;
grant select on table public.conciliacao_pagamento_conferido to authenticated;
