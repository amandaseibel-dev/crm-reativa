-- ROLLBACK de 20261022164436_identidade_nula_restantes
-- =============================================================================
-- Desfaz a correção: devolve às funções a guarda SEM o teste de nulo.
--
-- LEIA ANTES DE RODAR. Isto REABRE o furo: com a guarda antiga, qualquer
-- chamador cujo token não traga claim de e-mail -- chave de serviço inclusive --
-- passa pela allowlist.
-- Em registrar_decisao_suspeita_duplicidade, reverter tambem devolve a chave
-- de servico o caminho que a isencao `auth.role() <> 'service_role'` abria.
--
-- Só faz sentido se a correção tiver causado problema PIOR do que o furo, e o
-- único efeito esperado dela é recusar quem antes passava sem e-mail. Se a
-- dúvida for sobre quem passou a ser recusado, o caminho é ler a mensagem de
-- recusa, não reabrir a porta.
--
-- Mesma técnica e mesmas três travas da ida, espelhadas. Nada de corpo
-- retypado. Idempotente.
begin;

do $$
declare
  r record;
  v_def text;
  v_novo text;
  v_atual text;
begin
  for r in
    select * from (values
      ('public.projecao_reprocessar_importacao(uuid)',
       '914d6f1246b3005aedd979f8a9b5af80',
       '4b3d3e4792f61c7d660d1a3d38f09b58'),
      ('public.registrar_decisao_suspeita_duplicidade(uuid,text,uuid,uuid,text)',
       '3caee080465ea1da3992eac032dfe453',
       '5c91e1545c85a850471e533831e01b1c'),
      ('public.projecao_definir_meta(text,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric)',
       'ecb5a8560012fde8bf6b95335afb2b90',
       'fa0b6f76caca6a1f3b70b5660c10206a'),
      ('public.projecao_definir_meta(text,numeric,numeric)',
       '0d652f76597fc8115ff9ab03db13f2a2',
       '51f402b6b805c46157ed23e41576a377'),
      ('public.projecao_definir_meta_operador(text,text,numeric)',
       'e36033aa65cdf4618a2c76b08f4d73ad',
       '1c06b879be23e360a2b41e24e47993db')
    ) as t(assinatura, md5_antes, md5_depois)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;

    if v_atual is null then
      raise exception 'FUNCAO AUSENTE: %', r.assinatura;
    end if;

    if v_atual = r.md5_depois then
      raise notice 'ja esta no estado original, nada a fazer: %', r.assinatura;
      continue;
    end if;

    if v_atual <> r.md5_antes then
      raise exception
        'CORPO INESPERADO em %: md5(prosrc) e %, esperado %. A funcao foi alterada depois da correcao -- nao reverter as cegas.',
        r.assinatura, v_atual, r.md5_antes;
    end if;

    v_def := pg_get_functiondef(r.assinatura::regprocedure);

    if (length(v_def) - length(replace(v_def, 'IF v_email IS NULL OR v_email NOT IN (', ''))) / length('IF v_email IS NULL OR v_email NOT IN (') <> 1 then
      raise exception 'ANCORA NAO UNICA em %', r.assinatura;
    end if;

    v_novo := replace(v_def, 'IF v_email IS NULL OR v_email NOT IN (', 'IF v_email NOT IN (');
    execute v_novo;

    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_depois then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto %',
        r.assinatura, v_atual, r.md5_depois;
    end if;

    raise notice 'revertida (FURO REABERTO): %', r.assinatura;
  end loop;
end $$;

commit;
