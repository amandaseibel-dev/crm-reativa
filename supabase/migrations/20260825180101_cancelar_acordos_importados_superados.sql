-- Cancelar o acordo importado que outro acordo ja substituiu.
--
-- O padrao foi identificado a partir de um caso real (Diego de Araujo Alves,
-- 25/08): dois acordos importados ATIVOS para o mesmo aluno -- #2551, parcela
-- vencida em 28/07, e #3077, parcela em 14/08. Sao acordos DIFERENTES, nao
-- registro duplicado: o aluno fechou, nao pagou, o acordo foi cancelado na
-- Prime e ele fechou outro. Nossa base ficou com os dois ATIVO porque
-- A IMPORTACAO SO INSERE, NUNCA CANCELA -- e sem alguem entrar e cancelar na
-- mao, o acordo velho fica ali para sempre inflando a carteira.
--
-- CRITERIO (conservador de proposito, calibrado pelo caso do Diego):
--   * acordo importado ATIVO, e existe outro acordo importado do MESMO aluno,
--     de LOTE diferente, criado DEPOIS;
--   * o antigo nao tem NENHUMA parcela paga -- ninguem esta pagando ele;
--   * a ultima parcela em aberto do antigo JA TINHA VENCIDO quando o novo
--     entrou -- estava morto, nao apenas mais velho;
--   * o antigo NAO TEM VINCULO com titulo.
--
-- A ultima condicao e a mais importante e foi descoberta lendo a trigger
-- `titulos_por_status_acordo`: cancelar um acordo REABRE (NEGOCIADO -> ABERTO)
-- os titulos vinculados a ele. Se o acordo superado tivesse vinculo, cancelar
-- devolveria a mensalidade ao saldo aberto -- e o acordo novo ja cobre a mesma
-- divida, entao a divida seria contada duas vezes. Exatamente o defeito que
-- passamos o dia corrigindo. Por isso esses ficam de fora: eram 1 caso
-- (R$ 344,71), que precisa de tratamento separado.
--
-- Efeitos colaterais conferidos ANTES de aplicar:
--   titulos_por_status_acordo    -- nao dispara: nenhum alvo tem vinculo.
--   atribuir_responsavel_por_acordo -- so notifica quando o operador do acordo
--     MUDA (aqui so muda status), e so define responsavel de aluno que nao tem.
--     Medido: 0 alvos se enquadram. Zero efeito.
--   _guard_resp_acordo -- bloqueia troca de operador_responsavel_email; nao e
--     tocado.
--
-- RESULTADO EM PROD 2026-08-25: 67 acordos cancelados, R$ 89.495,82 fora da
-- carteira. 0 titulos reabertos. 0 superados restantes pelo mesmo criterio.
--
-- REVERSIVEL: cada linha levou a assinatura `cancelamento_superado_20260826`
-- em `motivo_ajuste`. O rollback devolve status ATIVO so a essas.
--
-- NAO RESOLVE A RAIZ. Enquanto a importacao nao cancelar o acordo anterior do
-- aluno, isto volta a cada remessa -- ja foram 11 desde 20/07.
--
-- Rollback: supabase/rollbacks/20260826080000_cancelar_acordos_importados_superados.sql

with imp as (
  select ac.id, ac.aluno_id, ac.criado_em,
         substring(coalesce(ac.observacao,'') from 'lote ([0-9a-f-]+)') lote
  from public.acordos ac
  where ac.status='ATIVO' and ac.criado_por_email='importacao@sistema' and ac.aluno_id is not null
),
par as (
  select acordo_id, count(*) filter (where status='PAGO') pagas,
         max(vencimento) filter (where status in ('VENCIDA','A_VENCER')) venc_max
  from public.parcelas group by 1
),
alvo as (
  select distinct on (x.id) x.id
  from imp x
  join imp y on y.aluno_id = x.aluno_id and y.criado_em > x.criado_em and y.lote is distinct from x.lote
  join par px on px.acordo_id = x.id
  where px.pagas = 0
    and px.venc_max < y.criado_em
    and not exists (select 1 from public.acordo_titulo_vinculo v
                     where v.acordo_id = x.id and coalesce(v.ativo, true))
  order by x.id, y.criado_em desc
)
update public.acordos ac
   set status = 'CANCELADO',
       atualizado_em = now(),
       motivo_ajuste = coalesce(nullif(ac.motivo_ajuste,''),'') ||
                       case when coalesce(ac.motivo_ajuste,'') = '' then '' else ' | ' end ||
                       'cancelado por acordo mais recente do mesmo aluno (cancelamento_superado_20260826)'
  from alvo
 where ac.id = alvo.id;
