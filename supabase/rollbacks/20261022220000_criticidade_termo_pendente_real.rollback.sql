-- ROLLBACK de 20261022220000_criticidade_termo_pendente_real.sql
-- =============================================================================
-- O QUE REVERTER SIGNIFICA, dito antes do SQL: volta o peso +2 de
-- "termo pendente" para 100% dos casos -- porque `casos.status_termo` e
-- constante 'Sem termo' --, e com isso volta a anular o desconto de -2 de
-- acionamento recente. Na pratica: os 1.013 casos acionados nos ultimos 7 dias
-- voltam a ser URGENTE e a operacao volta a ver "surgiu URGENTE do nada" depois
-- de acionar a carteira inteira.
--
-- Reverter NAO desfaz nenhuma reclassificacao ja gravada: `nivel_criticidade` e
-- `criticidade` sao DERIVADOS. Depois de aplicar este rollback, os rotulos so
-- voltam ao estado antigo quando cada caso for recalculado -- por evento, pela
-- virada das 03:00, ou rodando a varredura de proposito:
--   select public.recalcular_situacao_virada_diaria('rollback_termo_pendente');
--
-- MESMAS TRES TRAVAS, na ordem inversa (md5 de depois vira o esperado "antes"):
--   1. md5(prosrc) atual = o md5 DEPOIS da correcao, senao RECUSA;
--   2. ancora (agora o texto NOVO) exatamente uma vez;
--   3. md5(prosrc) ao final = o md5 ORIGINAL de 22/10/2026.
-- IDEMPOTENTE: se ja esta no corpo original, registra e segue.
--
-- ZERO DML aqui tambem.
begin;

do $$
declare
  r record;
  v_def text;
  v_novo text;
  v_atual text;
  v_revertidas int := 0;
  v_ja int := 0;
  -- invertidos de proposito: o que era a troca volta a ser a ancora
  v_ancora constant text := $a$upper(btrim(coalesce(c.status_termo,''))) not in ('', 'SEM TERMO') and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')$a$;
  v_troca  constant text := $n$c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')$n$;
begin
  for r in
    select * from (values
      -- assinatura, md5(prosrc) corrigido, md5(prosrc) original
      ('public.recalcular_situacao_aluno(uuid,text)',
       '41475103b8b7ad363dfdc76c4170c5a8',
       'eb6b5f79a247669d50cf311c7bab47a9'),
      ('public.calibragem_criticidade_auto()',
       '638d1fc4d234699ac395ff24f1f65a86',
       '7850e7543596aff7c00c375d3d0c5a1c')
    ) as t(assinatura, md5_corrigido, md5_original)
  loop
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;

    if v_atual is null then
      raise exception 'FUNCAO AUSENTE: %', r.assinatura;
    end if;

    if v_atual = r.md5_original then
      v_ja := v_ja + 1;
      raise notice 'ja no corpo original, nada a reverter: %', r.assinatura;
      continue;
    end if;

    -- TRAVA 1
    if v_atual <> r.md5_corrigido then
      raise exception
        'CORPO INESPERADO em %: md5(prosrc) e %, esperado % (o corpo corrigido). Alguem mexeu depois da migration -- revisar antes de reverter.',
        r.assinatura, v_atual, r.md5_corrigido;
    end if;

    v_def := pg_get_functiondef(r.assinatura::regprocedure);

    -- TRAVA 2
    if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
      raise exception 'ANCORA NAO UNICA em %: esperado exatamente 1 ocorrencia.', r.assinatura;
    end if;

    v_novo := replace(v_def, v_ancora, v_troca);
    execute v_novo;

    -- TRAVA 3
    select md5(p.prosrc) into v_atual
      from pg_proc p where p.oid = r.assinatura::regprocedure;
    if v_atual <> r.md5_original then
      raise exception
        'RESULTADO INESPERADO em %: md5(prosrc) ficou %, previsto % (o corpo original)',
        r.assinatura, v_atual, r.md5_original;
    end if;

    v_revertidas := v_revertidas + 1;
    raise notice 'revertida: % (md5 % -> %)', r.assinatura, r.md5_corrigido, r.md5_original;
  end loop;

  raise notice 'rollback termo_pendente: % revertida(s), % ja estava(m) no original', v_revertidas, v_ja;
end $$;

commit;
