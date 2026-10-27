-- =============================================================================
-- ROLLBACK de 20261027160000_revoke_execute_public_encerramento
--
-- DEVOLVE O ESTADO VULNERAVEL. Só se justifica se a revogação quebrar algum
-- chamador não previsto. Em 27/10/2026 nenhum foi encontrado: os quatro
-- chamadores sem `security definer` usam a assinatura de 5 argumentos e têm
-- grant EXPLICITO para `authenticated`; os outros ~41 são `security definer` do
-- owner e não dependem de PUBLIC; no app não há chamada nenhuma.
--
-- NAO E RESTORE: o PITR não está habilitado neste projeto. É SQL por
-- identidade, aplicado para frente.
-- =============================================================================
--
-- SO A PUBLIC, E NADA A `anon`.
--
-- Medido em produção em 27/10/2026, antes da revogação: a ACL das funções NAO
-- tinha concessão direta a `anon` -- só PUBLIC, postgres, authenticated e
-- service_role. Conceder a `anon` aqui criaria privilégio que nunca existiu, o
-- que seria AMPLIAR acesso em vez de restaurar.
--
-- DEPENDENCIA: o papel `public` sempre existe; `anon` não é citado, então este
-- arquivo roda num Postgres sem os papéis da Supabase.
-- -----------------------------------------------------------------------------

grant execute on function public._caso_sem_saldo_conferido(uuid, text)
  to public;
grant execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  to public;
grant execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  to public;
grant execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  to public;
grant execute on function public.caso_encerramento_congelado(uuid)
  to public;

-- A SEXTA: em produção ela JA ESTAVA sem PUBLIC antes de tudo (medido,
-- `has_function_privilege('public', ..., 'EXECUTE')` = false em 27/10/2026).
-- Conceder aqui NAO restauraria o estado anterior -- abriria um caminho que
-- estava fechado. Por isso vai COMENTADA, e só deve ser descomentada em
-- ambiente onde se tenha MEDIDO que ela tinha PUBLIC antes.
--
-- grant execute on function public.caso_encerrado_operacional(text, text, text, text, text)
--   to public;

-- -----------------------------------------------------------------------------
-- CONFERENCIA DEPOIS DO ROLLBACK
--
-- Pelo PRIVILEGIO EFETIVO, nunca por texto de `proacl`: a ordem do array e o
-- concedente não são estáveis, e `proacl` NULO significa privilégio PADRAO, que
-- para função INCLUI EXECUTE a PUBLIC -- `aclexplode` de um `proacl` nulo
-- devolve zero linhas e diria "sem PUBLIC" num caso em que PUBLIC executa.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_faltou text;
begin
  select string_agg(a.sig, ', ' order by a.sig) into v_faltou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null
      or not has_function_privilege('public', to_regprocedure(a.sig), 'EXECUTE');

  if v_faltou is not null then
    raise exception
      'ROLLBACK_INCOMPLETO: PUBLIC segue sem EXECUTE em %. Verifique se o executor e o dono ou tem grant option -- um grant feito por papel sem direito emite WARNING e nao concede nada.',
      v_faltou;
  end if;
end
$confere$;
