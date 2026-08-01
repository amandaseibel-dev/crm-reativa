-- Acionar deve recalcular a situacao/criticidade da carteira.
--
-- Causa raiz: o gatilho AFTER INSERT em aluno_movimentacoes
-- (fn_atualizar_ultimo_acionamento) atualizava alunos/casos.data_ultimo_acionamento,
-- mas NAO chamava recalcular_situacao_aluno. Como o peso "dias_sem_acionamento"
-- (>=10 dias => +2) so e reavaliado em evento financeiro ou no cron noturno,
-- o operador acionava e a criticidade nao mudava ate a virada diaria.
--
-- Correcao: apos gravar data_ultimo_acionamento, disparar o recalculo canonico
-- (mesmo padrao dos gatilhos financeiros _trg_recalc_*), protegido para nunca
-- impedir o registro do acionamento.

CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- recalcular situacao/criticidade apos o acionamento (dias_sem_acionamento zera).
  -- protegido: falha aqui nunca impede o registro do acionamento.
  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;
