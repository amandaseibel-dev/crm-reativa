-- A dedução por data está aposentada. Definitivamente.
--
-- Amanda, 26/08/2026: "mensalidades em aberto, sem vincular devem continuar com
-- mensalidades em aberto, so sai se for vinculada, nao crie regras que nao
-- existem" e "quero alteracao agora corrigir e nao voltar mais nesse assunto".
--
-- `titulo_superado_por_acordo` escondia a mensalidade sempre que existisse
-- QUALQUER acordo do aluno criado depois do vencimento dela. Nunca foi regra do
-- negócio -- foi deduzida do calendário. A regra real, dita pela gestão, é uma
-- só: a mensalidade sai da conta quando alguém A VINCULA ao acordo.
--
-- Em vez de editar cada chamador (e correr o risco de esquecer um, ou de alguém
-- reintroduzir a dedução amanhã), a função passa a responder SEMPRE false.
-- Assim todo caminho -- saldo, recálculo de situação, penetração, e qualquer
-- outro que apareça -- para de esconder de uma vez. Ela continua existindo só
-- para não quebrar quem a referencia.
--
-- Chamadores conhecidos na data desta migration:
--   aluno_saldo_pendente_detalhe  (corrigido na migration 20260826290000)
--   recalcular_situacao_aluno
--   _penetracao_ano_montar
--
-- IMPACTO: 4.368 títulos, 1.432 alunos, R$ 6.229.309,16 voltam a contar como
-- dívida em aberto -- que é o que sempre foram.
--
-- O CASO QUE PROVOU: Elionaldo Pereira de Amorim Junior. Quatro mensalidades de
-- set a dez/2025, R$ 3.312,75, todas ABERTO e SEM VÍNCULO, nenhuma parcela de
-- acordo em aberto -- e o CRM mostrava saldo R$ 0,00.
--
-- O QUE ME FEZ ERRAR ANTES, registrado para não se repetir: li `liquidado_em`
-- da Prime como "foi pago" e concluí que 99,5% dessas mensalidades estavam
-- quitadas. Liquidado no portador 195 (REATIVA RECUPERAÇÃO) significa que o
-- título SAIU daquela carteira -- e o caminho normal de saída é virar acordo,
-- não ser pago. 974 deles foram liquidados ANTES do próprio vencimento, o que
-- ninguém faz pagando.

create or replace function public.titulo_superado_por_acordo(p_aluno_id uuid, p_vencimento date)
returns boolean
language sql
immutable
security definer
set search_path to 'public'
as $function$
  -- Aposentada em 26/08/2026. A mensalidade so sai da conta quando VINCULADA
  -- a um acordo (acordo_titulo_vinculo). Nao existe deducao por data.
  select false;
$function$;

comment on function public.titulo_superado_por_acordo(uuid, date) is
  'APOSENTADA em 26/08/2026 -- responde sempre false. Escondia mensalidade por deducao de calendario (existia acordo criado depois do vencimento), regra que nunca existiu no negocio. A regra real: mensalidade sai da conta so quando vinculada ao acordo. Mantida apenas para nao quebrar chamadores.';
