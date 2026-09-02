-- Desfaz 20260902170000_arte_de_rematricula_sai_da_ficha.sql
--
-- Devolve "Pedido de contato (rematricula)" a lista de artes do operador na
-- ficha do aluno. O texto da arte nunca foi alterado, entao volta como estava.

do $$
begin
  if to_regclass('public.email_templates') is not null then
    update public.email_templates
       set ativo = true
     where chave = 'primeira_abordagem';
  end if;
end $$;
