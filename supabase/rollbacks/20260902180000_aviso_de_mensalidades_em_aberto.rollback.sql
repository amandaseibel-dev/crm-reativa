-- Desfaz 20260902180000_aviso_de_mensalidades_em_aberto.sql
--
-- Remove a arte "Aviso de mensalidades em aberto" da lista do operador.
-- Nao devolve sozinha a arte de rematricula: para isso, rodar tambem
-- supabase/rollbacks/20260902170000_arte_de_rematricula_sai_da_ficha.rollback.sql
-- e reverter o `sugerir()` em src/components/EmailAlunoUnificado.jsx.

do $$
begin
  if to_regclass('public.email_templates') is not null then
    delete from public.email_templates where chave = 'aviso_mensalidades_aberto';
  end if;
end $$;
