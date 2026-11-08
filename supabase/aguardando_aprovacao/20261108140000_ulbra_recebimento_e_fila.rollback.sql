-- ============================================================================
-- ROLLBACK de 20261108140000_ulbra_recebimento_e_fila
--
-- Par do artefato de 08/11/2026. Como o SQL original NAO FOI APLICADO, este
-- arquivo tambem nunca rodou.
--
-- SEGURO PORQUE SO DESFAZ O QUE NASCEU ALI. As tres tabelas sao novas e nao
-- existia nada antes delas: nao ha dado anterior para preservar e nenhum
-- objeto existente e tocado. As funcoes sao novas e nenhuma substituiu outra
-- de mesmo nome (conferido em producao em 08/11/2026: nao existe `ulbra_sync_*`
-- nem `ulbra_atendimento_*` no schema public).
--
-- O QUE SE PERDE AO RODAR -- e NAO e so o espelho:
--
--   a) RECONSTRUIVEL lendo a Mensageria de novo: o espelho das conversas e dos
--      atendimentos (`ulbra_conversas`, `ulbra_atendimentos`) e o cursor do
--      incremental (`ulbra_sync_estado`). A fonte e a Mensageria.
--
--   b) NAO RECONSTRUIVEL -- nasce aqui e nao existe em lugar nenhum fora:
--      - `ulbra_leitura_usuario`: os MARCADORES DE LEITURA por usuario (quem
--        leu o que, e ate quando). Sumindo, toda conversa volta a aparecer como
--        nao lida para todo mundo.
--      - `ulbra_detalhe_pendencias`: as PENDENCIAS LOCAIS de alcance
--        (`ALCANCE_ESGOTADO`) com o ponto de retomada `antes_de`. Sumindo,
--        perde-se onde cada leitura de historico parou -- e a retomada volta
--        ao inicio.
--      - `ulbra_detalhe_fila`: a fila de detalhes com as tentativas ja gastas.
--      - em `ulbra_atendimentos`, o trabalho registrado so aqui: quem assumiu,
--        quem dispensou e com que motivo.
--
-- Antes de rodar, copiar o que e do grupo (b):
--
--   create table ulbra_atendimentos_backup_<data> as
--     select * from public.ulbra_atendimentos
--      where responsavel_email is not null or dispensado_em is not null;
--   create table ulbra_leitura_usuario_backup_<data>   as select * from public.ulbra_leitura_usuario;
--   create table ulbra_detalhe_pendencias_backup_<data> as select * from public.ulbra_detalhe_pendencias;
--
-- Tabela de backup nasce aberta para `authenticated`, TRUNCATE incluso
-- (memoria `tabela-nova-herda-truncate-para-authenticated`): ligar RLS e
-- revogar, ou cria-la em schema fora do `public`.
--
-- ORDEM: funcoes antes das tabelas, porque sao elas que referenciam.
-- Se o cron do passo 3 ja existir, ele TEM de sair primeiro -- senao continua
-- batendo numa funcao cuja porta de escrita nao existe mais, gastando
-- orcamento da Mensageria e enchendo o log de erro:
--
--   select cron.unschedule('ulbra_sincronizar');
-- ============================================================================

begin;

drop function if exists public.ulbra_sincronizar_disparar();
drop function if exists public.ulbra_detalhe_reabrir(text);
drop function if exists public.ulbra_conversa_marcar_lida(text);
drop function if exists public.ulbra_atendimento_dispensar(text, text);
drop function if exists public.ulbra_atendimento_assumir(text);
drop function if exists public.ulbra_sync_gravar(jsonb);

-- leitura por usuario referencia ulbra_conversas: sai ANTES dela
drop table if exists public.ulbra_detalhe_pendencias;
drop table if exists public.ulbra_detalhe_fila;
drop table if exists public.ulbra_leitura_usuario;
drop table if exists public.ulbra_sync_estado;
drop table if exists public.ulbra_atendimentos;
drop table if exists public.ulbra_conversas;

commit;
