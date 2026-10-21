-- M3 · O NIVELAMENTO AUTOMÁTICO PASSA A RESPEITAR A MARCA DE GIRO.
--
-- Artigo 5 da regra permanente de distribuição: um lote recém-distribuído tem
-- fidelização própria e NÃO pode ser desfeito pelo nivelamento. A marca dessa
-- fidelização é `casos.giro_fidelizacao_ate`, criada em 20261016115142.
--
-- O FURO, MEDIDO EM 21/10/2026
--
-- `nivelamento_automatico_gestao` monta a tabela `_eleg` com as guardas de
-- saldo, `nao_acionar`, `caso_encerrado_operacional`, link de pagamento vivo,
-- baixa aguardando e confirmação financeira aberta -- e com a fidelização de 10
-- dias POR ACIONAMENTO (`caso_dentro_prazo_fidelizacao`, pela DUA).
--
-- Mas ela NÃO lê `giro_fidelizacao_ate`. Conferido no corpo de produção
-- (md5(prosrc) f058f92912052301694ae481681e3975): a expressão
-- `giro_fidelizacao_ate` aparece ZERO vezes. São duas fidelizações diferentes --
-- uma por acionamento, outra por lote -- e o nivelamento só respeita a primeira.
--
-- Censo do dia, nas 37 funções que escrevem `casos.operador_email`: apenas
-- QUATRO leem a marca (`assumir_caso_livre`, `giro_2026_10_executar_lote_impl`,
-- `liberar_fidelizacao_caso`, `trg_impor_teto_operador`). Esta é a quinta.
--
-- O TAMANHO REAL DO RISCO, DECLARADO SEM AUMENTAR
--
-- O job 48 chama `nivelamento_automatico_gestao(10, true)`, ou seja `p_origens`
-- fica no DEFAULT `ARRAY['amanda.seibel@aelbra.com.br']`. E `_eleg` só olha
-- casos com `operador_email = any(p_origens)`. Medido em 21/10/2026: a base da
-- gestão tem 26 casos e ZERO deles com marca de giro, enquanto as 3.913 marcas
-- vivas da base estão com 7 operadores -- fora do alcance do job.
--
-- Então, com a chamada de hoje, o job 48 NÃO consegue desfazer o lote do giro.
-- Isto não é a remoção de um bloqueio ativo: é o fechamento de um caminho
-- LATENTE, que se abre em dois casos concretos:
--   1) a função é chamada com `p_origens` mais largo (o parâmetro existe e
--      aceita qualquer lista -- a Carteira Geral e a base da Olga, por exemplo);
--   2) um caso com marca viva volta para a base da gestão por qualquer via
--      (devolução, rejeição de confirmação, troca de dono) e é pego às 09:20.
--
-- A ALTERAÇÃO
--
-- Uma linha de guarda em `_eleg`, ao lado da fidelização por acionamento que já
-- estava lá, por PATCH ANCORADO (`internal.patch_funcao_ancorada`): o patch
-- confere que a âncora existe exatamente 1 vez antes de trocar e é idempotente
-- pelo texto NOVO. Se a função mudar, ele recusa em vez de reescrever errado.
--
-- O QUE NÃO MUDA
--
--  * A elegibilidade: saldo, `nao_acionar`, encerrado/suspenso/jurídico, link
--    vivo, baixa aguardando, confirmação aberta e a janela de `p_dias` seguem
--    idênticas. A guarda nova só SUBTRAI candidato, nunca acrescenta.
--  * O teto configurável e o `calibragem.bypass_teto` do bloco de aplicação.
--  * A fidelização de 10 dias por acionamento (`caso_dentro_prazo_fidelizacao`).
--  * A distribuição: a fila (`tem_acordo desc, valor desc, caso_id`) e o critério
--    de destino (menor carga de acordo, depois de caso) seguem intactos.
--  * Titularidade financeira, honorário, autoria, acordos, histórico e retorno:
--    não são lidos nem escritos por esta mudança. `_eleg` não toca
--    `acordos.operador_responsavel_email` nem `data_ultimo_acionamento`.
--  * O agendamento: job 48 segue `20 9 * * *` e ativo. Esta migration não chama
--    `cron.schedule`, `cron.alter_job` nem `cron.unschedule`.
--
-- ZERO DML: nenhum insert, update ou delete de dado. Nenhuma coluna, tabela,
-- gatilho, grant ou agendamento. UMA função, UMA linha de guarda.
--
-- Reversível: supabase/rollbacks/20261021130000_*.rollback.sql

select internal.patch_funcao_ancorada('public','nivelamento_automatico_gestao',
$ancora$and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)$ancora$,
$novo$and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
     -- Artigo 5: lote recem distribuido tem fidelizacao propria e o nivelamento
     -- NAO desfaz. Sao duas fidelizacoes distintas -- a de cima e por
     -- ACIONAMENTO (DUA), esta e por LOTE (a marca do giro).
     and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)$novo$, 1);

comment on function public.nivelamento_automatico_gestao(integer, boolean, text[]) is
  'Nivela a base da gestao movendo caso vencido alem de p_dias para quem tem '
  'menos carga. Respeita as DUAS fidelizacoes: a de 10 dias por acionamento '
  '(caso_dentro_prazo_fidelizacao, pela DUA) e a do lote recem distribuido '
  '(caso_em_giro_fidelizacao, pela marca giro_fidelizacao_ate) -- artigo 5 da '
  'regra permanente. Nao le nem escreve titularidade financeira, honorario, '
  'autoria, acordo, historico ou retorno.';
