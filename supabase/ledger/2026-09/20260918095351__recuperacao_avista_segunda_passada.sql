-- SEGUNDA PASSADA (idempotencia). Nada do que o lote 1 tratou pode ser
-- tratado de novo; nenhum motivo pode ser reescrito sem mudanca.
do $idem$
declare
  v_r jsonb; v_t0 timestamptz; v_ms numeric; v_lote1 uuid[]; v_numeros text[];
  v_ac_a int; v_fila_a text; v_falhas text[] := '{}';
begin
  if (select ligado from public.fluxo_pagamentos_config where etapa = 'recuperar_acordo_avista') is distinct from false then
    raise exception 'IDEM: a etapa deveria estar desligada';
  end if;
  select array_agg((i ->> 'pagamento_id')::uuid), array_agg(i ->> 'numero_ulbra')
    into v_lote1, v_numeros
    from public.fluxo_pagamentos_execucoes e, jsonb_array_elements(e.resultado -> 'itens_da_rotina') i
   where e.origem = 'rollout_recuperacao_avista_lote_1' and (i ->> 'gravou')::boolean;
  if cardinality(v_lote1) <> 14 then raise exception 'IDEM: lote 1 nao encontrado'; end if;

  select count(*) into v_ac_a from public.acordos;
  select md5(string_agg(f.pagamento_id::text || coalesce(f.motivo,'') || coalesce(f.decisao,''), '|' order by f.pagamento_id)) into v_fila_a
    from public.fila_pagamento_sem_vinculo f;

  v_t0 := clock_timestamp();
  v_r := public.acordo_avista_recuperar_pendentes(50);
  v_ms := round(extract(epoch from clock_timestamp() - v_t0) * 1000);

  if (v_r ->> 'erros')::int <> 0 then v_falhas := v_falhas || 'erros na segunda passada'::text; end if;
  if exists (select 1 from jsonb_array_elements(v_r -> 'itens') i where (i ->> 'pagamento_id')::uuid = any(v_lote1)) then
    v_falhas := v_falhas || 'a segunda passada voltou a avaliar pagamento ja tratado'::text;
  end if;
  if exists (select 1 from unnest(v_numeros) n where (select count(*) from public.acordos a where ltrim(a.numero_ulbra,'0') = ltrim(n,'0')) <> 1) then
    v_falhas := v_falhas || 'acordo do lote 1 duplicado'::text;
  end if;
  if (v_r ->> 'recuperados')::int = 0 and (select count(*) from public.acordos) <> v_ac_a then
    v_falhas := v_falhas || 'acordo criado sem recuperacao'::text;
  end if;
  if (v_r ->> 'recuperados')::int = 0 and v_fila_a is distinct from
     (select md5(string_agg(f.pagamento_id::text || coalesce(f.motivo,'') || coalesce(f.decisao,''), '|' order by f.pagamento_id)) from public.fila_pagamento_sem_vinculo f) then
    v_falhas := v_falhas || 'fila reescrita sem mudanca'::text;
  end if;
  if cardinality(v_falhas) > 0 then
    raise exception 'SEGUNDA PASSADA ABORTADA: % | %', array_to_string(v_falhas, ' || '), (v_r - 'itens')::text;
  end if;

  insert into public.fluxo_pagamentos_execucoes (origem, resultado)
  values ('rollout_recuperacao_avista_lote_2',
          jsonb_build_object('rotina', v_r - 'itens', 'tempo_ms', v_ms, 'itens_da_rotina', v_r -> 'itens',
                             'idempotencia', 'nenhum dos 14 do lote 1 reavaliado; acordos e fila sem mudanca'));
end;
$idem$;
