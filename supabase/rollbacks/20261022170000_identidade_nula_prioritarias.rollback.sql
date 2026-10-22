-- ROLLBACK de 20261022170000_identidade_nula_prioritarias
-- =============================================================================
-- Desfaz a correção: devolve às funções a guarda SEM o teste de nulo.
--
-- LEIA ANTES DE RODAR. Isto REABRE o furo: com a guarda antiga, qualquer
-- chamador cujo token não traga claim de e-mail -- chave de serviço inclusive --
-- passa pela allowlist.
-- E aqui o furo e o PIOR dos sete: projecao_excluir_importacao volta a poder
-- apagar pagamentos (DELETE FROM public.pagamentos) sem identidade humana, e
-- projecao_alterar_operador volta a poder mover atribuicao financeira.
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
      ('public.projecao_excluir_importacao(uuid,text)',
       '8af3ebfb4728dc7cb0c6872845247941',
       '7306b6dbe648e80a3e2dca17a531236d'),
      ('public.projecao_alterar_operador(uuid,text,text,text)',
       'ded13d5b3cfec35ca0e86d26c7854c49',
       '373ac04072677eca1e39520872f86fe2')
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
