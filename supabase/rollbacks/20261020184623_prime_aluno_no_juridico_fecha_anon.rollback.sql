-- ROLLBACK de 20261020184623_prime_aluno_no_juridico_fecha_anon.sql
--
-- SO PRIVILEGIO. Nenhuma funcao substituida, nenhuma tabela, nenhum gatilho,
-- nenhum dado -- nao ha dado a restaurar. Devolve exatamente os grants que
-- producao tinha em 20/10/2026 antes da correcao:
--
--   PUBLIC=EXECUTE, authenticated=EXECUTE, postgres=EXECUTE, service_role=EXECUTE
--
-- ATENCAO -- ESTE ROLLBACK REABRE DADO PESSOAL SENSIVEL SEM LOGIN.
--
-- Com ele, `/rest/v1/rpc/prime_aluno_no_juridico` volta a responder por CPF, no
-- papel `anon`, se um aluno esta na cobranca judicial -- 72 CPFs no portador 202
-- na medicao de 20/10, com o parametro enumeravel. **So reverter com decisao
-- expressa da gestao e por motivo declarado**, porque nenhum caminho de usuario
-- depende desse acesso: nao ha chamador em src/, em supabase/functions/, em
-- migration, em funcao do banco nem em view.
--
-- O corpo da funcao nao foi tocado pela migration nem por este rollback:
-- md5(prosrc) = 7066bc7660854bf34ac45b95b032f65b nos dois lados.

grant execute on function public.prime_aluno_no_juridico(text) to public;

comment on function public.prime_aluno_no_juridico(text) is null;
