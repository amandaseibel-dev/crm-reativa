-- CONCILIACAO COM O ARQUIVO DO SANTANDER: o dinheiro entrou, e do nosso lado?
--
-- Pedido da Amanda: "podemos conciliar os casos de julho e agosto que consta
-- pagamento no arquivo santander e que nao foram vinculados ou que tem saldo em
-- aberto para ajuste? criar uma fila de confirmacao com base nesse arquivo?".
--
-- Universo em 29/08/2026: 8.355 pagamentos no arquivo desde 01/07, R$ 11.725.719,82.
--
--   VINCULAR  2.884 pagamentos  R$ 4.893.878,76  dinheiro sem dono (91 de nome repetido)
--   AJUSTAR   1.365 alunos      R$ 4.132.598,44  entrou dinheiro e o aluno segue devendo
--
-- POR QUE O SALDO VEM PARTIDO EM DOIS. A gestao explicou: "o saldo maior e pq tem
-- juros multa e honorarios". Dos R$ 6.323.939,30 que esses 1.365 ainda devem,
-- R$ 4.733.691,17 estao em PARCELA DE ACORDO -- valor ja negociado, que embute
-- juros, multa e honorarios -- e R$ 1.564.120,00 em MENSALIDADE aberta, que e
-- divida original. Sao decisoes diferentes, entao a fila mostra as duas metades
-- separadas em vez de um total que nao quer dizer nada.
--
-- LIMITE DO NOSSO DADO: nao da para decompor a parcela em principal + encargos.
-- O campo `parcelas.honorarios` esta praticamente vazio -- R$ 15.794,14 em
-- R$ 4,7 milhoes. O valor da parcela vem cheio e assim fica.
--
-- VALOR NAO E CHAVE E NAO E ALARME. Amanda: "sempre o valor do pagamento a vista
-- por exemplo sera maior que o valor principal". O arquivo traz valor cheio; o
-- nosso registro traz o principal. Logo "pagou mais do que devia" e o
-- comportamento NORMAL de quem quitou a vista, nao anomalia -- e conciliar por
-- valor produz falso positivo em massa. Casar por aluno + data, nunca por valor.
-- Mesmo fenomeno ja medido na Prime: paidAmount > netAmount em 89,4% dos casos,
-- acrescimo mediano +89,8%.
--
-- ORDEM: de tras pra frente, pagamento mais recente primeiro, dentro de cada
-- tipo -- decisao da gestao.
--
-- Esta funcao NAO altera nada. So lista para uma pessoa decidir.

create or replace function public.conciliacao_santander(p_desde date default date '2026-07-01')
returns table (
  tipo text, pagamento_id uuid, aluno_id uuid, nome text, cpf text, responsavel text,
  valor_pago numeric, qtd_pagamentos int, ultimo_pagamento date,
  saldo_aberto numeric, saldo_em_acordo numeric, saldo_em_mensalidade numeric,
  operador_pagamento text, nome_repetido boolean
)
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $$
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  return query
  with norm as (
    select a.id, translate(upper(regexp_replace(trim(coalesce(a.nome,'')), '\s+', ' ', 'g')),
                           'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nm
      from public.alunos a where coalesce(trim(a.nome),'') <> ''
  ),
  cont as (select nm, count(*) n from norm group by nm),
  ajustar as (
    select 'AJUSTAR'::text tipo, null::uuid pagamento_id, g.aluno_id, al.nome, al.cpf,
           coalesce(al.responsavel_atual_nome,'(sem dono)') responsavel,
           round(g.pago,2) valor_pago, g.qtd::int qtd_pagamentos, g.ultimo ultimo_pagamento,
           round(coalesce(al.saldo_total,0),2) saldo_aberto,
           round(coalesce(pc.parcelas,0),2) saldo_em_acordo,
           round(coalesce(tt.titulos,0),2) saldo_em_mensalidade,
           g.operador operador_pagamento, false nome_repetido
      from (
        select p.aluno_id, sum(p.valor_pago) pago, count(*) qtd,
               max(p.data_pagamento) ultimo, max(p.operador_nome) operador
          from public.pagamentos p
         where p.aluno_id is not null and p.data_pagamento >= p_desde
         group by p.aluno_id
      ) g
      join public.alunos al on al.id = g.aluno_id
      left join lateral (
        select coalesce(sum(pa.valor),0) parcelas
          from public.acordos ac join public.parcelas pa on pa.acordo_id = ac.id
         where ac.aluno_id = g.aluno_id and upper(coalesce(ac.status,'')) = 'ATIVO'
           and pa.status <> 'PAGO'
      ) pc on true
      left join lateral (
        select coalesce(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),0) titulos
          from public.acordos_titulos t
         where t.aluno_id = g.aluno_id and upper(coalesce(t.situacao,'')) = 'ABERTO'
      ) tt on true
     where coalesce(al.saldo_total,0) > 0.005
  ),
  vincular as (
    select 'VINCULAR'::text, p.id, null::uuid, p.aluno_nome, null::text, '(sem dono)'::text,
           round(p.valor_pago,2), 1, p.data_pagamento,
           null::numeric, null::numeric, null::numeric,
           p.operador_nome, coalesce(c.n,0) > 1
      from public.pagamentos p
      left join cont c on c.nm = translate(upper(regexp_replace(trim(coalesce(p.aluno_nome,'')), '\s+', ' ', 'g')),
                                           'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
     where p.aluno_id is null and p.data_pagamento >= p_desde
  )
  select * from ajustar
  union all
  select * from vincular
  order by 1, 9 desc nulls last, 7 desc;
end;
$$;

revoke all on function public.conciliacao_santander(date) from public, anon;
grant execute on function public.conciliacao_santander(date) to authenticated, service_role;
