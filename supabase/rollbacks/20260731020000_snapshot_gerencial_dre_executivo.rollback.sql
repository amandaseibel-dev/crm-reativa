-- ROLLBACK: SNAPSHOT GERENCIAL — DRE e Executivo voltam a ser AO VIVO
-- (o front deve voltar a chamar dashboard_executivo / dre_dados)
begin;
drop function if exists public.atualizar_snapshots_gerenciais(int);
drop function if exists public.dre_snapshot(int);
drop function if exists public.dashboard_executivo_snapshot();
drop function if exists public.snapshot_gerencial_e_gestao();
drop table if exists public.snapshot_gerencial;
commit;
