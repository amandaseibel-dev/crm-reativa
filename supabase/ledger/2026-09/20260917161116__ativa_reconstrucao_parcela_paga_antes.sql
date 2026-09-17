-- ATIVACAO DA ETAPA reconstruir_parcela_paga_antes (17/09/2026, PR #403).
--
-- Liga SOMENTE a linha 'reconstruir_parcela_paga_antes' de
-- fluxo_pagamentos_config e roda a reconstrucao na hora, sem esperar a rodada
-- das :40. Guardas: funcoes com o md5 implantado em 20260917160417, fila do
-- motor igual a auditada (57 pendentes: 2 aprovados, 55 fora do alcance da
-- etapa), nenhuma rodada do fluxo em andamento, e resultado exatamente 72113 e
-- 72153 reconstruidos e baixados. Qualquer desvio aborta tudo, inclusive a
-- ativacao.

do $ativa$
declare
  c_fila         constant text := 'AGUARDANDO_ACORDO=43;PARCELA_JA_PAGA=12;REVISAO=2';
  c_fila_hash    constant text := '21686198ad2b1348c9e9102fc929fdeaf24b791bd7d4f039f1539ec51881ac25';
  c_motor_md5    constant text := 'fa3d64add73e0e73e587e16f0c0624d1';
  c_previa_md5   constant text := '216dda2dd924ef796ab45be4d74ff632';
  c_reconst_md5  constant text := '0bd85569a834454244abb5ea97f068a2';
  c_pend_md5     constant text := 'b2c955b43a05e7fe0b75738d273cbaa2';

  v_ligado boolean;
  v_por text;
  v_txt text;
  v_n int;
  v_r jsonb;
  v_outras_antes text;
  v_outras_depois text;
begin
  set local lock_timeout = '3s';

  -- 1. as funcoes sao as implantadas e auditadas
  if md5((select prosrc from pg_proc where oid = 'public.pagamento_conciliar_um(uuid,boolean)'::regprocedure)) is distinct from c_motor_md5
     or md5((select prosrc from pg_proc where oid = 'public.parcela_paga_antes_previa(uuid)'::regprocedure)) is distinct from c_previa_md5
     or md5((select prosrc from pg_proc where oid = 'public.parcela_paga_antes_reconstruir(uuid,boolean)'::regprocedure)) is distinct from c_reconst_md5
     or md5((select prosrc from pg_proc where oid = 'public.parcela_paga_antes_reconstruir_pendentes(integer,uuid[])'::regprocedure)) is distinct from c_pend_md5 then
    raise exception 'ABORTADO: funcoes diferentes das implantadas em 20260917160417';
  end if;

  -- 2. a etapa esta exatamente como a migration a deixou
  select ligado, alterado_por into v_ligado, v_por
    from public.fluxo_pagamentos_config
   where etapa = 'reconstruir_parcela_paga_antes'
   for update;
  if not found or v_ligado is distinct from false or v_por is distinct from 'migration_20260917200000' then
    raise exception 'ABORTADO: etapa nao esta como a migration deixou (ligado=%, por=%)', v_ligado, v_por;
  end if;

  -- 3. a fila e a auditada
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
    raise exception 'ABORTADO: os pagamentos da fila nao sao os 57 auditados (sha256 %)', v_txt;
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
   where etapa <> 'reconstruir_parcela_paga_antes';

  update public.fluxo_pagamentos_config
     set ligado = true,
         alterado_em = now(),
         alterado_por = 'ativacao_20260917_gestao'
   where etapa = 'reconstruir_parcela_paga_antes'
     and ligado = false;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'ABORTADO: % linhas alteradas, esperado 1', v_n;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'LIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
          jsonb_build_object(
            'etapa', 'reconstruir_parcela_paga_antes',
            'ligado_antes', false,
            'ligado_depois', true,
            'motivo', 'ativacao apos a auditoria da previa em todos os pendentes (PR #403, migration 20260917160417): 57 analisados, 2 aprovados (72113 e 72153), 55 fora do alcance da etapa',
            'fila_no_momento', c_fila));

  select string_agg(etapa||'|'||ligado::text||'|'||coalesce(observacao,'')||'|'||
                    coalesce(alterado_em::text,'')||'|'||coalesce(alterado_por,''), E'\n' order by etapa)
    into v_outras_depois
    from public.fluxo_pagamentos_config
   where etapa <> 'reconstruir_parcela_paga_antes';
  if v_outras_depois is distinct from v_outras_antes then
    raise exception 'ABORTADO: outra etapa de fluxo_pagamentos_config mudou';
  end if;

  -- 6. a reconstrucao na hora, pelo mesmo mecanismo da importacao e da rodada
  v_r := public.parcela_paga_antes_reconstruir_pendentes(50);
  select string_agg(i ->> 'boleto', ',' order by i ->> 'boleto') into v_txt
    from jsonb_array_elements(v_r -> 'itens') i
   where coalesce((i ->> 'gravou')::boolean, false);
  if (v_r ->> 'avaliados')::int <> 2 or (v_r ->> 'reconstruidas')::int <> 2 or (v_r ->> 'erros')::int <> 0
     or v_txt is distinct from '50721130001,50721530001' then
    raise exception 'ABORTADO: reconstrucao diferente da auditada: %', v_r;
  end if;

  -- 7. prova do estado final dos dois acordos
  select count(*) into v_n
    from public.pagamentos g
    join public.parcelas q on q.boleto = ltrim(g.numero_parcela_completo, '0')
    join public.acordos a on a.id = q.acordo_id
    join public.fila_pagamento_sem_vinculo f on f.pagamento_id = g.id
   where ltrim(g.numero_parcela_completo, '0') in ('50721130001', '50721530001')
     and g.status_conciliacao = 'BAIXADO'
     and q.status = 'PAGO' and q.origem_baixa_ref = g.id::text and q.boleto_confiavel and q.numero = 1
     and f.decisao = 'RESOLVIDO_AUTOMATICO'
     and a.status = 'ATIVO'
     and ((a.numero_ulbra = '72113' and a.qtd_parcelas = 5 and a.valor_total = 5356.23)
       or (a.numero_ulbra = '72153' and a.qtd_parcelas = 7 and a.valor_total = 5482.63))
     and (select count(*) from public.parcelas q2 where q2.acordo_id = a.id) = a.qtd_parcelas
     and (select sum(q2.valor) from public.parcelas q2 where q2.acordo_id = a.id) = a.valor_total;
  if v_n <> 2 then
    raise exception 'ABORTADO: estado final dos acordos 72113/72153 nao fecha (%)', v_n;
  end if;

  select coalesce(string_agg(s||'='||n, ';' order by s collate "C"),'') into v_txt
    from (select g.status_conciliacao s, count(*) n
            from public.pagamentos g
           where g.status_conciliacao is not null and g.status_conciliacao <> 'BAIXADO'
             and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                              where f.pagamento_id = g.id and f.decisao is not null)
           group by 1) t;
  if v_txt is distinct from 'AGUARDANDO_ACORDO=43;PARCELA_JA_PAGA=12' then
    raise exception 'ABORTADO: fila depois da reconstrucao inesperada: %', v_txt;
  end if;
end;
$ativa$;
