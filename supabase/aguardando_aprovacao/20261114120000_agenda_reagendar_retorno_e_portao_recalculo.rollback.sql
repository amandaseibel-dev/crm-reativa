-- ROLLBACK de 20261114120000_agenda_reagendar_retorno_e_portao_recalculo
-- Reverte o portao (42e9ddf7d9393d12e6d4078c14a6a2f1 -> 03dacc0abb23490a8e060c4f86e0df94) e remove a RPC.
-- O BACKUP retorno_backup_20261114 NAO e apagado: e a evidencia. Restaurar
-- DADOS a partir dele e uma etapa separada, com aprovacao, filtrada por id.
begin;

drop function if exists public.agenda_reagendar_retorno(uuid, date, text, boolean);

do $rollback$
declare
  v_assin constant text := 'public.recalcular_situacao_aluno(uuid,text)';
  v_ancora constant text := $a$  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;
  -- PORTAO (14/11/2026): com sessao de usuario so recalcula o aluno dele, ou se for gestao.
  -- Sem sessao (cron da virada, triggers de backend, service_role) passa como antes.
  if auth.uid() is not null
     and lower(coalesce(auth.email(), '')) <> all (array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'])
     and lower(coalesce(auth.email(), '')) is distinct from (select lower(responsavel_atual_email) from public.alunos where id = p_aluno_id) then
    raise exception 'Sem permissao para recalcular a situacao deste aluno';
  end if;$a$;
  v_troca constant text := $n$  if p_aluno_id is null then return jsonb_build_object('erro','sem_aluno'); end if;$n$;
  v_oid oid := to_regprocedure(v_assin);
  v_def text; v_nova text; v_md5_antes text; v_md5_depois text;
  v_guarda_antes text; v_guarda_depois text; v_n int;
begin
  if v_oid is null then raise exception 'FUNCAO AUSENTE: %', v_assin; end if;
  v_def := pg_get_functiondef(v_oid);
  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_antes, v_guarda_antes from pg_proc p where p.oid = v_oid;

  if v_md5_antes = '03dacc0abb23490a8e060c4f86e0df94' then
    raise notice 'rollback do portao: ja sem o portao, nada a reverter.';
    return;
  end if;
  if v_md5_antes <> '42e9ddf7d9393d12e6d4078c14a6a2f1' then
    raise exception 'CORPO INESPERADO no rollback em %: md5(prosrc) e %, esperado 42e9ddf7d9393d12e6d4078c14a6a2f1.', v_assin, v_md5_antes;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then raise exception 'ANCORA NAO BATE no rollback: % ocorrencia(s), esperado 1.', v_n; end if;

  v_nova := replace(v_def, v_ancora, v_troca);
  execute v_nova;

  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_depois, v_guarda_depois from pg_proc p where p.oid = v_oid;
  if v_guarda_depois is distinct from v_guarda_antes then
    raise exception 'DONO/DEFINER/CONFIG/GRANTS mudaram no rollback';
  end if;
  if v_md5_depois <> '03dacc0abb23490a8e060c4f86e0df94' then
    raise exception 'RESULTADO INESPERADO no rollback: md5 %, previsto 03dacc0abb23490a8e060c4f86e0df94', v_md5_depois;
  end if;
end $rollback$;

commit;
