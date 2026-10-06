-- Desfaz 20261006150000_arte_novas_condicoes_de_negociacao.sql
--
-- Tira a arte "Novas condicoes de negociacao" da lista do operador. Rodar
-- quando a campanha da semana encerrar -- o texto promete prazo que vence.
--
-- Nao devolve o `novo` das artes antigas: aquele sinalizador so serve para o
-- pop-up de estreia, e elas ja estrearam.
--
-- Para apenas pausar sem perder o texto, use `ativo = false` no lugar do
-- delete.

do $$
begin
  if to_regclass('public.email_templates') is not null then
    delete from public.email_templates where chave = 'novas_condicoes_negociacao';
  end if;
end $$;
