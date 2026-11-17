-- Fotografia do estado de termo físico, em uma linha (md5). Tirada ANTES da migração e DEPOIS
-- do rollback: se o rollback é reversível de verdade, as duas são iguais.
-- Não inclui contagem de histórico: testes de outras barreiras gravam linhas de histórico por conta própria.
\set ON_ERROR_STOP on
select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'contencao:' || coalesce(to_regclass('public.termo_fisico_contencao')::text, '-') as x
  union all select 'fn_registrar:' || coalesce(to_regprocedure('public.registrar_administrativo_termo_fisico(text,text)')::text, '-')
  union all select 'fn_aluno:' || coalesce(to_regprocedure('public.aluno_movimentacao_tabulacao_so_gestao()')::text, '-')
  union all select 'trg:' || tgname || '@' || tgrelid::regclass::text
    from pg_trigger
   where not tgisinternal and tgname in ('aluno_mov_tabulacao_so_gestao', 'trg_encerramento_so_gestao')
  union all select 'tab:' || c || ':' || (select count(*) from public.tabulacoes t where t.codigo = c)::text
    from unnest(array['TERMO_FISICO_EM_ANDAMENTO', 'TERMO_FISICO_ARQUIVADO']) as c
  union all select 'tabulacoes_total:' || count(*)::text from public.tabulacoes
  union all select 'enc_prosrc:' || md5(p.prosrc) from pg_proc p
   where p.proname = '_encerramento_so_gestao' and p.pronamespace = 'public'::regnamespace
  union all select 'rls:' || c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text from pg_class c where c.oid in ('public.alunos'::regclass, 'public.tabulacoes'::regclass, 'public.aluno_movimentacoes'::regclass)
  union all select 'relacl:' || c.relname || ':' || coalesce(c.relacl::text, '') from pg_class c where c.oid in ('public.alunos'::regclass, 'public.tabulacoes'::regclass, 'public.aluno_movimentacoes'::regclass)
  union all select 'enc_acl:' || coalesce(p.proacl::text, '') from pg_proc p
   where p.proname = '_encerramento_so_gestao' and p.pronamespace = 'public'::regnamespace
) s;
