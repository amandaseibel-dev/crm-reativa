-- REGRA DO SISTEMA: a situacao/criticidade da carteira e SEMPRE automatica.
--
-- Cobertura em duas camadas:
--   1) Eventos  -> gatilhos _trg_recalc_* (acordos, parcelas, baixas, confirmacao,
--      termos, vinculos) + fn_atualizar_ultimo_acionamento (acionamento).
--   2) Tempo    -> esta virada diaria (cron jobid 3), para o drift que ocorre SEM
--      evento: dias_vencido, dias_sem_acionamento e fim_mes.
--
-- Causa raiz corrigida: a virada anterior so varria um subconjunto (parcelas
-- vencendo hoje/ontem, casos com data_retorno<=hoje, retornos de acordo na janela).
-- Com isso, casos que envelheciam sem evento (ex.: cruzar 10 dias sem acionamento
-- ou 5 dias de atraso) NAO tinham a criticidade reavaliada. Medicao em prod:
-- 16.749 casos vivos, cron varria 2.217, 1.868 casos de criticidade alta estagnados.
--
-- Correcao: a virada diaria passa a varrer TODA a base viva (todo caso nao quitado),
-- com isolamento de erro por linha (um caso com falha nunca interrompe a varredura).
-- Custo medido: ~12,8 ms/caso => base inteira (~16,7k) em ~3,5 min. O cron foi
-- reagendado para 06:00 UTC (03:00 BRT), fora do horario de trabalho:
--   select cron.alter_job(3, schedule => '0 6 * * *');

CREATE OR REPLACE FUNCTION public.recalcular_situacao_virada_diaria(p_lote text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  n int := 0;
  e int := 0;
  v_lote text := coalesce(p_lote, 'virada_'||to_char(now(),'YYYYMMDD'));
begin
  for r in
    select c.aluno_id
    from public.casos c
    where c.aluno_id is not null
      and coalesce(upper(c.situacao_operacional),'') not in ('QUITADO','SALDO_ZERO_CONFIRMADO')
    order by c.criticidade nulls last, c.caso_atualizado_em asc nulls first
  loop
    begin
      perform public.recalcular_situacao_aluno(r.aluno_id, v_lote);
      n := n + 1;
    exception when others then
      e := e + 1;
    end;
  end loop;
  return jsonb_build_object('lote', v_lote, 'alunos_recalculados', n, 'erros', e, 'executado_em', now());
end; $function$;
