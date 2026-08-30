-- CONFERENCIA DE PAGAMENTOS: uma lista so, uma linha por pessoa.
--
-- Amanda: "organize a fila e todos os pagamentos que entraram por aluno, sem se
-- repetir os alunos, deixe uma aba para conferencia de pagamentos, nao precisamos
-- de diversas, vamos centralizar em lugar so".
--
-- A DESCOBERTA QUE SIMPLIFICOU TUDO: as quatro filas anteriores eram FATIAS DA
-- MESMA POPULACAO -- aluno com pagamento nao conferido. "Quitacao sugerida",
-- "Possivel acordo" e "Conciliacao" olhavam o mesmo conjunto por angulos
-- diferentes. A diferenca entre elas e ATRIBUTO DA LINHA, nao fila separada.
--
-- Por isso a linha traz os FATOS -- quanto entrou, quanto ainda deve (partido em
-- acordo e mensalidade), se tem acordo ativo -- e quem decide e a pessoa. Nada de
-- situacao derivada de comparar pago com saldo: pagamento a vista vem maior que o
-- principal, e isso nao e sinal de nada (premissa 17).
--
-- DOIS TIPOS DE LINHA, nunca repetindo pessoa:
--   ALUNO        pagamento ja vinculado                      1.365
--   SEM_VINCULO  dinheiro sem dono, agrupado pelo NOME do
--                arquivo (que e a chave do vinculo)          1.314
--   total 2.679 linhas, 5.572 pagamentos, R$ 9.026.477,20 que entraram e
--   R$ 6.323.939,30 em aberto.
--
-- `pagamento_ids` vai na linha para a tela vincular todos os pagamentos daquela
-- pessoa de uma vez -- `pagamento_vincular_aluno` e por pagamento.
--
-- CORTES da gestao: janela julho + agosto; saldo ZERO fora ("os que estao zerado
-- ja foram conferidos"); e so pagamento ainda NAO conferido. A faixa filtra por
-- saldo, entao com faixa > 0 as linhas SEM_VINCULO somem -- elas nao tem saldo.

create or replace function public.conferencia_pagamentos(
  p_desde date default date '2026-07-01',
  p_faixa_min numeric default 0,
  p_limite int default 300
)
returns table (
  tipo text, aluno_id uuid, nome text, cpf text, responsavel text,
  entrou numeric, qtd_pagamentos int, primeiro_pagamento date, ultimo_pagamento date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  saldo_vencido numeric, tem_acordo boolean, pagamento_ids uuid[],
  total_linhas int, total_pagamentos int, total_entrou numeric, total_saldo numeric
)
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $$
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
     where n.aluno_id is not null
       and coalesce(al.saldo_total,0) > greatest(coalesce(p_faixa_min,0), 0.005)
     group by n.aluno_id, al.nome, al.cpf, al.responsavel_atual_nome,
              al.saldo_total, al.saldo_vencido, pc.parcelas, tt.titulos
  ),
  sem_vinculo as (
    select 'SEM_VINCULO'::text, null::uuid, max(n.aluno_nome), null::text, '(sem dono)'::text,
           round(sum(n.valor_pago),2), count(*)::int,
           min(n.data_pagamento), max(n.data_pagamento),
           0::numeric, 0::numeric, 0::numeric, 0::numeric, false, array_agg(n.id)
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
         t.x_saldo, t.x_acordo, t.x_mens, t.x_venc, t.x_tem_ac, t.x_pags,
         r.t_l, r.t_p, round(r.t_e,2), round(r.t_s,2)
    from tudo t cross join resumo r
   order by t.x_saldo desc, t.x_entrou desc, t.x_nome
   limit greatest(coalesce(p_limite,300),1);
end;
$$;

revoke all on function public.conferencia_pagamentos(date, numeric, int) from public, anon;
grant execute on function public.conferencia_pagamentos(date, numeric, int) to authenticated, service_role;
