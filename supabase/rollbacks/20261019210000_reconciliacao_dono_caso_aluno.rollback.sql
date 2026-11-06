-- ROLLBACK de 20261019210000_reconciliacao_dono_caso_aluno.
--
-- PITR NAO esta habilitado neste projeto, entao rollback e SQL de reversao, nao
-- restore. Aqui e trivial: a migration so CRIA objetos novos e nao modifica
-- nenhum corpo preexistente -- nao ha definicao anterior a restaurar.
--
-- Nenhum dado foi escrito pela migration (objetos 1-3 sao nao volateis e o
-- gatilho nasce desabilitado), entao este rollback nao precisa de backup de
-- linhas e nao apaga nada de ninguem.
--
-- Depois de rodar, conferir que nada sobrou:
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('cpf_digito_valido','reconciliacao_dono_caso_aluno',
--                        'fichas_duplicadas_revisao','_caso_herda_do_aluno');
--   -- esperado: 0
--   select count(*) from pg_trigger where tgname = 'trg_caso_herda_do_aluno';
--   -- esperado: 0
begin;

drop trigger if exists trg_caso_herda_do_aluno on public.casos;
drop function if exists public._caso_herda_do_aluno();
drop function if exists public.fichas_duplicadas_revisao(integer);
drop function if exists public.reconciliacao_dono_caso_aluno(jsonb);
drop function if exists public.cpf_digito_valido(text);

commit;
