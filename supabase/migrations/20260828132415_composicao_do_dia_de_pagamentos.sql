-- De quais arquivos e feito o total de um dia.
--
-- POR QUE EXISTE. A substituicao de importacao e por NOME DE ARQUIVO. Como a
-- Amanda sobe "Pagamentos para importar.xlsx" e o Diego sobe "relatorio dia
-- 27.xlsx", uma nunca substitui a outra: o total do dia e a SOMA dos arquivos,
-- nao o ultimo. Em 27/08/2026 foram quatro arquivos concorrendo pelo mesmo dia,
-- e a Amanda achou que a projecao estava desatualizada -- estava certa, era o
-- numero que nao se explicava.
--
-- Isto NAO muda o comportamento da importacao. Chegamos a considerar trocar a
-- substituicao para "por dia", e medimos: apagaria 2.318 pagamentos do mes,
-- R$ 2.962.359,19. A importacao aditiva com trava de duplicidade esta certa
-- para como eles trabalham (varios arquivos parciais no mesmo dia). O que
-- faltava era so o numero se explicar.

create or replace function public.composicao_do_dia(p_dia date)
returns table (
  arquivo_nome text, usuario text, status text,
  importado_em timestamptz, linhas int,
  valor numeric, honorario numeric
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(i.arquivo_nome, '(sem importacao)'),
         coalesce(i.usuario, '-'),
         coalesce(i.status, '-'),
         i.created_at,
         count(*)::int,
         round(sum(coalesce(p.valor_pago,0)), 2),
         round(sum(coalesce(p.valor_honorario,0)), 2)
    from public.pagamentos p
    left join public.importacoes i on i.id = p.importacao_id
   where p.data_pagamento = p_dia
   group by 1,2,3,4
   order by 5 desc;
$$;

revoke all on function public.composicao_do_dia(date) from public, anon;
grant execute on function public.composicao_do_dia(date) to authenticated, service_role;
