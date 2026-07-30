-- Rollback de 20260730160000_auto_sair_fila_quitou_ou_confirmacao.sql
-- Restaura as definições ORIGINAIS das duas funções (capturadas de prod
-- ahattpqrjmhkzsmnbdzs em 2026-07-30 antes da alteração).

BEGIN;

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
  end if;
  return new;
end;
$function$;

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

  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null;
end;
$function$;

COMMIT;
