-- CORRECAO DE DADO (aprovada pela Amanda em 25/09/2026): devolve para ABERTO
-- as 19 mensalidades que a regra de 22/09 deixou presas como NEGOCIADO em
-- acordo cancelado sem nenhum pagamento. Os ids vem do backup criado antes
-- (_backup_reabre_mensalidade_acordo_cancelado_20260925, versao 20260925125311).
-- Cada titulo passa por titulo_reavaliar (regra 20260925123852). Nao vincula
-- nada a acordo novo. Aborta inteira se qualquer trava falhar.
do $$
declare
  v_ids uuid[];
  v_regra uuid[];
  v_qtd int;
  v_soma numeric;
  v_fp_sql text;
  v_fp_antes jsonb;
  v_fp_depois jsonb;
  v_n int;
begin
  -- 0) a regra nova tem de estar em producao
  if md5((select p.prosrc from pg_proc p where p.oid = 'public.titulo_reavaliar(uuid)'::regprocedure))
     <> 'efdf3fd198a56198223ade82e4991d40' then
    raise exception 'titulo_reavaliar em producao nao e o de 20260925123852';
  end if;

  -- 1) ids e totais do backup
  select array_agg(id order by id), count(*), coalesce(sum(valor_original), 0)
    into v_ids, v_qtd, v_soma
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925;
  if v_qtd <> 19 or v_soma <> 8457.59 then
    raise exception 'backup com % titulos / R$ % (esperado 19 / 8457.59)', v_qtd, v_soma;
  end if;

  -- 2) nenhuma das 19 mudou desde o backup (todas as colunas)
  select count(*) into v_n
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925 b
    join public.acordos_titulos t on t.id = b.id
   where to_jsonb(t) = (to_jsonb(b) - 'salvo_em');
  if v_n <> 19 then
    raise exception 'so % das 19 continuam identicas ao backup', v_n;
  end if;

  -- 3) a regra ainda aponta exatamente estas 19, nem mais nem menos
  select array_agg(t.id order by t.id) into v_regra
    from public.acordos_titulos t
    join public.acordos ac on ac.id = t.acordo_id
   where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
     and upper(coalesce(ac.status,'')) in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'))
     and not exists (
       select 1
         from (select v.acordo_id from public.acordo_titulo_vinculo v where v.titulo_id = t.id
               union
               select t.acordo_id) c
        where c.acordo_id is not null
          and (exists (select 1 from public.parcelas p
                        where p.acordo_id = c.acordo_id and upper(coalesce(p.status,'')) = 'PAGO')
               or exists (select 1 from public.baixas_pagamento b
                           where b.acordo_id = c.acordo_id and b.devolvido_em is null)));
  if v_regra is distinct from v_ids then
    raise exception 'a regra aponta % titulos diferentes do backup', coalesce(array_length(v_regra, 1), 0);
  end if;

  -- 4) impressao digital de tudo que NAO pode mudar
  v_fp_sql := $q$
    select jsonb_build_object(
      'acordos', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.acordos x),
      'parcelas', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.parcelas x),
      'pagamentos', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.pagamentos x),
      'acordo_titulo_vinculo', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.acordo_titulo_vinculo x),
      'baixas_pagamento', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.baixas_pagamento x),
      'casos', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.casos x),
      'acordos_titulos_fora_das_19', (select jsonb_build_array(count(*), md5(coalesce(string_agg(md5(x::text), '' order by x.id), ''))) from public.acordos_titulos x where x.id <> all($1))
    ) $q$;
  execute v_fp_sql into v_fp_antes using v_ids;

  -- 5) a correcao
  perform public.titulo_reavaliar(x) from unnest(v_ids) x;

  -- 6) conferencias
  execute v_fp_sql into v_fp_depois using v_ids;
  if v_fp_depois <> v_fp_antes then
    raise exception 'algo fora das 19 mudou: antes % depois %', v_fp_antes, v_fp_depois;
  end if;

  select count(*) into v_n
    from public.acordos_titulos
   where id = any(v_ids) and situacao = 'ABERTO' and status = 'em_aberto' and acordo_id is null;
  if v_n <> 19 then
    raise exception 'so % das 19 ficaram ABERTO/em_aberto/sem acordo', v_n;
  end if;

  -- so situacao, status, acordo_id e atualizado_em mudaram
  select count(*) into v_n
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925 b
    join public.acordos_titulos t on t.id = b.id
   where (to_jsonb(t) - 'situacao' - 'status' - 'acordo_id' - 'atualizado_em')
       = (to_jsonb(b) - 'salvo_em' - 'situacao' - 'status' - 'acordo_id' - 'atualizado_em');
  if v_n <> 19 then
    raise exception 'em % das 19 mudou alguma coluna alem de situacao/status/acordo_id/atualizado_em', 19 - v_n;
  end if;

  -- 7) a prova fica gravada junto do backup
  execute format('comment on table public._backup_reabre_mensalidade_acordo_cancelado_20260925 is %L',
    jsonb_build_object(
      'correcao', 'reabre_mensalidades_acordo_cancelado_sem_pagamento',
      'executada_em', now(),
      'titulos', 19, 'valor_original', v_soma,
      'impressao_digital_antes', v_fp_antes,
      'impressao_digital_depois', v_fp_depois,
      'iguais', v_fp_depois = v_fp_antes)::text);
end $$;
