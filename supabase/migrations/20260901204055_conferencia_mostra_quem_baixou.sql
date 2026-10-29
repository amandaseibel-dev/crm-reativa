-- A FILA PASSA A DIZER QUEM FEZ A BAIXA, E QUANDO.
--
-- Amanda, 01/09/2026: "quero que apareca quem fez a baixa".
--
-- O PROBLEMA QUE ISSO RESOLVE: a linha mostrava o valor baixado e nada mais.
-- Chegando num aluno, nao havia como saber se aquela baixa foi tua, da Fernanda,
-- ou de uma rotina automatica -- entao a unica saida era abrir a ficha ou
-- decidir de novo. Era assim que se andava em circulos.
--
-- Em 10 dias de baixas, quem aparece: amanda.seibel (1.289), cobranca04 (98) e
-- `rotina@sistema` (201, em dois nomes de rotina). A terceira e a que mais
-- importa ver: baixa que ninguem fez a mao.
--
-- COMO O NOME E RESOLVIDO: `baixado_por_nome` e nulo na maior parte das linhas e
-- repete o e-mail no resto, entao ele nao serve. A fonte boa e
-- `baixado_por_email`, cruzado com `usuarios` para virar o nome de gente
-- ("Fernanda", "Amanda Borges"). `rotina@sistema` vira "automatico" -- e o sinal
-- de que nao houve decisao humana ali.
--
-- Sao DUAS colunas novas no retorno, `baixado_por` e `ultima_baixa`. Trocar o
-- retorno de uma funcao exige DROP antes do CREATE, e por isso os grants sao
-- reaplicados no fim.
--
-- DESFAZER: supabase/rollbacks/20260901140000_conferencia_mostra_quem_baixou.rollback.sql

drop function if exists public.conferencia_pagamentos(date, numeric, integer, date, text);

create or replace function public.conferencia_pagamentos(
  p_desde date default '2026-06-01'::date,
  p_valor_min numeric default 0,
  p_limite integer default 300,
  p_ate date default null::date,
  p_tipo_divida text default null::text
)
returns table(
  tipo text, aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos integer, primeiro_pagamento date, ultimo_pagamento date,
  baixado numeric, qtd_baixas integer, baixado_por text, ultima_baixa date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, tem_acordo boolean, quitado_em date, pagamento_ids uuid[],
  total_linhas integer, total_pagamentos integer, total_entrou numeric,
  total_baixado numeric, total_saldo numeric
)
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $function$
declare v_ate date := coalesce(p_ate + 1, date '2999-12-31');
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  return query
  with nao_conferido as (
    select p.id, p.aluno_id, p.aluno_nome, p.valor_pago, p.data_pagamento
      from public.pagamentos p
     where p.data_pagamento >= p_desde and p.data_pagamento < v_ate
       and not exists (select 1 from public.conciliacao_pagamento_conferido c
                        where c.pagamento_id = p.id)
  ),
  pg as (
    select n.aluno_id aid, sum(n.valor_pago) entrou, count(*)::int qtd,
           min(n.data_pagamento) prim, max(n.data_pagamento) ult, array_agg(n.id) pags
      from nao_conferido n where n.aluno_id is not null group by n.aluno_id
  ),
  bx as (
    select b.aluno_id::uuid aid, sum(b.valor_pago) baixado, count(*)::int qtd,
           max(b.baixado_em)::date ult_baixa,
           array_agg(distinct lower(coalesce(nullif(btrim(b.baixado_por_email),''), '?'))) emails
      from public.baixas_pagamento b
     where upper(coalesce(b.status_baixa,'')) = 'REALIZADA'
       and b.data_pagamento >= p_desde and b.data_pagamento < v_ate
       and b.aluno_id ~ '^[0-9a-f-]{36}$'
     group by 1
  ),
  universo as (
    select coalesce(pg.aid, bx.aid) aid,
           coalesce(pg.entrou,0) entrou, coalesce(pg.qtd,0) qtd_pg,
           pg.prim, pg.ult, coalesce(pg.pags, '{}'::uuid[]) pags,
           coalesce(bx.baixado,0) baixado, coalesce(bx.qtd,0) qtd_bx,
           bx.ult_baixa, bx.emails
      from pg left join bx on bx.aid = pg.aid
  ),
  com_aluno as (
    select 'ALUNO'::text x_tipo, u.aid x_id, al.nome x_nome, al.cpf x_cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') x_resp,
           round(u.entrou,2) x_entrou, u.qtd_pg, u.prim, u.ult,
           round(u.baixado,2) x_baixado, u.qtd_bx,
           -- QUEM FEZ A BAIXA. O e-mail vira nome de gente pela tabela de
           -- usuarios; a rotina automatica vira "automatico", que e o caso em
           -- que ninguem decidiu nada.
           (select string_agg(distinct coalesce(
                     us.nome,
                     case when e = 'rotina@sistema' then 'automático' end,
                     e), ', ')
              from unnest(u.emails) e
              left join public.usuarios us on lower(us.email) = e) x_quem,
           u.ult_baixa x_ult_baixa,
           round(coalesce(al.saldo_total,0),2) x_saldo,
           round(coalesce(pc.parcelas,0),2) x_acordo,
           round(coalesce(tt.titulos,0),2) x_mens,
           round(coalesce(al.saldo_vencido,0),2) x_venc,
           exists (select 1 from public.acordos a
                    where a.aluno_id = u.aid and upper(coalesce(a.status,''))='ATIVO') x_tem_ac,
           qz.quitado_em x_quit, u.pags x_pags
      from universo u
      join public.alunos al on al.id = u.aid
      left join lateral (
        select coalesce(sum(pa.valor),0) parcelas
          from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
         where ac.aluno_id = u.aid and upper(coalesce(ac.status,''))='ATIVO' and pa.status <> 'PAGO'
      ) pc on true
      left join lateral (
        select coalesce(sum(coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)),0) titulos
          from public.acordos_titulos t
         where t.aluno_id = u.aid and upper(coalesce(t.situacao,''))='ABERTO'
      ) tt on true
      left join lateral (
        select c.quitado_em::date quitado_em from public.casos c
         where c.aluno_id = u.aid and c.quitado_em is not null
         order by c.quitado_em desc limit 1
      ) qz on true
     where coalesce(al.saldo_total,0) > 0.005
       and coalesce(u.entrou,0) >= coalesce(p_valor_min,0)
       and (upper(coalesce(p_tipo_divida,'')) = 'TUDO'
            or coalesce(tt.titulos,0) > 0.005
            or coalesce(al.saldo_vencido,0) > 0.005
            or coalesce(al.responsavel_atual_nome,'') = '')
       and (p_tipo_divida is null
            or upper(p_tipo_divida) = 'TUDO'
            or (upper(p_tipo_divida) = 'MENSALIDADE' and coalesce(tt.titulos,0) > 0.005)
            or (upper(p_tipo_divida) = 'ACORDO'      and coalesce(tt.titulos,0) <= 0.005))
  ),
  sem_vinculo as (
    select 'SEM_VINCULO'::text, null::uuid, max(n.aluno_nome), null::text, '(sem dono)'::text,
           round(sum(n.valor_pago),2), count(*)::int,
           min(n.data_pagamento), max(n.data_pagamento),
           0::numeric, 0, null::text, null::date,
           0::numeric, 0::numeric, 0::numeric, 0::numeric,
           false, null::date, array_agg(n.id)
      from nao_conferido n
     where n.aluno_id is null and coalesce(btrim(n.aluno_nome),'') <> ''
     group by upper(btrim(n.aluno_nome))
    having sum(n.valor_pago) >= coalesce(p_valor_min,0) and p_tipo_divida is null
  ),
  tudo as (select * from com_aluno union all select * from sem_vinculo),
  resumo as (
    select count(*)::int t_l, coalesce(sum(t.qtd_pg),0)::int t_p,
           coalesce(sum(t.x_entrou),0) t_e, coalesce(sum(t.x_baixado),0) t_b,
           coalesce(sum(t.x_saldo),0) t_s
      from tudo t
  )
  select t.x_tipo, t.x_id, t.x_nome, t.x_cpf, t.x_resp,
         t.x_entrou, t.qtd_pg, t.prim, t.ult, t.x_baixado, t.qtd_bx,
         t.x_quem, t.x_ult_baixa,
         t.x_saldo, t.x_acordo, t.x_mens, t.x_venc, t.x_tem_ac, t.x_quit, t.x_pags,
         r.t_l, r.t_p, round(r.t_e,2), round(r.t_b,2), round(r.t_s,2)
    from tudo t cross join resumo r
   order by (t.x_quit is not null and t.ult is not null and t.ult > t.x_quit) desc,
            (coalesce(t.x_mens,0) > 0.005) desc,
            t.x_mens desc, t.x_entrou desc, t.x_saldo desc, t.x_nome
   limit greatest(coalesce(p_limite,300),1);
end;
$function$;

revoke all on function public.conferencia_pagamentos(date, numeric, integer, date, text) from public, anon;
grant execute on function public.conferencia_pagamentos(date, numeric, integer, date, text) to authenticated, service_role;
