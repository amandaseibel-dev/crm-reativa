-- RETOMADA DA ETAPA baixa_pelo_relatorio APOS O REPROCESSAMENTO DOS 69.
--
-- Encerra a pausa temporaria de 20260916112756. Altera SOMENTE a linha
-- 'baixa_pelo_relatorio' de fluxo_pagamentos_config: ligado volta a true e a
-- observacao volta, byte a byte, a que existia antes da pausa. A observacao da
-- pausa fica registrada em auditoria. Nenhuma outra etapa, funcao, gatilho ou
-- cron e tocado.

do $retoma$
declare
  c_obs_pausa    constant text := 'pausado temporariamente para aplicação/auditoria do backfill #392; não religar antes da fase dos pagamentos | ESTADO ANTERIOR: ligado=true / observacao anterior: ';
  c_obs_anterior constant text := 'le o numero do documento no pagamento, grava na parcela e baixa -- so quando o valor bate e o acordo esta ATIVO';
  c_fila         constant text := 'AGUARDANDO_ACORDO=38;PARCELA_JA_PAGA=6';
  c_fila_hash    constant text := '77e1ee5739011d4d8915ba547e90bc51acdcafca35e80dc92bd6d66c9556077e';
  c_motor_md5    constant text := 'fa3d64add73e0e73e587e16f0c0624d1';
  c_recalc_md5   constant text := '8632b2fcc49b7899fd48dc3801f6a309';
  c_fecha_md5    constant text := '9a2301342f99c312e7bfa971ac621a1e';

  v_ligado boolean;
  v_obs text;
  v_por text;
  v_txt text;
  v_n int;
  v_outras_antes text;
  v_outras_depois text;
begin
  set local lock_timeout = '3s';

  -- 1. a etapa esta exatamente como a pausa 20260916112756 a deixou
  select ligado, observacao, alterado_por into v_ligado, v_obs, v_por
    from public.fluxo_pagamentos_config
   where etapa = 'baixa_pelo_relatorio'
   for update;
  if not found then
    raise exception 'ABORTADO: etapa baixa_pelo_relatorio ausente';
  end if;
  if v_ligado is distinct from false then
    raise exception 'ABORTADO: baixa_pelo_relatorio nao esta pausada (ligado=%)', v_ligado;
  end if;
  if v_por is distinct from 'protecao_20260916_gestao'
     or v_obs is distinct from c_obs_pausa || c_obs_anterior then
    raise exception 'ABORTADO: a etapa nao esta no estado deixado pela pausa 20260916112756';
  end if;

  -- 2. nada que a primeira rodada baixaria sem autorizacao
  select count(*) into v_n from public.pagamentos where status_conciliacao = 'AGUARDANDO_AMARRACAO';
  if v_n <> 0 then
    raise exception 'ABORTADO: % pagamentos AGUARDANDO_AMARRACAO', v_n;
  end if;

  select coalesce(string_agg(s||'='||n, ';' order by s collate "C"),'') into v_txt
    from (select g.status_conciliacao s, count(*) n
            from public.pagamentos g
           where g.status_conciliacao is not null and g.status_conciliacao <> 'BAIXADO'
             and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                              where f.pagamento_id = g.id and f.decisao is not null)
           group by 1) t;
  if v_txt is distinct from c_fila then
    raise exception 'ABORTADO: fila do motor % difere da auditada %', v_txt, c_fila;
  end if;
  select encode(sha256(convert_to(string_agg(g.id::text||'|'||g.status_conciliacao||'|'||g.valor_pago::text, E'\n'
           order by g.id::text collate "C"),'UTF8')),'hex')
    into v_txt
    from public.pagamentos g
   where g.status_conciliacao is not null and g.status_conciliacao <> 'BAIXADO'
     and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                      where f.pagamento_id = g.id and f.decisao is not null);
  if v_txt is distinct from c_fila_hash then
    raise exception 'ABORTADO: os pagamentos da fila nao sao os 44 auditados (sha256 %)', v_txt;
  end if;

  -- 3. motor e gatilhos essenciais continuam os aprovados
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'pagamento_conciliar_um') is distinct from c_motor_md5 then
    raise exception 'ABORTADO: corpo de pagamento_conciliar_um mudou';
  end if;
  if (select t.tgenabled::text || md5(p.prosrc) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.parcelas'::regclass and t.tgname = 'trg_recalc_parcela' and not t.tgisinternal)
     is distinct from 'O' || c_recalc_md5 then
    raise exception 'ABORTADO: trg_recalc_parcela ausente, desabilitado ou alterado';
  end if;
  if (select t.tgenabled::text || md5(p.prosrc) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'public.parcelas'::regclass and t.tgname = 'trg_acordo_fecha_com_a_ultima_parcela' and not t.tgisinternal)
     is distinct from 'O' || c_fecha_md5 then
    raise exception 'ABORTADO: trg_acordo_fecha_com_a_ultima_parcela ausente, desabilitado ou alterado';
  end if;

  -- 4. nenhuma rodada do fluxo em andamento
  if exists (select 1 from cron.job_run_details r join cron.job j on j.jobid = r.jobid
              where j.jobname = 'fluxo_pagamentos_horario' and r.status in ('running','starting')) then
    raise exception 'ABORTADO: rodada de fluxo_pagamentos_horario em andamento';
  end if;

  -- 5. a unica escrita de configuracao
  select string_agg(etapa||'|'||ligado::text||'|'||coalesce(observacao,'')||'|'||
                    coalesce(alterado_em::text,'')||'|'||coalesce(alterado_por,''), E'\n' order by etapa)
    into v_outras_antes
    from public.fluxo_pagamentos_config
   where etapa <> 'baixa_pelo_relatorio';

  update public.fluxo_pagamentos_config
     set ligado = true,
         observacao = c_obs_anterior,
         alterado_em = now(),
         alterado_por = 'retomada_20260916_gestao'
   where etapa = 'baixa_pelo_relatorio'
     and ligado = false;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ABORTADO: % linhas alteradas, esperado 1', v_n;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'RELIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
          jsonb_build_object(
            'etapa', 'baixa_pelo_relatorio',
            'ligado_antes', false,
            'ligado_depois', true,
            'motivo', 'retomada apos o reprocessamento dos 69 (ledger 20260916134959); encerra a pausa 20260916112756',
            'observacao_da_pausa', v_obs,
            'observacao_restaurada', c_obs_anterior,
            'fila_no_momento', c_fila,
            'aguardando_amarracao', 0));

  -- 6. prova: so esta etapa mudou, e todas estao no estado exigido
  select string_agg(etapa||'|'||ligado::text||'|'||coalesce(observacao,'')||'|'||
                    coalesce(alterado_em::text,'')||'|'||coalesce(alterado_por,''), E'\n' order by etapa)
    into v_outras_depois
    from public.fluxo_pagamentos_config
   where etapa <> 'baixa_pelo_relatorio';
  if v_outras_depois is distinct from v_outras_antes then
    raise exception 'ABORTADO: outra etapa de fluxo_pagamentos_config mudou';
  end if;

  select string_agg(etapa||'='||ligado::text, ';' order by etapa collate "C") into v_txt
    from public.fluxo_pagamentos_config;
  if v_txt is distinct from 'amarrar_boleto=true;baixa_pelo_relatorio=true;baixa_por_documento=false;consulta_portador=false;pos_importacao=true;sinalizar_duplicado=true;vinculo_por_negociacao=false' then
    raise exception 'ABORTADO: estado final das etapas inesperado: %', v_txt;
  end if;
  if (select observacao from public.fluxo_pagamentos_config where etapa = 'baixa_pelo_relatorio') is distinct from c_obs_anterior then
    raise exception 'ABORTADO: observacao nao foi restaurada';
  end if;
end
$retoma$;

