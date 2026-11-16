-- ROLLBACK de 20261114120000_agenda_reagendar_retorno_e_portao_recalculo
-- Remove a RPC, recria o gatilho de zeragem por data e reverte o FOR UPDATE do
-- recalculo (c3e38ac0 -> 03dacc0a). NAO concede nem devolve EXECUTE a anon:
-- na ACL de origem anon ja nao tinha EXECUTE.
-- O BACKUP retorno_backup_20261114 NAO e apagado: e a evidencia. Restaurar dados
-- e etapa separada, com aprovacao: ver 20261114120000_restauracao_por_id.sql.pendente.
begin;

drop function if exists public.agenda_reagendar_retorno(uuid, date, text, boolean);

drop trigger if exists trg_aluno_reset_retorno_confirmado on public.alunos;
create trigger trg_aluno_reset_retorno_confirmado
  before update of data_retorno on public.alunos
  for each row
  when (new.data_retorno is distinct from old.data_retorno)
  execute function public.tg_aluno_reset_retorno_confirmado();

-- Reverte a leitura travada (c3e38ac0 -> 03dacc0a): mesma ancora/troca ao contrario.
do $lockr$
declare
  v_assin constant text := 'public.recalcular_situacao_aluno(uuid,text)';
  v_ancora constant text := $a$from public.alunos where id=p_aluno_id for update;$a$;
  v_troca constant text := $n$from public.alunos where id=p_aluno_id;$n$;
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
    raise notice 'rollback leitura travada: ja sem o lock, nada a reverter.';
    return;
  end if;
  if v_md5_antes <> 'c3e38ac06719b886297369e1f0e507aa' then
    raise exception 'CORPO INESPERADO no rollback: md5 %, esperado c3e38ac0.', v_md5_antes;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then raise exception 'ANCORA NAO BATE no rollback: %', v_n; end if;
  v_nova := replace(v_def, v_ancora, v_troca);
  execute v_nova;
  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_depois, v_guarda_depois from pg_proc p where p.oid = v_oid;
  if v_guarda_depois is distinct from v_guarda_antes then raise exception 'DONO/DEFINER/CONFIG/ACL mudaram no rollback'; end if;
  if v_md5_depois <> '03dacc0abb23490a8e060c4f86e0df94' then
    raise exception 'RESULTADO INESPERADO no rollback: md5 %, previsto 03dacc0a', v_md5_depois;
  end if;
end $lockr$;

-- Nota: na ACL de origem (fixture 20261113) anon NAO tinha EXECUTE em
-- recalcular_situacao_aluno. O revoke da parte D e no-op e o rollback nao concede nada.

commit;
