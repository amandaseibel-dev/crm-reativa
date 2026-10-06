-- A VIRADA DIARIA VOLTA A ENXERGAR QUEM VOLTOU A DEVER.
--
-- `casos.saldo_total` NAO e calculado em lugar nenhum na leitura: a
-- `vw_saude_carteira` apenas le `COALESCE(c.saldo_total, 0)`. Quem reescreve
-- esse campo e a virada diaria das 06:00 (cron job 3), que chama
-- `recalcular_situacao_aluno` aluno a aluno. E a varredura tem uma porta de
-- mao unica: uma vez QUITADO, o caso nunca mais e revisitado. Se o titulo
-- reabrir depois -- acordo cancelado, ou mensalidade nova importada -- nada
-- recalcula o saldo. Ele fica em 0,00 para sempre.
--
-- MEDIDO EM PRODUCAO EM 01/10/2026: 4.812 casos QUITADO sao pulados hoje;
-- destes, apenas 13 (0,27%) tem divida cobravel. A exclusao esta certa em
-- 99,73% -- falta a excecao, nao trocar a regra. Dos 13, so 8 podem voltar
-- sozinhos (R$ 10.110,18 / 20 titulos); os outros 5 ficam de fora de proposito
-- (1 CANCELAMENTO_COBRANCA, 3 AGUARDANDO_BAIXA, 1 encerrado_operacional).
--
-- NAO DA UPDATE EM SALDO. A correcao dos 8 e feita chamando a FUNCAO OFICIAL
-- de recalculo (bloco comentado no fim), que e a unica que sabe decidir
-- situacao, criticidade, retorno e proxima acao.
--
-- REENTRADA SEGURA: `recalcular_situacao_aluno` so atribui QUITADO quando
-- `v_saldo_total <= 0.005`. Nao e esta migration que decide reabrir -- ela so
-- deixa a funcao oficial olhar. Quem nao tiver divida continua QUITADO intacto.
--
-- Corpo anterior: md5 6f5e5f35749a6f943f2bba035c78a4a8, 1029 bytes. Unica
-- mudanca: a clausula `where` do `for`.
--
-- Rollback: supabase/rollbacks/20261001175200_virada_diaria_revisita_quitado_com_divida.rollback.sql

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
      and (
        coalesce(upper(c.situacao_operacional),'') not in ('QUITADO','SALDO_ZERO_CONFIRMADO')
        -- EXCECAO: quitado que voltou a dever. As quatro condicoes sao
        -- cumulativas e cada uma tira um grupo que NAO pode voltar sozinho.
        or (
             -- 1) divida cobravel real > 0, pela MESMA regra que
             --    `recalcular_situacao_aluno` usa para somar o saldo do caso:
             --    situacao ABERTO/NEGOCIADO, status <> quitada, boleto que nao
             --    seja o do proprio acordo, e sem vinculo ativo a acordo vivo.
             exists (
               select 1
                 from public.acordos_titulos t
                where t.aluno_id = c.aluno_id
                  and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
                  and coalesce(lower(t.status),'') not in ('quitada')
                  and coalesce(t.tipo_boleto,'') <> 'Acordo'
                  and coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                               t.valor_em_aberto, t.valor_original, 0) > 0
                  and not exists (
                        select 1 from public.acordo_titulo_vinculo v
                          join public.acordos a on a.id = v.acordo_id
                         where v.titulo_id = t.id and coalesce(v.ativo, true)
                           and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA','QUITADO'))
             )
             -- 2) caso encerrado operacionalmente NAO reabre por rotina.
             and coalesce(c.encerrado_operacional, false) = false
             -- 3) pagamento pode estar parado na fila de baixa: nao cobrar
             --    quem talvez ja tenha pago.
             and not exists (
               select 1 from public.alunos al
                where al.id = c.aluno_id
                  and upper(coalesce(al.status_atual,'')) in ('AGUARDANDO_BAIXA','CANCELAMENTO_COBRANCA')
             )
             -- 4) conciliacao pendente tem o mesmo efeito do item 3.
             and not exists (
               select 1 from public.baixas_pagamento b
                where b.aluno_id = c.aluno_id::text
                  and upper(coalesce(b.status_baixa,'')) not in ('BAIXADO','CONCLUIDO','CANCELADO')
             )
        )
      )
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

-- CORRECAO DOS 8 ATUAIS -- pela funcao oficial, nunca por UPDATE de saldo.
--
-- Nao esta solto no corpo da migration de proposito: rodar depois de conferir a
-- simulacao, e com o resultado registrado. O lote nomeado deixa rastro no
-- audit_log para saber exatamente o que entrou por esta porta.
--
-- select public.recalcular_situacao_aluno(c.aluno_id, 'reentrada_quitado_com_divida_20261001')
--   from public.casos c
--  where upper(coalesce(c.situacao_operacional,'')) in ('QUITADO','SALDO_ZERO_CONFIRMADO')
--    and coalesce(c.encerrado_operacional,false) = false;
