-- Rollback da 20261109130000_portal_votacao_logotipo.
-- Só usar se a votação ainda NÃO tiver votos que precisem ser preservados.
-- Ordem: funções antes das tabelas (dependência de portal_votos -> portal_votacoes).
drop function if exists public.portal_logotipo_encerrar();
drop function if exists public.portal_logotipo_apuracao();
drop function if exists public.portal_logotipo_votar(smallint);
drop function if exists public.portal_logotipo_situacao();
drop table if exists public.portal_votos;
drop table if exists public.portal_votacoes;
