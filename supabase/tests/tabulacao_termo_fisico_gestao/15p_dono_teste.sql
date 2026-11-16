-- PREPARAÇÃO (postgres) — SOMENTE banco descartável. Dono de teste com atributos de produção medidos:
-- rolsuper=false e rolbypassrls=true (produção: dono postgres, rolsuper=false, rolbypassrls=true).
\set ON_ERROR_STOP on
do $$ begin
  if not exists (select 1 from pg_roles where rolname='dono_teste') then
    create role dono_teste nologin nosuperuser bypassrls; end if;
end $$;
grant usage on schema public to dono_teste;
grant select on public.usuarios, public.alunos, public.tabulacoes, public.aluno_movimentacoes to dono_teste;
-- Fixture de teste: em producao o dono e postgres, dono da tabela; aqui o dono_teste precisa do INSERT (prova em bancada: sem ele a RPC falha com 42501).
grant insert on public.aluno_movimentacoes to dono_teste;
grant usage on sequence public.aluno_movimentacoes_id_seq to dono_teste;
-- Fixture de teste: auth.jwt()/auth.role() (stubs do 01) e o schema auth. Em producao o dono e postgres, que ja tem acesso.
grant usage on schema auth to dono_teste;
grant execute on function auth.jwt(), auth.role() to dono_teste;
alter table public.termo_fisico_contencao owner to dono_teste;
alter function public.usuario_e_gestao() owner to dono_teste;
alter function public.app_usuario_ativo() owner to dono_teste;
alter function public.aluno_movimentacao_tabulacao_so_gestao() owner to dono_teste;
alter function public.registrar_administrativo_termo_fisico(text, text) owner to dono_teste;
select 'PREP dono_teste (rolsuper=false, rolbypassrls=true)' as passo;
