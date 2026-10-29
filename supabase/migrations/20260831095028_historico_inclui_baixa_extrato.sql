-- SINCRONIA ENTRE AS ABAS: o Historico passa a enxergar a baixa pelo extrato.
--
-- Amanda: "tenha uma sincronicidade entre as abas".
--
-- A FALHA: `historico_confirmacoes_por_dia` lia SO
-- `solicitacoes_confirmacao_pagamento`. Baixando pela Confirmacao de Pagamento
-- (a fila nova), quem TINHA confirmacao aberta aparecia -- a funcao grava
-- PAGAMENTO_CONFIRMADO com confirmado_em. Mas quem NAO tinha confirmacao
-- pendente sumia: a baixa ia para `baixas_pagamento` e o Historico nao olhava
-- ali. Sao 1.301 das 2.144 pessoas da fila -- o trabalho desapareceria do
-- registro do dia.
--
-- Agora o Historico soma as duas origens SEM contar duas vezes: a baixa pelo
-- extrato so entra quando nao existe solicitacao daquele aluno confirmada no
-- mesmo dia. A acao aparece como 'BAIXA_EXTRATO', separada de 'CONFIRMADO',
-- para dar para ver de onde veio cada decisao.
--
-- Testado em producao com ROLLBACK: aluno com saldo e sem confirmacao aberta --
-- BAIXA_EXTRATO no historico foi de 0 para 1 apos a baixa.

create or replace function public.historico_confirmacoes_por_dia()
returns table(dia date, usuario text, email text, acao text, automatico boolean, qtd bigint)
language sql stable security definer
set search_path to 'public'
as $function$
  with base as (
    select
      (s.confirmado_em at time zone 'America/Sao_Paulo')::date as dia,
      case when lower(btrim(coalesce(s.confirmado_por, ''))) like '%@%'
           then lower(btrim(s.confirmado_por)) end as email_autor,
      case
        when s.status = 'PAGAMENTO_CONFIRMADO'                          then 'CONFIRMADO'
        when s.status in ('CONCLUIDA_SALDO_ZERO','ENCERRADO_SALDO_ZERO') then 'SALDO_ZERO'
        when s.status = 'PAGAMENTO_REJEITADO'                            then 'REJEITADO'
      end as acao
    from public.solicitacoes_confirmacao_pagamento s
    where s.confirmado_em is not null
      and s.status in ('PAGAMENTO_CONFIRMADO','CONCLUIDA_SALDO_ZERO',
                       'ENCERRADO_SALDO_ZERO','PAGAMENTO_REJEITADO')
      and (s.confirmado_em at time zone 'America/Sao_Paulo')::date
          >= (now() at time zone 'America/Sao_Paulo')::date - 60
    union all
    select
      (b.baixado_em at time zone 'America/Sao_Paulo')::date as dia,
      case when lower(btrim(coalesce(b.baixado_por_email,''))) like '%@%'
           then lower(btrim(b.baixado_por_email)) end as email_autor,
      'BAIXA_EXTRATO' as acao
    from public.baixas_pagamento b
    where b.baixado_em is not null
      and upper(coalesce(b.status_baixa,'')) = 'REALIZADA'
      and coalesce(b.observacao_operador,'') ilike '%extrato do Santander%'
      and (b.baixado_em at time zone 'America/Sao_Paulo')::date
          >= (now() at time zone 'America/Sao_Paulo')::date - 60
      and not exists (
        select 1 from public.solicitacoes_confirmacao_pagamento s2
         where s2.aluno_id = b.aluno_id
           and s2.confirmado_em is not null
           and (s2.confirmado_em at time zone 'America/Sao_Paulo')::date
               = (b.baixado_em at time zone 'America/Sao_Paulo')::date
      )
  )
  select
    base.dia,
    coalesce(u.nome, base.email_autor, 'sistema') as usuario,
    base.email_autor as email,
    base.acao,
    base.email_autor is null as automatico,
    count(*) as qtd
  from base
  left join public.usuarios u on lower(btrim(u.email)) = base.email_autor
  where base.acao is not null
  group by base.dia, coalesce(u.nome, base.email_autor, 'sistema'),
           base.email_autor, base.acao, base.email_autor is null
  order by base.dia desc, qtd desc;
$function$;

revoke all on function public.historico_confirmacoes_por_dia() from public, anon;
grant execute on function public.historico_confirmacoes_por_dia() to authenticated, service_role;
