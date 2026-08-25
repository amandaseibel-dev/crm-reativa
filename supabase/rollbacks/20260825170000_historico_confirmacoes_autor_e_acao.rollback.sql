-- Rollback de 20260825170000_historico_confirmacoes_autor_e_acao.sql
-- Volta a RPC à forma antiga (só PAGAMENTO_CONFIRMADO, apelido, sem ação).
-- A coluna usuarios.nome_exibicao NÃO é removida de propósito: ela é aditiva,
-- ninguém mais depende dela, e apagá-la traria de volta a ambiguidade entre as
-- duas Amandas em qualquer tela que venha a usá-la.
drop function if exists public.historico_confirmacoes_por_dia();

create or replace function public.historico_confirmacoes_por_dia()
  returns table(dia date, usuario text, email text, qtd bigint)
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  select (s.confirmado_em at time zone 'America/Sao_Paulo')::date as dia,
         coalesce(nullif(u.apelido,''), nullif(u.nome,''), s.confirmado_por, '-') as usuario,
         lower(coalesce(s.confirmado_por,'-')) as email,
         count(*) as qtd
  from public.solicitacoes_confirmacao_pagamento s
  left join public.usuarios u on lower(u.email) = lower(s.confirmado_por)
  where s.status = 'PAGAMENTO_CONFIRMADO'
    and s.confirmado_em is not null
    and (s.confirmado_em at time zone 'America/Sao_Paulo')::date >= (now() at time zone 'America/Sao_Paulo')::date - 30
  group by 1, 2, 3
  order by 1 desc, qtd desc;
$function$;
