-- ROLLBACK de 20261113120000_retorno_tratado_nao_herda_selo_do_operador
-- =============================================================================
-- O QUE REVERTER SIGNIFICA, dito antes do SQL: o recalculo volta a copiar a
-- origem OPERADOR para a data que a maquina grava. O retorno JA TRATADO que
-- venceu volta a reaparecer como "combinado de hoje" a cada virada diaria, com
-- a hora antiga, e o "Ja falei" volta a ser apagado no dia seguinte.
--
-- Reverter NAO reescreve nenhuma linha: quem ja virou AUTOMATICO continua
-- AUTOMATICO (a origem antiga nao e guardada em lugar nenhum, e nao deve ser
-- inventada). ZERO DML.
--
-- MESMAS TRAVAS, invertidas: o texto novo vira a ancora.
begin;

do $$
declare
  v_assin constant text := 'public.recalcular_situacao_aluno(uuid,text)';
  -- invertidos de proposito
  v_ancora constant text := $a$elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        v_origem  := case when v_ret_atual is distinct from hoje
                           and exists (select 1 from public.alunos al
                                        where al.id = p_aluno_id
                                          and al.retorno_confirmado_em is not null)
                          then 'AUTOMATICO'
                          else coalesce(nullif(v_orig_atual,''), 'AUTOMATICO') end;
     end if;$a$;
  v_troca constant text := $n$elsif v_ret_atual is not null and v_ret_atual > hoje then
        v_retorno := v_ret_atual;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     else
        v_retorno := hoje;
        v_origem  := coalesce(nullif(v_orig_atual,''), 'AUTOMATICO');
     end if;$n$;
  v_oid oid;
  v_def text;
  v_nova text;
  v_md5_antes text;
  v_md5_depois text;
  v_guarda_antes text;
  v_guarda_depois text;
  v_n int;
begin
  v_oid := to_regprocedure(v_assin);
  if v_oid is null then
    raise exception 'FUNCAO AUSENTE: %', v_assin;
  end if;

  v_def := pg_get_functiondef(v_oid);
  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_antes, v_guarda_antes
    from pg_proc p where p.oid = v_oid;

  if position(v_troca in v_def) > 0 then
    raise notice 'rollback retorno tratado: ja no corpo original (md5 %), nada a reverter.', v_md5_antes;
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception
      'ANCORA NAO BATE em %: % ocorrencia(s), esperado 1 (md5 atual %). Alguem mexeu depois da migration -- revisar antes de reverter.',
      v_assin, v_n, v_md5_antes;
  end if;

  v_nova := replace(v_def, v_ancora, v_troca);
  execute v_nova;

  v_def := pg_get_functiondef(v_oid);
  if (length(v_def) - length(replace(v_def, v_troca, ''))) / length(v_troca) <> 1
     or position(v_ancora in v_def) > 0
     or length(v_def) <> length(v_nova) then
    raise exception 'RESULTADO INESPERADO em %: a reversao nao ficou exatamente uma vez.', v_assin;
  end if;

  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_depois, v_guarda_depois
    from pg_proc p where p.oid = v_oid;
  if v_guarda_depois is distinct from v_guarda_antes then
    raise exception 'DONO/DEFINER/CONFIG/GRANTS mudaram em %: antes [%], depois [%]', v_assin, v_guarda_antes, v_guarda_depois;
  end if;

  raise notice 'rollback retorno tratado: revertida em % (md5 % -> %)', v_assin, v_md5_antes, v_md5_depois;
end $$;

commit;
