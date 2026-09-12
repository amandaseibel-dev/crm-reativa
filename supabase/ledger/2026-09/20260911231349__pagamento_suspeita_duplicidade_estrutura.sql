-- Suspeita de duplicidade de pagamento: marca, nao bloqueia, nao descarta.
--
-- Por que nao ha constraint: o arquivo do Santander tem 11 colunas posicionais
-- e NENHUM identificador de transacao (sem NSU, sem nosso numero, sem
-- autenticacao, sem sequencia, sem hora, sem lote). Nao existe chave de
-- idempotencia verdadeira para construir.
--
-- E medido em prod 2026-09-11: das 37 repeticoes de boleto, 27 sao pagamento
-- de RESIDUO (um valor grande e depois um pequeno, dias depois) -- legitimo,
-- e nenhuma delas no mesmo dia. Bloquear por boleto derrubaria pagamento de
-- verdade. O que separa o trigo do joelho e a DATA: mesmo boleto no mesmo dia
-- sao 9 grupos, R$ 16.841,44 de excedente, e 7 deles diferem por CENTAVOS --
-- assinatura de reimportacao com recalculo.
--
-- Nada aqui altera `pagamentos`, valor recebido, baixa ou relatorio. A tabela
-- e um caderno de conferencia ao lado, e nenhuma rotina automatica a consome.

create table if not exists public.pagamento_suspeita_duplicidade (
  id                        bigserial primary key,
  pagamento_id              uuid not null references public.pagamentos(id) on delete cascade,
  pagamento_anterior_id     uuid not null references public.pagamentos(id) on delete cascade,
  numero_parcela_completo   text not null,
  data_pagamento            date,
  valor_novo                numeric,
  valor_anterior            numeric,
  diferenca_abs             numeric,
  diferenca_pct             numeric,
  confianca                 text not null check (confianca in ('ALTA','MEDIA','BAIXA')),
  motivo                    text not null,
  importacao_id             uuid,
  importacao_anterior_id    uuid,
  detectado_em              timestamptz not null default now(),
  -- conferencia humana; nada decide sozinho
  decisao                   text check (decisao in ('DUPLICADO','LEGITIMO')),
  conferido_em              timestamptz,
  conferido_por             text,
  observacao                text,
  constraint pagamento_suspeita_par_unico unique (pagamento_id, pagamento_anterior_id)
);

create index if not exists ix_pag_suspeita_pendente
  on public.pagamento_suspeita_duplicidade (detectado_em desc) where decisao is null;
create index if not exists ix_pag_suspeita_boleto
  on public.pagamento_suspeita_duplicidade (numero_parcela_completo, data_pagamento);

-- Deny-all: so service_role/postgres alcanca. Quando houver tela de gestao,
-- entra a policy de leitura para gestao.
alter table public.pagamento_suspeita_duplicidade enable row level security;

comment on table public.pagamento_suspeita_duplicidade is
  'Suspeita de pagamento repetido (mesmo boleto + mesma data). Caderno de conferencia: nao bloqueia importacao, nao altera pagamentos, nao entra em relatorio financeiro.';

-- Detector. Le `pagamentos` e escreve SO na tabela de suspeita. Idempotente
-- pelo par (pagamento_id, pagamento_anterior_id). Se p_importacao_id vier,
-- olha apenas os pagamentos daquela importacao (uso pos-importacao).
create or replace function public.pagamentos_detectar_suspeita_duplicidade(
  p_importacao_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_novas int := 0;
begin
  with pares as (
    select
      novo.id                  as pagamento_id,
      ant.id                   as pagamento_anterior_id,
      novo.numero_parcela_completo,
      novo.data_pagamento,
      novo.valor_pago          as valor_novo,
      ant.valor_pago           as valor_anterior,
      abs(coalesce(novo.valor_pago,0) - coalesce(ant.valor_pago,0)) as dif_abs,
      case when greatest(abs(coalesce(novo.valor_pago,0)), abs(coalesce(ant.valor_pago,0))) > 0
           then abs(coalesce(novo.valor_pago,0) - coalesce(ant.valor_pago,0))
                / greatest(abs(coalesce(novo.valor_pago,0)), abs(coalesce(ant.valor_pago,0)))
           else 0 end as dif_pct,
      novo.importacao_id,
      ant.importacao_id as importacao_anterior_id
    from public.pagamentos novo
    join public.pagamentos ant
      on ant.numero_parcela_completo = novo.numero_parcela_completo
     and ant.data_pagamento          = novo.data_pagamento
     -- o "anterior" e o que entrou antes; evita gravar o par duas vezes
     and (ant.created_at, ant.id) < (novo.created_at, novo.id)
    where novo.numero_parcela_completo is not null
      and novo.data_pagamento is not null
      and (p_importacao_id is null or novo.importacao_id = p_importacao_id)
  ),
  classificado as (
    select p.*,
      case when coalesce(valor_novo,0) = 0 or coalesce(valor_anterior,0) = 0 then 'BAIXA'
           when dif_abs <= 1.00 or dif_pct <= 0.01                          then 'ALTA'
           when dif_pct <= 0.85                                             then 'MEDIA'
           else 'BAIXA' end as confianca,
      case when coalesce(valor_novo,0) = 0 or coalesce(valor_anterior,0) = 0
             then 'Mesmo boleto e mesma data, e um dos lancamentos tem valor zero -- linha provavelmente invalida.'
           when dif_abs <= 1.00 or dif_pct <= 0.01
             then 'Mesmo boleto, mesma data e valor praticamente igual (diferenca de centavos): assinatura de reimportacao do mesmo pagamento.'
           when dif_pct <= 0.85
             then 'Mesmo boleto e mesma data, valores diferentes: pode ser pagamento parcial no mesmo dia ou reimportacao com recalculo. Precisa conferencia.'
           else 'Mesmo boleto e mesma data, valores muito distintos: conferir se sao dois recebimentos reais.'
      end as motivo
    from pares p
  )
  insert into public.pagamento_suspeita_duplicidade (
    pagamento_id, pagamento_anterior_id, numero_parcela_completo, data_pagamento,
    valor_novo, valor_anterior, diferenca_abs, diferenca_pct, confianca, motivo,
    importacao_id, importacao_anterior_id)
  select pagamento_id, pagamento_anterior_id, numero_parcela_completo, data_pagamento,
         valor_novo, valor_anterior, round(dif_abs,2), round(dif_pct,4), confianca, motivo,
         importacao_id, importacao_anterior_id
    from classificado
  on conflict (pagamento_id, pagamento_anterior_id) do nothing;

  get diagnostics v_novas = row_count;

  return jsonb_build_object(
    'novas_suspeitas', v_novas,
    'pendentes_total', (select count(*) from public.pagamento_suspeita_duplicidade where decisao is null),
    'escopo', coalesce(p_importacao_id::text, 'historico completo'),
    'em', now());
end;
$fn$;

-- Visao de conferencia
create or replace view public.vw_pagamento_suspeita_pendente as
select s.id, s.numero_parcela_completo, s.data_pagamento, s.confianca,
       s.valor_anterior, s.valor_novo, s.diferenca_abs, s.diferenca_pct, s.motivo,
       s.pagamento_anterior_id, s.pagamento_id,
       ia.arquivo_nome as arquivo_anterior, inew.arquivo_nome as arquivo_novo,
       s.detectado_em
from public.pagamento_suspeita_duplicidade s
left join public.importacoes ia   on ia.id   = s.importacao_anterior_id
left join public.importacoes inew on inew.id = s.importacao_id
where s.decisao is null;

-- Primeira varredura sobre todo o historico (escreve so na tabela de suspeita)
select public.pagamentos_detectar_suspeita_duplicidade();
