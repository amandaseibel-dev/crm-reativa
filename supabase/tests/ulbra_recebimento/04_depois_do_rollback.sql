-- Roda DEPOIS do rollback candidato (o CI aplica o .rollback.sql antes deste).
-- Afirma que o banco volta ao ponto anterior: nenhuma tabela nem funcao da
-- etapa 1 sobra, e as tabelas que ja existiam seguem intactas.
\set ON_ERROR_STOP on

do $$ declare n int; begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('ulbra_conversas', 'ulbra_atendimentos', 'ulbra_sync_estado', 'ulbra_leitura_usuario');
  perform public.afirmar(n = 0, 'rollback remove as 4 tabelas da etapa 1');
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('ulbra_sync_gravar', 'ulbra_atendimento_assumir',
                       'ulbra_atendimento_dispensar', 'ulbra_conversa_marcar_lida');
  perform public.afirmar(n = 0, 'rollback remove as 4 funcoes da etapa 1');
  select count(*) into n from public.alunos;
  perform public.afirmar(n = 3, 'alunos (que ja existiam) seguem com os 3 registros');
  select count(*) into n from public.casos;
  perform public.afirmar(n = 2, 'casos (que ja existiam) seguem intactos');
end $$;

select 'ROLLBACK: banco voltou ao ponto anterior' as resultado;
