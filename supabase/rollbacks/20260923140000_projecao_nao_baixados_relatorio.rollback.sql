-- ROLLBACK de 20260923140000_projecao_nao_baixados_relatorio.sql
--
-- A migration so CRIOU uma funcao de leitura. Nao alterou tabela, nao alterou
-- nenhuma funcao existente, nao gravou linha nenhuma -- entao desfazer e
-- apagar a funcao, e mais nada. Nenhum dado depende dela.
--
-- Depois disto, a aba "Não baixados / Rejeitados" da Projecao passa a mostrar
-- o erro de carregamento. A fila de "Pagamentos sem vinculo", o motor da
-- conciliacao e a propria Projecao continuam intactos: nenhum deles chama esta
-- funcao.

drop function if exists public.projecao_nao_baixados(jsonb);

do $prova$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'projecao_nao_baixados') then
    raise exception 'ROLLBACK: projecao_nao_baixados ainda existe';
  end if;
end
$prova$;
