-- ROLLBACK de 20261022131017_importar_recusa_email_nulo
-- =============================================================================
-- Desfaz a correção: devolve às duas sobrecargas de
-- `projecao_importar_pagamentos` a guarda SEM o teste de nulo.
--
-- LEIA ANTES DE RODAR. Isto REABRE o furo: com a guarda antiga, qualquer
-- chamador cujo token não traga claim de e-mail (chave de serviço inclusive)
-- importa sem passar pela allowlist, gravando `auditoria.usuario` nulo.
-- Só faz sentido se a correção tiver causado problema PIOR do que o furo --
-- e o único efeito esperado dela é recusar quem antes passava sem e-mail.
-- Se a dúvida for sobre quem passou a ser recusado, o caminho é olhar a
-- mensagem de recusa ("Sem permissão para importar a planilha de pagamentos"),
-- não reabrir a porta.
--
-- Mesma técnica e mesmas travas da ida, espelhadas: md5 de origem, âncora única
-- e md5 de destino previsto. Nada de corpo retypado. Idempotente.
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
      -- assinatura, md5 corrigido (origem), md5 original (destino), âncora, troca
      ('public.projecao_importar_pagamentos(text,text,jsonb,text,boolean,uuid,text)',
       '1e376707892d12ed66f77479371ece45',
       'a0880e5367d19e0a02ef9f71c9447860',
       'IF v_email IS NULL OR v_email NOT IN (',
       'IF v_email NOT IN ('),
      ('public.projecao_importar_pagamentos(text,text,jsonb,boolean)',
       '8ba7459a400ee4c489ed4147f3c76e95',
       'ea90af29c17787046fcbb61382028f3b',
       'IF auth.email() IS NULL OR lower(auth.email()) NOT IN (',
       'IF lower(auth.email()) NOT IN (')
    ) as t(assinatura, md5_antes, md5_depois, ancora, troca)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p
     where p.oid = r.assinatura::regprocedure;

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

    if (length(v_def) - length(replace(v_def, r.ancora, ''))) / length(r.ancora) <> 1 then
      raise exception 'ANCORA NAO UNICA em % (ancora: %)', r.assinatura, r.ancora;
    end if;

    v_novo := replace(v_def, r.ancora, r.troca);
    execute v_novo;

    select md5(p.prosrc) into v_atual
      from pg_proc p
     where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_depois then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto %',
        r.assinatura, v_atual, r.md5_depois;
    end if;

    raise notice 'revertida (FURO REABERTO): %', r.assinatura;
  end loop;
end $$;

commit;
