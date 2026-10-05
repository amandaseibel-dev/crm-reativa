-- ROLLBACK de 20261003083400_acao_massiva_sem_retorno_automatico.
--
-- Devolve o gatilho exatamente como 20261002094233 o deixou: a recalculadora
-- volta a ser chamada tambem para ACAO_MASSIVA_EXTERNA*, o que faz a acao
-- massiva voltar a gravar data_retorno e status_acionamento.
--
-- Nao desfaz dado: o que ja foi gravado continua gravado.

create or replace function public.fn_atualizar_ultimo_acionamento()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
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

  -- SO AVANCA: um acionamento mais antigo nunca sobrescreve um mais novo.
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
