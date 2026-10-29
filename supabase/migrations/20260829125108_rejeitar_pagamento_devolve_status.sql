-- Rejeitar pagamento devolve o STATUS, nao so o operador.
--
-- Amanda, 29/08/2026: "se a baixa for rejeitada deve voltar para cobranca".
-- Nao voltava. A funcao restaurava `casos.operador_email` e deixava o aluno em
-- AGUARDANDO_BAIXA para sempre -- e como esse status esta em
-- STATUS_NAO_ACIONAVEIS na Carteira, o caso sumia da fila e nao tinha volta.
--
-- Isso e a torneira; o reparo do acumulado esta em 20260829010000 (480 casos,
-- R$ 906.949,69 de saldo vencido invisivel).
--
-- Volta para 'CONTATAR', e SO para quem esta em espera (AGUARDANDO_BAIXA ou
-- BAIXA_REALIZADA). Nao pisa em quitado, juridico, suspensao nem cancelamento --
-- encerrar cobranca e da gestao (premissa 10).
--
-- Testado em producao com ROLLBACK: criada solicitacao, rejeitada, conferido
-- RESULTADO=CONTATAR, transacao revertida sem gravar nada.

create or replace function public.devolver_operador_ao_rejeitar_confirmacao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if upper(coalesce(NEW.status,'')) = 'PAGAMENTO_REJEITADO'
     and upper(coalesce(OLD.status,'')) is distinct from 'PAGAMENTO_REJEITADO'
     and NEW.aluno_id is not null then

    -- 1) devolve o dono anterior (comportamento que ja existia)
    update public.casos c
       set operador_email = m.operador_email,
           operador_nome  = m.operador_nome,
           operador       = coalesce(m.operador_upper, upper(m.operador_nome))
      from public.calibragem_dono_anterior_confirmacao m
     where m.aluno_id = NEW.aluno_id::text
       and c.aluno_id::text = NEW.aluno_id::text
       and c.operador_email is null;

    delete from public.calibragem_dono_anterior_confirmacao where aluno_id = NEW.aluno_id::text;

    -- 2) devolve o STATUS. Sem isto o aluno fica preso e o caso nunca reaparece.
    update public.alunos al
       set status_atual   = 'CONTATAR',
           status_jornada = 'CONTATAR'
     where al.id = NEW.aluno_id::uuid
       and upper(coalesce(al.status_atual,'')) in ('AGUARDANDO_BAIXA','BAIXA_REALIZADA');
  end if;
  return NEW;
end;
$function$;
