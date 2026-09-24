-- Pausa o vinculo automatico dos acordos FORTE (job de 15 em 15 minutos).
--
-- POR QUE. A regra FORTE (20260922170000_acordo_vinculo_sugestoes.sql) casa
-- mensalidade com acordo por DATA DE LIQUIDACAO na Prime dentro de uma janela
-- de -60/+7 dias da criacao do acordo, exigindo apenas que haja um unico grupo
-- na janela e nenhum outro acordo do aluno concorrendo. Ela nunca compara
-- VALOR: nada no criterio pergunta se a divida cabe no acordo.
--
-- O que isso produziu, medido em producao em 24/09/2026 -- 116 vinculos
-- ativos, 72 acordos, R$ 209.452,29 em mensalidades:
--
--   acordo 1919 ... R$ 15.428,65 em 2x ... recebeu 5 mensalidades = R$ 64.362,00
--   acordo 5011 ... R$  3.890,61 em 1x ... recebeu 2 mensalidades = R$ 13.670,12
--   acordo 1198 ... R$  1.339,58 em 3x ... recebeu 3 mensalidades = R$  7.322,94
--   acordo 1108 ... R$    237,28 ......... recebeu 1 mensalidade  = R$  1.090,08
--
-- Um acordo nao renegocia quatro vezes o proprio valor. E 33 desses vinculos
-- caíram em acordo QUITADO: como titulo vinculado a acordo quitado vira
-- PAGO/quitada, R$ 24.460,12 de mensalidade foram marcados como pagos sem
-- pagamento nenhum deles.
--
-- Pausa, e nao remocao: a sugestao continua existindo para quem quiser olhar
-- (`acordo_vinculo_sugestoes_calcular`, tela de sugestoes), e a confirmacao
-- humana (`acordo_vinculo_sugestao_confirmar`) segue intacta. O que para e a
-- efetivacao SEM CLIQUE. Religar e uma linha -- mas so depois que o criterio
-- passar a olhar valor.
--
-- Reativar, quando for o caso:
--   select cron.alter_job((select jobid from cron.job
--                           where jobname = 'acordo_vinculo_automatico'),
--                         active => true);

do $$
declare
  v_id bigint;
begin
  select jobid into v_id from cron.job where jobname = 'acordo_vinculo_automatico';
  if v_id is null then
    raise notice 'job acordo_vinculo_automatico nao encontrado -- nada a pausar';
    return;
  end if;
  perform cron.alter_job(v_id, active => false);
  raise notice 'job % (acordo_vinculo_automatico) pausado', v_id;
end
$$;
