-- Desfaz 20261110200000_tv_painel_operadores: remove a função de leitura.
-- Nada mais foi criado ou alterado por ela (sem tabela, sem dado, sem grant
-- em outro objeto). A Edge Function tv-dados v3 tolera a ausência da função
-- (os rankings voltam a mostrar "dado indisponível").
drop function if exists public.tv_painel_operadores();
