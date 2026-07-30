-- ROLLBACK: CALIBRAGEM — APROVAR + EXECUTOR TRANSACIONAL
-- OBS: não reverte movimentações já executadas (isso é feito via nova simulação
-- inversa ou restauração de backup). Remove apenas as funções e colunas novas.
begin;
drop function if exists public.calibragem_executar_simulacao(uuid);
drop function if exists public.calibragem_aprovar_simulacao(uuid);
alter table public.casos drop column if exists nivelamento_simulacao_id;
alter table public.casos drop column if exists nivelamento_em;
alter table public.casos drop column if exists nivelamento_marcador;
commit;
