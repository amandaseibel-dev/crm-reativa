-- PROPOSTA · RECOLOCAR O PREDICADO DO CONTADOR DEPOIS DA #738
-- =============================================================================
-- NÃO É MIGRATION. Mora em `supabase/propostas/` de propósito: não tem
-- timestamp de 14 dígitos, nenhum pipeline a enxerga, e ninguém a aplica por
-- engano. É o caminho de desbloqueio da #738, escrito antes de ser preciso.
--
-- QUANDO ESTE ARQUIVO VIRA MIGRATION
--   Somente se a gestão decidir aplicar a #738
--   (`20261023004500_fluxo_incremental_reserva_bloqueado`) em produção. Enquanto
--   a #738 estiver bloqueada, este arquivo fica exatamente aqui.
--
-- COMO PROMOVER
--   1. decidir aplicar a #738;
--   2. copiar este corpo para
--      `supabase/migrations/<AAAAMMDDHHMMSS>_contador_pendentes_apos_reserva.sql`,
--      com timestamp POSTERIOR ao instante em que a #738 for aplicada -- e,
--      portanto, posterior a 20261024170000 também;
--   3. aplicar a #738 e, na sequência, esta;
--   4. remover a entrada `20261023004500` da lista de BLOQUEADAS em
--      `supabase/tests/contador_pendentes_nao_regride.test.js` -- a catraca
--      recusa exceção morta, então ela cobra essa limpeza.
--
-- POR QUE ELA É NECESSÁRIA
--   A #738 faz `create or replace function public.fluxo_pagamentos_incremental`
--   com o corpo INTEIRO e NÃO traz o predicado do estado terminal (conferido:
--   `grep -c ENCERRADO_SEM_EFEITO_FINANCEIRO` = 0 no arquivo dela). Aplicada
--   depois de 20261024170000, ela devolveria o contador ao estado anterior e
--   `pendentes` voltaria a contar os pagamentos já encerrados sem efeito
--   financeiro -- em silêncio, porque nada falha.
--
--   Não dá para corrigir o arquivo da #738: ele está mesclado na `main` e a
--   catraca do repositório recusa alterar migration que já existe no branch
--   base (`scripts/ci/catraca-migrations.mjs`, "migration que já existia no
--   branch base foi modificada"). Então a correção vem DEPOIS, por arquivo
--   próprio.
--
-- O QUE ELA FAZ, E O QUE NÃO FAZ
--   Troca UMA expressão -- a do contador `v_pend` -- por patch ancorado. Não
--   mexe na seleção do lote, nos tetos, na trava, na espera nem na reserva que
--   a #738 introduz. Não cria objeto, não grava dado, não tem DML. Idempotente:
--   se o predicado já estiver lá, `internal.patch_funcao_ancorada` devolve
--   `notice` e não faz nada.
--
--   É o MESMO patch de `20261024170000_conciliacao_saida_terminal.sql`, com a
--   MESMA âncora. A âncora existe no corpo da #738: conferido em 24/10/2026,
--   linha 352 do arquivo dela é
--   `   where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';`
--   -- idêntica à do corpo vivo. Por isso o patch encaixa nos dois corpos, e por
--   isso aplicar a #738 ANTES de 20261024170000 também seria seguro.
-- =============================================================================

select internal.patch_funcao_ancorada(
  'public',
  'fluxo_pagamentos_incremental',
  $ancora$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';$ancora$,
  $novo$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO'
     -- SAIDA TERMINAL (24/10/2026): quem ja foi encerrado sem efeito financeiro
     -- deixa de ser contado como pendente. So o CONTADOR muda; a selecao do
     -- lote acima continua identica.
     and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$novo$,
  1
);

-- O PORTÃO. Mesmo do 20261024170000: o predicado tem de estar no contador, e a
-- seleção do lote tem de seguir sem ele.
do $portao$
declare v_n int; v_ok boolean;
begin
  select (length(p.prosrc) - length(replace(p.prosrc,
            $x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$, '')))
         / length($x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$)
    into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if coalesce(v_n, 0) <> 1 then
    raise exception 'PORTAO: o contador tem % ocorrencia(s) do predicado, esperado 1.', coalesce(v_n, 0);
  end if;

  select position($y$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$y$ in p.prosrc)
         > position($y$select count(*) into v_pend$y$ in p.prosrc)
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if not coalesce(v_ok, false) then
    raise exception 'PORTAO: o predicado nao esta no contador -- pode ter caido na selecao do lote.';
  end if;

  raise notice 'Contador de pendentes recolocado apos a reserva. Nenhum pagamento movido.';
end
$portao$;
