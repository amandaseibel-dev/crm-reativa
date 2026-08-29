-- Fila por FAIXA, com LIMITE, e o desfazer -- as tres coisas pela fluidez.
--
-- Amanda: "otimize tudo que puder nessa aba, para ficar mais fluida a
-- confirmacao de pagamento".
--
-- 1) CORRECAO ANTES DE OTIMIZACAO (premissa 13): a fila tinha 1.364 linhas e a
--    API corta em 1.000 sem avisar. A tela mostraria fila truncada com cara de
--    completa. Agora a RPC limita e devolve `total_faixa` e `saldo_faixa`, para
--    a tela dizer "300 de 1.364" -- truncar em silencio e o defeito proibido.
--
-- 2) FAIXA. Nao e preciso trabalhar 1.364. Medido em 29/08/2026:
--       50k+       23 alunos  R$ 1.746.151,65  27,6% do saldo
--       20k a 50k  35 alunos  R$ 1.111.865,62  17,6%
--       10k a 20k  37 alunos  R$   519.891,83   8,2%
--       5k a 10k  120 alunos  R$   801.143,75  12,7%
--       1k a 5k   756 alunos  R$ 1.923.358,58  30,4%
--       < 1k      393 alunos  R$   219.382,13   3,5%
--    95 alunos (10k+) concentram R$ 3.377.909,10 -- 53% do saldo. Trabalhar por
--    faixa e o caminho curto para estancar.
--
-- 3) DESFAZER. `conciliacao_santander_desfazer` apaga a decisao e o aluno volta
--    para a fila. E o que permite trabalhar rapido sem medo do clique errado.
--    ATENCAO: desfaz a DECISAO, nao estorna a baixa nem a quitacao -- para isso
--    existem os fluxos proprios do Financeiro, e a tela avisa isso na hora.
--
-- ARMADILHA: `saldo_aberto` e parametro de saida e colide com a referencia
-- dentro do CTE de resumo (42702). Por isso os nomes internos sao prefixados.

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
  total_faixa int, saldo_faixa numeric
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
     where p.aluno_id is not null and p.data_pagamento >= p_desde
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
       and not exists (select 1 from public.conciliacao_santander_decisao d where d.aluno_id = e.x_id)
  ),
  resumo as (select count(*)::int x_n, coalesce(sum(b2.x_saldo),0) x_s from base b2)
  select b.x_id, b.x_nome, b.x_cpf, b.x_resp, b.x_entrou, b.x_qtd, b.x_primeiro, b.x_ultimo,
         b.x_saldo, b.x_acordo, b.x_mens, b.x_venc, b.x_ops,
         r.x_n, round(r.x_s,2)
    from base b cross join resumo r
   order by b.x_saldo desc, b.x_id
   limit greatest(coalesce(p_limite, 300), 1);
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
  return jsonb_build_object('ok', v_apagadas > 0, 'aluno_id', p_aluno_id);
end;
$$;

revoke all on function public.conciliacao_santander(date, numeric, int) from public, anon;
grant execute on function public.conciliacao_santander(date, numeric, int) to authenticated, service_role;
revoke all on function public.conciliacao_santander_desfazer(uuid) from public, anon;
grant execute on function public.conciliacao_santander_desfazer(uuid) to authenticated, service_role;
