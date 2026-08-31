-- Marca quem pagou DEPOIS de ter sido quitado, e poe esses primeiro na fila.
--
-- Amanda, sobre o pagamento que chega depois do "Quitar tudo": deve voltar para
-- a fila, "pq foi uma quitacao total". O raciocinio e o ponto -- se a quitacao
-- foi total, dinheiro entrando depois e sinal de que algo merece um olhar:
-- pagamento em duplicidade, estorno a fazer, ou divida nova.
--
-- O comportamento ja era esse: o carimbo cobre os pagamentos que existiam na
-- hora da decisao, nao os futuros. O que faltava era a tela AVISAR, em vez de a
-- gestao ter de descobrir abrindo a ficha.
--
-- Medido em 30/08/2026: 9 pessoas na fila tem quitacao anterior, e 3 delas
-- pagaram DEPOIS de quitar, somando R$ 19.794,65. Nenhuma veio do botao "Quitar
-- tudo", que e novo -- vieram de CONFIRMACAO_PAGAMENTO e LINK_PAGAMENTO.
--
-- `quitado_em` traz a quitacao mais recente do aluno; a tela compara com o
-- ultimo pagamento, mostra o selo e a ordem poe esses no topo.

drop function if exists public.conferencia_pagamentos(date, numeric, int);

create or replace function public.conferencia_pagamentos(
  p_desde date default '2026-07-01'::date,
  p_faixa_min numeric default 0,
  p_limite integer default 300
)
returns table (
  tipo text, aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos integer, primeiro_pagamento date, ultimo_pagamento date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, tem_acordo boolean, quitado_em date, pagamento_ids uuid[],
  total_linhas integer, total_pagamentos integer, total_entrou numeric, total_saldo numeric
)
language plpgsql
stable security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  return query
  with nao_conferido as (
    select p.id, p.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
      from public.pagamentos p
     where p.data_pagamento >= p_desde
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
  ),
  com_aluno as (
    select 'ALUNO'::text x_tipo, n.aluno_id x_id, al.nome x_nome, al.cpf x_cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') x_resp,
           round(sum(n.valor_pago),2) x_entrou, count(*)::int x_qtd,
           min(n.data_pagamento) x_prim, max(n.data_pagamento) x_ult,
           round(coalesce(al.saldo_total,0),2) x_saldo,
           round(coalesce(pc.parcelas,0),2) x_acordo,
           round(coalesce(tt.titulos,0),2) x_mens,
           round(coalesce(al.saldo_vencido,0),2) x_venc,
           exists (select 1 from public.acordos a
                    where a.aluno_id = n.aluno_id and upper(coalesce(a.status,''))='ATIVO') x_tem_ac,
           qz.quitado_em x_quit,
           array_agg(n.id) x_pags
      from nao_conferido n
      join public.alunos al on al.id = n.aluno_id
      left join lateral (
        select coalesce(sum(pa.valor),0) parcelas
          from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
         where ac.aluno_id = n.aluno_id and upper(coalesce(ac.status,''))='ATIVO' and pa.status <> 'PAGO'
      ) pc on true
      left join lateral (
        select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0) titulos
          from public.acordos_titulos t
         where t.aluno_id = n.aluno_id and upper(coalesce(t.situacao,''))='ABERTO'
      ) tt on true
      left join lateral (
        select c.quitado_em::date quitado_em
          from public.casos c
         where c.aluno_id = n.aluno_id and c.quitado_em is not null
         order by c.quitado_em desc limit 1
      ) qz on true
     where n.aluno_id is not null
       and coalesce(al.saldo_total,0) > greatest(coalesce(p_faixa_min,0), 0.005)
     group by n.aluno_id, al.nome, al.cpf, al.responsavel_atual_nome,
              al.saldo_total, al.saldo_vencido, pc.parcelas, tt.titulos, qz.quitado_em
  ),
  sem_vinculo as (
    select 'SEM_VINCULO'::text, null::uuid, max(n.aluno_nome), null::text, '(sem dono)'::text,
           round(sum(n.valor_pago),2), count(*)::int,
           min(n.data_pagamento), max(n.data_pagamento),
           0::numeric, 0::numeric, 0::numeric, 0::numeric, false, null::date, array_agg(n.id)
      from nao_conferido n
     where n.aluno_id is null and coalesce(btrim(n.aluno_nome),'') <> ''
       and coalesce(p_faixa_min,0) <= 0
     group by upper(btrim(n.aluno_nome))
  ),
  tudo as (select * from com_aluno union all select * from sem_vinculo),
  resumo as (
    select count(*)::int t_l, coalesce(sum(t.x_qtd),0)::int t_p,
           coalesce(sum(t.x_entrou),0) t_e, coalesce(sum(t.x_saldo),0) t_s
      from tudo t
  )
  select t.x_tipo, t.x_id, t.x_nome, t.x_cpf, t.x_resp,
         t.x_entrou, t.x_qtd, t.x_prim, t.x_ult,
         t.x_saldo, t.x_acordo, t.x_mens, t.x_venc, t.x_tem_ac, t.x_quit, t.x_pags,
         r.t_l, r.t_p, round(r.t_e,2), round(r.t_s,2)
    from tudo t cross join resumo r
   -- quem pagou depois de quitar vem primeiro: e o que mais pede olhar
   order by (t.x_quit is not null and t.x_ult > t.x_quit) desc,
            t.x_saldo desc, t.x_entrou desc, t.x_nome
   limit greatest(coalesce(p_limite,300),1);
end;
$function$;

revoke all on function public.conferencia_pagamentos(date, numeric, int) from public, anon;
grant execute on function public.conferencia_pagamentos(date, numeric, int) to authenticated, service_role;
