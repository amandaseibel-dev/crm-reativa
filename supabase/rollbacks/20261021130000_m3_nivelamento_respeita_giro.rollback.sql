-- ROLLBACK de 20261021130000_m3_nivelamento_respeita_giro.sql
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   O NIVELAMENTO AUTOMÁTICO VOLTA A PODER MOVER CASO COM MARCA DE GIRO VIVA,
--   DESFAZENDO A FIDELIZAÇÃO DO LOTE RECÉM-DISTRIBUÍDO -- O QUE O ARTIGO 5 DA
--   REGRA PERMANENTE DE DISTRIBUIÇÃO PROÍBE.
--
-- Por isso este rollback só deve ser usado com decisão expressa da gestão e
-- motivo declarado.
--
-- Âncora: o corpo em produção ANTES de aplicar a migration tinha
-- md5(prosrc) = f058f92912052301694ae481681e3975, com 6.599 bytes, e a expressão
-- `giro_fidelizacao_ate` aparecia ZERO vezes nele.
--
-- POR QUE A REVERSÃO NEUTRALIZA A GUARDA EM VEZ DE APAGAR A LINHA
--
-- `internal.patch_funcao_ancorada` RECUSA, por desenho, um patch cujo texto novo
-- seja pedaço da âncora -- porque aí não há como distinguir "já aplicado" de
-- "nunca aplicado". Apagar texto é exatamente esse caso. Então a reversão troca
-- a guarda por um `and true`, que não filtra nada: o comportamento volta a ser
-- o de antes, e fica escrito no corpo da função que a M3 foi revertida e por
-- quem. Nada de reescrever a função inteira -- se o corpo tiver mudado por
-- outra frente, o patch recusa em vez de sobrescrever trabalho alheio.
--
-- Para voltar a aplicar a M3 depois de uma reversão, rode a migration de novo:
-- ela é idempotente pelo texto novo.
--
-- ZERO DML: nenhuma linha de dado a reverter. Nenhum agendamento a refazer --
-- o job 48 nunca foi tocado, segue `20 9 * * *` e ativo.

select internal.patch_funcao_ancorada('public','nivelamento_automatico_gestao',
$ancora$     -- Artigo 5: lote recem distribuido tem fidelizacao propria e o nivelamento
     -- NAO desfaz. Sao duas fidelizacoes distintas -- a de cima e por
     -- ACIONAMENTO (DUA), esta e por LOTE (a marca do giro).
     and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)$ancora$,
$novo$     -- M3 REVERTIDA por decisao expressa da gestao: o nivelamento voltou a
     -- NAO respeitar a marca do lote recem distribuido. O artigo 5 fica
     -- desprotegido nesta funcao ate que a M3 seja reaplicada.
     and true$novo$, 1);

-- Devolve tambem o comentario ao estado anterior: a funcao NAO tinha comentario
-- antes desta migration.
comment on function public.nivelamento_automatico_gestao(integer, boolean, text[]) is null;
