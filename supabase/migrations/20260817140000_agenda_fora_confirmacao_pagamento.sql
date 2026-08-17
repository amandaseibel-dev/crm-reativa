-- Agenda Operacional: caso na fila de Confirmação de Pagamento sai da agenda.
--
-- Complemento de 20260817120000 (retorno_origem). O recálculo já zera o
-- retorno quando o caso QUITA (saldo total zerado) ou quando a confirmação
-- pendente cobre todo o saldo vencido. Faltava o caso do pagamento PARCIAL:
-- solicitação pendente + saldo vencido > 0 mantém COBRANCA_VENCIDA, então o
-- retorno agendado continuava aparecendo na agenda (28 casos em 17/08/2026)
-- mesmo com o caso já fora da fila operacional.
--
-- A fila operacional (PainelCarteira) usa solicitacoes_confirmacao_pagamento
-- como fonte de verdade -- não o texto de status. A agenda passa a usar o
-- mesmo critério, via um terceiro valor de retorno_origem:
--   OPERADOR                 -> agendado pela operação, aparece na Agenda
--   OPERADOR_EM_CONFIRMACAO  -> agendado, mas o caso está em confirmação;
--                               sai da Agenda e VOLTA sozinho se a
--                               confirmação for rejeitada/cancelada
--   AUTOMATICO               -> motor da fila, nunca aparece na Agenda
--
-- Guardar o compromisso em vez de apagá-lo evita perder o agendamento do
-- operador quando o financeiro rejeita o pagamento e o caso volta pra ele.

comment on column public.alunos.retorno_origem is
  'Origem de data_retorno: OPERADOR (agendado ao tabular, aparece na Agenda Operacional), OPERADOR_EM_CONFIRMACAO (agendado, mas o caso está na fila de Confirmação de Pagamento -- volta a OPERADOR se a confirmação for rejeitada) ou AUTOMATICO (motor da fila / ação massiva / regra por status). Null quando não há retorno.';

create or replace function public.tg_conf_pagamento_agenda()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_aluno uuid;
  v_pendente boolean;
begin
  begin
    v_aluno := new.aluno_id::uuid;
  exception when others then
    return new;  -- caso órfão (aluno_id não-uuid): nada a fazer
  end;

  v_pendente := new.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO');

  if v_pendente then
    update public.alunos
       set retorno_origem = 'OPERADOR_EM_CONFIRMACAO'
     where id = v_aluno
       and retorno_origem = 'OPERADOR';
  else
    -- Confirmação resolvida (validada, rejeitada ou cancelada): devolve o
    -- compromisso pra agenda, desde que não sobre outra pendente.
    update public.alunos
       set retorno_origem = 'OPERADOR'
     where id = v_aluno
       and retorno_origem = 'OPERADOR_EM_CONFIRMACAO'
       and not exists (
         select 1 from public.solicitacoes_confirmacao_pagamento s
          where s.aluno_id = new.aluno_id
            and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_conf_pagamento_agenda on public.solicitacoes_confirmacao_pagamento;
create trigger trg_conf_pagamento_agenda
  after insert or update of status on public.solicitacoes_confirmacao_pagamento
  for each row execute function public.tg_conf_pagamento_agenda();

-- Backfill: quem já está na fila de confirmação sai da agenda agora.
update public.alunos a
   set retorno_origem = 'OPERADOR_EM_CONFIRMACAO'
 where a.retorno_origem = 'OPERADOR'
   and exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = a.id::text
        and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'));
