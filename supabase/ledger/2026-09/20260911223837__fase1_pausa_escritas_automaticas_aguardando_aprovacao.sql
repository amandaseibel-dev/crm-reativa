-- Fase 1: observabilidade primeiro. Nada escreve sozinho sem aprovacao.
-- 1) casos_reabrir_com_divida volta EXATAMENTE a definicao anterior (o laco de
--    criacao de ficha fica fora de producao ate a previa ser aprovada). O job
--    horario :35 volta a fazer so o que ja fazia e ja estava autorizado.
do $restore$
declare v_def text;
begin
  select definicao_completa into v_def
    from public._backup_fn_casos_reabrir_com_divida_20260912 limit 1;
  if v_def is null then
    raise exception 'backup da funcao nao encontrado -- abortando para nao deixar a versao nova em producao';
  end if;
  execute v_def;
end
$restore$;

-- 2) Os dois jobs que ALTERAM dado financeiro ficam com o erro de tipo
--    corrigido, mas DESARMADOS. O comando correto fica gravado; so o disparo
--    automatico esta suspenso, aguardando aprovacao da previa.
select cron.alter_job((select jobid from cron.job where jobname = 'baixa_automatica_por_titulo'), active := false);
select cron.alter_job((select jobid from cron.job where jobname = 'fluxo_acordos_diario'),        active := false);
