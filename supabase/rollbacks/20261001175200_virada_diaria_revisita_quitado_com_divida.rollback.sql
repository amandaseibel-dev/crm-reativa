-- Rollback de supabase/migrations/20261001175200_virada_diaria_revisita_quitado_com_divida.sql.
--
-- Devolve `recalcular_situacao_virada_diaria` ao corpo que estava em producao
-- em 01/10/2026: md5 6f5e5f35749a6f943f2bba035c78a4a8, 1029 bytes.
--
-- O rollback NAO desfaz os recalculos ja feitos -- e nem deveria. O recalculo
-- grava o saldo que a propria funcao oficial apurou a partir dos titulos; se
-- esse numero estiver certo, ele continua certo depois de voltar a varredura ao
-- estado anterior. O que o rollback faz e parar de visitar os QUITADO de novo.
--
-- Se for preciso desfazer tambem o efeito nos 8 casos, isso e outra decisao e
-- outro arquivo: exige backup linha a linha de `casos` (PITR NAO esta
-- habilitado neste projeto) antes de qualquer reversao de saldo.

create or replace function public.recalcular_situacao_virada_diaria(p_lote text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '240s'
as $function$
declare
  r record;
  n int := 0;
  e int := 0;
  v_lote text := coalesce(p_lote, 'virada_'||to_char(now(),'YYYYMMDD'));
begin
  -- REGRA DO SISTEMA: a situacao/criticidade e sempre automatica.
  -- A virada diaria varre TODA a base viva (todo caso nao quitado), garantindo
  -- que o drift temporal (dias_vencido, dias_sem_acionamento, fim_mes) seja
  -- sempre refletido, mesmo sem evento financeiro ou acionamento.
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
      -- um caso com falha nunca interrompe a varredura da base
      e := e + 1;
    end;
  end loop;
  return jsonb_build_object('lote', v_lote, 'alunos_recalculados', n, 'erros', e, 'executado_em', now());
end; $function$;
