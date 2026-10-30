-- ROLLBACK da Fase 2 passo 2.1 (fila de confirmacao de pagamentos em modo sombra).
--
-- POR QUE ESTE ROLLBACK E SEGURO DE RODAR: a migration 20261020140500 nao altera NENHUM
-- objeto preexistente. Ela cria uma tabela, quatro indices, uma politica, duas funcoes e
-- UMA linha de configuracao. Desfazer e remover exatamente esses objetos -- nada que
-- existia antes precisa ser restaurado, e por isso este rollback nao depende de PITR
-- (que nao esta habilitado neste projeto).
--
-- O QUE ELE APAGA: os itens da fila, que sao dados DERIVADOS de `pagamentos`. Nenhuma
-- baixa, nenhum pagamento, nenhuma parcela, nenhum acordo. Reenfileirar reconstroi a
-- fila a partir da mesma fonte -- EXCETO as decisoes humanas (`decidido_por`,
-- `decidido_em`, `decisao`, `motivo` de NAO_IDENTIFICADO), que sao informacao original e
-- NAO voltam.
--
-- POR ISSO A GUARDA ABAIXO: se alguem ja decidiu algo na fila, este rollback PARA e
-- exige a saida explicita. Rollback que apaga decisao humana em silencio e pior que
-- nenhum rollback.
--   Saida explicita (consciente, da gestao), na SESSAO, antes de rodar este arquivo --
--   `set local` NAO serve aqui porque o arquivo abre a propria transacao:
--     set rollback_fila_confirmacao.apagar_decisoes = 'sim';
--   e, depois do rollback:
--     reset rollback_fila_confirmacao.apagar_decisoes;
begin;

do $do$
declare v_dec int; v_saida text;
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname='public' and c.relname='fila_confirmacao_pagamento') then
    raise notice 'A fila nao existe -- nada a desfazer na tabela.';
    return;
  end if;

  select count(*) into v_dec
    from public.fila_confirmacao_pagamento
   where decidido_por is not null or decisao is not null or estado = 'NAO_IDENTIFICADO';

  if v_dec > 0 then
    v_saida := current_setting('rollback_fila_confirmacao.apagar_decisoes', true);
    if coalesce(v_saida,'') <> 'sim' then
      raise exception
        'ABORTA: a fila tem % item(ns) com decisao humana registrada. Esses dados nao se '
        'reconstroem reenfileirando. Para apagar de proposito, rode antes na sessao: '
        'set rollback_fila_confirmacao.apagar_decisoes = ''sim'';', v_dec;
    end if;
    raise notice 'Saida explicita aceita: apagando % item(ns) com decisao humana.', v_dec;
  end if;
end
$do$;

drop function if exists public.confirmacao_fila_enfileirar_lote(date, integer, boolean);
drop function if exists public.confirmacao_fila_enfileirar_um(uuid, date, boolean);

-- A politica `fila_confirmacao_leitura_gestao` e os quatro indices caem COM a tabela.
-- Nao ha `drop policy` separado de proposito: `drop policy if exists ... on <tabela>`
-- ainda falha quando a TABELA nao existe, e este rollback precisa poder rodar duas vezes.
drop table if exists public.fila_confirmacao_pagamento;

-- A linha de configuracao e da Fase 2 e nao existia antes.
delete from public.fluxo_pagamentos_config where etapa = 'fila_confirmacao_enfileirar';

do $do$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname='public' and c.relname='fila_confirmacao_pagamento') then
    raise exception 'ABORTA: a fila continua existindo depois do rollback';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='public' and p.proname like 'confirmacao_fila_enfileirar%') then
    raise exception 'ABORTA: o populador continua existindo depois do rollback';
  end if;
  if exists (select 1 from public.fluxo_pagamentos_config where etapa='fila_confirmacao_enfileirar') then
    raise exception 'ABORTA: a etapa continua em fluxo_pagamentos_config';
  end if;
  raise notice 'OK: fila, populador e etapa removidos. Nenhum objeto preexistente foi tocado.';
end
$do$;

commit;
