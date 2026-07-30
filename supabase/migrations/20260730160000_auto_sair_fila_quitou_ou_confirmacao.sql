-- Automatiza "sair da fila" quando o aluno QUITA ou é MANDADO PARA CONFIRMAÇÃO.
--
-- Contexto: casos pagos apareciam como "sem acionamento"/"CRÍTICO" e contando na
-- base a negociar. Reconciliação pontual feita em 2026-07-30
-- (_backup_reconciliacao_pagos_20260730). Aqui torna-se automático, nos DOIS
-- pontos de engate já existentes — sem criar triggers paralelos.
--
-- (1) MANDOU PARA CONFIRMAÇÃO: _aluno_aguardando_baixa_ao_confirmar já movia o
--     ALUNO para AGUARDANDO_BAIXA, mas NÃO tocava no `casos` -> o card seguia
--     crítico/sem acionamento. Passa a espelhar no caso: criticidade='NORMAL' +
--     status_acionamento='Aguardando confirmação de pagamento'. MANTÉM operador e
--     `total_em_aberto` (uma confirmação AGUARDANDO já protege o caso de
--     redistribuição via caso_protegido_redistribuicao; se a confirmação for
--     REJEITADA o valor precisa continuar lá). NÃO encerra.
--
-- (2) QUITOU: _talvez_quitar_aluno já quita aluno+caso e libera a vaga (a
--     reposição sai via trg_repor_caso_operador). Acrescenta apenas
--     total_em_aberto=0 + criticidade='NORMAL' para o card não ficar com
--     valor/criticidade fantasma. Quitação é terminal -> zerar é seguro.
--
-- Colunas tocadas (criticidade, status_acionamento, total_em_aberto) NÃO estão na
-- lista de trg_bloquear_alteracoes_restritas_casos. Interações de trigger
-- verificadas: no caminho (1) o caso já está protegido (OLD e NEW), então
-- trg_repor_caso_operador retorna sem reposição.
--
-- Reversível (ver rollbacks/20260730160000_*.rollback.sql). Idempotente.

BEGIN;

-- (1) Confirmação: espelha neutralização no caso, preservando operador e valor.
CREATE OR REPLACE FUNCTION public._aluno_aguardando_baixa_ao_confirmar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if upper(coalesce(new.status,'')) = 'AGUARDANDO_CONFIRMACAO' and new.aluno_id is not null then
    update public.alunos set
      status_jornada = 'AGUARDANDO_BAIXA',
      status_atual = 'AGUARDANDO_BAIXA',
      status_acionamento = 'Aguardando confirmação de pagamento',
      data_ultimo_acionamento = now()
    where id::text = new.aluno_id::text
      and status_jornada not in ('QUITADO','QUITADO_MANUAL','BAIXA_REALIZADA','AGUARDANDO_BAIXA');

    -- Espelho no caso: sai do crítico/"sem acionamento" e some da base a negociar,
    -- mas permanece na fila de confirmação (operador e total preservados).
    update public.casos c
       set criticidade = 'NORMAL',
           status_acionamento = 'Aguardando confirmação de pagamento'
     where c.aluno_id::text = new.aluno_id::text
       and c.quitado_em is null
       and not public.caso_encerrado_operacional(c.cpf, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  end if;
  return new;
end;
$function$;

-- (2) Quitação automática: zera valor/criticidade fantasma no caso já quitado.
CREATE OR REPLACE FUNCTION public._talvez_quitar_aluno(v_aluno uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_saldo numeric; v_parc int; v_conf int;
begin
  if v_aluno is null then return; end if;

  select coalesce(sum(coalesce(saldo_corrigido, valor_original, 0)), 0) into v_saldo
    from public.acordos_titulos
   where aluno_id = v_aluno and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_saldo > 0 then return; end if;

  select count(*) into v_parc
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = v_aluno
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  if v_parc > 0 then return; end if;

  select count(*) into v_conf
    from public.solicitacoes_confirmacao_pagamento
   where aluno_id = v_aluno::text and status = 'AGUARDANDO_CONFIRMACAO';
  if v_conf > 0 then return; end if;

  update public.alunos
    set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO',
        valor_em_aberto = 0
    where id = v_aluno
      and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');

  -- Regra aprovada pela gestao (24/07/2026): saldo consolidado zero encerra o
  -- caso, libera a vaga na hora e gera UMA reposicao (via trg_repor_caso_operador).
  -- Idempotencia: so age em caso ainda nao encerrado (quitado_em is null) e que
  -- ainda ocupa vaga (operador_email not null). Rodando de novo, nada acontece.
  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         total_em_aberto   = 0,
         criticidade       = 'NORMAL',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null;
end;
$function$;

COMMIT;
