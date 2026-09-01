-- Volta `conferencia_pagamentos` ao retorno SEM `baixado_por` / `ultima_baixa`.
--
-- Esta e a definicao que estava em prod antes da migration 20260901140000
-- (md5 do pg_get_functiondef: 64016a251c6a8e26ce88d9bc31c24edc, 6597 bytes),
-- copiada do proprio banco para o rollback nao depender de reconstruir a
-- cadeia de patches de 20260831120000 + 20260831230000.
--
-- A TELA PRECISA VOLTAR JUNTO: `src/pages/ConferenciaPagamentos.jsx` le as duas
-- colunas novas. Rodar so este arquivo deixa a coluna "Baixado" sem o autor,
-- mas nao quebra -- os campos vem indefinidos e a tela nao os desenha.

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
  baixado numeric, qtd_baixas integer,
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
    select b.aluno_id::uuid aid, sum(b.valor_pago) baixado, count(*)::int qtd
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
           coalesce(bx.baixado,0) baixado, coalesce(bx.qtd,0) qtd_bx
      from pg left join bx on bx.aid = pg.aid
  ),
  com_aluno as (
    select 'ALUNO'::text x_tipo, u.aid x_id, al.nome x_nome, al.cpf x_cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') x_resp,
           round(u.entrou,2) x_entrou, u.qtd_pg, u.prim, u.ult,
           round(u.baixado,2) x_baixado, u.qtd_bx,
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
           0::numeric, 0, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
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
