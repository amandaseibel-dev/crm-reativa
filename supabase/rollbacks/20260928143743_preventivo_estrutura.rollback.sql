-- REVERSÃO COMPLETA DO PREVENTIVO (as três migrations de 28/09/2026)
--
-- O Preventivo é uma frente NOVA e ISOLADA: nada fora do prefixo `prev_` e do
-- prefixo de função `preventivo_` foi criado ou alterado por ela. Por isso a
-- reversão é um drop limpo — não há estado da cobrança para restaurar, não há
-- coluna alheia para devolver, não há gatilho de terceiro para recriar.
--
-- O QUE SE PERDE: as carteiras preventivas importadas, o histórico de
-- sincronização e as ações registradas. Não há PITR habilitado neste projeto
-- (ver `pitr-nao-habilitado-rollback-nao-e-restore`), então, se houver carteira
-- em uso, EXPORTE ANTES:
--
--   \copy (select * from public.prev_titulo)  to 'prev_titulo.csv'  csv header
--   \copy (select * from public.prev_evento)  to 'prev_evento.csv'  csv header
--   \copy (select * from public.prev_acao_destinatario) to 'prev_acao_dest.csv' csv header
--
-- A ordem abaixo respeita as dependências; `cascade` não é usado para que um
-- objeto inesperado apareça como erro em vez de ser arrastado em silêncio.

drop function if exists public.preventivo_acoes(uuid);
drop function if exists public.preventivo_acao_marcar(uuid, text);
drop function if exists public.preventivo_acao_publico(uuid, boolean);
drop function if exists public.preventivo_acao_preparar(uuid, text, text, jsonb);
drop function if exists public.preventivo_acao_resumo(uuid);
drop function if exists public.preventivo_titulos(uuid, uuid, text, date, date, text, text, integer);
drop function if exists public.preventivo_resultados(uuid);
drop function if exists public.preventivo_sinc_situacao(uuid);
drop function if exists public.preventivo_sinc_concluir(uuid, text);
drop function if exists public.preventivo_sinc_falhou(uuid, text, text);
drop function if exists public.preventivo_sinc_gravar(uuid, text, jsonb);
drop function if exists public.preventivo_sinc_alvos(uuid, integer);
drop function if exists public.preventivo_sinc_abrir(uuid, text);
drop function if exists public.preventivo_janela_aplicar();
drop function if exists public.preventivo_lotes(uuid);
drop function if exists public.preventivo_lote_confirmar(uuid, text, text, jsonb, text, jsonb);
drop function if exists public.preventivo_lote_previa(uuid, jsonb);
drop function if exists public.preventivo_lote_processar(uuid, jsonb, boolean, uuid);
drop function if exists public.preventivo_carteiras();
drop function if exists public.preventivo_carteira_criar(text, text, date, date);
drop function if exists public.preventivo_email_valido(text);
drop function if exists public.preventivo_normalizar_celular(text);

drop table if exists public.prev_acao_destinatario;
drop table if exists public.prev_acao;
drop table if exists public.prev_evento;
drop table if exists public.prev_titulo_snapshot;
drop table if exists public.prev_sinc_fila;
drop table if exists public.prev_sinc;
drop table if exists public.prev_titulo_lote;
drop table if exists public.prev_lote_recusa;
drop table if exists public.prev_titulo;
drop table if exists public.prev_lote;
drop table if exists public.prev_carteira;

drop function if exists public.preventivo_na_janela(date);
drop function if exists public.preventivo_dias_atraso(date);
drop function if exists public.preventivo_limite_dias();
drop function if exists public.preventivo_hoje();
drop function if exists public.preventivo_e_gestao();
